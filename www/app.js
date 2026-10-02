// ============================================================
// Hesper App Shell
// ============================================================

window.HESPER_APP_BUILD = 'v14';

const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'movies', label: 'Movies' },
    { id: 'shows', label: 'TV Shows' },
    { id: 'music', label: 'Music' },
    { id: 'duplicates', label: 'Duplicates' },
    { id: 'unknown', label: 'Unknown' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'settings', label: 'Settings' }
];

// Library tabs -> backend endpoint (see server.cpp)
const LIBRARY_ENDPOINTS = {
    movies: '/api/movies',
    shows: '/api/shows',
    duplicates: '/api/duplicates',
    unknown: '/api/unknown'
};

// The Weather plugin (plugins/weather/ui.js) writes its formatted reading
// (e.g. "84°F") here and fires a window 'storage' event whenever it changes.
const WEATHER_TEMP_KEY = 'hesper_weather_current_temp';

function hesperFormatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// ---------------- Skins ----------------
// A skin is a folder in skins/<id>/ with skin.json (+ optional skin.css).
// The saved skin's CSS is injected immediately at load so the page never
// flashes the default look first.
const SKIN_KEY = 'hesper-skin';
const SKIN_ID_RE = /^[A-Za-z0-9_-]+$/;

function hesperSetSkinCss(id, bust) {
    const old = document.getElementById('hesper-skin-css');
    if (old) old.remove();
    if (!id || id === 'default' || !SKIN_ID_RE.test(id)) return;
    const link = document.createElement('link');
    link.id = 'hesper-skin-css';
    link.rel = 'stylesheet';
    link.href = `/skins/${id}/skin.css` + (bust ? `?t=${Date.now()}` : '');
    link.onerror = () => link.remove();   // a skin without a skin.css is fine
    document.head.appendChild(link);
}

try { hesperSetSkinCss(localStorage.getItem(SKIN_KEY)); } catch (e) { /* storage unavailable */ }

class ThemePanel extends HesperComponent {
    render() {
        const { engine, onClose } = this.props;
        const { createElement, ui } = engine;
        const presetNames = engine.theme.listPresets();
        const currentTokens = engine.theme.getAll();

        const presetCards = presetNames.map(name => {
            const tokens = engine.theme.presets[name];
            return createElement('div', {
                className: `preset-card focusable ${engine.theme.get('bg') === tokens.bg ? 'active-preset' : ''}`,
                onClick: () => {
                    engine.theme.applyPreset(name);
                    if (this.props.onRefresh) this.props.onRefresh();
                }
            },
                createElement('div', {
                    className: 'preset-preview-swatch',
                    style: { background: `linear-gradient(135deg, ${tokens.bg} 0%, ${tokens.surface} 50%, ${tokens.accent} 100%)` }
                }),
                createElement('div', { className: 'preset-name' }, name)
            );
        });

        const colorPickers = [
            { key: 'accent', label: 'Accent Color' },
            { key: 'bg', label: 'Background' },
            { key: 'surface', label: 'Surface' },
            { key: 'text', label: 'Text Color' }
        ].map(({ key, label }) => {
            return createElement('div', { className: 'theme-row' },
                createElement('label', {}, label),
                createElement('input', {
                    type: 'color',
                    value: currentTokens[key] || '#000000',
                    onInput: (e) => {
                        // No re-render here: rebuilding the <input> mid-drag would close the native color picker.
                        engine.theme.set(key, e.target.value);
                    }
                })
            );
        });

        const content = createElement('div', {},
            createElement('p', { className: 'sub' }, 'Select a visual theme or customize token colors:'),
            createElement('div', { className: 'preset-container' }, ...presetCards),
            createElement('div', { className: 'color-grid' }, ...colorPickers)
        );

        return ui.modal('Theme Settings', content, onClose);
    }
}

