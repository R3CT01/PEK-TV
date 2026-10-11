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
        if (finished && window.HesperSync) window.HesperSync.recordWatched(this._historyMeta(id, meta));
        if (finished || !(position >= RESUME_MIN_SEC)) {
            delete map[id];
        } else {
            map[id] = Object.assign({}, meta, { id: id, position: position, duration: duration > 0 ? duration : 0, updated: Date.now() });
        }
        this._writeProgress(map);
    }

    // What goes into Watch History: the item plus its artwork, so the card still has a picture later,
    // even on another device or after the file is gone. Plugin streams bring their own artwork.
    _historyMeta(id, meta) {
        const m = Object.assign({}, meta);
        if (!m.image && !m.torrent) {
            const P = this.state.posters || {};
            const art = m.kind === 'movie' ? P['m:' + id] : (P['e:' + id] || P['s:' + m.showTitle]);
            if (art) m.image = art;
        }
        return m;
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
        const map = {}, items = {};
        try {
            const [mv, sh] = await Promise.all([
                fetch('/api/movies').then(r => r.json()),
                fetch('/api/shows').then(r => r.json())
            ]);
            (mv.movies || []).forEach(m => {
                const k = S.histKey({ kind: 'movie', title: m.title, year: m.year || 0 });
                if (k && !map[k]) { map[k] = m.id; items[k] = { kind: 'movie', id: m.id, title: m.title, year: m.year || 0 }; }
            });
            (sh.shows || []).forEach(show => (show.seasons || []).forEach(se => (se.episodes || []).forEach(e => {
                const k = S.histKey({ kind: 'episode', showTitle: show.showTitle, season: e.season, episode: e.episode });
                if (k && !map[k]) { map[k] = e.id; items[k] = { kind: 'episode', id: e.id, showTitle: show.showTitle, season: e.season, episode: e.episode }; }
            })));
        } catch (err) { return null; }
        this._libIndex = { t: Date.now(), map: map, items: items };
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
        if (map) this._queueHistoryArt(map);
    }

    // Pictures for history cards that have none stored (older entries): local files first, then episode stills by title.
    _queueHistoryArt(avail) {
        const jobs = [];
        (this.state.history || []).slice(0, 60).forEach(it => {
            if (it.image) return;
            const id = avail && avail[it.key];
            if (it.kind === 'movie') {
                if (id) jobs.push({ key: 'm:' + id, url: '/api/movie-details?id=' + encodeURIComponent(id) });
                return;
            }
            const q = '?show=' + encodeURIComponent(it.showTitle) + '&season=' + (it.season | 0) + '&episode=' + (it.episode | 0);
            jobs.push({ key: id ? 'e:' + id : 'he:' + it.key, url: '/api/episode-details' + q });
            jobs.push({ key: 's:' + it.showTitle, url: '/api/show-details?title=' + encodeURIComponent(it.showTitle) });
        });
        if (jobs.length) this._queuePosters(jobs);
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
            email_not_configured: 'Email is not set up on the server yet, so codes cannot be sent.',
            email_failed: 'The code email could not be sent. Try again in a minute.',
            session_expired: 'You were signed out. Please sign in again.',
            too_large: 'Too much data to sync at once.',
            not_linked: 'Not signed in yet.',
            cloud_outdated: 'The cloud service has to be updated before profiles can sync (see cloud/DEPLOY.md).',
            unknown_profile: 'This profile was removed on another device.',
            local: 'Could not read the plugins on this device.',
            plugin_quota: 'Your plugin backup is full (30 plugins or 60 MB). Remove one you no longer use.',
            damaged: 'The plugin from the cloud arrived damaged. Try again.',
            gone: 'That plugin is no longer in your cloud backup.'
        })[err] || 'Hesper Cloud is having trouble. Try again later.';
    }

    // opts: { manual }. Updates the screen when something changed.
    async _runSync(opts) {
        const S = window.HesperSync;
        if (!S || !S.isLinked()) return { ok: false, error: 'busy' };
        if (this._syncing) { this._syncAgain = true; return { ok: false, error: 'busy' }; }   // something changed mid-sync: go again right after
        opts = opts || {};
        this._syncing = true;
        if (opts.manual) this._setSyncUi({ busy: true, msg: '' });
        let res;
        try {
            res = await S.sync({ resolve: (m) => this._resolveLocalId(m) });
        } catch (e) { res = { ok: false, error: 'offline' }; }
        // Plugin backup rides along with the sync: back up what changed, and note what the cloud has that this device lacks.
        let pb = null;
        const PB = window.HesperPluginBackup;
        if (res.ok && PB) {
            try { pb = await PB.run({ force: !!opts.manual }); } catch (e) { pb = null; }
        }
        this._syncing = false;
        if (this._syncAgain) { this._syncAgain = false; this._autoSync(1000); }
        const pbCount = pb && pb.pending ? pb.pending.length : 0;
        const pbChanged = pbCount !== (this._pbPrev || 0);
        this._pbPrev = pbCount;
        const refresh = res.ok && res.changed && !this._player;
        const patch = {};
        if (opts.manual) {
            patch.busy = false;
            patch.msg = res.ok ? '' : this._syncMessage(res.error);
            if (res.ok && pb && !pb.off) {
                if (!pb.ok) patch.msg = 'History synced. Plugin backup did not finish: ' + this._syncMessage(pb.error);
                else if (pb.uploaded) patch.msg = 'Backed up ' + pb.uploaded + (pb.uploaded === 1 ? ' plugin.' : ' plugins.');
            }
        }
        else if (!res.ok && res.error === 'session_expired') { patch.msg = this._syncMessage(res.error); }
        if (refresh || opts.manual || patch.msg || (pbChanged && !this._player)) {
            this.setState({
                progress: refresh ? this._readProgress() : this.state.progress,
                history: this._readHistory(),
                syncUi: Object.assign({}, this.state.syncUi, patch)
            });
            if (refresh) this._queueResumeArt();
        }
        return res;
    }

    // Quiet background sync (history, resume points, favorites and the plugin backup): on start, every 10 minutes,
    // and soon after a favorite changes, something is watched, a plugin is installed, playback ends, the device
    // comes back online or the app is reopened.
    _autoSync(delayMs) {
        const S = window.HesperSync;
        if (!S || !S.isLinked()) return;
        clearTimeout(this._autoSyncTimer);
        this._autoSyncTimer = setTimeout(() => {
            // Don't rebuild the screen under a text box or a video: try again shortly instead of dropping the sync.
            if (this.state.syncUi.mode || this._player || this.state.searchOpen) { this._autoSync(20000); return; }
            this._runSync({});
        }, delayMs || 0);
    }

    _startAutoSync() {
        if (!this._pbHooked && window.HesperPluginInstaller) {
            this._pbHooked = true;     // back a plugin up shortly after it is installed
            window.HesperPluginInstaller.onInstalled(() => this._autoSync(1500));
        }
        if (!this._autoHooked) {
            // Sync soon after anything worth keeping changes, not only on the timer.
            this._autoHooked = true;
            const S = window.HesperSync;
            document.addEventListener('hesper-favorites', (e) => { if (!(e && e.detail && e.detail.remote)) this._autoSync(2000); });   // added or removed a favorite
            document.addEventListener('hesper-history', () => this._autoSync(2000));                                                   // finished watching something
            window.addEventListener('online', () => this._autoSync(1500));                                                             // back online
            document.addEventListener('visibilitychange', () => {                                                                     // came back to the app
                if (document.visibilityState === 'visible' && S && Date.now() - (S.lastSync() || 0) > 60000) this._autoSync(1000);
            });
        }
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
        await this._afterSignIn('Signed in. Your history is syncing.');
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
        if (res.ok && res.needsVerify) {   // right password: every sign-in also needs the 6-digit code from the email
            f.code = ''; f.password = '';
            this._setSyncUi({ busy: false, mode: 'verify', msg: 'We emailed a 6-digit code to ' + f.email.trim() + ' to confirm it is you. Enter it to sign in. It can take a minute. Check spam too.' });
            return;
        }
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

    // "Sign Out" asks first. Back or Close = stay signed in.
    _renderSignOutModal() {
        if (!this.state.signOutAsk) return null;
        const { createElement, ui } = this.props.engine;
        const body = createElement('div', {},
            createElement('p', { className: 'sub' }, 'Syncing stops on this device. Your favorites and watch history stay here. To sign in again you will need your password and a new code from your email.'),
            createElement('div', { className: 'section-actions', style: { margin: '14px 0 6px' } },
                ui.button('Yes, sign out', () => { this.setState({ signOutAsk: false }); this.signOutDevice(); }, { variant: 'primary' })));
        return ui.modal('Are you sure you want to sign out?', body, () => this.setState({ signOutAsk: false }));   // the modal's own button is "Close" = stay
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

    // ---------------- Watch History cards ----------------

    _historyArt(it, id) {
        if (it.image) return it.image;
        const P = this.state.posters || {};
        if (it.kind === 'movie') return (id && P['m:' + id]) || '';
        return (id && P['e:' + id]) || P['he:' + it.key] || P['s:' + it.showTitle] || '';
    }

    _historyTitle(it) { return it.kind === 'movie' ? it.title : it.showTitle; }

    _historySub(it) {
        return it.kind === 'movie' ? (it.year ? String(it.year) : '') : 'Season ' + it.season + ' \u00b7 Episode ' + it.episode;
    }

    // Everything we can say about where an item is: on this device's library, and the plugins that streamed it.
    //   here  = file on THIS device (checked live)   libWas = it was played from a library (maybe another device's)
    //   plugs = [{ id, name, plugin }]  plugin = the installed plugin, or null when it is not installed here
    _historySources(it, id) {
        const list = this.state.pluginsList || [];
        const plugs = (Array.isArray(it.plug) ? it.plug : []).map(pg => {
            const inst = list.find(x => x.folder === pg.id) || null;
            return { id: pg.id, name: (inst && inst.app_name) || pg.name || 'A plugin', plugin: inst };
        });
        return { here: !!id, libWas: !!it.lib, plugs: plugs };
    }

    _historyChips(it, src) {
        const { createElement } = this.props.engine;
        const chips = [];
        const chip = (text, cls) => chips.push(createElement('span', { className: 'sx-chip ' + cls }, text));
        if (src.here) chip('Your library', 'on');
        else if (src.libWas) chip('Library \u00b7 not on this device', 'off');
        src.plugs.forEach(pg => chip(pg.plugin ? pg.name : pg.name + ' \u00b7 not installed', pg.plugin ? 'on' : 'off'));
        if (!chips.length) chip(this.state.histAvail ? 'Source unknown' : 'Checking\u2026', 'off');
        return createElement('div', { className: 'sx-hist-chips' }, ...chips);
    }

    _historyCard(it, fmt) {
        const { createElement, ui } = this.props.engine;
        const avail = this.state.histAvail;
        const id = avail ? avail[it.key] : null;
        const src = this._historySources(it, id);
        const title = this._historyTitle(it);
        const img = this._historyArt(it, id);
        const when = ['Watched ' + fmt(it.watchedAt), it.count > 1 ? it.count + ' times' : ''].filter(Boolean).join(' \u00b7 ');

        const thumb = createElement('div', { className: 'sx-hist-thumb' });
        const placeholder = () => createElement('div', { className: 'sx-hist-ph' }, String(title || '?').trim().charAt(0).toUpperCase());
        if (img) {
            const im = createElement('img', { src: img, alt: '' });
            im.decoding = 'async';
            im.addEventListener('error', () => { if (im.parentNode) im.parentNode.replaceChild(placeholder(), im); });
            thumb.appendChild(im);
        } else {
            thumb.appendChild(placeholder());
        }

        const sub = this._historySub(it);
        const el = createElement('div', { className: 'empty-state focusable sx-card sx-hist-card', onClick: () => this.setState({ histOpen: it }) },
            thumb,
            createElement('div', { className: 'sx-hist-body' },
                createElement('h3', {}, title),
                sub ? createElement('p', {}, sub) : null,
                createElement('p', {}, when),
                this._historyChips(it, src)));
        return ui._longPress(el, () => ui.toast(title + (sub ? ' \u00b7 ' + sub : '') + ' \u00b7 ' + when));
    }

    // ---- Episodes of one show share one card (movies and unparsed items stay single) ----
    _showKey(name) { return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

    _historyGroups(items) {
        const out = [], byShow = {};
        items.forEach(it => {
            const k = it.kind === 'episode' && it.showTitle ? this._showKey(it.showTitle) : '';
            if (!k) { out.push({ single: it }); return; }
            if (byShow[k]) { byShow[k].eps.push(it); return; }
            byShow[k] = { show: it.showTitle, k: k, eps: [it] };
            out.push(byShow[k]);                                   // the card sits where the show's newest item was
        });
        return out;
    }

    _historyShowCard(g, fmt) {
        const { createElement, ui } = this.props.engine;
        const avail = this.state.histAvail;
        const latest = g.eps.reduce((x, y) => ((y.watchedAt || 0) > (x.watchedAt || 0) ? y : x), g.eps[0]);
        // Where the show can be found = everything its episodes were seen through.
        const src = { here: false, libWas: false, plugs: [] };
        g.eps.forEach(ep => {
            const s = this._historySources(ep, avail ? avail[ep.key] : null);
            src.here = src.here || s.here;
            src.libWas = src.libWas || s.libWas;
            s.plugs.forEach(pg => { if (!src.plugs.some(x => x.id === pg.id)) src.plugs.push(pg); });
        });
        const P = this.state.posters || {};
        const img = P['s:' + g.show] || this._historyArt(latest, avail ? avail[latest.key] : null);
        const n = g.eps.length;
        const sub = n + (n === 1 ? ' episode' : ' episodes') + ' watched';
        const last = 'Last: Season ' + latest.season + ' \u00b7 Episode ' + latest.episode + ' \u00b7 ' + fmt(latest.watchedAt);

        const thumb = createElement('div', { className: 'sx-hist-thumb' });
        const placeholder = () => createElement('div', { className: 'sx-hist-ph' }, String(g.show || '?').trim().charAt(0).toUpperCase());
        if (img) {
            const im = createElement('img', { src: img, alt: '' });
            im.decoding = 'async';
            im.addEventListener('error', () => { if (im.parentNode) im.parentNode.replaceChild(placeholder(), im); });
            thumb.appendChild(im);
        } else {
            thumb.appendChild(placeholder());
        }
        const el = createElement('div', { className: 'empty-state focusable sx-card sx-hist-card', onClick: () => this._openHistoryShow(g.k) },
            thumb,
            createElement('div', { className: 'sx-hist-body' },
                createElement('h3', {}, g.show),
                createElement('p', {}, sub),
                createElement('p', {}, last),
                this._historyChips(latest, src)));
        return ui._longPress(el, () => ui.toast(g.show + ' \u00b7 ' + sub + ' \u00b7 ' + last));
    }

    // Opens a show's episode list and makes sure each of its episodes has its own picture (not only the newest 60 history items).
    _openHistoryShow(k) {
        this.setState({ histShow: k });
        const avail = this.state.histAvail;
        const jobs = [];
        (this.state.history || []).forEach(it => {
            if (it.kind !== 'episode' || !it.showTitle || this._showKey(it.showTitle) !== k || it.image) return;
            const id = avail && avail[it.key];
            jobs.push({ key: id ? 'e:' + id : 'he:' + it.key,
                url: '/api/episode-details?show=' + encodeURIComponent(it.showTitle) + '&season=' + (it.season | 0) + '&episode=' + (it.episode | 0) });
        });
        if (jobs.length) this._queuePosters(jobs);
    }

    // Tapping a show card: its watched episodes by season. Tapping one opens the usual "where to find it" popup on top.
    _renderHistoryShowModal() {
        const k = this.state.histShow;
        if (!k) return null;
        const eps = (this.state.history || []).filter(it => it.kind === 'episode' && it.showTitle && this._showKey(it.showTitle) === k);
        if (!eps.length) return null;
        const { createElement, ui } = this.props.engine;
        const fmt = (t) => { try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
        const bySeason = {};
        eps.forEach(ep => { const s = ep.season | 0; (bySeason[s] = bySeason[s] || []).push(ep); });
        const rows = [];
        Object.keys(bySeason).map(Number).sort((x, y) => x - y).forEach(sn => {
            rows.push(createElement('h2', { className: 'sub-heading' }, sn === 0 ? 'Specials' : 'Season ' + sn));
            const cards = bySeason[sn].sort((x, y) => (x.episode | 0) - (y.episode | 0)).map(ep => {
                const sub = ['Watched ' + fmt(ep.watchedAt), ep.count > 1 ? ep.count + ' times' : ''].filter(Boolean).join(' \u00b7 ');
                const id = this.state.histAvail ? this.state.histAvail[ep.key] : null;
                const P = this.state.posters || {};
                const still = ep.image || (id && P['e:' + id]) || P['he:' + ep.key] || '';
                const thumb = createElement('div', { className: 'sx-hist-thumb sx-hist-still' });
                const placeholder = () => createElement('div', { className: 'sx-hist-ph' }, 'E' + (ep.episode | 0));
                if (still) {
                    const im = createElement('img', { src: still, alt: '' });
                    im.decoding = 'async';
                    im.addEventListener('error', () => { if (im.parentNode) im.parentNode.replaceChild(placeholder(), im); });
                    thumb.appendChild(im);
                } else {
                    thumb.appendChild(placeholder());
                }
                const el = createElement('div', { className: 'empty-state focusable sx-card sx-hist-card', onClick: () => this.setState({ histOpen: ep }) },
                    thumb,
                    createElement('div', { className: 'sx-hist-body' },
                        createElement('h3', {}, 'Episode ' + ep.episode),
                        createElement('p', {}, sub)));
                return ui._longPress(el, () => ui.toast(eps[0].showTitle + ' \u00b7 Season ' + sn + ' \u00b7 Episode ' + ep.episode + ' \u00b7 ' + sub));
            });
            rows.push(ui.grid(cards, { minColWidth: '300px', className: 'sx-hist-grid' }));
        });
        const body = createElement('div', {},
            createElement('p', { className: 'sub' }, eps.length + (eps.length === 1 ? ' episode' : ' episodes') + ' watched'),
            ...rows);
        return ui.modal(eps[0].showTitle, body, () => this.setState({ histShow: null }));
    }

    _renderHistory() {
        const { createElement, ui } = this.props.engine;
        const items = (this.state.history || []).slice(0, 300);
        if (!items.length) return ui.card('No watch history yet', 'Things you finish watching will be listed here.');
        const fmt = (t) => { try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
        return createElement('div', {},
            ui.grid(this._historyGroups(items).map(g => g.single ? this._historyCard(g.single, fmt) : this._historyShowCard(g, fmt)),
                { minColWidth: '340px', className: 'sx-hist-grid' }),
            createElement('div', { className: 'section-actions' },
                ui.button(this.state.syncUi.confirmClear ? 'Tap again to clear all history' : 'Clear Watch History', () => this.clearWatchHistory()))
        );
    }

    // Tapping a card: a bigger picture and the way to get to it (library, plugin, or both).
    _renderHistoryModal() {
        const it = this.state.histOpen;
        if (!it) return null;
        const { createElement, ui } = this.props.engine;
        const avail = this.state.histAvail;
        const id = avail ? avail[it.key] : null;
        const src = this._historySources(it, id);
        const img = this._historyArt(it, id);
        const close = () => this.setState({ histOpen: null });
        const fmt = (t) => { try { return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; } };
        const sub = [this._historySub(it), 'Watched ' + fmt(it.watchedAt), it.count > 1 ? it.count + ' times' : ''].filter(Boolean).join(' \u00b7 ');

        const rows = [];
        if (src.here) {
            rows.push(createElement('p', { className: 'sub' }, 'This is in the library on this device.'));
            rows.push(createElement('div', { className: 'section-actions' },
                ui.button('Open in Your Library', () => this._openHistoryInLibrary(it), { variant: 'primary' })));
        } else if (src.libWas) {
            rows.push(createElement('p', { className: 'sub' }, 'You watched this from a library, but the file is not in a library on this device.'));
        }
        src.plugs.forEach(pg => {
            if (pg.plugin) {
                rows.push(createElement('p', { className: 'sub' }, 'You watched this with ' + pg.name + '.'));
                rows.push(createElement('div', { className: 'section-actions' },
                    ui.button('Open ' + pg.name, () => this._openHistoryPlugin(pg), { variant: src.here ? undefined : 'primary' })));
            } else {
                rows.push(createElement('p', { className: 'sub' }, 'You watched this with ' + pg.name + ', which is not installed on this device. Install it in Settings \u2192 Plugins to find it again.'));
            }
        });
        if (!rows.length) {
            rows.push(createElement('p', { className: 'sub' }, avail
                ? 'This is not in a library on this device and no source was saved for it.'
                : 'Checking your library\u2026'));
        }

        const body = createElement('div', {},
            sub ? createElement('p', { className: 'sub' }, sub) : null,
            img ? createElement('img', { className: 'detail-image sx-hist-modal-img', src: img, alt: '' }) : null,
            createElement('h2', { className: 'sub-heading' }, 'Where to find it'),
            ...rows);
        return ui.modal(this._historyTitle(it), body, close);
    }

    // Jumps to the item in the Movies / TV Shows tab and opens its page.
    _openHistoryInLibrary(it) {
        const m = this._libIndex && this._libIndex.items && this._libIndex.items[it.key];
        if (!m) return;
        this.setState({ histOpen: null, histShow: null, moreOpen: false });
        if (m.kind === 'movie') {
            this.setState({ activeTab: 'movies' });
            this.loadLibrary('movies');
            this.openMovieDetail({ id: m.id, title: m.title, year: m.year });
        } else {
            this.setState({ activeTab: 'shows', showNav: { show: m.showTitle, season: m.season } });
            this.loadLibrary('shows');
            this.loadShowInfo(m.showTitle);
            this.openEpisodeDetail(m.showTitle, { id: m.id, season: m.season, episode: m.episode });
        }
    }

    _openHistoryPlugin(pg) {
        if (!pg || !pg.plugin) return;
        this.setState({ histOpen: null, histShow: null });
        this.openPlugin(pg.plugin);
    }

    // ---------------- Plugin backup (see plugin_backup.js) ----------------

    togglePluginBackup() {
        const PB = window.HesperPluginBackup;
        if (!PB) return;
        PB.setEnabled(!PB.enabled());
        this._setSyncUi({ msg: PB.enabled() ? 'Plugin backup is on.' : 'Plugin backup is off. Nothing is uploaded or offered. What is already in your cloud stays there.' });
        if (PB.enabled()) this._autoSync(300);
    }

    // Downloads a plugin from the cloud backup and shows the normal install screen for it
    // (permissions, safety checks, confirm). Nothing is installed until the user confirms there.
    async restoreCloudPlugin(id) {
        const PB = window.HesperPluginBackup, I = window.HesperPluginInstaller;
        if (!PB || !I || this.state.pluginInstall || this.state.syncUi.busy) return;
        this._setSyncUi({ busy: true, msg: '' });
        try {
            const files = await PB.fetchForRestore(id);
            const prep = I.prepareFiles(id, files);
            const verdict = await I.check(prep);
            this._setSyncUi({ busy: false });
            this.setState({ pluginInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
        } catch (e) {
            const m = (e && e.error) ? this._syncMessage(e.error) : ('Could not restore this plugin: ' + String((e && e.message) || e).slice(0, 160));
            this._setSyncUi({ busy: false, msg: m });
        }
    }

    dismissCloudPlugin(id) {
        const PB = window.HesperPluginBackup;
        if (!PB) return;
        PB.dismiss(id);
        this._setSyncUi({});
    }

    async keepLocalPlugin(id) {
        const PB = window.HesperPluginBackup;
        if (!PB || this.state.syncUi.busy) return;
        this._setSyncUi({ busy: true, msg: '' });
        const r = await PB.keepLocal(id);
        this._setSyncUi({ busy: false, msg: r.ok ? 'Your version is now the one in the cloud.' : this._syncMessage(r.error) });
    }

    _renderPluginBackup(go, row) {
        const { createElement, ui } = this.props.engine;
        const PB = window.HesperPluginBackup;
        if (!PB) return [];
        const on = PB.enabled();
        const out = [ui.listRow('Back up my plugins',
            on ? 'On: plugins you installed from a .zip are saved to your account. Tap to turn off.' : 'Off. Tap to turn on.',
            () => this.togglePluginBackup(), { statusDot: on })];
        if (!on) return out;
        const here = {};
        (this.state.pluginsList || []).forEach(p => { here[p.folder] = true; });
        const items = PB.pending().filter(p => !(p.kind === 'new' && here[p.id]));
        if (items.length) {
            out.push(createElement('p', { className: 'sub' }, 'In your cloud backup. Nothing is installed until you confirm.'));
            items.forEach(p => {
                const label = p.name + (p.version ? ' ' + p.version : '');
                const sub = p.kind === 'new' ? 'Not installed on this device'
                    : p.kind === 'update' ? 'A newer version is in your backup'
                    : 'Different from the version on this device';
                out.push(ui.listRow(label, sub, null));
                out.push(row(
                    go(p.kind === 'new' ? 'Restore' : (p.kind === 'update' ? 'Update' : 'Use cloud version'), () => this.restoreCloudPlugin(p.id), true),
                    p.kind === 'conflict'
                        ? go('Keep mine', () => this.keepLocalPlugin(p.id))
                        : ui.button('Not now', () => this.dismissCloudPlugin(p.id))));
            });
        }
        return out;
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
                parts.push(createElement('p', { className: 'sub' }, 'Sign in to sync your watch history and resume points, and to get your plugins back.'));
                parts.push(email(), pass('Password', 'password'));
                parts.push(row(go('Sign In', () => this.signInAccount(), true), ui.button('Forgot Password?', () => this._openAuth('forgot')), ui.button('Cancel', () => this._openAuth(''))));
            } else if (u.mode === 'signup') {
                parts.push(createElement('p', { className: 'sub' }, 'Create an account with your email and a password. We will email you a code to confirm the address. You will use the same details on your other devices.'));
                parts.push(email(), pass('Password', 'password'), pass('Confirm password', 'confirm'));
                parts.push(row(go('Create Account', () => this.signUpAccount(), true), ui.button('Cancel', () => this._openAuth(''))));
            } else if (u.mode === 'verify') {
                parts.push(createElement('p', { className: 'sub' }, 'Enter the 6-digit code we emailed you.'));
                parts.push(email(), ui.textInput('6-digit code', f.code, (v) => { f.code = v; }, { placeholder: '123456' }));
                parts.push(row(go('Confirm Code', () => this.verifyAccountEmail(), true), go('Resend Code', () => this.resendVerifyCode()), ui.button('Back', () => this._openAuth('signin'))));
            } else if (u.mode === 'forgot') {
                parts.push(createElement('p', { className: 'sub' }, 'We will email you a 6-digit code to set a new password.'));
                parts.push(email());
                parts.push(row(go('Send Reset Code', () => this.sendResetCode(), true), ui.button('I Have a Code', () => this._openAuth('reset')), ui.button('Back', () => this._openAuth('signin'))));
            } else if (u.mode === 'reset') {
                parts.push(createElement('p', { className: 'sub' }, 'Enter the code from the email and choose a new password.'));
                parts.push(email(), ui.textInput('6-digit code', f.code, (v) => { f.code = v; }, { placeholder: '123456' }), pass('New password', 'password'), pass('Confirm new password', 'confirm'));
                parts.push(row(go('Set New Password', () => this.resetPasswordAccount(), true), ui.button('Send a New Code', () => this._openAuth('forgot')), ui.button('Back', () => this._openAuth('signin'))));
            } else {
                parts.push(createElement('p', { className: 'sub' }, 'Optional. One account for the household: each profile keeps its own watch history, resume points and favorites in step across your devices, and profiles you make show up on all of them. It also backs up the plugins you install. Nothing is uploaded until you sign in.'));
                parts.push(row(ui.button('Sign In', () => this._openAuth('signin'), { variant: 'primary' }), ui.button('Create Account', () => this._openAuth('signup'))));
            }
        } else {
            const last = S.lastSync();
            parts.push(ui.listRow('Signed in', S.getEmail(), null));
            { const hp = window.HesperProfiles, me = hp && hp.enabled ? hp.current() : null;
              if (me) parts.push(createElement('p', { className: 'sub' }, `Syncing the profile "${me.name}". Switch profile (Settings > Profiles) to sync another one.`)); }
            parts.push(ui.listRow(u.busy ? 'Syncing\u2026' : 'Sync is on',
                last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet', null, { statusDot: !u.busy && !!last }));
            parts.push(row(
                ui.button(u.busy ? 'Syncing\u2026' : 'Sync Now', () => { if (!u.busy) this._runSync({ manual: true }); }, { variant: 'primary' }),
                ui.button('Sign Out', () => { if (!u.busy) this.setState({ signOutAsk: true }); })));
            parts.push(...this._renderPluginBackup(go, row));
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
