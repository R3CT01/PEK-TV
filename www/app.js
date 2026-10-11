// ============================================================
// PEK TV App Shell: MainApp core (state, lifecycle, navigation, render)
// The rest of MainApp lives in app_appearance.js, app_sources.js,
// app_library.js, app_watch.js, app_playback.js and app_plugins.js (loaded after this file).
// Constants and helpers are in app_config.js.
// ============================================================

class MainApp extends PekComponent {
    constructor(props) {
        super(props);
        this.state = {
            activeTab: 'dashboard',
            pluginsList: [],
            resumeAsk: null,      // a Resume Watching card was tapped: ask Continue / Start over
            pluginPick: null,     // PEK TV's own .zip picker for plugin install (null = closed)
            pluginInstall: null,  // plugin install screen: null = closed, else { stage: checking|confirm|installing|error, ... }
            pluginRemove: null,   // remove-plugin confirmation: null = closed, else { folder, name, busy, error }
            skinInstall: null,    // skin install screen: null = closed, else { stage: checking|confirm|installing|error, ... }
            skinRemove: null,     // remove-skin confirmation: null = closed, else { id, name, busy, error }
            appClose: this._readCloseFlag(),   // set after removing a plugin that changed the layout; blocks the app until PEK TV is closed
            favorites: window.PekFavorites ? window.PekFavorites.list() : [],   // the shared Favorites list (favorites.js)
            favFilter: 'all',     // Favorites tab: 'all' | 'movie' | 'tv'
            favRemove: null,      // remove-from-favorites confirmation: null = closed, else { key, title }
            signOutAsk: false,    // "sign out of cloud sync?" confirmation (Settings > Cloud Sync)
            exitAsk: false,       // "exit PEK TV?" confirmation (Android Back at the top level)
            sources: [],
            library: {},          // { movies: {...}, shows: {...}, unknown: {...} }
            picker: null,         // null = closed, else { path, parent, dirs, loading, error }
            netPicker: null,      // network folders: null = closed, else { stage: hosts|login|share|browse, ... }
            showNav: { show: null, season: null },   // TV Shows drill-down: null/null = show folders, show only = seasons, both = episodes
            skins: [],            // [{ id, name, author, version, description, tokens }]
            activeSkin: (() => { try { return localStorage.getItem(SKIN_KEY) || 'default'; } catch (e) { return 'default'; } })(),
            layout: pekReadPref(LAYOUT_KEY, 'classic', LAYOUTS.map(l => l.id)),
            posterSize: pekReadPref(POSTER_SIZE_KEY, 'auto', POSTER_SIZES.map(z => z.id)),
            viewMode: pekReadPref(VIEW_MODE_KEY, 'grid', ['grid', 'list']),   // Movies / TV Shows: poster grid or text list
            refreshCooldown: 0,   // seconds left before another refresh is allowed
            refreshing: false,    // true while the server is rescanning
            busy: '',             // text for the full-screen loading ring ('' = hidden)
            detail: null,         // null = closed, else { title, subtitle, overview, image, loading, error }
            showInfo: {},         // showTitle -> { overview, poster } | { loading } | { error }
            posters: this._readPosters(),   // 'm:<id>' / 's:<title>' -> poster url ('' = none found)
            clock: this._readClock(),        // { hour12, showDate, tz }
            showClockSettings: false,
            dash: this._readDash(),      // dashboard widgets (app_dashboard.js)
            dashEdit: false,             // dashboard is in customize mode
            dashAdd: false,              // the "Add widget" list is open
            moreOpen: false,      // phone bottom bar: the "More" sheet
            weatherText: this._readWeather(),
            progress: this._readProgress(),  // id -> { id, kind, title, showTitle, season, episode, year, position, duration, updated }
            history: this._readHistory(),    // finished items, newest first (see sync.js)
            histOpen: null,                  // a Watch History card was tapped: the popup with where to find it
            histShow: null,                  // a grouped show card was tapped: the popup listing its watched episodes
            searchOpen: false,               // the library search box
            histAvail: null,                 // item key -> local file id, null until checked
            syncUi: { busy: false, mode: '', confirmDelete: false, confirmClear: false, msg: '' }
        };
    }

