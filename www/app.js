// ============================================================
// Hesper App Shell: MainApp core (state, lifecycle, navigation, render)
// The rest of MainApp lives in app_appearance.js, app_sources.js,
// app_library.js, app_watch.js, app_playback.js and app_plugins.js (loaded after this file).
// Constants and helpers are in app_config.js; ThemePanel is in theme_panel.js.
// ============================================================

class MainApp extends HesperComponent {
    constructor(props) {
        super(props);
        this.state = {
            activeTab: 'dashboard',
            showThemePanel: false,
            pluginsList: [],
            resumeAsk: null,      // a Resume Watching card was tapped: ask Continue / Start over
            pluginPick: null,     // Hesper's own .zip picker for plugin install (null = closed)
            pluginInstall: null,  // plugin install screen: null = closed, else { stage: checking|confirm|installing|error, ... }
            pluginRemove: null,   // remove-plugin confirmation: null = closed, else { folder, name, busy, error }
            appClose: this._readCloseFlag(),   // set after removing a plugin that changed the layout; blocks the app until Hesper is closed
            favorites: window.HesperFavorites ? window.HesperFavorites.list() : [],   // the shared Favorites list (favorites.js)
            favFilter: 'all',     // Favorites tab: 'all' | 'movie' | 'tv'
            favRemove: null,      // remove-from-favorites confirmation: null = closed, else { key, title }
            sources: [],
            library: {},          // { movies: {...}, shows: {...}, unknown: {...} }
            picker: null,         // null = closed, else { path, parent, dirs, loading, error }
            netPicker: null,      // network folders: null = closed, else { stage: hosts|login|share|browse, ... }
            showNav: { show: null, season: null },   // TV Shows drill-down: null/null = show folders, show only = seasons, both = episodes
            skins: [],            // [{ id, name, author, version, description, tokens }]
            activeSkin: (() => { try { return localStorage.getItem(SKIN_KEY) || 'default'; } catch (e) { return 'default'; } })(),
            layout: hesperReadPref(LAYOUT_KEY, 'classic', LAYOUTS.map(l => l.id)),
            posterSize: hesperReadPref(POSTER_SIZE_KEY, 'auto', POSTER_SIZES.map(z => z.id)),
            viewMode: hesperReadPref(VIEW_MODE_KEY, 'grid', ['grid', 'list']),   // Movies / TV Shows: poster grid or text list
            refreshCooldown: 0,   // seconds left before another refresh is allowed
            refreshing: false,    // true while the server is rescanning
            busy: '',             // text for the full-screen loading ring ('' = hidden)
            detail: null,         // null = closed, else { title, subtitle, overview, image, loading, error }
            showInfo: {},         // showTitle -> { overview, poster } | { loading } | { error }
            posters: this._readPosters(),   // 'm:<id>' / 's:<title>' -> poster url ('' = none found)
            clock: this._readClock(),        // { hour12, showDate, tz }
            showClockSettings: false,
            moreOpen: false,      // phone bottom bar: the "More" sheet
            weatherText: this._readWeather(),
            progress: this._readProgress(),  // id -> { id, kind, title, showTitle, season, episode, year, position, duration, updated }
            history: this._readHistory(),    // finished items, newest first (see sync.js)
            histAvail: null,                 // item key -> local file id, null until checked
            syncUi: { busy: false, linking: false, showKey: false, confirmDelete: false, confirmClear: false, msg: '' }
        };
    }

