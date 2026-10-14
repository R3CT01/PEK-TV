// ============================================================
// MainApp: Dashboard: a customizable home screen made of widgets
// Loaded after app.js. These methods are added to MainApp.prototype.
//
// Widgets: Clock, Weather, Continue Watching, Recently Added, Favorites,
// and a shortcut tile for any installed plugin. The list (order, size) is
// saved per profile under DASH_KEY.
// ============================================================

const DASH_KEY = 'hesper-dashboard';
const DASH_ROW_MAX = 12;     // posters shown in a row widget
const DASH_TYPES = {
    clock:     { label: 'Clock',             desc: 'Time and date',                   tile: true },
    weather:   { label: 'Weather',           desc: 'Conditions for your city',        tile: true },
    'continue':{ label: 'Continue Watching', desc: 'Pick up where you left off' },
    recent:    { label: 'Recently Added',    desc: 'Newest movies in your library' },
    favorites: { label: 'Favorites',         desc: 'Your saved movies and shows' },
    plugin:    { label: 'Plugin',            desc: 'A shortcut to a plugin',          tile: true }
};
const DASH_BUILTIN_ORDER = ['clock', 'weather', 'continue', 'recent', 'favorites'];

class MainAppDashboardMethods {

    // ---------------- Saved layout ----------------

    _dashDefault() {
        return [
            { id: 'clock', type: 'clock', size: 's' },
            { id: 'weather', type: 'weather', size: 's' },
            { id: 'continue', type: 'continue', size: 's' },
            { id: 'recent', type: 'recent', size: 's' },
            { id: 'favorites', type: 'favorites', size: 's' }
        ];
    }

    _readDash() {
        try {
            const raw = JSON.parse(localStorage.getItem(DASH_KEY) || 'null');
            if (Array.isArray(raw)) {
                const seen = {};
                const out = [];
                raw.forEach(w => {
                    if (!w || typeof w.type !== 'string' || !DASH_TYPES[w.type]) return;
                    const folder = w.type === 'plugin' ? String(w.folder || '') : '';
                    if (w.type === 'plugin' && !/^[A-Za-z0-9_-]+$/.test(folder)) return;
                    const id = w.type === 'plugin' ? 'plugin:' + folder : w.type;
                    if (seen[id]) return;
                    seen[id] = 1;
                    const e = { id, type: w.type, size: w.size === 'm' ? 'm' : 's' };
                    if (folder) e.folder = folder;
                    out.push(e);
                });
                return out;   // an empty list is the person's own choice
            }
        } catch (e) { /* unreadable: fall back to the default */ }
        return this._dashDefault();
    }

    _dashSave(list, extra) {
        try { localStorage.setItem(DASH_KEY, JSON.stringify(list)); }
        catch (e) { /* storage unavailable: the layout lasts until restart */ }
        try { document.dispatchEvent(new CustomEvent('pek-settings')); } catch (e) { /* no events */ }
        this.setState(Object.assign({ dash: list }, extra || {}));
    }

    _dashMove(id, dir) {
        const l = this.state.dash.slice();
        const i = l.findIndex(w => w.id === id), j = i + dir;
        if (i < 0 || j < 0 || j >= l.length) return;
        const t = l[i]; l[i] = l[j]; l[j] = t;
        this._dashSave(l);
    }

    _dashResize(id) {
        this._dashSave(this.state.dash.map(w => w.id === id ? Object.assign({}, w, { size: w.size === 'm' ? 's' : 'm' }) : w));
    }

    _dashRemove(id) {
        this._dashSave(this.state.dash.filter(w => w.id !== id));
    }

    _dashAdd(w) {
        const l = this.state.dash.concat([Object.assign({ size: 's' }, w)]);
        this._dashSave(l, { dashAdd: false });
        this._dashLoad(l);
    }

    _dashReset() {
        const l = this._dashDefault();
        this._dashSave(l, { dashAdd: false });
        this._dashLoad(l);
    }

    // Get the art and data the widgets on screen need.
    _dashLoad(list) {
        const l = list || this.state.dash;
        this._queueResumeArt();
        if (l.some(w => w.type === 'recent')) this.loadLibrary('movies');
    }

    // ---------------- Helpers ----------------

    _dashPlugin(w) {
        return (this.state.pluginsList || []).find(p => p.folder === w.folder) || null;
    }

