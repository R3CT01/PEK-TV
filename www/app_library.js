// ============================================================
// MainApp: Library: loading libraries, posters, shows/seasons, library tab rendering, plugins tab
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppLibraryMethods {

    // ---------------- Library (Movies / Shows / Unknown) ----------------

    async loadLibrary(tab, force = false) {
        const endpoint = LIBRARY_ENDPOINTS[tab];
        if (!endpoint) return;
        if (!force && this.state.library[tab]) return;
        window.HesperActivity.begin('lib:' + tab, 'Loading your library\u2026');
        try {
            const res = await fetch(endpoint);
            const data = await res.json();
            this.setState({ library: { ...this.state.library, [tab]: data } });
            this._queuePostersFor(tab, data);
        } catch (err) {
            this.setState({ library: { ...this.state.library, [tab]: { error: true } } });
        }
        window.HesperActivity.end('lib:' + tab);
    }

    refreshLibrary() {
        this.setState({ library: {} });
        this.loadLibrary(this.state.activeTab, true);
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
        const act = window.HesperActivity;
        const left = this._posterQueue.length + this._posterActive;
        if (left) act.update('posters', 'Fetching poster art (' + left + ' left)');
        else act.end('posters', 'Poster art up to date');
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
        // A repaint would close the keyboard under the search box: hold the new posters back until it is closed.
        if (this.state.searchOpen) {
            if (!this._posterTimer) this._posterTimer = setTimeout(() => { this._posterTimer = null; this._flushPosters(); }, 1500);
            return;
        }
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

    // ---------------- TV Shows drill-down: show -> season -> episodes ----------------

    openShow(showTitle) {
        this.setState({ showNav: { show: showTitle, season: null } });
        this.loadShowInfo(showTitle);
    }

    openSeason(seasonNumber) {
        this.setState({ showNav: { show: this.state.showNav.show, season: seasonNumber } });
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
            if (this.state.viewMode === 'list') {
                return createElement('div', { className: 'plugin-list' },
                    ...shows.map(s => ui.listRow(s.showTitle,
                        `${plural(s.seasons.length, 'season')} \u00b7 ${plural(s.episodeCount, 'episode')}`, () => this.openShow(s.showTitle))));
            }
            return ui.grid(
                shows.map(s => ui.posterCard(s.showTitle,
                    `${plural(s.seasons.length, 'season')} \u00b7 ${plural(s.episodeCount, 'episode')}`, this.state.posters['s:' + s.showTitle], () => this.openShow(s.showTitle))),
                { minColWidth: '200px', className: 'sx-poster-grid' }
            );
        }

        const season = seasonNumber !== null ? show.seasons.find(x => x.season === seasonNumber) : null;

        // Level 2: the seasons you have for this show.
        if (!season) {
            const isW = this._watchedLookup();
            const epW = (e) => isW({ kind: 'episode', showTitle: show.showTitle, season: e.season, episode: e.episode });
            const seenIn = (se) => se.episodes.filter(epW).length;
            const allSeen = show.seasons.length > 0 && show.seasons.every(se => se.episodes.length > 0 && seenIn(se) === se.episodes.length);
            return createElement('div', {},
                createElement('div', { className: 'section-actions' },
                    ui.button('\u2190 All Shows', () => this.showBack()),
                    ui.button(allSeen ? 'Mark show as unwatched' : 'Mark show as watched', () => this._setSeasonWatched(show, show.seasons, !allSeen))
                ),
                this._renderShowHero(show, `${plural(show.seasons.length, 'season')} \u00b7 ${plural(show.episodeCount, 'episode')}`),
                ui.grid(
                    show.seasons.map(se => ui.card(
                        `Season ${se.season}`,
                        plural(se.episodes.length, 'episode') + (seenIn(se) ? ` \u00b7 ${seenIn(se)} watched` : ''),
                        () => this.openSeason(se.season)
                    )),
                    { minColWidth: '200px' }
                )
            );
        }

        // Level 3: the episodes you have in that season.
        const isW = this._watchedLookup();
        const epW = (e) => isW({ kind: 'episode', showTitle: show.showTitle, season: e.season, episode: e.episode });
        const allSeen = season.episodes.length > 0 && season.episodes.every(epW);
        return createElement('div', {},
            createElement('div', { className: 'section-actions' },
                ui.button(`\u2190 ${show.showTitle}`, () => this.showBack()),
                ui.button(allSeen ? 'Mark season as unwatched' : 'Mark season as watched', () => this._setSeasonWatched(show, [season], !allSeen))
            ),
            createElement('h2', { className: 'sub-heading' }, `${show.showTitle} \u00b7 Season ${season.season}`),
            createElement('div', { className: 'plugin-list' },
                ...season.episodes.map(e => ui.listRow(`Episode ${e.episode}`, epW(e) ? '\u2713 Watched' : null, () => this.openEpisodeDetail(show.showTitle, e), { onLongPress: () => ui.toast(e.filename) }))
            )
        );
    }

    // ---------------- Plugins ----------------

    // Back inside a sandboxed plugin (close a detail page, previous page of results ...).
    // True when the plugin handled it, so the plugin window itself stays open.
    _pluginBack() {
        // The plugin window that is on top (a plugin can open another one, e.g. "Play with Snake Skin").
        const win = this.props.engine.windows.activeWindow;
        const sb = win && win._sandbox;
        return !!(sb && sb.handleBack && sb.handleBack());
    }

    openPlugin(p) {
        const { engine } = this.props;
        const { createElement, ui } = engine;
        const app = this;

        let node = null;
        if (p.sandboxed) {
            node = p.sandbox.mount(engine);      // runs in the sandboxed frame; see plugin_sandbox.js
        } else try {
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

        const win = engine.windows.create(class extends HesperWindow {
            render() {
                return createElement('div', { className: 'plugin-window' },
                    createElement('div', { className: 'plugin-window-bar' },
                        ui.button('Back', () => { if (!app._pluginBack()) engine.windows.back(); }),
                        createElement('h2', {}, p.app_name)
                    ),
                    createElement('div', { className: 'plugin-window-body' }, node)
                );
            }
        });
        win._sandbox = p.sandboxed ? p.sandbox : null;   // what Back asks first while this window is on top
    }


    // ---------------- Search your library ----------------
    // One box that looks through movies, shows and episodes on this device. The results are drawn straight into
    // their own box (not through setState) so typing never repaints the screen and the keyboard stays open.

    openSearch() {
        this._searchQ = '';
        this._searchCache = null;
        this._searchSeq = 0;
        this._searchFocusPending = true;
        this.setState({ searchOpen: true, moreOpen: false });
    }

    closeSearch() {
        clearTimeout(this._searchT);
        this._searchBox = null;
        this.setState({ searchOpen: false });
    }

    async _searchData() {
        const c = this._searchCache;
        if (c && Date.now() - c.t < 120000) return c;
        try {
            const [mv, sh] = await Promise.all([
                fetch('/api/movies').then(r => r.json()),
                fetch('/api/shows').then(r => r.json())
            ]);
            this._searchCache = { t: Date.now(), movies: mv.movies || [], shows: sh.shows || [] };
            return this._searchCache;
        } catch (e) { return { movies: [], shows: [], error: true }; }
    }

    _onSearchInput(v) {
        this._searchQ = v;
        clearTimeout(this._searchT);
        this._searchT = setTimeout(() => {
            if (this._searchBox && this._searchBox.isConnected) this._fillSearch(this._searchBox);
        }, 140);
    }

    async _fillSearch(box) {
        const { createElement, ui } = this.props.engine;
        const clear = () => { while (box.firstChild) box.removeChild(box.firstChild); };
        const say = (text) => { clear(); box.appendChild(createElement('p', { className: 'sub' }, text)); };
        const norm = (t) => String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ').trim();
        const words = norm(this._searchQ).split(' ').filter(Boolean);
        const seq = ++this._searchSeq;
        if (!words.length) { say('Type a title to search your library.'); this.props.engine.refreshFocusList(); return; }
        const data = await this._searchData();
        if (seq !== this._searchSeq || !box.isConnected) return;
        if (data.error) { say('Could not reach your library. Is the server running?'); this.props.engine.refreshFocusList(); return; }

        const hit = (hay) => { const h = norm(hay); return words.every(w => h.indexOf(w) >= 0); };
        const pad = (n) => (n < 10 ? '0' : '') + n;
        const movies = data.movies.filter(m => hit(m.title + ' ' + (m.year || '') + ' ' + (m.filename || ''))).slice(0, 24);
        const shows = data.shows.filter(s => hit(s.showTitle)).slice(0, 24);
        const eps = [];
        data.shows.forEach(sh => (sh.seasons || []).forEach(se => (se.episodes || []).forEach(e => {
            if (eps.length < 30 && hit(sh.showTitle + ' season ' + se.season + ' episode ' + e.episode + ' s' + pad(se.season) + 'e' + pad(e.episode) + ' ' + (e.filename || ''))) eps.push({ show: sh.showTitle, e: e });
        })));

        clear();
        const P = this.state.posters || {};
        const heading = (t) => box.appendChild(createElement('h2', { className: 'sub-heading' }, t));
        if (movies.length) {
            heading('Movies');
            box.appendChild(ui.grid(movies.map(m => ui.posterCard(m.title, m.year ? String(m.year) : '', P['m:' + m.id], () => {
                this.closeSearch();
                this.openMovieDetail(m);
            })), { minColWidth: '120px', className: 'sx-poster-grid' }));
        }
        if (shows.length) {
            heading('TV Shows');
            box.appendChild(ui.grid(shows.map(s => ui.posterCard(s.showTitle, '', P['s:' + s.showTitle], () => {
                this.closeSearch();
                this.setState({ activeTab: 'shows', showNav: { show: s.showTitle, season: null } });
                this.loadLibrary('shows');
                this.loadShowInfo(s.showTitle);
            })), { minColWidth: '120px', className: 'sx-poster-grid' }));
        }
        if (eps.length) {
            heading('Episodes');
            box.appendChild(createElement('div', { className: 'plugin-list' }, ...eps.map(x => ui.listRow(
                x.show + ' \u00b7 S' + x.e.season + 'E' + x.e.episode, null, () => {
                    this.closeSearch();
                    this.setState({ activeTab: 'shows', showNav: { show: x.show, season: x.e.season } });
                    this.loadLibrary('shows');
                    this.loadShowInfo(x.show);
                    this.openEpisodeDetail(x.show, x.e);
                }))));
        }
        if (!movies.length && !shows.length && !eps.length) say('Nothing in your library matches \u201c' + this._searchQ.trim() + '\u201d.');
        this.props.engine.refreshFocusList();
    }

    _renderSearchModal() {
        if (!this.state.searchOpen) return null;
        const { createElement, ui } = this.props.engine;
        const results = createElement('div', { className: 'sx-search-results' });
        this._searchBox = results;
        const input = ui.textInput('', this._searchQ || '', (v) => this._onSearchInput(v), { placeholder: 'Search movies, shows and episodes' });
        const body = createElement('div', {}, input, results);
        const modal = ui.modal('Search your library', body, () => this.closeSearch());
        const panel = modal.firstChild;
        if (panel && panel.classList) panel.classList.add('sx-search-panel');
        this._fillSearch(results);
        if (this._searchFocusPending) {
            this._searchFocusPending = false;
            setTimeout(() => { const f = input.querySelector('input'); if (f && f.isConnected) f.focus(); }, 60);
        }
        return modal;
    }

    // ---------------- Rendering ----------------

    _renderHeader(title, showRefresh = false, showSearch = showRefresh) {
        const { createElement } = this.props.engine;
        const weatherPlugin = this._findWeatherPlugin();
        const { refreshCooldown, refreshing } = this.state;

        let searchBtn = null;
        if (showSearch) {
            searchBtn = createElement('button', {
                className: 'theme-launch-btn refresh-btn focusable',
                title: 'Search your library',
                onClick: () => this.openSearch()
            }, createElement('span', {}, 'Search'));
        }

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
                searchBtn,
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
            const isW = this._watchedLookup();
            const msub = (m) => ((isW({ kind: 'movie', title: m.title, year: m.year || 0 }) ? '\u2713 ' : '') + (m.year ? String(m.year) : '')).trim();
            if (this.state.viewMode === 'list') {
                return createElement('div', { className: 'plugin-list' },
                    ...movies.map(m => ui.listRow(m.title, msub(m), () => this.openMovieDetail(m), { onLongPress: () => ui.toast(m.filename) })));
            }
            return ui.grid(
                movies.map(m => ui.posterCard(m.title, msub(m), this.state.posters['m:' + m.id], () => this.openMovieDetail(m), { onLongPress: () => ui.toast(m.filename) })),
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
}

hesperMixin(MainApp, MainAppLibraryMethods);
