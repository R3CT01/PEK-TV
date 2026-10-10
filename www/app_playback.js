// ============================================================
// MainApp: Playback and detail modals
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppPlaybackMethods {

    // ---------------- Details (TMDb via the backend) ----------------

    closeDetail() { this.setState({ detail: null }); }

    // The shared player (player.js) with a <video> backend: used where there is
    // no native player, such as the web/dev build.
    _openWebPlayer(url, title, backend, track, onCloseCb) {
        if (this._player) {
            if (this._player.mini) this._player.close();   // starting something new replaces the mini player
            else return;
        }
        this.setState({ detail: null });
        const player = new window.HesperPlayer({
            title: title || '',
            backend: backend || new window.HtmlVideoBackend(),
            skipMeta: track ? track.meta : null,
            next: this._nextProvider ? this._nextProvider(track) : null,   // lets the player offer Skip Intro / Skip Recap (library files and torrents)
            onProgress: track ? (pos, dur) => this._saveProgress(track.id, track.meta, pos, dur) : null,
            onClose: () => {
                if (typeof onCloseCb === 'function') { try { onCloseCb(); } catch (e) { /* ignore */ } }
                this._player = null;
                this._playingId = null;
                const prog = this._readProgress();
                const left = Object.keys(prog).some(k => prog[k] && prog[k].position >= RESUME_MIN_SEC);
                this.setState({ progress: prog, history: this._readHistory(), activeTab: (!left && this.state.activeTab === 'resume') ? 'dashboard' : this.state.activeTab });
                this._autoSync(1500);
                this._queueResumeArt();
            }
        });
        this._player = player;
        this._playingId = track ? track.id : null;
        player.open(url, (track && track.startSec) || 0);
    }

    // Reads the active theme's colors (so skins work) and returns them as JSON
    // with #AARRGGBB values for the native player's dialogs.
    _themeForNative() {
        const names = {
            bg: '--sx-bg-elevated', surface: '--sx-surface', border: '--sx-border',
            accent: '--sx-accent', text: '--sx-text', muted: '--sx-text-muted',
            glow: '--sx-accent-glow'
        };
        const out = {};
        try {
            const probe = document.createElement('span');
            probe.style.display = 'none';
            document.body.appendChild(probe);
            const hex = n => ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
            Object.keys(names).forEach(k => {
                probe.style.color = '';
                probe.style.color = 'var(' + names[k] + ')';
                const m = getComputedStyle(probe).color.match(/[\d.]+/g);   // r g b [a]
                if (!m || m.length < 3) return;
                const a = m.length > 3 ? parseFloat(m[3]) * 255 : 255;
                out[k] = '#' + hex(a) + hex(parseFloat(m[0])) + hex(parseFloat(m[1])) + hex(parseFloat(m[2]));
            });
            document.body.removeChild(probe);
            const r = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sx-radius'), 10);
            if (r) out.radius = r;
        } catch (e) { /* native side falls back to the default colors */ }
        return JSON.stringify(out);
    }

    // Hands a library file to the native player on Android (HesperAndroid is
    // injected by the app). Elsewhere it just opens the stream URL.
    // meta describes what is playing (for Resume Watching); startSec > 0 resumes.
    async playMedia(id, title, meta, startSec) {
        const url = window.location.origin + '/api/stream/' + encodeURIComponent(id);
        const { ui } = this.props.engine;
        startSec = startSec > 0 ? startSec : 0;

        // Already playing this exact file in the mini player: just bring it back up.
        if (this._player && this._player.mini && this._playingId === id) {
            this.setState({ detail: null });
            this._player.expand();
            return;
        }

        // Make sure the file is still there before opening the player.
        let missing = false;
        try {
            const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
            missing = probe.status === 404;
        } catch (e) { /* server unreachable: let the player report it */ }
        if (missing) {
            ui.toast("Can't play file");
            this.setState({ detail: null });
            this._removeProgress(id);
            return;
        }

        const track = meta ? { id: id, meta: meta, startSec: startSec } : null;

        // Android with libmpv: the shared controls (player.js) drive a native mpv surface.
        if (window.MpvBackend && window.MpvBackend.available() && window.HesperPlayer) {
            this._openWebPlayer(url, title, new window.MpvBackend({ title: title || '', theme: this._themeForNative() }), track);
            return;
        }
        try {
            if (window.HesperAndroid && typeof window.HesperAndroid.play === 'function') {
                window.HesperAndroid.play(url, title || '', this._themeForNative());
                return;
            }
        } catch (e) { console.warn('[Hesper] native play failed, falling back', e); }
        if (window.HesperPlayer && window.HtmlVideoBackend) { this._openWebPlayer(url, title, null, track); return; }
        window.open(url, '_blank');
    }

    // Plays any stream URL that is not a library file (torrent streams). There is no library id,
    // so no library resume position is kept (a torrent can pass `track` to keep its own). onClose runs when the player is closed (the caller cleans up).
    // track (optional) = { id, meta, startSec }: keeps the position for Resume Watching and starts at startSec.
    playStream(url, title, onClose, track) {
        if (window.MpvBackend && window.MpvBackend.available() && window.HesperPlayer) {
            this._openWebPlayer(url, title, new window.MpvBackend({ title: title || '', theme: this._themeForNative() }), track || null, onClose);
            return;
        }
        try {
            if (window.HesperAndroid && typeof window.HesperAndroid.play === 'function') {
                window.HesperAndroid.play(url, title || '', this._themeForNative());
                return;
            }
        } catch (e) { console.warn('[Hesper] native play failed, falling back', e); }
        if (window.HesperPlayer && window.HtmlVideoBackend) { this._openWebPlayer(url, title, null, track || null, onClose); return; }
        window.open(url, '_blank');
    }

    async _fetchJson(url) {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        return data;
    }

    async openMovieDetail(m) {
        const base = { playId: m.id, meta: { kind: 'movie', title: m.title, year: m.year || 0 }, title: m.title, subtitle: m.year ? String(m.year) : '', overview: '', image: '', loading: true, error: '' };
        this.setState({ detail: base });
        try {
            const d = await this._fetchJson(`/api/movie-details?id=${encodeURIComponent(m.id)}`);
            if (!this.state.detail || this.state.detail.title !== m.title) return;
            this.setState({ detail: { ...base, overview: d.overview || '', image: d.poster || '', loading: false } });
        } catch (err) {
            if (!this.state.detail || this.state.detail.title !== m.title) return;
            this.setState({ detail: { ...base, loading: false, error: 'Could not load details.' } });
        }
    }

    async openEpisodeDetail(showTitle, ep) {
        const label = `Episode ${ep.episode}`;
        const base = { playId: ep.id, meta: { kind: 'episode', showTitle: showTitle, season: ep.season, episode: ep.episode }, title: label, subtitle: `${showTitle} \u00b7 Season ${ep.season}`, overview: '', image: '', loading: true, error: '' };
        this.setState({ detail: base });
        try {
            const q = `show=${encodeURIComponent(showTitle)}&season=${ep.season}&episode=${ep.episode}`;
            const d = await this._fetchJson(`/api/episode-details?${q}`);
            if (!this.state.detail || this.state.detail.subtitle !== base.subtitle) return;
            this.setState({ detail: { ...base, title: d.name ? `${label}: ${d.name}` : label, overview: d.overview || '', image: d.still || '', loading: false } });
        } catch (err) {
            if (!this.state.detail || this.state.detail.subtitle !== base.subtitle) return;
            this.setState({ detail: { ...base, loading: false, error: 'Could not load details.' } });
        }
    }

    // Play, or Resume + Start over when there is a saved position for this file.
    _renderPlayButtons(d) {
        const { createElement, ui } = this.props.engine;
        const saved = this._resumeFor(d.playId);
        if (!saved) {
            return createElement('div', { style: { margin: '14px 0 6px' } },
                ui.button('\u25b6  Play', () => this.playMedia(d.playId, d.title, d.meta, 0), { variant: 'primary' }));
        }
        const at = window.HesperPlayerUtil ? window.HesperPlayerUtil.fmtTime(saved.position) : Math.round(saved.position) + 's';
        return createElement('div', { className: 'section-actions', style: { margin: '14px 0 6px' } },
            ui.button('\u25b6  Resume from ' + at, () => this.playMedia(d.playId, d.title, d.meta, saved.position), { variant: 'primary' }),
            ui.button('Start over', () => this.playMedia(d.playId, d.title, d.meta, 0)));
    }

    _renderDetailModal() {
        const d = this.state.detail;
        if (!d) return null;
        const { createElement, ui } = this.props.engine;
        let text;
        if (d.loading) text = 'Loading\u2026';
        else if (d.error) text = d.error;
        else text = d.overview || 'No synopsis available.';
        const body = createElement('div', {},
            d.subtitle ? createElement('p', { className: 'sub' }, d.subtitle) : null,
            d.image ? createElement('img', { className: 'detail-image', src: d.image, alt: '' }) : null,
            createElement('div', { className: 'glass-panel' }, createElement('p', {}, text)),
            d.playId ? this._renderPlayButtons(d) : null
        );
        return ui.modal(d.title, body, () => this.closeDetail());
    }
}

hesperMixin(MainApp, MainAppPlaybackMethods);
