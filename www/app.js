// ============================================================
// Hesper App Shell
// ============================================================

window.HESPER_APP_BUILD = 'v16';

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

// "Resume Watching" is added after Dashboard only once something has been watched.
const RESUME_NAV_ITEM = { id: 'resume', label: 'Resume Watching' };
const HISTORY_NAV_ITEM = { id: 'history', label: 'Watch History' };   // shown once something has been finished
const PROGRESS_KEY = 'hesper_progress_v1';
const RESUME_MIN_SEC = 30;        // watched less than this: nothing to resume
const RESUME_DONE_RATIO = 0.95;   // watched this much: counts as finished

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

// Built-in header clock: saved choices and the time zones offered in its settings.
const CLOCK_12H_KEY  = 'hesper_clock_12h';
const CLOCK_DATE_KEY = 'hesper_clock_show_date';
const CLOCK_TZ_KEY   = 'hesper_clock_tz';     // '' = this device's own zone
const CLOCK_ZONES = [
    { id: 'UTC', label: 'UTC' },
    { id: 'Pacific/Honolulu', label: 'Honolulu' },
    { id: 'America/Anchorage', label: 'Anchorage' },
    { id: 'America/Los_Angeles', label: 'Los Angeles' },
    { id: 'America/Phoenix', label: 'Phoenix' },
    { id: 'America/Denver', label: 'Denver' },
    { id: 'America/Chicago', label: 'Chicago' },
    { id: 'America/Mexico_City', label: 'Mexico City' },
    { id: 'America/New_York', label: 'New York' },
    { id: 'America/Toronto', label: 'Toronto' },
    { id: 'America/Sao_Paulo', label: 'S\u00e3o Paulo' },
    { id: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires' },
    { id: 'Atlantic/Reykjavik', label: 'Reykjav\u00edk' },
    { id: 'Europe/London', label: 'London' },
    { id: 'Europe/Paris', label: 'Paris' },
    { id: 'Europe/Berlin', label: 'Berlin' },
    { id: 'Europe/Madrid', label: 'Madrid' },
    { id: 'Europe/Rome', label: 'Rome' },
    { id: 'Europe/Athens', label: 'Athens' },
    { id: 'Europe/Istanbul', label: 'Istanbul' },
    { id: 'Europe/Moscow', label: 'Moscow' },
    { id: 'Africa/Lagos', label: 'Lagos' },
    { id: 'Africa/Cairo', label: 'Cairo' },
    { id: 'Africa/Nairobi', label: 'Nairobi' },
    { id: 'Africa/Johannesburg', label: 'Johannesburg' },
    { id: 'Asia/Dubai', label: 'Dubai' },
    { id: 'Asia/Karachi', label: 'Karachi' },
    { id: 'Asia/Kolkata', label: 'Mumbai / Delhi' },
    { id: 'Asia/Dhaka', label: 'Dhaka' },
    { id: 'Asia/Bangkok', label: 'Bangkok' },
    { id: 'Asia/Singapore', label: 'Singapore' },
    { id: 'Asia/Hong_Kong', label: 'Hong Kong' },
    { id: 'Asia/Shanghai', label: 'Beijing / Shanghai' },
    { id: 'Asia/Seoul', label: 'Seoul' },
    { id: 'Asia/Tokyo', label: 'Tokyo' },
    { id: 'Australia/Perth', label: 'Perth' },
    { id: 'Australia/Sydney', label: 'Sydney' },
    { id: 'Pacific/Auckland', label: 'Auckland' }
];

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
            netPicker: null,      // network folders: null = closed, else { stage: hosts|login|share|browse, ... }
            showNav: { show: null, season: null },   // TV Shows drill-down: null/null = show folders, show only = seasons, both = episodes
            skins: [],            // [{ id, name, author, version, description, tokens }]
            activeSkin: (() => { try { return localStorage.getItem(SKIN_KEY) || 'default'; } catch (e) { return 'default'; } })(),
            refreshCooldown: 0,   // seconds left before another refresh is allowed
            refreshing: false,    // true while the server is rescanning
            busy: '',             // text for the full-screen loading ring ('' = hidden)
            detail: null,         // null = closed, else { title, subtitle, overview, image, loading, error }
            showInfo: {},         // showTitle -> { overview, poster } | { loading } | { error }
            posters: this._readPosters(),   // 'm:<id>' / 's:<title>' -> poster url ('' = none found)
            clock: this._readClock(),        // { hour12, showDate, tz }
            showClockSettings: false,
            weatherText: this._readWeather(),
            progress: this._readProgress(),  // id -> { id, kind, title, showTitle, season, episode, year, position, duration, updated }
            history: this._readHistory(),    // finished items, newest first (see sync.js)
            histAvail: null,                 // item key -> local file id, null until checked
            syncUi: { busy: false, linking: false, showKey: false, confirmDelete: false, confirmClear: false, msg: '' }
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
        this._startClockTicker();
        this._watchNetwork();
        this._queueResumeArt();
        this._startAutoSync();

        // Live-update the header badge when the weather plugin publishes a new reading.
        window.addEventListener('storage', () => {
            const text = this._readWeather();
            if (text !== this.state.weatherText) this.setState({ weatherText: text });
        });
    }

    // ---------------- Online / offline ----------------
    // net.js draws the green/red dot and reports changes. Offline mode: the local
    // library keeps working, internet-only things wait until the network is back.
    _watchNetwork() {
        const net = window.HesperNet;
        if (!net) return;
        const { ui } = this.props.engine;
        net.onChange((online) => {
            ui.toast(online ? 'Back online' : 'Offline mode: your local library only');
            if (online) {
                this._autoSync();
                // fetch the poster art that was skipped while offline
                ['movies', 'shows'].forEach(t => {
                    const d = this.state.library[t];
                    if (d && !d.error) this._queuePostersFor(t, d);
                });
            }
        });
    }

    // ---------------- Clock (built-in header widget) ----------------
    _deviceUses12h() {
        try { return new Intl.DateTimeFormat().resolvedOptions().hour12 !== false; }
        catch (e) { return true; }
    }

    _readClock() {
        const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
        const h = get(CLOCK_12H_KEY), d = get(CLOCK_DATE_KEY), z = get(CLOCK_TZ_KEY);
        return {
            hour12: h === null ? this._deviceUses12h() : h === '1',
            showDate: d === null ? true : d === '1',
            tz: z || ''
        };
    }

    _saveClock(patch) {
        const clock = { ...this.state.clock, ...patch };
        try {
            localStorage.setItem(CLOCK_12H_KEY, clock.hour12 ? '1' : '0');
            localStorage.setItem(CLOCK_DATE_KEY, clock.showDate ? '1' : '0');
            localStorage.setItem(CLOCK_TZ_KEY, clock.tz || '');
        } catch (e) { /* storage unavailable: the choice lasts until restart */ }
        // The whole UI repaints on setState; keep the settings list where it was.
        const panel = document.querySelector('.theme-panel');
        const top = panel ? panel.scrollTop : 0;
        this.setState({ clock });
        const again = document.querySelector('.theme-panel');
        if (again) again.scrollTop = top;
    }

    _clockZoneLabel(tz) {
        if (!tz) return '';
        const z = CLOCK_ZONES.find(x => x.id === tz);
        return z ? z.label : tz;
    }

    // { time, day } for a moment, in the chosen format and zone.
    _formatClock(date, clock) {
        try {
            const t = { hour: clock.hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: clock.hour12 };
            const d = { weekday: 'short', month: 'short', day: 'numeric' };
            if (clock.tz) { t.timeZone = clock.tz; d.timeZone = clock.tz; }
            // en-GB gives a steady 00-23 clock for the 24-hour option.
            let time = new Intl.DateTimeFormat(clock.hour12 ? undefined : 'en-GB', t).format(date);
            time = time.replace(/^24/, '00');
            return { time, day: new Intl.DateTimeFormat(undefined, d).format(date) };
        } catch (e) {
            return { time: date.toLocaleTimeString(), day: date.toDateString() };
        }
    }

    // The two lines shown in the header badge.
    _clockLines(clock) {
        const { time, day } = this._formatClock(new Date(), clock);
        const zone = this._clockZoneLabel(clock.tz);
        const dateLine = clock.showDate ? (zone ? day + ' \u00b7 ' + zone : day) : zone;
        return { time, dateLine };
    }

    _renderClockBadge() {
        const { createElement } = this.props.engine;
        const { time, dateLine } = this._clockLines(this.state.clock);
        return createElement('button', {
            className: 'clock-badge focusable',
            title: 'Clock settings',
            onClick: () => this.setState({ showClockSettings: true })
        },
            createElement('span', { className: 'clock-time' }, time),
            dateLine ? createElement('span', { className: 'clock-date' }, dateLine) : null
        );
    }

    // Updates the badge text in place once a second, so the app is not
    // repainted (and focus is not disturbed) every tick.
    _startClockTicker() {
        if (this._clockTimer) return;
        this._clockTimer = setInterval(() => {
            const badges = document.querySelectorAll('.clock-badge');
            if (!badges.length) return;
            const { time, dateLine } = this._clockLines(this.state.clock);
            badges.forEach(b => {
                const t = b.querySelector('.clock-time');
                if (t && t.textContent !== time) t.textContent = time;
                const d = b.querySelector('.clock-date');
                if (d && d.textContent !== dateLine) d.textContent = dateLine;
            });
        }, 1000);
    }

    _renderClockSettings() {
        if (!this.state.showClockSettings) return null;
        const { createElement, ui } = this.props.engine;
        const { clock } = this.state;
        const now = new Date();

        const zones = [{ id: '', label: 'This device' }].concat(CLOCK_ZONES).map(z => {
            const f = this._formatClock(now, { ...clock, tz: z.id });
            const selected = (clock.tz || '') === z.id;
            return ui.listRow((selected ? '\u2713  ' : '') + z.label, f.time + ' \u00b7 ' + f.day,
                () => this._saveClock({ tz: z.id }));
        });

        const body = createElement('div', {},
            ui.toggle('24-hour time', !clock.hour12, (on) => this._saveClock({ hour12: !on })),
            ui.toggle('Show date', clock.showDate, (on) => this._saveClock({ showDate: on })),
            createElement('p', { className: 'sub', style: { margin: '1.2rem 0 0.5rem' } }, 'Time zone'),
            createElement('div', {}, ...zones)
        );
        return ui.modal('Clock', body, () => this.setState({ showClockSettings: false }));
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

    async _addSourceImpl(path) {
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

    // ---------------- Network folders (SMB, NFS, FTP, WebDAV and DLNA found on the local network) ----------------

    // Wi-Fi drops multicast packets unless Android is told to let them through
    // (the app holds a MulticastLock only while searching).
    _multicast(on) {
        try {
            if (window.HesperAndroid && typeof window.HesperAndroid.setMulticast === 'function') window.HesperAndroid.setMulticast(!!on);
        } catch (e) { /* the port scan still finds hosts without it */ }
    }

    async openNetPicker() {
        this._netUser = ''; this._netPass = ''; this._netManual = ''; this._netShare = ''; this._netTried = false;
        this._netHosts = []; this._netUnsupported = [];
        this._netSig = '';
        this.setState({ netPicker: { stage: 'hosts', scanning: true, hosts: [], unsupported: [], error: null } });
        await this._startDiscovery();
    }

    async _startDiscovery() {
        this._multicast(true);
        try { await fetch('/api/discover', { method: 'POST' }); } catch (e) { /* polled below anyway */ }
        this._pollDiscovery(0);
    }

    async searchNetwork() {
        const np = this.state.netPicker;
        if (!np || np.scanning) return;
        this._netSig = '';
        this.setState({ netPicker: { ...np, stage: 'hosts', scanning: true, error: null } });
        await this._startDiscovery();
    }

    async _pollDiscovery(n) {
        try {
            const res = await fetch('/api/discover');
            const data = await res.json();
            const np = this.state.netPicker;
            if (!np) { this._multicast(false); return; }
            this._netHosts = data.hosts || [];
            this._netUnsupported = data.unsupported || [];
            // Re-render only when something visible changed: every re-render replays
            // the window's fade-in, which showed up as the window blinking once a second.
            const sig = JSON.stringify([this._netHosts, !!data.scanning, this._netUnsupported]);
            if (sig !== this._netSig) {
                this._netSig = sig;
                if (np.stage === 'hosts') {
                    this.setState({ netPicker: { ...np, hosts: this._netHosts, scanning: !!data.scanning, unsupported: this._netUnsupported } });
                }
            }
            if (data.scanning && n < 20) { setTimeout(() => this._pollDiscovery(n + 1), 1000); return; }
        } catch (e) { /* stop searching */ }
        this._multicast(false);
        const np = this.state.netPicker;
        if (np && np.stage === 'hosts' && np.scanning) this.setState({ netPicker: { ...np, scanning: false } });
    }

    closeNetPicker() {
        this._multicast(false);
        this.setState({ netPicker: null });
    }

    // What the user typed in "Or type an address": a full URL (ftp://nas, dav://nas:8080/files,
    // nfs://nas ...) is used as is; a bare name or IP means an SMB share.
    _netTypedUrl(text) {
        const t = String(text || '').trim();
        if (!t) return '';
        return /^[a-z]+:\/\//i.test(t) ? t : 'smb://' + t;
    }

    _netOpenTyped() {
        this._netUser = ''; this._netPass = ''; this._netTried = false;
        const url = this._netTypedUrl(this._netManual);
        if (!url) {
            this.setState({ netPicker: { ...this.state.netPicker, error: 'Enter the address of the device first.' } });
            return;
        }
        return this.netBrowse(url, false);
    }

    _netOpenHost(host) {
        this._netUser = ''; this._netPass = ''; this._netTried = false;
        return this.netBrowse(host.url, false);
    }

    // Shows the shares of a host or the folders inside a location (url = smb://..., ftp://..., etc.).
    async netBrowse(url, withCreds) {
        this.setState({ netPicker: { ...this.state.netPicker, loading: true, error: null } });
        const body = new URLSearchParams({ url });
        if (withCreds) { body.set('user', this._netUser || ''); body.set('pass', this._netPass || ''); }
        try {
            const res = await fetch('/api/net/browse', { method: 'POST', body });
            const data = await res.json();
            if (!this.state.netPicker) return;
            if (!data.ok) {
                if (data.auth) {
                    this.setState({ netPicker: { stage: 'login', url, loading: false,
                        error: this._netTried ? 'Wrong user name or password.' : null } });
                } else if (data.canTypeShare) {
                    this.setState({ netPicker: { stage: 'share', url, loading: false, error: data.error } });
                } else {
                    this.setState({ netPicker: { ...this.state.netPicker, loading: false, error: data.error || 'Could not open that location.' } });
                }
                return;
            }
            this.setState({ netPicker: {
                stage: 'browse', loading: false, error: null, scheme: data.scheme,
                path: data.path, parent: data.parent, addable: !!data.addable, shares: data.shares || [], dirs: data.directories || []
            } });
        } catch (err) {
            if (!this.state.netPicker) return;
            this.setState({ netPicker: { ...this.state.netPicker, loading: false, error: 'Could not reach the Hesper server.' } });
        }
    }

    netSignIn() {
        const np = this.state.netPicker;
        this._netTried = true;
        return this.netBrowse(np.url, true);
    }

    // The window goes back to the device list: re-render it with what was found.
    _netToHosts() {
        this.setState({ netPicker: { stage: 'hosts', scanning: false, hosts: this._netHosts || [], unsupported: this._netUnsupported || [], error: null } });
    }

    // Back inside the network picker: up a folder, then back to the device list, then close.
    netBack() {
        const np = this.state.netPicker;
        if (!np) return;
        if (np.stage === 'browse' && np.parent) { this.netBrowse(np.parent, false); return; }
        if (np.stage !== 'hosts') { this._netToHosts(); return; }
        this.closeNetPicker();
    }

    async _addNetSourceImpl(url) {
        const body = new URLSearchParams({ path: url });
        if (this._netUser) { body.set('user', this._netUser); body.set('pass', this._netPass || ''); }
        try {
            const res = await fetch('/api/sources', { method: 'POST', body });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                this.setState({ netPicker: { ...this.state.netPicker, error: data.message || 'Could not add that folder.' } });
                return;
            }
            this.closeNetPicker();
            await this.loadSources();
            // The first scan of a network folder takes longer than a local one.
            setTimeout(() => this.refreshLibrary(), 4000);
            setTimeout(() => this.refreshLibrary(), 15000);
        } catch (err) {
            this.setState({ netPicker: { ...this.state.netPicker, error: 'Could not reach the Hesper server.' } });
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

    // ---------------- Loading ring ----------------
    _ring(big) {
        return this.props.engine.createElement('div', { className: 'hs-ring' + (big ? ' lg' : '') });
    }

    _loadingBlock(text) {
        const { createElement } = this.props.engine;
        return createElement('div', { className: 'hs-loading' }, this._ring(false), createElement('span', { className: 'sub' }, text));
    }

    _setBusy(msg) { this.setState({ busy: msg || '' }); }

    // Waits for the server's background scan to finish (checks once a second).
    async _waitForScan(maxSec) {
        for (let i = 0; i < maxSec; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const st = await fetch('/api/scan-status').then(r => r.json()).catch(() => ({ scanning: false }));
            if (!st.scanning) break;
        }
    }

    _renderBusy() {
        const { createElement } = this.props.engine;
        const np = this.state.netPicker;
        const text = this.state.busy
            || (this.state.refreshing ? 'Scanning your library\u2026' : '')
            || (np && np.loading ? 'Connecting\u2026' : '');
        if (!text) return null;
        return createElement('div', { className: 'hs-busy' }, this._ring(true), createElement('div', {}, text));
    }

    async addSource(path) {
        this._setBusy('Adding folder\u2026');
        try {
            await this._addSourceImpl(path);
            this._setBusy('Scanning your library\u2026');
            await this._waitForScan(60);
            this.refreshLibrary();
        } finally { this._setBusy(''); }
    }

    async addNetSource(url) {
        this._setBusy('Adding network folder\u2026');
        try {
            await this._addNetSourceImpl(url);
            this._setBusy('Scanning your library\u2026');
            await this._waitForScan(120);
            this.refreshLibrary();
        } finally { this._setBusy(''); }
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
        if (id === 'resume') this._queueResumeArt();
        if (id === 'history') this._refreshHistoryAvailability();
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
        if (window.HesperNet && !window.HesperNet.isOnline()) return;   // offline: poster art waits for the network
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
            this._fetchJson(it.url).then(d => d.poster || d.still || '', () => '').then(poster => {
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

    _navItems() {
        const items = NAV_ITEMS.slice();
        let at = 1;
        if (this._resumeItems().length) { items.splice(at, 0, RESUME_NAV_ITEM); at++; }
        if ((this.state.history || []).length) items.splice(at, 0, HISTORY_NAV_ITEM);
        return items;
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
            no_account: 'No account found for that key.',
            bad_key: 'That key is not valid.',
            too_large: 'Too much data to sync at once.',
            not_linked: 'Not linked yet.'
        })[err] || 'Hesper Cloud is having trouble. Try again later.';
    }

    // opts: { create, manual }. Updates the screen when something changed.
    async _runSync(opts) {
        const S = window.HesperSync;
        if (!S || !S.isLinked() || this._syncing) return { ok: false, error: 'busy' };
        opts = opts || {};
        this._syncing = true;
        if (opts.manual) this._setSyncUi({ busy: true, msg: '' });
        let res;
        try {
            res = await S.sync({ create: !!opts.create, resolve: (m) => this._resolveLocalId(m) });
        } catch (e) { res = { ok: false, error: 'offline' }; }
        this._syncing = false;
        const refresh = res.ok && res.changed && !this._player;
        const patch = {};
        if (opts.manual) { patch.busy = false; patch.msg = res.ok ? '' : this._syncMessage(res.error); }
        if (refresh || opts.manual) {
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
            if (this.state.syncUi.linking || this._player) return;   // don't rebuild the screen under a text box or a video
            this._runSync({});
        }, delayMs || 0);
    }

    _startAutoSync() {
        this._autoSync(2500);
        if (!this._syncTimer) this._syncTimer = setInterval(() => this._autoSync(0), 10 * 60 * 1000);
    }

    async createSyncAccount() {
        const S = window.HesperSync;
        if (!S) return;
        S.setKey(S.newKey());
        this._setSyncUi({ busy: true, showKey: true, linking: false, msg: 'Save this key somewhere safe: it is the only way to sign in on another device.' });
        const res = await this._runSync({ create: true, manual: true });
        if (!res.ok && res.error !== 'busy') { S.unlink(); this._setSyncUi({ busy: false, showKey: false, msg: this._syncMessage(res.error) }); }
        else this._setSyncUi({ msg: 'Save this key somewhere safe: it is the only way to sign in on another device.' });
    }

    async linkSyncAccount() {
        const S = window.HesperSync;
        const typed = this._syncKeyInput || '';
        if (!S) return;
        if (!S.validKey(typed)) { this._setSyncUi({ msg: 'That key looks too short. It has 25 letters and numbers.' }); return; }
        S.setKey(typed);
        this._syncKeyInput = '';
        this._setSyncUi({ linking: false, busy: true, msg: '' });
        const res = await this._runSync({ manual: true });
        if (!res.ok && res.error !== 'busy') { S.unlink(); this._setSyncUi({ busy: false, msg: this._syncMessage(res.error) }); }
        else this.props.engine.ui.toast('Linked. Your history is syncing.');
    }

    unlinkSyncDevice() {
        window.HesperSync.unlink();
        this._setSyncUi({ showKey: false, confirmDelete: false, msg: 'This device is no longer synced. Your local history is kept.' });
    }

    async deleteCloudData() {
        if (!this.state.syncUi.confirmDelete) { this._setSyncUi({ confirmDelete: true }); return; }
        this._setSyncUi({ busy: true });
        const res = await window.HesperSync.deleteAccount();
        this._setSyncUi({ busy: false, confirmDelete: false, showKey: false, msg: res.ok ? 'Your cloud account and its data were deleted.' : this._syncMessage(res.error) });
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
        const parts = [createElement('h2', {}, 'Cloud Sync')];
        if (!S) {
            parts.push(createElement('p', { className: 'sub' }, 'Sync is not available in this build.'));
        } else if (!S.isLinked()) {
            parts.push(createElement('p', { className: 'sub' }, 'Optional. Keeps your watch history and resume points in step across your devices. Nothing is uploaded until you turn it on.'));
            parts.push(createElement('div', { className: 'section-actions' },
                ui.button(u.busy ? 'Working\u2026' : 'Create Sync Account', () => { if (!u.busy) this.createSyncAccount(); }, { variant: 'primary' }),
                ui.button(u.linking ? 'Cancel' : 'Link Existing Account', () => this._setSyncUi({ linking: !u.linking, msg: '' }))));
            if (u.linking) {
                parts.push(ui.textInput('Sync key', this._syncKeyInput || '', (v) => { this._syncKeyInput = v; }, { placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' }));
                parts.push(createElement('div', { className: 'section-actions' }, ui.button('Link This Device', () => this.linkSyncAccount(), { variant: 'primary' })));
            }
        } else {
            const last = S.lastSync();
            parts.push(ui.listRow(u.busy ? 'Syncing\u2026' : 'Sync is on',
                last ? 'Last synced ' + new Date(last).toLocaleString() : 'Not synced yet', null, { statusDot: !u.busy && !!last }));
            if (u.showKey) parts.push(ui.listRow('Your sync key', S.getKey(), null));
            parts.push(createElement('div', { className: 'section-actions' },
                ui.button(u.busy ? 'Syncing\u2026' : 'Sync Now', () => { if (!u.busy) this._runSync({ manual: true }); }, { variant: 'primary' }),
                ui.button(u.showKey ? 'Hide Sync Key' : 'Show Sync Key', () => this._setSyncUi({ showKey: !u.showKey }))));
            parts.push(createElement('div', { className: 'section-actions' },
                ui.button('Unlink This Device', () => this.unlinkSyncDevice()),
                ui.button(u.confirmDelete ? 'Tap again to delete cloud data' : 'Delete Cloud Data', () => this.deleteCloudData())));
        }
        if (u.msg) parts.push(createElement('p', { className: 'sub' }, u.msg));
        return createElement('div', { className: 'settings-section' }, ...parts);
    }

    // Art for the Resume Watching cards: movie posters, episode stills (show poster as backup).
    _queueResumeArt() {
        const items = this._resumeItems();
        const jobs = [];
        items.forEach(it => {
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
                const title = isMovie ? it.title : `${it.showTitle} \u00b7 S${it.season}E${it.episode}`;
                const sub = [isMovie && it.year ? String(it.year) : '', this._fmtLeft(it)].filter(Boolean).join(' \u00b7 ');
                const img = isMovie
                    ? this.state.posters['m:' + it.id]
                    : (this.state.posters['e:' + it.id] || this.state.posters['s:' + it.showTitle]);
                return ui.posterCard(title, sub, img, () => this.resumeItem(it), { onLongPress: () => ui.toast(title + (sub ? ' \u00b7 ' + sub : '')) });
            }),
            { minColWidth: '200px', className: 'sx-poster-grid' }
        );
    }

    resumeItem(it) {
        const isMovie = it.kind === 'movie';
        const title = isMovie ? it.title : `${it.showTitle} \u00b7 S${it.season}E${it.episode}`;
        this.playMedia(it.id, title, it, it.position);
    }

    // ---------------- Details (TMDb via the backend) ----------------

    closeDetail() { this.setState({ detail: null }); }

    // The shared player (player.js) with a <video> backend: used where there is
    // no native player, such as the web/dev build.
    _openWebPlayer(url, title, backend, track) {
        if (this._player) return;
        this.setState({ detail: null });
        const player = new window.HesperPlayer({
            title: title || '',
            backend: backend || new window.HtmlVideoBackend(),
            onProgress: track ? (pos, dur) => this._saveProgress(track.id, track.meta, pos, dur) : null,
            onClose: () => {
                this._player = null;
                const prog = this._readProgress();
                const left = Object.keys(prog).some(k => prog[k] && prog[k].position >= RESUME_MIN_SEC);
                this.setState({ progress: prog, history: this._readHistory(), activeTab: (!left && this.state.activeTab === 'resume') ? 'dashboard' : this.state.activeTab });
                this._autoSync(1500);
                this._queueResumeArt();
            }
        });
        this._player = player;
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
        if (this._player) { this._player.onBack(); return true; }
        if (engine.windows.activeWindow) { engine.windows.back(); return true; }
        if (this.state.detail) { this.closeDetail(); return true; }
        if (this.state.showThemePanel) { this.setState({ showThemePanel: false }); return true; }
        if (this.state.showClockSettings) { this.setState({ showClockSettings: false }); return true; }
        if (this.state.netPicker) { this.netBack(); return true; }
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
                this._renderClockBadge(),
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
                ui.button('Add Source Folder', () => this.openPicker(), { variant: 'primary' }),
                ui.button('Add Network Folder', () => this.openNetPicker())
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

        if (!data) return this._loadingBlock('Loading your library\u2026');
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
            body = this._loadingBlock('Loading folders\u2026');
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

    _renderNetPicker() {
        const np = this.state.netPicker;
        if (!np) return null;
        const { createElement, ui } = this.props.engine;
        const err = np.error ? createElement('p', { className: 'browse-error' }, np.error) : null;
        let body;

        if (np.stage === 'hosts') {
            const hosts = np.hosts || [];
            const rows = hosts.map(h => ui.listRow(h.name, `${h.label}${h.name === h.address ? '' : ' \u00b7 ' + h.address}`, () => this._netOpenHost(h)));
            if (!hosts.length) {
                rows.push(createElement('p', { className: 'sub' }, np.scanning
                    ? 'Searching your network\u2026'
                    : 'Nothing found. Check that this device and the share are on the same Wi-Fi, or type the address below.'));
            } else if (np.scanning) {
                rows.push(createElement('p', { className: 'sub' }, 'Still searching\u2026'));
            }
            const missing = (np.unsupported || []).map(x => x.toUpperCase());
            body = createElement('div', {},
                missing.length
                    ? createElement('p', { className: 'browse-error' }, `This build can find ${missing.join(' / ')} devices but cannot open them (no ${missing.join(' / ')} support).`)
                    : null,
                createElement('p', { className: 'sub' }, 'Devices sharing files on your network:'),
                createElement('div', { className: 'browse-list plugin-list' }, ...rows),
                err,
                ui.textInput('Or type an address', this._netManual || '', (v) => { this._netManual = v; }, { placeholder: 'my-nas   or   ftp://192.168.1.20   or   dav://nas:8080' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Open', () => this._netOpenTyped(), { variant: 'primary' }),
                    ui.button(np.scanning ? 'Searching\u2026' : 'Search again', () => this.searchNetwork())
                )
            );
        } else if (np.stage === 'login') {
            body = createElement('div', {},
                createElement('p', { className: 'sub' }, `Sign in to ${np.url}`),
                err,
                ui.textInput('User name', this._netUser || '', (v) => { this._netUser = v; }, { placeholder: 'user or DOMAIN\\user' }),
                ui.textInput('Password', this._netPass || '', (v) => { this._netPass = v; }, { type: 'password' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Sign in', () => this.netSignIn(), { variant: 'primary' }),
                    ui.button('Back', () => this.netBack())
                )
            );
        } else if (np.stage === 'share') {
            const base = String(np.url || '').replace(/\/+$/, '');
            body = createElement('div', {},
                createElement('p', { className: 'sub' }, `Could not list the shares on ${base}. Type the share name instead.`),
                np.error ? createElement('p', { className: 'browse-error' }, np.error) : null,
                ui.textInput('Share name', this._netShare || '', (v) => { this._netShare = v; }, { placeholder: 'Media' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Open', () => {
                        const name = (this._netShare || '').trim().replace(/^\/+/, '');
                        // NFS exports are paths (/srv/media); the server expects them percent-encoded.
                        const seg = base.startsWith('nfs://') ? encodeURIComponent(name.startsWith('/') ? name : '/' + name) : name;
                        if (name) this.netBrowse(base + '/' + seg, false);
                    }, { variant: 'primary' }),
                    ui.button('Back', () => this.netBack())
                )
            );
        } else {
            const rows = [];
            rows.push(ui.listRow(np.parent ? '.. (up one level)' : '.. (back to devices)', np.parent || null, () => this.netBack()));
            (np.shares || []).forEach(sh => rows.push(ui.listRow(sh.name, 'Share', () => this.netBrowse(sh.path, false))));
            (np.dirs || []).forEach(d => rows.push(ui.listRow(d.name, null, () => this.netBrowse(d.path, false))));
            if (!(np.shares || []).length && !(np.dirs || []).length) {
                rows.push(createElement('p', { className: 'sub' }, np.addable ? 'No subfolders here.' : 'No shares found on this device.'));
            }
            body = createElement('div', {},
                createElement('p', { className: 'sub' }, np.addable ? 'Current folder:' : 'Choose a share:'),
                createElement('div', { className: 'browse-path' }, np.path || ''),
                err,
                createElement('div', { className: 'browse-list plugin-list' }, ...rows),
                np.addable
                    ? createElement('div', { className: 'section-actions' },
                        ui.button('Add this folder', () => this.addNetSource(np.path), { variant: 'primary' }))
                    : null
            );
        }
        return ui.modal('Add Network Folder', body, () => this.closeNetPicker());
    }

    render() {
        const { engine } = this.props;
        const { createElement, ui } = engine;
        const { activeTab, showThemePanel, pluginsList, sources } = this.state;

        // Sidebar Navigation
        const navItems = this._navItems();
        const navElements = navItems.map(item => {
            return createElement('button', {
                className: `nav-item focusable ${activeTab === item.id ? 'active' : ''}`,
                onClick: () => this.selectTab(item.id)
            }, item.label);
        });

        const currentLabel = navItems.find(i => i.id === activeTab)?.label || 'Hesper';

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
                        ui.button('Add Network Folder', () => this.openNetPicker()),
                        ui.button(this.state.refreshing ? 'Scanning\u2026' : this.state.refreshCooldown > 0 ? `Rescan Library (${this.state.refreshCooldown}s)` : 'Rescan Library', () => this.rescan())
                    )
                ),
                this._renderSyncSettings(),
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
        } else if (activeTab === 'history') {
            mainContent = createElement('div', {},
                this._renderHeader('Watch History'),
                this._renderHistory()
            );
        } else if (activeTab === 'resume') {
            mainContent = createElement('div', {},
                this._renderHeader('Resume Watching'),
                this._renderResume()
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
            this._renderClockSettings(),
            this._renderPicker(),
            this._renderNetPicker(),
            this._renderBusy()
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
