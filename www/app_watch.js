// ============================================================
// MainApp: Watch tracking: progress, resume, history and cloud sync
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppWatchMethods {

    // ---------------- Resume watching ----------------

    _readProgress() {
        try {
            const o = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
            return (o && typeof o === 'object') ? o : {};
        } catch (e) { return {}; }
    }

    _writeProgress(map) {
        try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(map)); }
        catch (e) { /* storage unavailable: resume simply won't persist */ }
    }

    // Items with something worth resuming, most recently watched first.
    _resumeItems() {
        const map = this.state.progress || {};
        return Object.keys(map).map(k => map[k])
            .filter(it => it && it.id && it.position >= RESUME_MIN_SEC)
            .sort((x, y) => (y.updated || 0) - (x.updated || 0));
    }

    // Called by the player every ~10s and when it closes. Writes straight to storage
    // (no re-render while a video is playing); the screen catches up when the player closes.
    _saveProgress(id, meta, position, duration) {
        const map = this._readProgress();
        const finished = duration > 0 && position / duration >= RESUME_DONE_RATIO;
        if (finished && window.HesperSync) window.HesperSync.recordWatched(meta);
        if (finished || !(position >= RESUME_MIN_SEC)) {
            delete map[id];
        } else {
            map[id] = Object.assign({}, meta, { id: id, position: position, duration: duration > 0 ? duration : 0, updated: Date.now() });
        }
        this._writeProgress(map);
    }

    _removeProgress(id) {
        const map = this._readProgress();
        delete map[id];
        this._writeProgress(map);
        const left = Object.keys(map).some(k => map[k] && map[k].position >= RESUME_MIN_SEC);
        this.setState({ progress: map, activeTab: (!left && this.state.activeTab === 'resume') ? 'dashboard' : this.state.activeTab });
    }

    _resumeFor(id) {
        const it = (this.state.progress || {})[id];
        return it && it.position >= RESUME_MIN_SEC ? it : null;
    }

    // ---------------- Watch history + cloud sync (see sync.js, cloud/worker.js) ----------------

    _readHistory() { return window.HesperSync ? window.HesperSync.listHistory() : []; }

    _setSyncUi(patch) { this.setState({ syncUi: Object.assign({}, this.state.syncUi, patch) }); }

    // Index of what is on THIS device: item key -> local file id (rebuilt at most every 2 min).
    async _ensureLibIndex() {
        const S = window.HesperSync;
        if (this._libIndex && Date.now() - this._libIndex.t < 120000) return this._libIndex.map;
        const map = {};
        try {
            const [mv, sh] = await Promise.all([
                fetch('/api/movies').then(r => r.json()),
                fetch('/api/shows').then(r => r.json())
            ]);
            (mv.movies || []).forEach(m => {
                const k = S.histKey({ kind: 'movie', title: m.title, year: m.year || 0 });
                if (k && !map[k]) map[k] = m.id;
            });
            (sh.shows || []).forEach(show => (show.seasons || []).forEach(se => (se.episodes || []).forEach(e => {
                const k = S.histKey({ kind: 'episode', showTitle: show.showTitle, season: e.season, episode: e.episode });
                if (k && !map[k]) map[k] = e.id;
            })));
        } catch (err) { return null; }
        this._libIndex = { t: Date.now(), map: map };
        return map;
    }

    // Looks up this device's own file id for an item synced from another device.
    async _resolveLocalId(meta) {
        const map = await this._ensureLibIndex();
        const key = window.HesperSync.histKey(meta);
        return (map && key && map[key]) || null;
    }

    // Opening Watch History: find out which of the items are on this device.
    async _refreshHistoryAvailability() {
        this._libIndex = null;
        const map = await this._ensureLibIndex();
        if (map && this.state.activeTab === 'history') this.setState({ histAvail: map });
    }

    _syncMessage(err) {
        return ({
            offline: 'Could not reach Hesper Cloud. Check your connection.',
            bad_email: 'That email address does not look right.',
            weak_password: 'Passwords need at least 8 characters.',
            bad_credentials: 'Wrong email or password.',
            email_taken: 'There is already an account with that email. Try signing in.',
            bad_code: 'That code is wrong or has expired. Request a new one.',
            email_not_verified: 'Your email is not verified yet.',
            rate_limited: 'Too many attempts. Wait a few minutes and try again.',
            email_not_configured: 'Password reset email is not set up on the server yet.',
            session_expired: 'You were signed out. Please sign in again.',
            too_large: 'Too much data to sync at once.',
            not_linked: 'Not signed in yet.'
        })[err] || 'Hesper Cloud is having trouble. Try again later.';
    }

    // opts: { manual }. Updates the screen when something changed.
    async _runSync(opts) {
        const S = window.HesperSync;
        if (!S || !S.isLinked() || this._syncing) return { ok: false, error: 'busy' };
        opts = opts || {};
        this._syncing = true;
        if (opts.manual) this._setSyncUi({ busy: true, msg: '' });
        let res;
        try {
            res = await S.sync({ resolve: (m) => this._resolveLocalId(m) });
        } catch (e) { res = { ok: false, error: 'offline' }; }
        this._syncing = false;
        const refresh = res.ok && res.changed && !this._player;
        const patch = {};
        if (opts.manual) { patch.busy = false; patch.msg = res.ok ? '' : this._syncMessage(res.error); }
        else if (!res.ok && res.error === 'session_expired') { patch.msg = this._syncMessage(res.error); }
        if (refresh || opts.manual || patch.msg) {
            this.setState({
                progress: refresh ? this._readProgress() : this.state.progress,
                history: this._readHistory(),
                syncUi: Object.assign({}, this.state.syncUi, patch)
            });
            if (refresh) this._queueResumeArt();
        }
        return res;
    }

    // Quiet background sync: on start, after playback, when back online, every 10 minutes.
    _autoSync(delayMs) {
        const S = window.HesperSync;
        if (!S || !S.isLinked()) return;
        clearTimeout(this._autoSyncTimer);
        this._autoSyncTimer = setTimeout(() => {
            if (this.state.syncUi.mode || this._player) return;   // don't rebuild the screen under a text box or a video
            this._runSync({});
        }, delayMs || 0);
    }

    _startAutoSync() {
        this._autoSync(2500);
        if (!this._syncTimer) this._syncTimer = setInterval(() => this._autoSync(0), 10 * 60 * 1000);
    }

    // What is typed in the sign-in boxes lives here (not in state), so typing never redraws the screen.
    _authForm() {
        if (!this._auth) this._auth = { email: '', password: '', confirm: '', code: '' };
        return this._auth;
    }

    _openAuth(mode) {
        const f = this._authForm();
        if (!mode) { f.password = ''; f.confirm = ''; f.code = ''; }
        this._setSyncUi({ mode: mode, msg: '', busy: false, confirmDelete: false });
    }

    // Called after any successful sign up / sign in / reset.
    async _afterSignIn(toast) {
        const f = this._authForm();
        f.password = ''; f.confirm = ''; f.code = '';
        this._setSyncUi({ mode: '', busy: true, msg: '' });
        this.props.engine.ui.toast(toast);
        const res = await this._runSync({ manual: true });
        if (!res.ok && res.error !== 'busy') this._setSyncUi({ busy: false });
    }

    async signUpAccount() {
        const S = window.HesperSync, f = this._authForm();
        if (!S) return;
        if (!S.validEmail(f.email)) { this._setSyncUi({ msg: this._syncMessage('bad_email') }); return; }
        if (!S.validPassword(f.password)) { this._setSyncUi({ msg: this._syncMessage('weak_password') }); return; }
        if (f.password !== f.confirm) { this._setSyncUi({ msg: 'The two passwords do not match.' }); return; }
        this._setSyncUi({ busy: true, msg: '' });
        const res = await S.signUp(f.email, f.password);
        if (!res.ok) { this._setSyncUi({ busy: false, msg: this._syncMessage(res.error) }); return; }
        f.code = '';
        this._setSyncUi({ busy: false, mode: 'verify', msg: 'We emailed a 6-digit code to ' + f.email.trim() + '. Enter it to finish. It can take a minute. Check spam too.' });
    }

    async verifyAccountEmail() {
        const S = window.HesperSync, f = this._authForm();
        if (!S) return;
        if (String(f.code).replace(/\D/g, '').length !== 6) { this._setSyncUi({ msg: 'Enter the 6-digit code from the email.' }); return; }
        this._setSyncUi({ busy: true, msg: '' });
        const res = await S.verifyEmail(f.email, f.code);
        if (!res.ok) { this._setSyncUi({ busy: false, msg: this._syncMessage(res.error) }); return; }
        await this._afterSignIn('Email verified. Your history is syncing.');
    }

    async resendVerifyCode() {
        const S = window.HesperSync, f = this._authForm();
        if (!S) return;
        this._setSyncUi({ busy: true, msg: '' });
        const res = await S.resendCode(f.email);
        this._setSyncUi({ busy: false, msg: res.ok ? 'A new code is on its way. Only the newest code works.' : this._syncMessage(res.error) });
    }

    async signInAccount() {
        const S = window.HesperSync, f = this._authForm();
        if (!S) return;
        if (!S.validEmail(f.email) || !f.password) { this._setSyncUi({ msg: 'Enter your email and password.' }); return; }
        this._setSyncUi({ busy: true, msg: '' });
        const res = await S.signIn(f.email, f.password);
        if (!res.ok && res.error === 'email_not_verified') {
            f.code = ''; f.password = '';
            this._setSyncUi({ busy: false, mode: 'verify', msg: 'Your email is not verified yet. We sent a new code to ' + f.email.trim() + '. Enter it to finish.' });
            return;
        }
        if (!res.ok) { this._setSyncUi({ busy: false, msg: this._syncMessage(res.error) }); return; }
        await this._afterSignIn('Signed in. Your history is syncing.');
    }

    async sendResetCode() {
        const S = window.HesperSync, f = this._authForm();
        if (!S) return;
        if (!S.validEmail(f.email)) { this._setSyncUi({ msg: this._syncMessage('bad_email') }); return; }
        this._setSyncUi({ busy: true, msg: '' });
        const res = await S.forgotPassword(f.email);
        if (!res.ok) { this._setSyncUi({ busy: false, msg: this._syncMessage(res.error) }); return; }
        f.code = ''; f.password = ''; f.confirm = '';
        this._setSyncUi({ busy: false, mode: 'reset', msg: 'If that email has an account, a 6-digit code is on its way. It can take a minute. Check spam too.' });
    }

    async resetPasswordAccount() {
        const S = window.HesperSync, f = this._authForm();
        if (!S) return;
        if (String(f.code).replace(/\D/g, '').length !== 6) { this._setSyncUi({ msg: 'Enter the 6-digit code from the email.' }); return; }
        if (!S.validPassword(f.password)) { this._setSyncUi({ msg: this._syncMessage('weak_password') }); return; }
        if (f.password !== f.confirm) { this._setSyncUi({ msg: 'The two passwords do not match.' }); return; }
        this._setSyncUi({ busy: true, msg: '' });
        const res = await S.resetPassword(f.email, f.code, f.password);
        if (!res.ok) { this._setSyncUi({ busy: false, msg: this._syncMessage(res.error) }); return; }
        await this._afterSignIn('Password changed. You are signed in.');
    }

    async signOutDevice() {
        this._setSyncUi({ busy: true });
        await window.HesperSync.signOut();
        this._setSyncUi({ busy: false, confirmDelete: false, msg: 'Signed out. Your local history is kept on this device.' });
    }

    async deleteCloudData() {
        if (!this.state.syncUi.confirmDelete) { this._setSyncUi({ confirmDelete: true }); return; }
        this._setSyncUi({ busy: true });
        const res = await window.HesperSync.deleteAccount();
        this._setSyncUi({ busy: false, confirmDelete: false, msg: res.ok ? 'Your cloud account and its data were deleted.' : this._syncMessage(res.error) });
    }

    clearWatchHistory() {
        if (!this.state.syncUi.confirmClear) { this._setSyncUi({ confirmClear: true }); return; }
        window.HesperSync.clearHistory();
        this.setState({ history: this._readHistory(), activeTab: 'dashboard', syncUi: Object.assign({}, this.state.syncUi, { confirmClear: false }) });
        this._autoSync(500);
    }

    _renderHistory() {
        const { createElement, ui } = this.props.engine;
        const items = (this.state.history || []).slice(0, 300);
        const avail = this.state.histAvail;
        if (!items.length) return ui.card('No watch history yet', 'Things you finish watching will be listed here.');
        const fmt = (t) => { try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
        const rows = items.map(it => {
            const title = it.kind === 'movie' ? it.title : `${it.showTitle} \u00b7 S${it.season}E${it.episode}`;
            const here = avail ? !!avail[it.key] : null;     // null = still checking
            const sub = [it.kind === 'movie' && it.year ? String(it.year) : '', 'Watched ' + fmt(it.watchedAt), it.count > 1 ? `${it.count} times` : '',
                here === true ? 'On this device' : here === false ? 'Not on this device' : ''].filter(Boolean).join(' \u00b7 ');
            return ui.listRow(title, sub, null, { statusDot: here === true });
        });
        return createElement('div', {},
            createElement('div', { className: 'plugin-list' }, ...rows),
            createElement('div', { className: 'section-actions' },
                ui.button(this.state.syncUi.confirmClear ? 'Tap again to clear all history' : 'Clear Watch History', () => this.clearWatchHistory()))
        );
    }

    _renderSyncSettings() {
        const { createElement, ui } = this.props.engine;
        const S = window.HesperSync;
        const u = this.state.syncUi;
        const f = this._authForm();
        const parts = [createElement('h2', {}, 'Cloud Sync')];
        const row = (...btns) => createElement('div', { className: 'section-actions' }, ...btns);
        const email = () => ui.textInput('Email', f.email, (v) => { f.email = v; }, { type: 'email', placeholder: 'you@example.com' });
        const pass = (label, key) => ui.textInput(label, f[key], (v) => { f[key] = v; }, { type: 'password', placeholder: 'At least 8 characters' });
        const go = (label, fn, primary) => ui.button(u.busy ? 'Working\u2026' : label, () => { if (!u.busy) fn(); }, primary ? { variant: 'primary' } : undefined);

        if (!S) {
            parts.push(createElement('p', { className: 'sub' }, 'Sync is not available in this build.'));
        } else if (!S.isLinked()) {
            if (u.mode === 'signin') {
                parts.push(createElement('p', { className: 'sub' }, 'Sign in to sync your watch history and resume points.'));
                parts.push(email(), pass('Password', 'password'));
                parts.push(row(go('Sign In', () => this.signInAccount(), true), ui.button('Forgot Password?', () => this._openAuth('forgot')), ui.button('Cancel', () => this._openAuth(''))));
            } else if (u.mode === 'signup') {
                parts.push(createElement('p', { className: 'sub' }, 'Create an account with your email and a password. We will email you a code to confirm the address. You will use the same details on your other devices.'));
                parts.push(email(), pass('Password', 'password'), pass('Confirm password', 'confirm'));
                parts.push(row(go('Create Account', () => this.signUpAccount(), true), ui.button('Cancel', () => this._openAuth(''))));
            } else if (u.mode === 'verify') {
                parts.push(createElement('p', { className: 'sub' }, 'Verify your email to finish creating your account.'));
                parts.push(email(), ui.textInput('6-digit code', f.code, (v) => { f.code = v; }, { placeholder: '123456' }));
                parts.push(row(go('Verify Email', () => this.verifyAccountEmail(), true), go('Resend Code', () => this.resendVerifyCode()), ui.button('Back', () => this._openAuth('signin'))));
            } else if (u.mode === 'forgot') {
                parts.push(createElement('p', { className: 'sub' }, 'We will email you a 6-digit code to set a new password.'));
                parts.push(email());
                parts.push(row(go('Send Reset Code', () => this.sendResetCode(), true), ui.button('I Have a Code', () => this._openAuth('reset')), ui.button('Back', () => this._openAuth('signin'))));
            } else if (u.mode === 'reset') {
                parts.push(createElement('p', { className: 'sub' }, 'Enter the code from the email and choose a new password.'));
                parts.push(email(), ui.textInput('6-digit code', f.code, (v) => { f.code = v; }, { placeholder: '123456' }), pass('New password', 'password'), pass('Confirm new password', 'confirm'));
                parts.push(row(go('Set New Password', () => this.resetPasswordAccount(), true), ui.button('Send a New Code', () => this._openAuth('forgot')), ui.button('Back', () => this._openAuth('signin'))));
            } else {
                parts.push(createElement('p', { className: 'sub' }, 'Optional. Keeps your watch history and resume points in step across your devices. Nothing is uploaded until you sign in.'));
                parts.push(row(ui.button('Sign In', () => this._openAuth('signin'), { variant: 'primary' }), ui.button('Create Account', () => this._openAuth('signup'))));
            }
        } else {
            const last = S.lastSync();
            parts.push(ui.listRow('Signed in', S.getEmail(), null));
            parts.push(ui.listRow(u.busy ? 'Syncing\u2026' : 'Sync is on',
                last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet', null, { statusDot: !u.busy && !!last }));
            parts.push(row(
                ui.button(u.busy ? 'Syncing\u2026' : 'Sync Now', () => { if (!u.busy) this._runSync({ manual: true }); }, { variant: 'primary' }),
                ui.button('Sign Out', () => { if (!u.busy) this.signOutDevice(); })));
            parts.push(row(ui.button(u.confirmDelete ? 'Tap again to delete your account and cloud data' : 'Delete Account & Cloud Data', () => this.deleteCloudData())));
        }
        if (u.msg) parts.push(createElement('p', { className: 'sub' }, u.msg));
        return createElement('div', { className: 'settings-section' }, ...parts);
    }

    // Art for the Resume Watching cards: movie posters, episode stills (show poster as backup).
    _queueResumeArt() {
        const items = this._resumeItems();
        const jobs = [];
        items.forEach(it => {
            if (it.torrent) return;            // plugin streams bring their own artwork
            if (it.kind === 'movie') {
                jobs.push({ key: 'm:' + it.id, url: '/api/movie-details?id=' + encodeURIComponent(it.id) });
            } else {
                jobs.push({ key: 'e:' + it.id, url: '/api/episode-details?show=' + encodeURIComponent(it.showTitle) + '&season=' + it.season + '&episode=' + it.episode });
                jobs.push({ key: 's:' + it.showTitle, url: '/api/show-details?title=' + encodeURIComponent(it.showTitle) });
            }
        });
        if (jobs.length) this._queuePosters(jobs);
    }

    _fmtLeft(it) {
        if (!(it.duration > 0)) return '';
        const mins = Math.max(1, Math.round((it.duration - it.position) / 60));
        return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : `${mins}m left`;
    }

    _renderResume() {
        const { ui } = this.props.engine;
        const items = this._resumeItems();
        if (!items.length) return ui.card('Nothing to resume', 'Things you start watching will show up here.');
        return ui.grid(
            items.map(it => {
                const isMovie = it.kind === 'movie';
                const title = this._resumeTitle(it);
                const sub = [isMovie && it.year ? String(it.year) : '', this._fmtLeft(it), this._originLabel(it)].filter(Boolean).join(' \u00b7 ');
                const img = it.torrent
                    ? (it.image || '')
                    : isMovie
                    ? this.state.posters['m:' + it.id]
                    : (this.state.posters['e:' + it.id] || this.state.posters['s:' + it.showTitle]);
                return ui.posterCard(title, sub, img, () => this.resumeItem(it), { onLongPress: () => ui.toast(title + (sub ? ' \u00b7 ' + sub : '')) });
            }),
            { minColWidth: '200px', className: 'sx-poster-grid' }
        );
    }

    _resumeTitle(it) {
        if (it.kind === 'movie') return it.title;
        if (it.kind === 'episode') return `${it.showTitle} \u00b7 S${it.season}E${it.episode}`;
        return it.title + (it.season && it.episode ? ` \u00b7 S${it.season}E${it.episode}` : '');
    }

    // Where this was started: the plugin's name, or the library when nothing says otherwise.
    _originLabel(it) {
        if (it.origin && it.origin.name) return it.origin.name;
        return it.torrent ? 'A plugin' : 'Your library';
    }

    // Tapping a card asks first: continue where it stopped, or start over.
    _renderResumeAskModal() {
        const it = this.state.resumeAsk;
        if (!it) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.setState({ resumeAsk: null });
        const at = window.HesperPlayerUtil ? window.HesperPlayerUtil.fmtTime(it.position) : Math.round(it.position) + 's';
        const from = it.origin && it.origin.name ? 'Started in ' + it.origin.name : (it.torrent ? 'Started in a plugin' : 'From your library');
        const left = this._fmtLeft(it);
        const body = createElement('div', {},
            createElement('p', { className: 'sub' }, [from, left].filter(Boolean).join(' \u00b7 ')),
            createElement('div', { className: 'section-actions', style: { margin: '14px 0 6px' } },
                ui.button('\u25b6  Continue from ' + at, () => this._doResume(it, it.position), { variant: 'primary' }),
                ui.button('Start over', () => this._doResume(it, 0))));
        return ui.modal(this._resumeTitle(it), body, close);
    }

    _doResume(it, startSec) {
        this.setState({ resumeAsk: null });
        if (it.torrent && it.torrent.source && window.HesperTorrent) { this._resumeTorrent(it, startSec); return; }
        this.playMedia(it.id, this._resumeTitle(it), it, startSec);
    }

    // Something started from a plugin (a torrent stream): start the same release again at the saved spot.
    async _resumeTorrent(it, startSec) {
        const { ui } = this.props.engine;
        const t = it.torrent;
        try {
            if (/^https:/i.test(t.source)) await window.HesperTorrent.allowLink(t.source);
            await window.HesperTorrent.open({
                source: t.source, title: t.title || it.title || it.showTitle || '',
                season: t.season || 0, episode: t.episode || 0, startSec: startSec > 0 ? startSec : 0,
                track: { meta: { kind: it.kind, title: it.title, year: it.year, showTitle: it.showTitle, season: it.season, episode: it.episode, image: it.image, origin: it.origin } }
            });
        } catch (e) {
            const m = String((e && e.message) || e || '');
            if (m !== 'Cancelled') ui.toast("Couldn't start this stream again. " + m.slice(0, 120));
        }
    }

    resumeItem(it) {
        this.setState({ resumeAsk: it });
    }
}

hesperMixin(MainApp, MainAppWatchMethods);