    componentDidMount() {
        const { engine } = this.props;
        window.HesperActivity.begin('plugins', 'Loading plugins\u2026', true);
        engine.plugins.discover().then(plugins => {
            window.HesperActivity.end('plugins', 'Loaded ' + plugins.length + ' plugins');
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
        document.addEventListener('hesper-favorites', () => {
            const list = window.HesperFavorites.list();
            if (this.state.activeTab === 'favorites') this.setState({ favorites: list });
            else this.state.favorites = list;
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
        if (id === 'favorites' && window.HesperFavorites) this.state.favorites = window.HesperFavorites.list();
        this.setState({ activeTab: id, showNav, moreOpen: false });
        this.loadLibrary(id);
        if (id === 'resume') this._queueResumeArt();
        if (id === 'history') this._refreshHistoryAvailability();
    }

    _navItems() {
        const items = NAV_ITEMS.slice();
        let at = 1;
        if (this._resumeItems().length) { items.splice(at, 0, RESUME_NAV_ITEM); at++; }
        if ((this.state.history || []).length) items.splice(at, 0, HISTORY_NAV_ITEM);
        const pluginTabs = (this.state.pluginsList || [])
            .filter(p => p.manifest && p.manifest.ui && p.manifest.ui.navTab)
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
        const { engine } = this.props;
        if (this.state.appClose) return true;   // the "close Hesper" screen cannot be dismissed
        if (this._player) { this._player.onBack(); return true; }
        if (engine.windows.activeWindow) {
            if (this._pluginBack && this._pluginBack()) return true;   // a plugin screen stepped back by itself
            engine.windows.back();
            return true;
        }
        if (this.state.resumeAsk) { this.setState({ resumeAsk: null }); return true; }
        if (this.state.detail) { this.closeDetail(); return true; }
        if (this.state.pluginPick) { this.pluginPickBack(); return true; }
        if (this.state.pluginInstall) { this.cancelPluginInstall(); return true; }
        if (this.state.pluginRemove) { this.cancelRemovePlugin(); return true; }
        if (this.state.favRemove) { this.cancelRemoveFavorite(); return true; }
        if (this.state.showThemePanel) { this.setState({ showThemePanel: false }); return true; }
        if (this.state.moreOpen) { this.setState({ moreOpen: false }); return true; }
        if (this.state.showClockSettings) { this.setState({ showClockSettings: false }); return true; }
        if (this.state.netPicker) { this.netBack(); return true; }
        if (this.state.picker) { this.closePicker(); return true; }
        if (this.state.activeTab === 'shows') return this.showBack();
        return false;
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
                this._renderTorrentSettings(),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Appearance & Themes'),
                    createElement('button', {
                        className: 'theme-launch-btn focusable',
                        onClick: () => this.setState({ showThemePanel: true })
                    }, 'Customize Colors')
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
                    createElement('p', { className: 'sub' }, 'A small status line in the corner that says what Hesper is doing (scanning, syncing, fetching posters...). It never takes focus and hides while a video plays. Detailed also shows plugin network requests.'),
                    createElement('div', { className: 'section-actions' },
                        ...[['off', 'Off'], ['basic', 'Basic'], ['detailed', 'Detailed']].map(([id, label]) =>
                            this._choiceButton(label, window.HesperActivity.get() === id,
                                () => { window.HesperActivity.set(id); this.setState({}); }))
                    )
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Navigation sound'),
                    createElement('p', { className: 'sub' }, 'A soft tick when you move around with the D-pad, remote or arrow keys.'),
                    createElement('div', { className: 'section-actions' },
                        ...[['off', 'Off'], ['low', 'Low'], ['med', 'Medium'], ['high', 'High']].map(([id, label]) =>
                            this._choiceButton(label, window.HesperNavSound && window.HesperNavSound.get() === id,
                                () => { window.HesperNavSound.set(id); this.setState({}); }))
                    )
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
                ),
                createElement('div', { className: 'settings-section' },
                    createElement('h2', {}, 'Plugins'),
                    createElement('p', { className: 'sub' }, 'Add a plugin from a .zip file. To remove one, hold its row in the Plugins tab.'),
                    createElement('div', { className: 'section-actions' },
                        ui.button('Install plugin from .zip', () => this.startPluginInstall(), { variant: 'primary' })
                    )
                )
            );
        } else if (activeTab === 'plugins') {
            // Built-in plugins can't be removed; installed ones can (hold the row).
            const removable = (p) => !HesperPluginInstaller.isBuiltin(p.folder);
            const row = (p) => {
                const official = HesperPluginInstaller.isOfficial(p.folder);
                const note = official
                    ? (p.sandboxed ? 'official' : 'official \u00b7 full access')
                    : 'third party \u00b7 sandboxed \u00b7 hold to remove';
                return ui.listRow(
                    p.app_name,
                    `${p.folder} \u00b7 ${note}`,
                    () => this.openPlugin(p),
                    { statusDot: true, onLongPress: removable(p) ? () => this.askRemovePlugin(p) : undefined }
                );
            };
            // Official plugins first, then a separator, then third-party ones.
            const officialPlugins = pluginsList.filter(p => HesperPluginInstaller.isOfficial(p.folder));
            const thirdParty = pluginsList.filter(p => !HesperPluginInstaller.isOfficial(p.folder));
            const label = (text, sep) => createElement('div', { className: 'plugin-group-label' + (sep ? ' plugin-group-sep' : '') }, text);
            const pluginRows = [];
            if (officialPlugins.length) {
                pluginRows.push(label('Official plugins'));
                officialPlugins.forEach(p => pluginRows.push(row(p)));
            }
            pluginRows.push(label('Third-party plugins', officialPlugins.length > 0));
            if (thirdParty.length) thirdParty.forEach(p => pluginRows.push(row(p)));
            else pluginRows.push(ui.card('No third-party plugins', 'Add one from Settings \u2192 Plugins \u2192 Install plugin from .zip.'));

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

        const isPhone = window.matchMedia(PHONE_MQ).matches;
        const sidebar = isPhone ? null : createElement('div', { className: 'hesper-sidebar' },
                createElement('div', { className: 'sidebar-brand' }, 'Hesper'),
                createElement('div', { className: 'sidebar-nav' }, ...navElements),
                createElement('div', { className: 'sidebar-footer' },
                    createElement('span', { className: 'status-badge' }, 'System Online')
                )
            );
        if (sidebar) sidebar.dataset.keepScroll = 'sidebar';

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
            bottomBar = createElement('div', { className: 'hesper-bottombar' },
                ...navItems.filter(i => PHONE_PRIMARY_TABS.includes(i.id)).map(tabBtn),
                createElement('button', {
                    className: `bb-item focusable ${moreActive || this.state.moreOpen ? 'active' : ''}`,
                    onClick: () => this.setState({ moreOpen: !this.state.moreOpen })
                }, 'More'),
                ...sheet
            );
        }

        const contentPane = createElement('div', { className: 'hesper-content' }, mainContent);
        // New tab or drill-down level => new key => starts at the top; same screen => keeps its place.
        contentPane.dataset.keepScroll = `content:${activeTab}:${this.state.showNav.show}:${this.state.showNav.season}`;

        return createElement('div', { className: 'hesper-shell' },
            sidebar,
            contentPane,
            bottomBar,
            themeModal,
            this._renderDetailModal(),
            this._renderClockSettings(),
            this._renderPicker(),
            this._renderNetPicker(),
            this._renderResumeAskModal(),
            this._renderPluginPickModal(),
            this._renderPluginInstallModal(),
            this._renderTorrentModal(),
            this._renderPluginRemoveModal(),
            this._renderFavoriteRemoveModal(),
            this._renderBusy(),
            this._renderAppCloseModal()
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
    // What sandboxed plugins (via plugin_sandbox.js) are allowed to ask the app to do.
    window.HesperHost = {
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