    _dashMeta(w) {
        if (w.type === 'plugin') {
            const p = this._dashPlugin(w);
            return { label: p ? p.app_name : w.folder, desc: p ? 'Plugin shortcut' : 'Plugin not installed', tile: true };
        }
        return DASH_TYPES[w.type];
    }

    _dashWeatherInfo() {
        const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
        const parse = (k) => { try { return JSON.parse(get(k) || 'null'); } catch (e) { return null; } };
        const coords = parse('pek_weather_coords');
        const city = (coords && coords.label) || get('pek_weather_city') || '';
        const last = parse('pek_weather_last');
        return { city, condition: (last && last.city === city && last.condition) || '', temp: this.state.weatherText };
    }

    _dashTile(size, onClick, ...children) {
        const { createElement, ui } = this.props.engine;
        const el = createElement('div', {
            className: 'empty-state focusable sx-card dash-tile dash-span-' + size,
            onClick
        }, ...children);
        // Press and hold any tile to start customizing, like an Android home screen.
        return ui._longPress(el, () => this.setState({ dashEdit: true }));
    }

    _dashRow(title, cards) {
        const { createElement } = this.props.engine;
        return createElement('div', { className: 'dash-row' },
            createElement('h2', { className: 'dash-row-title' }, title),
            createElement('div', { className: 'dash-scroll' },
                ...cards.map(c => createElement('div', { className: 'dash-cell' }, c)))
        );
    }

    // ---------------- Widgets (normal view) ----------------

    _dashWidget(w) {
        const { createElement, ui } = this.props.engine;
        const size = w.size === 'm' ? 'm' : 's';

        if (w.type === 'clock') {
            const { time, dateLine } = this._clockLines(this.state.clock);
            return this._dashTile(size, () => this.setState({ showClockSettings: true }),
                createElement('div', { className: 'dash-clock' },
                    createElement('span', { className: 'clock-time dash-big' }, time),
                    dateLine ? createElement('span', { className: 'clock-date' }, dateLine) : null));
        }

        if (w.type === 'weather') {
            const info = this._dashWeatherInfo();
            const open = () => {
                const wp = this._findWeatherPlugin();
                if (wp) this.openPlugin(wp); else ui.toast('The Weather plugin is not installed');
            };
            if (!info.city) {
                return this._dashTile(size, open,
                    createElement('h3', { className: 'empty-heading' }, 'Weather'),
                    createElement('p', {}, 'Tap to choose your city'));
            }
            return this._dashTile(size, open,
                createElement('span', { className: 'dash-big' }, info.temp),
                createElement('span', { className: 'dash-sub' }, [info.condition, info.city].filter(Boolean).join(' \u00b7 ')));
        }

        if (w.type === 'plugin') {
            const p = this._dashPlugin(w);
            if (!p) return null;
            return this._dashTile(size, () => this.openPlugin(p),
                createElement('h3', { className: 'empty-heading' }, p.app_name),
                createElement('p', {}, 'Open plugin'));
        }

        if (w.type === 'continue') {
            const items = this._resumeItems().slice(0, DASH_ROW_MAX);
            if (!items.length) return null;
            const P = this.state.posters || {};
            return this._dashRow('Continue Watching', items.map(it => {
                const isMovie = it.kind === 'movie';
                const title = this._resumeTitle(it);
                const sub = [isMovie && it.year ? String(it.year) : '', this._fmtLeft(it)].filter(Boolean).join(' \u00b7 ');
                const img = it.torrent ? (it.image || '') : isMovie ? P['m:' + it.id] : (P['e:' + it.id] || P['s:' + it.showTitle]);
                return ui.posterCard(title, sub, img, () => this.resumeItem(it));
            }));
        }

        if (w.type === 'recent') {
            const lib = this.state.library.movies;
            if (!lib) {
                // The Movies list is not loaded yet (first visit, or after a rescan): fetch it once.
                if (!this._dashAsked) {
                    this._dashAsked = true;
                    setTimeout(() => { Promise.resolve(this.loadLibrary('movies')).then(() => { this._dashAsked = false; }); }, 0);
                }
                return null;
            }
            const movies = (lib.movies || []).slice().sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, DASH_ROW_MAX);
            if (!movies.length) return null;
            return this._dashRow('Recently Added', movies.map(m =>
                ui.posterCard(m.title, m.year ? String(m.year) : '', this.state.posters['m:' + m.id], () => this.openMovieDetail(m))));
        }