    componentDidMount() {
        const { engine } = this.props;
        window.PekActivity.begin('plugins', 'Loading plugins\u2026', true);
        engine.plugins.discover().then(plugins => {
            window.PekActivity.end('plugins', 'Loaded ' + plugins.length + ' plugins');
            this.setState({ pluginsList: plugins });
            this._warmWeatherPlugin(plugins);
        });
        // Switching between phone and wide layout (rotation, split screen) swaps the nav.
        try {
            const mq = window.matchMedia(PHONE_MQ);
            const onChange = () => this.setState({ moreOpen: false });
            if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
        } catch (e) { /* no matchMedia: layout just won't switch live */ }
        // Hide the bottom bar while a text field is focused, so the on-screen keyboard
        // never pushes it up over the field.
        const isField = (el) => el && el.matches && el.matches('input, textarea, select');
        document.addEventListener('focusin', (e) => { if (isField(e.target)) document.documentElement.classList.add('hp-typing'); });
        document.addEventListener('focusout', () => document.documentElement.classList.remove('hp-typing'));

        // A plugin added or removed a favorite. Only repaint when the Favorites tab is showing;
        // otherwise just keep the list current so repainting the shell never disturbs an open plugin.
        document.addEventListener('pek-favorites', () => {
            const list = window.PekFavorites.list();
            if (this.state.activeTab === 'favorites') this.setState({ favorites: list });
            else this.state.favorites = list;
        });

        // Android's answer to a storage permission prompt (the one at first start has no one waiting for it).
        window.__pekStorageAny = (granted) => this._onStorageAnswer(granted);

        this.loadSources();
        this.loadSkins();
        this._startClockTicker();
        this._dashLoad();
        this._watchNetwork();
        this._queueResumeArt();
        this._startAutoSync();

        // Live-update the header badge when the weather plugin publishes a new reading.
        window.addEventListener('storage', () => {
            const text = this._readWeather();
            if (text !== this.state.weatherText) this.setState({ weatherText: text });
        });
    }

    selectTab(id) {
        // A plugin's own tab (plugin.json ui.navTab) opens that plugin's screen.
        if (typeof id === 'string' && id.indexOf('plugin:') === 0) {
            const p = (this.state.pluginsList || []).find(x => x.folder === id.slice(7));
            this.setState({ moreOpen: false });
            if (p) this.openPlugin(p);
            return;
        }
        // Tapping "TV Shows" always returns to the top-level show folders.
        const showNav = id === 'shows' ? { show: null, season: null } : this.state.showNav;
        if (id === 'favorites' && window.PekFavorites) this.state.favorites = window.PekFavorites.list();
        this.setState({ activeTab: id, showNav, moreOpen: false, dashEdit: false });
        this.loadLibrary(id);
        if (id === 'dashboard') this._dashLoad();
        if (id === 'resume') this._queueResumeArt();
        if (id === 'history') this._refreshHistoryAvailability();
    }

    // Plugins that ask for a tab of their own (plugin.json ui.navTab).
    _tabPlugins() {
        return (this.state.pluginsList || []).filter(p => p.manifest && p.manifest.ui && p.manifest.ui.navTab);
    }

    // Which of those the person put in the sidebar. Until they choose, the first three are shown.
    _sidebarPinned() {
        let saved = null;
        try {
            const v = JSON.parse(localStorage.getItem('hesper_sidebar_plugins') || 'null');
            if (Array.isArray(v)) saved = v.filter(x => typeof x === 'string');
        } catch (e) { /* unreadable: use the default */ }
        const tabs = this._tabPlugins().map(p => p.folder);
        return saved ? tabs.filter(f => saved.indexOf(f) >= 0) : tabs.slice(0, 3);
    }

