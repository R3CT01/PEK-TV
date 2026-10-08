// ============================================================
// MainApp: Settings screen
// Loaded after app.js. These methods are added to MainApp.prototype.
//
// Settings are grouped into a few categories. Each category is a
// collapsible row; only one is open at a time, so the page stays short
// and D-pad / remote navigation never has to walk past dozens of
// controls. Only the open category is built, which keeps repaints light.
//
//   Library          media folders, rescan
//   Appearance       skins, colours, layout, posters, clock
//   Account & Sync   cloud sync, plugin backup
//   Streaming        torrents, magnet links
//   Plugins          install from .zip
//   Advanced         background activity, navigation sound
// ============================================================

const SETTINGS_OPEN_KEY = 'hesper-settings-open';
const SETTINGS_GROUP_IDS = ['library', 'appearance', 'account', 'streaming', 'plugins', 'advanced'];

class MainAppSettingsMethods {

    // Which category is open ('' = all closed). Remembered between launches.
    _readSettingsOpen() {
        try {
            const v = localStorage.getItem(SETTINGS_OPEN_KEY);
            if (v === '') return '';
            if (SETTINGS_GROUP_IDS.indexOf(v) >= 0) return v;
        } catch (e) { /* storage unavailable */ }
        return 'library';
    }

    toggleSettingsGroup(id) {
        const next = this.state.settingsOpen === id ? '' : id;
        try { localStorage.setItem(SETTINGS_OPEN_KEY, next); } catch (e) { /* lasts until restart */ }
        this.setState({ settingsOpen: next });
        // Repainting rebuilds the page and the open/closed groups shift everything below,
        // so put focus back on the row that was pressed and bring it into view.
        const engine = this.props.engine;
        const head = document.querySelector('.settings-group-head[data-group="' + id + '"]');
        if (head && engine && engine.focusableElements) {
            const i = engine.focusableElements.indexOf(head);
            if (i >= 0) { engine.currentIndex = i; engine._applyFocus(false); }
            try { head.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old WebView */ }
        }
    }

    // A small heading inside a category (Skins, Colours, Layout ...).
    _settingsSub(text) {
        return this.props.engine.createElement('h3', { className: 'settings-sub' }, text);
    }

    _settingsNote(text) {
        return this.props.engine.createElement('p', { className: 'sub' }, text);
    }

    // ---------------- Category bodies ----------------

    _settingsLibrary() {
        const { createElement, ui } = this.props.engine;
        const { sources } = this.state;
        const sourceRows = sources.length
            ? sources.map(path => ui.listRow(path, 'Tap to remove this source', () => this.removeSource(path)))
            : [createElement('p', { className: 'sub' }, 'No media folders added yet.')];
        const scanLabel = this.state.refreshing
            ? 'Scanning\u2026'
            : this.state.refreshCooldown > 0 ? `Rescan Library (${this.state.refreshCooldown}s)` : 'Rescan Library';
        return [
            createElement('div', { className: 'plugin-list' }, ...sourceRows),
            createElement('div', { className: 'section-actions' },
                ui.button('Add Source Folder', () => this.openPicker(), { variant: 'primary' }),
                ui.button('Add Network Folder', () => this.openNetPicker()),
                ui.button(scanLabel, () => this.rescan())
            )
        ];
    }