class MainApp extends HesperComponent {
    constructor(props) {
        super(props);
        this.state = {
            activeTab: 'dashboard',
            showThemePanel: false,
            pluginsList: [],
            sources: [],
            library: {},          // { movies: {...}, shows: {...}, unknown: {...} }
            picker: null,         // null = closed, else { path, parent, dirs, loading, error }
            showNav: { show: null, season: null },   // TV Shows drill-down: null/null = show folders, show only = seasons, both = episodes
            skins: [],            // [{ id, name, author, version, description, tokens }]
            activeSkin: (() => { try { return localStorage.getItem(SKIN_KEY) || 'default'; } catch (e) { return 'default'; } })(),
            refreshCooldown: 0,   // seconds left before another refresh is allowed
            refreshing: false,    // true while the server is rescanning
            detail: null,         // null = closed, else { title, subtitle, overview, image, loading, error }
            showInfo: {},         // showTitle -> { overview, poster } | { loading } | { error }
            posters: this._readPosters(),   // 'm:<id>' / 's:<title>' -> poster url ('' = none found)
            weatherText: this._readWeather()
        };
    }

    componentDidMount() {
        const { engine } = this.props;
        engine.plugins.discover().then(plugins => {
            this.setState({ pluginsList: plugins });
            this._warmWeatherPlugin(plugins);
        });
        this.loadSources();
        this.loadSkins();

        // Live-update the header badge when the weather plugin publishes a new reading.
        window.addEventListener('storage', () => {
            const text = this._readWeather();
            if (text !== this.state.weatherText) this.setState({ weatherText: text });
        });
    }

    // ---------------- Weather (driven by the Weather plugin) ----------------

    _readWeather() {
        try { return localStorage.getItem(WEATHER_TEMP_KEY) || '--°'; } catch (e) { return '--°'; }
    }

    _findWeatherPlugin(plugins) {
        return (plugins || this.state.pluginsList).find(p =>
            p.folder === 'weather' || /weather/i.test(p.app_name || '')
        );
    }

    // The plugin only publishes a reading once its render() has run, so run it
    // once in the background (detached node, never shown) at boot.
    _warmWeatherPlugin(plugins) {
        const p = this._findWeatherPlugin(plugins);
        if (!p || typeof p.render !== 'function') return;
        try { p.render(this.props.engine); } catch (err) {
            console.warn('[Hesper] Weather plugin failed to warm up:', err);
        }
    }

    // ---------------- Media sources / folder picker ----------------

    async loadSources() {
        try {
            const res = await fetch('/api/sources');
            const data = await res.json();
            this.setState({ sources: data.sources || [] });
        } catch (err) {
            console.warn('[Hesper] Could not load sources:', err);
        }
    }

    async openPicker(path) {
        const previous = this.state.picker || {};
        this.setState({ picker: { ...previous, loading: true, error: null } });
        try {
            const url = '/api/browse' + (path ? `?path=${encodeURIComponent(path)}` : '');
            const res = await fetch(url);
            const data = await res.json();
            if (!this.state.picker) return; // closed while loading
            this.setState({
                picker: {
                    loading: false,
                    error: null,
                    path: data.path,
                    parent: data.parent,
                    dirs: data.directories || []
                }
            });
        } catch (err) {
            if (!this.state.picker) return;
            this.setState({
                picker: { loading: false, error: 'Could not reach /api/browse', path: path || '', parent: '', dirs: [] }
            });
        }
    }

    closePicker() {
        this.setState({ picker: null });
    }

    async addSource(path) {
        try {
            const res = await fetch(`/api/sources?path=${encodeURIComponent(path)}`, { method: 'POST' });
            if (!res.ok) throw new Error('Server rejected folder');
            this.closePicker();
            await this.loadSources();
            // The scan runs in the background on the server; refresh the library shortly after.
            setTimeout(() => this.refreshLibrary(), 4000);
        } catch (err) {
            this.setState({ picker: { ...this.state.picker, error: 'Could not add that folder.' } });
        }
    }