    _setSidebarPinned(folder, on) {
        const now = this._sidebarPinned().filter(f => f !== folder);
        if (on) now.push(folder);
        try { localStorage.setItem('hesper_sidebar_plugins', JSON.stringify(now)); } catch (e) { /* not saved */ }
        this.setState({});
    }

    _navItems() {
        const items = NAV_ITEMS.slice();
        let at = 1;
        if (this._resumeItems().length) { items.splice(at, 0, RESUME_NAV_ITEM); at++; }
        if ((this.state.history || []).length) items.splice(at, 0, HISTORY_NAV_ITEM);
        // Only plugins pinned to the sidebar get a tab of their own; every plugin stays reachable
        // from the Plugins tab, so twenty plugins no longer push the menu off the screen.
        const pins = this._sidebarPinned();
        const pluginTabs = this._tabPlugins()
            .filter(p => pins.indexOf(p.folder) >= 0)
            .map(p => ({ id: 'plugin:' + p.folder, label: p.manifest.ui.navTab }));
        if (pluginTabs.length) {
            const pluginsAt = items.findIndex(i => i.id === 'plugins');
            items.splice(pluginsAt < 0 ? items.length : pluginsAt, 0, ...pluginTabs);
        }
        return items;
    }

    // One level up: episodes -> seasons -> show folders. Returns true if it moved.
    // One "Back" for the whole app, used by the keyboard, the remote and the
    // browser's own Back button. Returns true if it closed or stepped out of something.
    goBack() {
        // a stream is starting: Back cancels it and nothing behind the box moves
        if (window.PekTorrent && window.PekTorrent.cancelStarting && window.PekTorrent.cancelStarting()) return true;
        const { engine } = this.props;
        if (this.state.appClose) return true;   // the "close PEK TV" screen cannot be dismissed
        if (this.state.exitAsk) { this.setState({ exitAsk: false }); return true; }   // Back on the exit question = stay
        if (this.state.signOutAsk) { this.setState({ signOutAsk: false }); return true; }   // Back on the sign-out question = stay signed in
        // while minimized the player is just a bar; Back belongs to the app
        if (this._player && !this._player.mini) { this._player.onBack(); return true; }
        if (engine.windows.activeWindow) {
            if (this._pluginBack && this._pluginBack()) return true;   // a plugin screen stepped back by itself
            engine.windows.back();
            return true;
        }
        if (this.state.searchOpen) { this.closeSearch(); return true; }
        if (this.state.histOpen) { this.setState({ histOpen: null }); return true; }
        if (this.state.histShow) { this.setState({ histShow: null }); return true; }
        if (this.state.resumeAsk) { this.setState({ resumeAsk: null }); return true; }
        if (this.state.detail) { this.closeDetail(); return true; }
        if (this.state.skinRemove) { this.cancelRemoveSkin(); return true; }
        if (this.state.skinInstall) { this.cancelSkinInstall(); return true; }
        if (this.state.pluginPick) { this.pluginPickBack(); return true; }
        if (this.state.pluginInstall) { this.cancelPluginInstall(); return true; }
        if (this.state.pluginRemove) { this.cancelRemovePlugin(); return true; }
        if (this.state.favRemove) { this.cancelRemoveFavorite(); return true; }
        if (this.state.moreOpen) { this.setState({ moreOpen: false }); return true; }
        if (this.state.dashAdd) { this.setState({ dashAdd: false }); return true; }
        if (this.state.showClockSettings) { this.setState({ showClockSettings: false }); return true; }
        if (this.state.dashEdit && this.state.activeTab === 'dashboard') { this.setState({ dashEdit: false }); return true; }
        if (this.state.netPicker) { this.netBack(); return true; }
        if (this.state.picker) { this.closePicker(); return true; }
        if (this.state.activeTab === 'shows' && this.showBack()) return true;
        return this._askExit();   // nothing left to close: on Android ask before leaving
    }