    _settingsAppearance() {
        const { createElement, ui } = this.props.engine;
        const skinRows = this.state.skins.map(s => ui.listRow(
            s.name,
            [s.version ? `v${s.version}` : '', s.author ? `by ${s.author}` : '', s.description || ''].filter(Boolean).join(' \u00b7 ') || 'Tap to apply',
            () => this.applySkin(s.id),
            Object.assign({ statusDot: s.id === this.state.activeSkin },
                HesperSkinInstaller.isBuiltin(s.id) ? {} : { onLongPress: () => this.askRemoveSkin(s) })
        ));
        return [
            // Skin + colours live together: the skin sets the look, colours fine-tune it.
            this._settingsSub('Skin & colors'),
            this._settingsNote('Pick a skin, then fine-tune its colors. To remove a skin you added, hold its row.'),
            createElement('div', { className: 'plugin-list' }, ...skinRows),
            createElement('div', { className: 'section-actions' },
                ui.button('Customize Colors', () => this.setState({ showThemePanel: true }), { variant: 'primary' }),
                ui.button('Install skin from .zip', () => this.startSkinInstall())
            ),

            this._settingsSub('Layout'),
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
            ),

            this._settingsSub('Clock'),
            createElement('div', { className: 'section-actions' },
                ui.button('Clock & time zone', () => this.setState({ showClockSettings: true }))
            )
        ];
    }

    _settingsAccount() {
        // Sign-in, sync and plugin backup. Built by the sync module.
        return [this._renderSyncSettings()];
    }

    _settingsStreaming() {
        return [this._renderTorrentSettings()];
    }

    _settingsPlugins() {
        const { createElement, ui } = this.props.engine;
        return [
            this._settingsNote('Add a plugin from a .zip file. To remove one, hold its row in the Plugins tab.'),
            createElement('div', { className: 'section-actions' },
                ui.button('Install plugin from .zip', () => this.startPluginInstall(), { variant: 'primary' })
            )
        ];
    }

    _settingsAdvanced() {
        const { createElement } = this.props.engine;
        const act = window.HesperActivity ? window.HesperActivity.get() : 'off';
        const snd = window.HesperNavSound ? window.HesperNavSound.get() : 'off';
        return [
            this._settingsSub('Background activity'),
            this._settingsNote('A small status line in the corner that says what Hesper is doing (scanning, syncing, fetching posters...). It never takes focus and hides while a video plays. Detailed also shows plugin network requests.'),
            createElement('div', { className: 'section-actions' },
                ...[['off', 'Off'], ['basic', 'Basic'], ['detailed', 'Detailed']].map(([id, label]) =>
                    this._choiceButton(label, act === id,
                        () => { if (window.HesperActivity) window.HesperActivity.set(id); this.setState({}); }))
            ),

            this._settingsSub('Navigation sound'),
            this._settingsNote('A soft tick when you move around with the D-pad, remote or arrow keys.'),
            createElement('div', { className: 'section-actions' },
                ...[['off', 'Off'], ['low', 'Low'], ['med', 'Medium'], ['high', 'High']].map(([id, label]) =>
                    this._choiceButton(label, snd === id,
                        () => { if (window.HesperNavSound) window.HesperNavSound.set(id); this.setState({}); }))
            )
        ];
    }

    // ---------------- Category list ----------------

    _settingsGroups() {
        const labelOf = (list, id) => { const x = list.find(i => i.id === id); return x ? (x.name || x.label) : ''; };
        const S = window.HesperSync;
        const n = this.state.sources.length;
        const skin = this.state.skins.find(s => s.id === this.state.activeSkin);
        const actNames = { off: 'Off', basic: 'Basic', detailed: 'Detailed' };
        const sndNames = { off: 'Off', low: 'Low', med: 'Medium', high: 'High' };
        const act = window.HesperActivity ? window.HesperActivity.get() : 'off';
        const snd = window.HesperNavSound ? window.HesperNavSound.get() : 'off';
        let account = 'Not signed in';
        try { if (S && S.isLinked()) account = S.getEmail() || 'Signed in'; } catch (e) { /* keep default */ }

        return [
            { id: 'library', title: 'Library',
              summary: n ? `${n} folder${n === 1 ? '' : 's'}` : 'No folders yet',
              body: () => this._settingsLibrary() },
            { id: 'appearance', title: 'Appearance',
              summary: [skin ? skin.name : '', labelOf(LAYOUTS, this.state.layout)].filter(Boolean).join(' \u00b7 '),
              body: () => this._settingsAppearance() },
            { id: 'account', title: 'Account & Sync',
              summary: account,
              body: () => this._settingsAccount() },
            { id: 'streaming', title: 'Streaming',
              summary: 'Torrents and magnet links',
              body: () => this._settingsStreaming() },
            { id: 'plugins', title: 'Plugins',
              summary: 'Install from a .zip file',
              body: () => this._settingsPlugins() },
            { id: 'advanced', title: 'Advanced',
              summary: `Activity ${actNames[act] || act} \u00b7 Sound ${sndNames[snd] || snd}`,
              body: () => this._settingsAdvanced() }
        ];
    }

    _renderSettingsPage() {
        const { createElement } = this.props.engine;
        const open = this.state.settingsOpen;
        const groups = this._settingsGroups().map(g => {
            const isOpen = g.id === open;
            const head = createElement('div', {
                className: 'focusable settings-group-head' + (isOpen ? ' open' : ''),
                onClick: () => this.toggleSettingsGroup(g.id)
            },
                createElement('div', { className: 'settings-group-text' },
                    createElement('h2', {}, g.title),
                    g.summary ? createElement('p', { className: 'settings-group-sum' }, g.summary) : null
                ),
                createElement('span', { className: 'settings-chevron' }, '\u203a')
            );
            head.setAttribute('data-group', g.id);
            return createElement('div', { className: 'settings-group' + (isOpen ? ' open' : '') },
                head,
                isOpen ? createElement('div', { className: 'settings-group-body' }, ...g.body()) : null
            );
        });
        return createElement('div', {},
            this._renderHeader('Settings'),
            createElement('div', { className: 'settings-groups' }, ...groups)
        );
    }
}

hesperMixin(MainApp, MainAppSettingsMethods);