        if (w.type === 'favorites') {
            const favs = (window.PekFavorites ? window.PekFavorites.list() : []).slice(0, DASH_ROW_MAX);
            if (!favs.length) return null;
            return this._dashRow('Favorites', favs.map(f => ui.posterCard(
                f.title,
                [f.year || '', f.type === 'tv' ? 'TV' : 'Movie'].filter(Boolean).join(' \u00b7 '),
                window.PekFavorites.posterUrl(f),
                () => this.openFavorite(f))));
        }
        return null;
    }

    // ---------------- Widgets (customize view) ----------------

    _dashEditCard(w, i, n) {
        const { createElement } = this.props.engine;
        const meta = this._dashMeta(w);
        const btn = (label, fn) => createElement('button', { className: 'nav-item focusable dash-ctl', onClick: fn }, label);
        const ctls = [];
        if (i > 0) ctls.push(btn('\u25b2 Up', () => this._dashMove(w.id, -1)));
        if (i < n - 1) ctls.push(btn('\u25bc Down', () => this._dashMove(w.id, 1)));
        if (meta.tile) ctls.push(btn(w.size === 'm' ? 'Size: Wide' : 'Size: Small', () => this._dashResize(w.id)));
        ctls.push(btn('Remove', () => this._dashRemove(w.id)));
        return createElement('div', { className: 'empty-state sx-card dash-edit-card ' + (meta.tile ? 'dash-span-' + (w.size === 'm' ? 'm' : 's') : 'dash-span-all') },
            createElement('h3', { className: 'empty-heading' }, meta.label),
            createElement('p', {}, meta.desc),
            createElement('div', { className: 'dash-ctls' }, ...ctls));
    }

    // ---------------- Screen ----------------

    _renderDashboard() {
        const { createElement, ui } = this.props.engine;
        const edit = this.state.dashEdit;
        const list = this.state.dash;

        const actions = edit
            ? createElement('div', { className: 'section-actions' },
                ui.button('Done', () => this.setState({ dashEdit: false }), { variant: 'primary' }),
                ui.button('Add widget', () => this.setState({ dashAdd: true })))
            : createElement('div', { className: 'section-actions' },
                ui.button('Customize', () => this.setState({ dashEdit: true })));

        const nodes = edit
            ? list.map((w, i) => this._dashEditCard(w, i, list.length))
            : list.map(w => this._dashWidget(w)).filter(Boolean);

        let body;
        if (!nodes.length) {
            body = ui.card(list.length ? 'Nothing to show yet' : 'Your dashboard is empty',
                list.length ? 'Watch something or add favorites and they will appear here.' : 'Tap Customize, then Add widget.');
        } else {
            body = createElement('div', { className: 'dash-grid' + (edit ? ' editing' : '') }, ...nodes);
        }
        const hint = edit ? createElement('p', { className: 'sub' }, 'Move, resize or remove widgets, then tap Done. Press and hold a tile to customize any time.') : null;
        return createElement('div', {}, actions, hint, body);
    }

    _renderDashAdd() {
        if (!this.state.dashAdd) return null;
        const { createElement, ui } = this.props.engine;
        const have = {};
        this.state.dash.forEach(w => { have[w.id] = true; });
        const rows = [];
        DASH_BUILTIN_ORDER.filter(t => !have[t]).forEach(t =>
            rows.push(ui.listRow(DASH_TYPES[t].label, DASH_TYPES[t].desc, () => this._dashAdd({ id: t, type: t }))));
        (this.state.pluginsList || [])
            .filter(p => p.folder !== 'weather' && /^[A-Za-z0-9_-]+$/.test(p.folder) && !have['plugin:' + p.folder])
            .forEach(p => rows.push(ui.listRow(p.app_name, 'Plugin shortcut', () => this._dashAdd({ id: 'plugin:' + p.folder, type: 'plugin', folder: p.folder }))));
        if (!rows.length) rows.push(createElement('p', { className: 'sub' }, 'Everything is already on your dashboard.'));
        rows.push(ui.listRow('Reset to default layout', 'Clock, weather, continue watching, recently added, favorites', () => this._dashReset()));
        return ui.modal('Add a widget', createElement('div', { className: 'plugin-list' }, ...rows), () => this.setState({ dashAdd: false }));
    }
}

pekMixin(MainApp, MainAppDashboardMethods);