    // ---------------- exit confirmation (Android) ----------------
    // Only the Android app can really exit; in a browser / desktop this returns false and Back behaves as before.
    _askExit() {
        const a = window.PekAndroid;
        if (!a || typeof a.exitApp !== 'function') return false;
        this.setState({ exitAsk: true });
        return true;
    }

    // Clears what the app itself cached in the page (NOT favorites, watch progress or settings), then the
    // Android side clears its own caches, stops everything and ends the process.
    _confirmExit() {
        this.setState({ exitAsk: false });
        try { sessionStorage.clear(); } catch (e) { /* nothing to clear */ }
        try { localStorage.removeItem('hesper_posters_v1'); } catch (e) { /* nothing to clear */ }   // poster cache
        try { if (window.caches && caches.keys) caches.keys().then(ks => ks.forEach(k => caches.delete(k))); } catch (e) { /* none */ }
        try { window.PekAndroid.exitApp(); } catch (e) { console.warn('[PEK TV] exit failed', e); }
    }

    // Settings > Profiles: who is watching, switch, manage (profiles.js). Hidden when the page has no storage or nobody is signed in to an account.
    _renderProfileSettings() {
        const hp = window.PekProfiles;
        if (!hp || !hp.enabled) return null;
        if (typeof hp.hasAccount === 'function' && !hp.hasAccount()) return null;   // profiles need a signed-in account
        const { createElement, ui } = this.props.engine;
        const me = hp.current();
        return createElement('div', { className: 'settings-section' },
            createElement('h2', {}, 'Profiles'),
            createElement('p', { className: 'sub' },
                `Watching as ${me ? me.name : 'Profile 1'}. Each profile keeps its own favorites, watch history, resume points, skip settings and look. Plugins and your library are shared.`),
            createElement('div', { className: 'section-actions' },
                ui.button('Sign out of profile', () => hp.openPicker(false), { variant: 'primary' }),
                ui.button('Manage profiles', () => hp.openPicker(true))
            )
        );
    }

    _renderExitModal() {
        if (!this.state.exitAsk) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.setState({ exitAsk: false });
        const body = createElement('div', {},
            createElement('p', { className: 'sub' }, 'PEK TV will stop running and its temporary cache will be cleared.'),
            createElement('div', { className: 'section-actions', style: { margin: '14px 0 6px' } },
                ui.button('Yes, exit', () => this._confirmExit(), { variant: 'primary' })));
        return ui.modal('Are you sure you want to exit?', body, close);   // the modal's own button is "Close" = stay
    }