    async removeSource(path) {
        try {
            await fetch(`/api/sources?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
        } catch (err) {
            console.warn('[Hesper] Could not remove source:', err);
        }
        await this.loadSources();
        this.refreshLibrary();
    }

    // Manual refresh: rate limited to once per 10 seconds (the server enforces
    // the same limit), then waits for the scan to finish and reloads the list.
    _startCooldown(seconds) {
        clearInterval(this._cooldownTimer);
        this.setState({ refreshCooldown: seconds });
        this._cooldownTimer = setInterval(() => {
            const left = this.state.refreshCooldown - 1;
            if (left <= 0) {
                clearInterval(this._cooldownTimer);
                this.setState({ refreshCooldown: 0 });
            } else {
                this.setState({ refreshCooldown: left });
            }
        }, 1000);
    }

    async rescan() {
        if (this.state.refreshCooldown > 0 || this.state.refreshing) return;
        this._startCooldown(10);
        this.setState({ refreshing: true });
        try {
            const res = await fetch('/api/rescan', { method: 'POST' });
            if (res.status === 429) {
                const d = await res.json().catch(() => ({}));
                this._startCooldown(d.retry_after || 10);
            } else {
                // Poll until the server says the scan is done (max ~60 s).
                for (let i = 0; i < 60; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const st = await fetch('/api/scan-status').then(r => r.json()).catch(() => ({ scanning: false }));
                    if (!st.scanning) break;
                }
            }
        } catch (err) {
            console.warn('[Hesper] Rescan failed:', err);
        }
        this.setState({ refreshing: false });
        this.refreshLibrary();
    }

    // ---------------- Skins ----------------

    async loadSkins() {
        const builtIn = { id: 'default', name: 'Hesper Default', author: 'Hesper', description: 'The standard look.' };
        let skins = [];
        try {
            const res = await fetch('/api/skins');
            const data = await res.json();
            const manifests = await Promise.all((data.skins || []).map(async ({ id }) => {
                if (!SKIN_ID_RE.test(id)) return null;
                try {
                    const m = await fetch(`/skins/${id}/skin.json`).then(r => r.json());
                    return { ...m, id, name: m.name || id };
                } catch (err) {
                    console.warn(`[Hesper] Skipping skin "${id}": bad skin.json`, err);
                    return null;
                }
            }));
            skins = manifests.filter(Boolean);
        } catch (err) {
            console.warn('[Hesper] Could not load skins:', err);
        }
        if (!skins.some(s => s.id === 'default')) skins.unshift(builtIn);
        this.setState({ skins });
    }

    // Choosing a skin sets its colours (tokens) and swaps its stylesheet.
    // The theme is reset first so one skin's colours never linger in the next.
    applySkin(id) {
        const skin = this.state.skins.find(s => s.id === id);
        if (!skin) return;
        const theme = this.props.engine.theme;
        try {
            theme.reset();
            if (skin.tokens && typeof skin.tokens === 'object') theme.setTokens(skin.tokens);
            hesperSetSkinCss(id, true);
            localStorage.setItem(SKIN_KEY, id);
        } catch (err) {
            console.warn('[Hesper] Could not apply skin, reverting to default:', err);
            theme.reset();
            hesperSetSkinCss('default');
            id = 'default';
            try { localStorage.setItem(SKIN_KEY, 'default'); } catch (e) { /* ignore */ }
        }
        this.setState({ activeSkin: id });
    }

    // ---------------- Library (Movies / Shows / Unknown) ----------------

    async loadLibrary(tab, force = false) {
        const endpoint = LIBRARY_ENDPOINTS[tab];
        if (!endpoint) return;
        if (!force && this.state.library[tab]) return;
        try {
            const res = await fetch(endpoint);
            const data = await res.json();
            this.setState({ library: { ...this.state.library, [tab]: data } });
            this._queuePostersFor(tab, data);
        } catch (err) {
            this.setState({ library: { ...this.state.library, [tab]: { error: true } } });
        }
    }

    refreshLibrary() {
        this.setState({ library: {} });
        this.loadLibrary(this.state.activeTab, true);
    }

    selectTab(id) {
        // Tapping "TV Shows" always returns to the top-level show folders.
        const showNav = id === 'shows' ? { show: null, season: null } : this.state.showNav;
        this.setState({ activeTab: id, showNav });
        this.loadLibrary(id);
    }

    // ---------------- Poster art for cards ----------------
    _readPosters() {
        try { return JSON.parse(localStorage.getItem('hesper_posters_v1') || '{}') || {}; }
        catch (e) { return {}; }
    }

    _queuePostersFor(tab, data) {
        if (tab === 'movies') {
            this._queuePosters((data.movies || []).map(m => ({
                key: 'm:' + m.id, url: '/api/movie-details?id=' + encodeURIComponent(m.id)
            })));
        } else if (tab === 'shows') {
            this._queuePosters((data.shows || []).map(s => ({
                key: 's:' + s.showTitle, url: '/api/show-details?title=' + encodeURIComponent(s.showTitle)
            })));
        }
    }

    // Fetches posters we don't have yet, 3 at a time, and publishes results in
    // batches so the grid is not rebuilt for every single image.
    _queuePosters(items) {
        if (!this._posterQueue) {
            this._posterQueue = []; this._posterActive = 0; this._posterPending = {}; this._posterSeen = {}; this._posterTimer = null;
        }
        items.forEach(it => {
            if (this.state.posters[it.key] !== undefined || this._posterSeen[it.key]) return;
            this._posterSeen[it.key] = true;
            this._posterQueue.push(it);
        });
        this._pumpPosters();
    }

    _pumpPosters() {
        while (this._posterActive < 3 && this._posterQueue.length) {
            const it = this._posterQueue.shift();
            this._posterActive++;
            this._fetchJson(it.url).then(d => d.poster || '', () => '').then(poster => {
                this._posterPending[it.key] = poster;
                this._posterActive--;
                if (!this._posterTimer) {
                    this._posterTimer = setTimeout(() => { this._posterTimer = null; this._flushPosters(); }, 600);
                }
                this._pumpPosters();
            });
        }
    }

    _flushPosters() {
        const pending = this._posterPending;
        this._posterPending = {};
        const keys = Object.keys(pending);
        if (!keys.length) return;
        const posters = { ...this.state.posters };
        keys.forEach(k => { posters[k] = pending[k]; });
        this.setState({ posters });
        try {
            const keep = {};
            Object.keys(posters).forEach(k => { if (posters[k]) keep[k] = posters[k]; });
            localStorage.setItem('hesper_posters_v1', JSON.stringify(keep));
        } catch (e) { /* storage unavailable: posters just reload next time */ }
    }

    // ---------------- Details (TMDb via the backend) ----------------

    closeDetail() { this.setState({ detail: null }); }

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
    playMedia(id, title) {
        const url = window.location.origin + '/api/stream/' + encodeURIComponent(id);
        try {
            if (window.HesperAndroid && typeof window.HesperAndroid.play === 'function') {
                window.HesperAndroid.play(url, title || '', this._themeForNative());
                return;
            }
        } catch (e) { console.warn('[Hesper] native play failed, falling back', e); }
        window.open(url, '_blank');
    }

    async _fetchJson(url) {
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
        return data;
    }

    async openMovieDetail(m) {
        const base = { playId: m.id, title: m.title, subtitle: m.year ? String(m.year) : '', overview: '', image: '', loading: true, error: '' };
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
        const base = { playId: ep.id, title: label, subtitle: `${showTitle} \u00b7 Season ${ep.season}`, overview: '', image: '', loading: true, error: '' };
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

    // Loads a show's bio once; the seasons screen shows it above the grid.
    async loadShowInfo(showTitle) {
        if (this.state.showInfo[showTitle]) return;
        this.setState({ showInfo: { ...this.state.showInfo, [showTitle]: { loading: true } } });
        try {
            const d = await this._fetchJson(`/api/show-details?title=${encodeURIComponent(showTitle)}`);
            this.setState({ showInfo: { ...this.state.showInfo, [showTitle]: { overview: d.overview || '', poster: d.poster || '' } } });
        } catch (err) {
            this.setState({ showInfo: { ...this.state.showInfo, [showTitle]: { error: true } } });
        }
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
            d.playId ? createElement('div', { style: { margin: '14px 0 6px' } }, ui.button('\u25b6  Play', () => this.playMedia(d.playId, d.title), { variant: 'primary' })) : null
        );
        return ui.modal(d.title, body, () => this.closeDetail());
    }

    // ---------------- TV Shows drill-down: show -> season -> episodes ----------------

    openShow(showTitle) {
        this.setState({ showNav: { show: showTitle, season: null } });
        this.loadShowInfo(showTitle);
    }

    openSeason(seasonNumber) {
        this.setState({ showNav: { show: this.state.showNav.show, season: seasonNumber } });
    }

    // One level up: episodes -> seasons -> show folders. Returns true if it moved.
    // One "Back" for the whole app, used by the keyboard, the remote and the
    // browser's own Back button. Returns true if it closed or stepped out of something.
    goBack() {
        const { engine } = this.props;
        if (engine.windows.activeWindow) { engine.windows.back(); return true; }
        if (this.state.detail) { this.closeDetail(); return true; }
        if (this.state.showThemePanel) { this.setState({ showThemePanel: false }); return true; }
        if (this.state.picker) { this.closePicker(); return true; }
        if (this.state.activeTab === 'shows') return this.showBack();
        return false;
    }

    showBack() {
        const { show, season } = this.state.showNav;
        if (season !== null) { this.setState({ showNav: { show, season: null } }); return true; }
        if (show !== null) { this.setState({ showNav: { show: null, season: null } }); return true; }
        return false;
    }

    _renderShowBio(showTitle) {
        const { createElement } = this.props.engine;
        const info = this.state.showInfo[showTitle];
        if (!info) return null;
        if (info.loading) return createElement('p', { className: 'sub' }, 'Loading synopsis\u2026');
        if (info.error || !info.overview) return null;
        return createElement('div', { style: { display: 'flex', gap: '12px', margin: '8px 0 16px' } },
            info.poster ? createElement('img', { src: info.poster, alt: '', style: { width: '90px', borderRadius: '8px', alignSelf: 'flex-start' } }) : null,
            createElement('p', { style: { margin: 0 } }, info.overview)
        );
    }

    // Glass "hero" card for a show: blurred poster backdrop, poster, title,
    // meta line and synopsis. Falls back to a plain heading until the bio loads.
    _renderShowHero(show, meta) {
        const { createElement } = this.props.engine;
        const info = this.state.showInfo[show.showTitle];
        const ready = info && !info.loading && !info.error && info.overview;
        if (!ready) {
            return createElement('div', {},
                createElement('h2', { className: 'sub-heading' }, show.showTitle),
                info && info.loading ? createElement('p', { className: 'sub' }, 'Loading synopsis\u2026') : null
            );
        }
        return createElement('div', { className: 'hero' },
            info.poster ? createElement('div', { className: 'hero-backdrop', style: { backgroundImage: 'url("' + info.poster + '")' } }) : null,
            createElement('div', { className: 'hero-glass' },
                info.poster ? createElement('img', { className: 'hero-poster', src: info.poster, alt: '' }) : null,
                createElement('div', { className: 'hero-text' },
                    createElement('h2', { className: 'hero-title' }, show.showTitle),
                    createElement('div', { className: 'hero-meta' }, meta),
                    createElement('div', { className: 'hero-rule' }),
                    createElement('p', { className: 'hero-overview' }, info.overview)
                )
            )
        );
    }

    _renderShows(data) {
        const { createElement, ui } = this.props.engine;
        const shows = data.shows || [];
        if (!shows.length) return this._renderEmptyLibrary('TV shows');

        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const { show: showTitle, season: seasonNumber } = this.state.showNav;
        const show = showTitle !== null ? shows.find(s => s.showTitle === showTitle) : null;

        // Level 1: one folder card per show.
        if (!show) {
            return ui.grid(
                shows.map(s => ui.posterCard(s.showTitle,
                    `${plural(s.seasons.length, 'season')} \u00b7 ${plural(s.episodeCount, 'episode')}`, this.state.posters['s:' + s.showTitle], () => this.openShow(s.showTitle))),
                { minColWidth: '200px', className: 'sx-poster-grid' }
            );
        }

        const season = seasonNumber !== null ? show.seasons.find(x => x.season === seasonNumber) : null;

        // Level 2: the seasons you have for this show.
        if (!season) {
            return createElement('div', {},
                createElement('div', { className: 'section-actions' },
                    ui.button('\u2190 All Shows', () => this.showBack())
                ),
                this._renderShowHero(show, `${plural(show.seasons.length, 'season')} \u00b7 ${plural(show.episodeCount, 'episode')}`),
                ui.grid(
                    show.seasons.map(se => ui.card(
                        `Season ${se.season}`,
                        plural(se.episodes.length, 'episode'),
                        () => this.openSeason(se.season)
                    )),
                    { minColWidth: '200px' }
                )
            );
        }

        // Level 3: the episodes you have in that season.
        return createElement('div', {},
            createElement('div', { className: 'section-actions' },
                ui.button(`\u2190 ${show.showTitle}`, () => this.showBack())
            ),
            createElement('h2', { className: 'sub-heading' }, `${show.showTitle} \u00b7 Season ${season.season}`),
            createElement('div', { className: 'plugin-list' },
                ...season.episodes.map(e => ui.listRow(`Episode ${e.episode}`, null, () => this.openEpisodeDetail(show.showTitle, e), { onLongPress: () => ui.toast(e.filename) }))
            )
        );
    }

    // ---------------- Plugins ----------------

    openPlugin(p) {
        const { engine } = this.props;
        const { createElement, ui } = engine;

        let node = null;
        try {
            node = typeof p.render === 'function' ? p.render(engine) : null;
        } catch (err) {
            console.error(`[Hesper] Plugin "${p.folder}" render() threw:`, err);
            node = ui.card('Plugin error', String((err && err.message) || err));
        }
        if (!node) {
            node = ui.card(
                p.app_name,
                'This plugin loaded, but its ui.js does not define window.render = (sx) => domNode, so there is no screen to show.'
            );
        }

        engine.windows.create(class extends HesperWindow {
            render() {
                return createElement('div', { className: 'plugin-window' },
                    createElement('div', { className: 'plugin-window-bar' },
                        ui.button('Back', () => engine.windows.back()),
                        createElement('h2', {}, p.app_name)
                    ),
                    createElement('div', { className: 'plugin-window-body' }, node)
                );
            }
        });
    }

    // ---------------- Rendering ----------------

    _renderHeader(title, showRefresh = false) {
        const { createElement } = this.props.engine;
        const weatherPlugin = this._findWeatherPlugin();
        const { refreshCooldown, refreshing } = this.state;

        let refreshBtn = null;
        if (showRefresh) {
            const blocked = refreshing || refreshCooldown > 0;
            const label = refreshing ? 'Scanning\u2026'
                : refreshCooldown > 0 ? `Refresh (${refreshCooldown}s)`
                : 'Refresh';
            const attrs = {
                className: 'theme-launch-btn refresh-btn focusable',
                title: 'Rescan your media folders for new files',
                onClick: () => this.rescan()
            };
            if (blocked) attrs.disabled = 'disabled';   // never pass disabled: false (it would still disable)
            refreshBtn = createElement('button', attrs,
                createElement('span', { className: `refresh-icon${refreshing ? ' spinning' : ''}` }, '\u21bb'),
                createElement('span', {}, label)
            );
        }

        return createElement('div', { className: 'content-header' },
            createElement('h1', { className: 'content-title' }, title),
            createElement('div', { className: 'header-actions' },
                refreshBtn,
                createElement('button', {
                    className: 'weather-badge focusable',
                    title: weatherPlugin ? 'Open Weather Widget' : 'Weather plugin not installed',
                    onClick: () => { if (weatherPlugin) this.openPlugin(weatherPlugin); }
                }, this.state.weatherText)
            )
        );
    }

    _renderEmptyLibrary(what) {
        const { createElement, ui } = this.props.engine;
        return createElement('div', {},
            ui.card(`No ${what} yet`, 'Add a media folder and Hesper will scan it and sort your videos here.'),
            createElement('div', { className: 'section-actions' },
                ui.button('Add Source Folder', () => this.openPicker(), { variant: 'primary' })
            )
        );
    }

    _renderDuplicates(data) {
        const { createElement, ui } = this.props.engine;
        const groups = data.groups || [];
        if (!groups.length) {
            return ui.card('No duplicates found', 'Every movie and episode in your library appears only once.');
        }
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const kindLabel = { movie: 'Same movie', episode: 'Same episode', size: 'Same size, different names' };

        return createElement('div', {},
            ui.card(
                `${plural(groups.length, 'duplicate group')} found`,
                `Keeping one copy of each would free up to ${hesperFormatBytes(data.wastedTotal)}. Hesper only lists duplicates; delete files from your file manager.`
            ),
            ...groups.map(g => createElement('div', { className: 'settings-section' },
                createElement('h2', {}, g.kind === 'size' ? `${g.label}: ${hesperFormatBytes(g.files[0].size)}` : g.label),
                createElement('p', { className: 'sub' }, `${kindLabel[g.kind] || 'Duplicate'} \u00b7 ${plural(g.files.length, 'copy')} \u00b7 up to ${hesperFormatBytes(g.wasted)} to free`),
                createElement('div', { className: 'plugin-list' },
                    ...g.files.map(f => ui.listRow(f.filename, `${hesperFormatBytes(f.size)} \u00b7 ${f.path}`))
                )
            ))
        );
    }

    _renderLibrary(tab) {
        const { createElement, ui } = this.props.engine;
        const data = this.state.library[tab];

        if (!data) return ui.card('Loading…', 'Fetching your library.');
        if (data.error) return ui.card('Could not load library', 'The backend did not respond. Is the server running?');

        if (tab === 'movies') {
            const movies = data.movies || [];
            if (!movies.length) return this._renderEmptyLibrary('movies');
            return ui.grid(
                movies.map(m => ui.posterCard(m.title, m.year ? String(m.year) : '', this.state.posters['m:' + m.id], () => this.openMovieDetail(m), { onLongPress: () => ui.toast(m.filename) })),
                { minColWidth: '200px', className: 'sx-poster-grid' }
            );
        }

        if (tab === 'shows') return this._renderShows(data);
        if (tab === 'duplicates') return this._renderDuplicates(data);

        // unknown
        const files = data.files || [];
        if (!files.length) {
            return ui.card('Nothing here', 'Every scanned file was classified as a movie or TV episode.');
        }
        return createElement('div', { className: 'plugin-list' },
            ...files.map(f => ui.listRow(f.filename, f.path))
        );
    }

    _renderPicker() {
        const { picker } = this.state;
        if (!picker) return null;
        const { createElement, ui } = this.props.engine;

        let body;
        if (picker.loading && !picker.path) {
            body = createElement('p', { className: 'sub' }, 'Loading folders…');
        } else {
            const rows = [];
            if (picker.parent && picker.parent !== picker.path) {
                rows.push(ui.listRow('.. (up one level)', picker.parent, () => this.openPicker(picker.parent)));
            }
            (picker.dirs || []).forEach(d => {
                rows.push(ui.listRow(d.name, null, () => this.openPicker(d.path)));
            });
            if (!(picker.dirs || []).length) {
                rows.push(createElement('p', { className: 'sub' }, 'No subfolders here.'));
            }

            body = createElement('div', {},
                createElement('p', { className: 'sub' }, 'Current folder:'),
                createElement('div', { className: 'browse-path' }, picker.path || ''),
                picker.error ? createElement('p', { className: 'browse-error' }, picker.error) : null,
                createElement('div', { className: 'browse-list plugin-list' }, ...rows),
                createElement('div', { className: 'section-actions' },
                    ui.button('Add this folder', () => this.addSource(picker.path), { variant: 'primary' })
                )
            );
        }

        return ui.modal('Choose a Media Folder', body, () => this.closePicker());
    }

    render() {
        const { engine } = this.props;
        const { createElement, ui } = engine;
        const { activeTab, showThemePanel, pluginsList, sources } = this.state;

        // Sidebar Navigation
        const navElements = NAV_ITEMS.map(item => {
            return createElement('button', {
                className: `nav-item focusable ${activeTab === item.id ? 'active' : ''}`,
                onClick: () => this.selectTab(item.id)
            }, item.label);
        });

        const currentLabel = NAV_ITEMS.find(i => i.id === activeTab)?.label || 'Hesper';

        // Tab View Content
        let mainContent;
        if (activeTab === 'settings') {
            const sourceRows = sources.length
                ? sources.map(path => ui.listRow(path, 'Tap to remove this source', () => this.removeSource(path)))
                : [createElement('p', { className: 'sub' }, 'No media folders added yet.')];

            mainContent = createElement('div', {},
                this._renderHeader('Settings'),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Media Sources'),
                    createElement('div', { className: 'plugin-list' }, ...sourceRows),
                    createElement('div', { className: 'section-actions' },
                        ui.button('Add Source Folder', () => this.openPicker(), { variant: 'primary' }),
                        ui.button(this.state.refreshing ? 'Scanning\u2026' : this.state.refreshCooldown > 0 ? `Rescan Library (${this.state.refreshCooldown}s)` : 'Rescan Library', () => this.rescan())
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Appearance & Themes'),
                    createElement('button', {
                        className: 'theme-launch-btn focusable',
                        onClick: () => this.setState({ showThemePanel: true })
                    }, 'Customize Colors')
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Skins'),
                    createElement('div', { className: 'plugin-list' },
                        ...this.state.skins.map(s => ui.listRow(
                            s.name,
                            [s.author ? `by ${s.author}` : '', s.description || ''].filter(Boolean).join(' \u00b7 ') || 'Tap to apply',
                            () => this.applySkin(s.id),
                            { statusDot: s.id === this.state.activeSkin }
                        ))
                    )
                )
            );
        } else if (activeTab === 'plugins') {
            const pluginRows = pluginsList.length > 0
                ? pluginsList.map(p => ui.listRow(p.app_name, p.folder, () => this.openPlugin(p), { statusDot: true }))
                : [ui.card('No Plugins Found', 'Add custom plugins to your plugins/ directory.')];

            mainContent = createElement('div', {},
                this._renderHeader('Plugins'),
                createElement('div', { className: 'plugin-list' }, ...pluginRows)
            );
        } else if (LIBRARY_ENDPOINTS[activeTab]) {
            mainContent = createElement('div', {},
                this._renderHeader(currentLabel, true),
                this._renderLibrary(activeTab)
            );
        } else {
            mainContent = createElement('div', {},
                this._renderHeader(currentLabel),
                ui.card(`Welcome to ${currentLabel}`, 'Select items or configure plugins to populate this section.')
            );
        }

        // Theme Modal Overlay
        const themeModal = showThemePanel ? new ThemePanel({
            engine,
            onClose: () => this.setState({ showThemePanel: false }),
            onRefresh: () => this.setState({})
        }).render() : null;

        return createElement('div', { className: 'hesper-shell' },
            createElement('div', { className: 'hesper-sidebar' },
                createElement('div', { className: 'sidebar-brand' }, 'Hesper'),
                createElement('div', { className: 'sidebar-nav' }, ...navElements),
                createElement('div', { className: 'sidebar-footer' },
                    createElement('span', { className: 'status-badge' }, 'System Online')
                )
            ),
            createElement('div', { className: 'hesper-content' }, mainContent),
            themeModal,
            this._renderDetailModal(),
            this._renderPicker()
        );
    }
}

// Bootstrapping
document.addEventListener('DOMContentLoaded', () => {
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        console.error('[Hesper] Missing #app element in index.html');
        return;
    }

    const engine = new HesperEngine(appRoot);
    const app = new MainApp({ engine });
    engine.mount(app);
    if (typeof app.componentDidMount === 'function') {
        app.componentDidMount();
    }

    // Diagnostic: open the app with ?keys=1 to see what the remote sends.
    if (/[?&]keys=1/.test(location.search)) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#000c;color:#0f0;padding:6px 10px;font:14px monospace;border-radius:6px;max-width:90vw';
        box.textContent = 'press a key\u2026';
        document.body.appendChild(box);
        window.addEventListener('keydown', (e) => { box.textContent = `key=${e.key} code=${e.code} keyCode=${e.keyCode}`; }, true);
        window.addEventListener('popstate', () => { box.textContent = 'popstate (browser Back)'; }, true);
    }

    // Back: Escape / Backspace / the remote's Back key (when the browser sends it
    // as a key), plus the browser's own history-back, which is what many TV
    // browsers do when the remote's Back button is pressed.
    const BACK_KEYS = ['Escape', 'GoBack', 'BrowserBack', 'XF86Back'];
    window.addEventListener('keydown', (e) => {
        const t = e.target;
        const typing = t && t.matches && t.matches('textarea, input:not([type=color]):not([type=checkbox]):not([type=button])');
        const isBack = BACK_KEYS.includes(e.key) || e.keyCode === 4 || (e.key === 'Backspace' && !typing);
        if (!isBack) return;
        if (typing && t.blur) t.blur();
        if (app.goBack()) e.preventDefault();
    });

    // History guard: the page keeps one extra history entry on top, so a browser
    // "Back" fires popstate instead of leaving. If the app has something to close
    // we close it and re-arm the guard; otherwise we let Back leave as normal.
    try {
        const marker = history.state && history.state.hesper;
        if (!marker) history.replaceState({ hesper: 'root' }, '');
        if (marker !== 'guard') history.pushState({ hesper: 'guard' }, '');
        window.addEventListener('popstate', () => {
            if (app.goBack()) history.pushState({ hesper: 'guard' }, '');
            else history.back();
        });
    } catch (err) {
        console.warn('[Hesper] History guard unavailable:', err);
    }
});