    render() {
        const { engine } = this.props;
        const { createElement, ui } = engine;
        const { activeTab, pluginsList, sources } = this.state;

        // Sidebar Navigation
        const navItems = this._navItems();
        const navElements = navItems.map(item => {
            return createElement('button', {
                className: `nav-item focusable ${activeTab === item.id ? 'active' : ''}`,
                onClick: () => this.selectTab(item.id)
            }, item.label);
        });

        const currentLabel = navItems.find(i => i.id === activeTab)?.label || 'PEK TV';

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
                this._renderProfileSettings(),
                this._renderSyncSettings(),
                this._renderTorrentSettings(),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'TV mode'),
                    createElement('p', { className: 'sub' }, 'Bigger text, TV-safe margins and a bolder highlight for viewing from the couch.'),
                    createElement('div', { className: 'plugin-list' },
                        ...[['auto', 'Auto', 'On for TV boxes, off on phones'], ['on', 'On', 'Always use the TV look'], ['off', 'Off', 'Never use the TV look']].map(([id, name, desc]) =>
                            ui.listRow(name, desc, () => { window.PekTV.setMode(id); this.setState({}); }, { statusDot: window.PekTV.mode() === id }))
                    ),
                    createElement('p', { className: 'sub' }, 'Screen margins (raise this if your TV cuts off the edges)'),
                    createElement('div', { className: 'plugin-list' },
                        ...[[0, 'None'], [2, 'Small'], [4, 'Medium'], [6, 'Large']].map(([pct, name]) =>
                            ui.listRow(name, null, () => { window.PekTV.setSafe(pct); this.setState({}); }, { statusDot: window.PekTV.safe() === pct }))
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Layout'),
                    createElement('div', { className: 'plugin-list layout-cards' },
                        ...LAYOUTS.map(l => ui.listRow(l.name, l.description, () => this.setLayout(l.id), { statusDot: l.id === this.state.layout }))
                    ),
                    createElement('p', { className: 'sub' }, 'Poster size'),
                    createElement('div', { className: 'section-actions' },
                        ...POSTER_SIZES.map(z => this._choiceButton(z.label, this.state.posterSize === z.id, () => this.setPosterSize(z.id)))
                    ),
                    createElement('p', { className: 'sub' }, 'Movies and TV Shows view'),
                    createElement('div', { className: 'section-actions' },
                        this._choiceButton('Grid', this.state.viewMode === 'grid', () => this.setViewMode('grid')),
                        this._choiceButton('List', this.state.viewMode === 'list', () => this.setViewMode('list'))
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Background activity'),
                    createElement('p', { className: 'sub' }, 'A small status line in the corner that says what PEK TV is doing (scanning, syncing, fetching posters...). It never takes focus and hides while a video plays. Detailed also shows plugin network requests.'),
                    createElement('div', { className: 'section-actions' },
                        ...[['off', 'Off'], ['basic', 'Basic'], ['detailed', 'Detailed']].map(([id, label]) =>
                            this._choiceButton(label, window.PekActivity.get() === id,
                                () => { window.PekActivity.set(id); this.setState({}); }))
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Navigation sound'),
                    createElement('p', { className: 'sub' }, 'A soft tick when you move around with the D-pad, remote or arrow keys.'),
                    createElement('div', { className: 'section-actions' },
                        ...[['off', 'Off'], ['low', 'Low'], ['med', 'Medium'], ['high', 'High']].map(([id, label]) =>
                            this._choiceButton(label, window.PekNavSound && window.PekNavSound.get() === id,
                                () => { window.PekNavSound.set(id); this.setState({}); }))
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Skins'),
                    createElement('p', { className: 'sub' }, 'Add a skin from a .zip file. To remove one you added, hold its row.'),
                    createElement('div', { className: 'plugin-list' },
                        ...this.state.skins.map(s => ui.listRow(
                            s.name,
                            [s.version ? `v${s.version}` : '', s.author ? `by ${s.author}` : '', s.description || ''].filter(Boolean).join(' \u00b7 ') || 'Tap to apply',
                            () => this.applySkin(s.id),
                            Object.assign({ statusDot: s.id === this.state.activeSkin },
                                PekSkinInstaller.isBuiltin(s.id) ? {} : { onLongPress: () => this.askRemoveSkin(s) })
                        ))
                    ),
                    createElement('div', { className: 'section-actions' },
                        ui.button('PEK Store', () => this.openPluginStore('skin'), { variant: 'primary' }),
                        ui.button('Install skin from .zip', () => this.startSkinInstall())
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Plugins'),
                    createElement('p', { className: 'sub' }, 'Get plugins from the PEK Store, or add one from a .zip file. To remove one, hold its row in the Plugins tab.'),
                    createElement('div', { className: 'section-actions' },
                        ui.button('PEK Store', () => this.openPluginStore(), { variant: 'primary' }),
                        ui.button('Install plugin from .zip', () => this.startPluginInstall())
                    )
                )
            );
        } else if (activeTab === 'plugins') {
            // Built-in plugins can't be removed; installed ones can (hold the row).
            const removable = (p) => !PekPluginInstaller.isBuiltin(p.folder);
            const pinned = this._sidebarPinned();
            const hasTab = (p) => p.manifest && p.manifest.ui && p.manifest.ui.navTab;
            const row = (p) => {
                const official = PekPluginInstaller.isOfficial(p.folder);
                const note = official
                    ? (p.sandboxed ? 'official' : 'official \u00b7 full access')
                    : 'third party \u00b7 sandboxed \u00b7 hold to remove';
                const main = ui.listRow(
                    p.app_name,
                    `${p.folder} \u00b7 ${note}`,
                    () => this.openPlugin(p),
                    { statusDot: true, onLongPress: removable(p) ? () => this.askRemovePlugin(p) : undefined }
                );
                if (!hasTab(p)) return main;
                const on = pinned.indexOf(p.folder) >= 0;
                return createElement('div', { className: 'plugin-row-group' },
                    main,
                    ui.toggle('Show \u201c' + p.manifest.ui.navTab + '\u201d in the sidebar', on, (next) => this._setSidebarPinned(p.folder, next))
                );
            };
            // Official plugins first, then a separator, then third-party ones.
            const officialPlugins = pluginsList.filter(p => PekPluginInstaller.isOfficial(p.folder));
            const thirdParty = pluginsList.filter(p => !PekPluginInstaller.isOfficial(p.folder));
            const label = (text, sep) => createElement('div', { className: 'plugin-group-label' + (sep ? ' plugin-group-sep' : '') }, text);
            const pluginRows = [];
            if (officialPlugins.length) {
                pluginRows.push(label('Official plugins'));
                officialPlugins.forEach(p => pluginRows.push(row(p)));
            }
            pluginRows.push(label('Third-party plugins', officialPlugins.length > 0));
            if (thirdParty.length) thirdParty.forEach(p => pluginRows.push(row(p)));
            else pluginRows.push(ui.card('No third-party plugins', 'Get one from Settings \u2192 Plugins \u2192 PEK Store.'));

            mainContent = createElement('div', {},
                this._renderHeader('Plugins'),
                createElement('div', { className: 'plugin-list' }, ...pluginRows)
            );
        } else if (activeTab === 'favorites') {
            mainContent = createElement('div', {},
                this._renderHeader('Favorites'),
                this._renderFavorites()
            );
        } else if (activeTab === 'history') {
            mainContent = createElement('div', {},
                this._renderHeader('Watch History', false, true),
                this._renderHistory()
            );
        } else if (activeTab === 'resume') {
            mainContent = createElement('div', {},
                this._renderHeader('Resume Watching'),
                this._renderResume()
            );
        } else if (activeTab === 'dashboard') {
            mainContent = createElement('div', {},
                this._renderHeader(currentLabel, false, true),
                this._renderDashboard()
            );
        } else if (LIBRARY_ENDPOINTS[activeTab]) {
            mainContent = createElement('div', {},
                this._renderHeader(currentLabel, true),
                this._renderLibrary(activeTab)
            );
        } else {
            mainContent = createElement('div', {},
                this._renderHeader(currentLabel, false, activeTab === 'dashboard'),
                ui.card(`Welcome to ${currentLabel}`, 'Select items or configure plugins to populate this section.')
            );
        }

        const isPhone = window.matchMedia(PHONE_MQ).matches;
        const sidebar = isPhone ? null : createElement('div', { className: 'pek-sidebar' },
                createElement('div', { className: 'sidebar-brand' }, 'PEK TV'),
                createElement('div', { className: 'sidebar-nav', 'data-keep-scroll': 'sidebar-nav' }, ...navElements),
                createElement('div', { className: 'sidebar-footer' },
                    createElement('span', { className: 'status-badge' }, 'System Online')
                )
            );

        let bottomBar = null;
        if (isPhone) {
            const tabBtn = (item) => createElement('button', {
                className: `bb-item focusable ${activeTab === item.id ? 'active' : ''}`,
                onClick: () => this.selectTab(item.id)
            }, item.label);
            const moreItems = navItems.filter(i => !PHONE_PRIMARY_TABS.includes(i.id));
            const moreActive = moreItems.some(i => i.id === activeTab);
            const sheet = this.state.moreOpen ? [
                createElement('div', { className: 'bb-backdrop', onClick: () => this.setState({ moreOpen: false }) }),
                createElement('div', { className: 'bb-sheet' }, ...moreItems.map(item =>
                    createElement('button', {
                        className: `nav-item bb-sheet-item focusable ${activeTab === item.id ? 'active' : ''}`,
                        onClick: () => this.selectTab(item.id)
                    }, item.label)))
            ] : [null, null];
            bottomBar = createElement('div', { className: 'pek-bottombar' },
                ...navItems.filter(i => PHONE_PRIMARY_TABS.includes(i.id)).map(tabBtn),
                createElement('button', {
                    className: `bb-item focusable ${moreActive || this.state.moreOpen ? 'active' : ''}`,
                    onClick: () => this.setState({ moreOpen: !this.state.moreOpen })
                }, 'More'),
                ...sheet
            );
        }

        const contentPane = createElement('div', { className: 'pek-content' }, mainContent);
        // New tab or drill-down level => new key => starts at the top; same screen => keeps its place.
        contentPane.dataset.keepScroll = `content:${activeTab}:${this.state.showNav.show}:${this.state.showNav.season}`;

        return createElement('div', { className: 'pek-shell' },
            sidebar,
            contentPane,
            bottomBar,
            this._renderDetailModal(),
            this._renderClockSettings(),
            this._renderDashAdd(),
            this._renderPicker(),
            this._renderNetPicker(),
            this._renderResumeAskModal(),
            this._renderHistoryShowModal(),
            this._renderHistoryModal(),
            this._renderSearchModal(),
            this._renderPluginPickModal(),
            this._renderPluginStoreModal(),
            this._renderSkinInstallModal(),
            this._renderSkinRemoveModal(),
            this._renderPluginInstallModal(),
            this._renderTorrentModal(),
            this._renderPluginRemoveModal(),
            this._renderFavoriteRemoveModal(),
            this._renderSignOutModal(),
            this._renderExitModal(),
            this._renderBusy(),
            this._renderAppCloseModal()
        );
    }
}

// Bootstrapping
document.addEventListener('DOMContentLoaded', () => {
    // "Who's watching?" (profiles.js) is showing: the app starts after a profile is picked (the page reloads).
    if (window.PekProfiles && window.PekProfiles.pending) return;
    const appRoot = document.getElementById('app');
    if (!appRoot) {
        console.error('[PEK TV] Missing #app element in index.html');
        return;
    }

    const engine = new PekEngine(appRoot);
    const app = new MainApp({ engine });
    // What sandboxed plugins (via plugin_sandbox.js) are allowed to ask the app to do.
    window.PekHost = {
        playStream: (url, title, onClose, track) => app.playStream(url, title, onClose, track),
        // Plugins that can play titles, and "open this plugin on this title" (plugin_sandbox.js checks permissions and taps first).
        streamers: (exceptFolder) => app._streamPlugins(exceptFolder),
        openPlugin: (folder, intent) => app.openPluginOnTitle(folder, intent)
    };
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

    // Android: the native Back handler (MainActivity.onBackPressed) asks the page directly instead of
    // walking the WebView's history, so Back never depends on a history entry still being there.
    // Returns true when the app handled it (closed a plugin, a dialog ... or showed the exit question).
    window.__pekBack = () => { try { return app.goBack() === true; } catch (err) { console.warn('[PEK TV] Back failed:', err); return false; } };

    // History guard (browsers / TV browsers only): the page keeps one extra history entry on top, so a
    // browser "Back" fires popstate instead of leaving. If the app has something to close we close it
    // and re-arm the guard; otherwise we let Back leave as normal. Not used inside the Android app.
    if (!window.PekAndroid) try {
        const marker = history.state && history.state.pek;
        if (!marker) history.replaceState({ pek: 'root' }, '');
        if (marker !== 'guard') history.pushState({ pek: 'guard' }, '');
        window.addEventListener('popstate', () => {
            if (app.goBack()) history.pushState({ pek: 'guard' }, '');
            else history.back();
        });
    } catch (err) {
        console.warn('[PEK TV] History guard unavailable:', err);
    }
});
