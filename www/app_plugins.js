// ============================================================
// MainApp: Plugins tab actions: install a plugin from a .zip, remove an installed plugin
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppPluginsMethods {

    // "Install plugin from .zip": opens PEK TV's own file picker (no system picker needed, so it
    // also works on TV boxes that have none). Phones and desktops can still reach the system
    // picker from the bottom of the list.
    // kind is 'plugin' (the default) or 'skin': the same picker serves both, and the zip is then
    // checked as that kind (a skin zip chosen for a plugin, or the other way round, is refused).
    async startPluginInstall(kind) {
        if (this.state.pluginInstall || this.state.skinInstall || this.state.pluginPick) return;
        kind = kind === 'skin' ? 'skin' : 'plugin';
        this.setState({ pluginPick: { kind, stage: 'home', loading: true, error: null, sources: [], hosts: [], scanning: false } });
        let sources = [];
        try {
            const res = await fetch('/api/sources');
            const data = await res.json();
            sources = data.sources || [];
        } catch (e) { /* the list just starts without library folders */ }
        const pp = this.state.pluginPick;
        if (!pp) return;
        this.setState({ pluginPick: Object.assign({}, pp, { loading: false, sources }) });
    }

    // Reads the chosen .zip, shows what it asks for, and checks it with the server.
    async _checkPluginFile(file, kind) {
        if (kind === 'skin') { await this._checkSkinFile(file); return; }
        this.setState({ pluginInstall: { stage: 'checking' } });
        try {
            const prep = await PekPluginInstaller.prepare(file);
            const verdict = await PekPluginInstaller.check(prep);
            this.setState({ pluginInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
        } catch (err) {
            this.setState({ pluginInstall: { stage: 'error', error: String((err && err.message) || err) } });
        }
    }

    _pluginPickCanSystem() {
        const a = window.PekAndroid;
        if (!a) return true;                                           // desktop browser
        return typeof a.canPickFiles === 'function' ? !!a.canPickFiles() : true;
    }

    async pluginPickSystem() {
        const { ui } = this.props.engine;
        const kind = this.state.pluginPick && this.state.pluginPick.kind;
        this.closePluginPick();
        let file = null;
        try {
            file = await PekPluginInstaller.pickZip();
        } catch (err) {
            ui.toast("Couldn't open the system file picker on this device.");
            return;
        }
        if (!file) return;
        await this._checkPluginFile(file, kind);
    }

    async pluginPickBrowse(path) {
        const pp = this.state.pluginPick;
        if (!pp || pp.loading) return;
        if (String(path).indexOf('/') === 0 || path === '@local') { if (!(await this._ensureStorage())) return; }
        this.setState({ pluginPick: Object.assign({}, pp, { loading: true, error: null }) });
        let data;
        try {
            const res = await fetch('/api/plugins/browse', { method: 'POST', body: new URLSearchParams({ path }) });
            data = await res.json();
        } catch (e) {
            data = { ok: false, error: "Couldn't reach PEK TV's server." };
        }
        const cur = this.state.pluginPick;
        if (!cur) return;
        if (!data || !data.ok) {
            const msg = data && data.auth
                ? 'This device asks for a login. Add it once as a media source in Settings, then try again.'
                : ((data && data.error) || "Couldn't open that location.");
            this.setState({ pluginPick: Object.assign({}, cur, { loading: false, error: msg }) });
            return;
        }
        this.setState({ pluginPick: Object.assign({}, cur, {
            stage: 'browse', loading: false, error: null,
            path: data.path, parent: data.parent || '', entries: data.entries || []
        }) });
    }

    async pluginPickChoose(entry) {
        const pp = this.state.pluginPick;
        if (!pp || pp.loading) return;
        this.setState({ pluginPick: Object.assign({}, pp, { loading: true, error: null }) });
        let file;
        try {
            file = await PekPluginInstaller.fetchZip(entry.path);
        } catch (err) {
            const cur = this.state.pluginPick;
            if (cur) this.setState({ pluginPick: Object.assign({}, cur, { loading: false, error: String((err && err.message) || err) }) });
            return;
        }
        if (!this.state.pluginPick) return;
        const kind = this.state.pluginPick.kind;
        this._multicast(false);
        this.setState({ pluginPick: null });
        await this._checkPluginFile(file, kind);
    }

    async pluginPickFindNetwork() {
        const pp = this.state.pluginPick;
        if (!pp || pp.scanning) return;
        this._ppSig = '';
        this.setState({ pluginPick: Object.assign({}, pp, { scanning: true, error: null }) });
        this._multicast(true);
        try { await fetch('/api/discover', { method: 'POST' }); } catch (e) { /* polled below anyway */ }
        this._pluginPickPoll(0);
    }

    async _pluginPickPoll(n) {
        try {
            const res = await fetch('/api/discover');
            const data = await res.json();
            const pp = this.state.pluginPick;
            if (!pp) { this._multicast(false); return; }
            const hosts = data.hosts || [];
            const scanning = !!data.scanning;
            // Re-render only when something visible changed (every render replays the fade-in).
            const sig = JSON.stringify([hosts, scanning]);
            if (sig !== this._ppSig) {
                this._ppSig = sig;
                this.setState({ pluginPick: Object.assign({}, pp, { hosts, scanning }) });
            }
            if (scanning && n < 20) { setTimeout(() => this._pluginPickPoll(n + 1), 1000); return; }
        } catch (e) { /* stop searching */ }
        this._multicast(false);
        const pp = this.state.pluginPick;
        if (pp && pp.scanning) this.setState({ pluginPick: Object.assign({}, pp, { scanning: false }) });
    }

    pluginPickHome() {
        const pp = this.state.pluginPick;
        if (!pp || pp.loading) return;
        this.setState({ pluginPick: Object.assign({}, pp, { stage: 'home', error: null }) });
    }

    // Back: up one folder, then to the start list, then close.
    pluginPickBack() {
        const pp = this.state.pluginPick;
        if (!pp) return;
        if (pp.loading) return;
        if (pp.stage === 'browse') {
            if (pp.parent && pp.parent !== pp.path) { this.pluginPickBrowse(pp.parent); return; }
            this.pluginPickHome();
            return;
        }
        this.closePluginPick();
    }

    closePluginPick() {
        this._multicast(false);
        this.setState({ pluginPick: null });
    }

    _renderPluginPickModal() {
        const pp = this.state.pluginPick;
        if (!pp) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.closePluginPick();
        const err = pp.error ? createElement('p', { className: 'browse-error' }, pp.error) : null;
        const sizeText = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
        const loading = pp.loading ? this._loadingBlock('Please wait\u2026') : null;
        const what = pp.kind === 'skin' ? 'skin' : 'plugin';

        if (pp.stage === 'browse') {
            const rows = [];
            rows.push(ui.listRow('.. (back)', pp.parent && pp.parent !== pp.path ? pp.parent : 'Back to the start', () => this.pluginPickBack()));
            (pp.entries || []).forEach(e => {
                if (e.dir) rows.push(ui.listRow(e.name + '/', null, () => this.pluginPickBrowse(e.path)));
                else rows.push(ui.listRow(e.name, sizeText(e.size || 0), () => this.pluginPickChoose(e)));
            });
            if (!(pp.entries || []).length) rows.push(createElement('p', { className: 'sub' }, 'No folders or .zip files here.'));
            const body = createElement('div', {},
                createElement('div', { className: 'browse-path' }, pp.path || ''),
                err,
                loading,
                createElement('div', { className: 'browse-list plugin-list' }, ...rows)
            );
            return ui.modal('Choose a ' + what + ' .zip', body, close);
        }

        // Start list: library folders, this device, and the network.
        const rows = [];
        (pp.sources || []).forEach(src => rows.push(ui.listRow(String(src), 'Library folder', () => this.pluginPickBrowse(String(src)))));
        rows.push(ui.listRow('This device', 'Storage on this phone or box', () => this.pluginPickBrowse('@local')));
        rows.push(ui.listRow(pp.scanning ? 'Searching the network\u2026' : 'Search the network', 'Find shared folders on your Wi-Fi or Ethernet', () => this.pluginPickFindNetwork()));
        (pp.hosts || []).forEach(h => rows.push(ui.listRow(h.name || h.address, h.label || h.protocol || '', () => this.pluginPickBrowse(h.url))));
        if (this._pluginPickCanSystem()) {
            rows.push(ui.listRow('Use the system file picker', 'Opens this device\u2019s own file chooser', () => this.pluginPickSystem()));
        }
        const body = createElement('div', {},
            createElement('p', { className: 'sub' }, 'Pick the ' + what + '\u2019s .zip file. Put it in a folder on your network or on this device first.'),
            err,
            loading,
            createElement('div', { className: 'browse-list plugin-list' }, ...rows)
        );
        return ui.modal('Choose a ' + what + ' .zip', body, close);
    }

    async confirmPluginInstall() {
        const pi = this.state.pluginInstall;
        if (!pi || pi.stage !== 'confirm') return;
        const { ui } = this.props.engine;
        this.setState({ pluginInstall: Object.assign({}, pi, { stage: 'installing' }) });
        window.PekActivity.begin('install', 'Installing ' + pi.prep.name + '\u2026');
        try {
            await PekPluginInstaller.install(pi.prep);
            // Remember where it came from (GitHub, a store shelf); a plain .zip clears any old label.
            if (pi.prep.source) PekPluginSources.set(pi.prep.id, pi.prep.source); else PekPluginSources.remove(pi.prep.id);
            window.PekActivity.end('install', 'Installed ' + pi.prep.name);
            await this._reloadPlugins();
            this.setState({ pluginInstall: null });
            if (pi.prep.ui && pi.prep.ui.reloadOnInstall) {
                // This plugin changes PEK TV's own layout (it adds a tab), so the whole app reloads.
                ui.toast(`${pi.replaced ? 'Updated' : 'Installed'} ${pi.prep.name}. Reloading PEK TV\u2026`, 2500);
                setTimeout(() => { try { location.reload(); } catch (e) { /* stay on this screen */ } }, 1200);
                return;
            }
            ui.toast(`${pi.replaced ? 'Updated' : 'Installed'} ${pi.prep.name}` +
                (pi.prep.hasBackend ? '. Restart PEK TV to start its Python backend.' : ''), pi.prep.hasBackend ? 7000 : 3500);
        } catch (err) {
            window.PekActivity.end('install', 'Plugin install failed');
            this.setState({ pluginInstall: { stage: 'error', error: String((err && err.message) || err) } });
        }
    }

    cancelPluginInstall() {
        const pi = this.state.pluginInstall;
        if (pi && (pi.stage === 'checking' || pi.stage === 'installing')) return;   // can't stop mid-way
        this.setState({ pluginInstall: null });
    }

    askRemovePlugin(p) {
        if (PekPluginInstaller.isBuiltin(p.folder)) {
            this.props.engine.ui.toast(`${p.app_name} is built in and can't be removed.`);
            return;
        }
        const closeOnRemove = !!(p.manifest && p.manifest.ui && p.manifest.ui.closeOnRemove);
        this.setState({ pluginRemove: { folder: p.folder, name: p.app_name, busy: false, error: '', closeOnRemove } });
    }

    cancelRemovePlugin() {
        const pr = this.state.pluginRemove;
        if (pr && pr.busy) return;
        this.setState({ pluginRemove: null });
    }

    async confirmRemovePlugin() {
        const pr = this.state.pluginRemove;
        if (!pr || pr.busy) return;
        const { ui } = this.props.engine;
        this.setState({ pluginRemove: Object.assign({}, pr, { busy: true, error: '' }) });
        try {
            await PekPluginInstaller.remove(pr.folder);
            await this._reloadPlugins();
            this.setState({ pluginRemove: null });
            if (pr.closeOnRemove) { this._requireAppClose(pr.name); return; }
            ui.toast(`Removed ${pr.name}`);
        } catch (err) {
            this.setState({ pluginRemove: Object.assign({}, pr, { busy: false, error: String((err && err.message) || err) }) });
        }
    }

    // Re-reads the plugins folder and refreshes the list (and anything built from it).
    async _reloadPlugins() {
        const plugins = await this.props.engine.plugins.discover();
        this.setState({ pluginsList: plugins });
    }

    _renderPluginInstallModal() {
        const pi = this.state.pluginInstall;
        if (!pi) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.cancelPluginInstall();

        if (pi.stage === 'checking') {
            return ui.modal('Install plugin', createElement('div', { className: 'glass-panel' }, createElement('p', {}, 'Checking the plugin\u2026')), close);
        }
        if (pi.stage === 'error') {
            return ui.modal("Can't install this plugin", createElement('div', { className: 'glass-panel' }, createElement('p', {}, pi.error)), close);
        }

        const p = pi.prep;

        // Warning screen declared by the plugin itself (plugin.json "warning"). Plugins without one skip this.
        // (Close = cancel; the button moves on to the normal permissions screen.)
        if (pi.stage === 'confirm' && p.warning && !pi.warned) {
            const warnBody = createElement('div', {},
                createElement('div', { className: 'glass-panel' },
                    ...p.warning.text.map(t => createElement('p', {}, t))
                ),
                ui.button(p.warning.button, () => {
                    const cur = this.state.pluginInstall;
                    if (cur && cur.stage === 'confirm') this.setState({ pluginInstall: Object.assign({}, cur, { warned: true }) });
                }, { variant: 'primary' })
            );
            return ui.modal(p.warning.title, warnBody, close);
        }

        const net = p.network.length ? `Can connect to: ${p.network.join(', ')}` : 'No network access';
        const lines = [
            ...this._githubNotice(pi),
            [p.version ? `Version ${p.version}` : null, p.author ? `by ${p.author}` : null].filter(Boolean).join(' \u00b7 '),
            p.description,
            net,
            p.storage ? 'Can keep its own private data' : null,
            p.library ? 'Its Python code can read the titles and years in your library (never file names or folders).' : null,
            p.torrent ? 'Can search for releases and start torrent streams through PEK TV (it never sees your provider key). Streams download and upload from your connection.' : null,
            p.favorites ? 'Can add titles to your Favorites and remove them (it sees only which titles are favorites).' : null,
            p.watched ? 'Can see which movies and episodes you have marked as watched and mark them watched or unwatched (it sees nothing else from your history).' : null,
            p.device ? 'Can see what this device can play (which video codecs its hardware decodes, screen size, HDR support) so it can pick releases that run smoothly. No identifiers.' : null,
            p.providers ? 'Can show \u201cWatch on Netflix / Hulu / \u2026\u201d buttons. PEK TV decides what they open: the service\u2019s app on Android, its website elsewhere.' : null,
            p.plugins ? 'Can list your plugins that play titles and open one of them when you tap a button.' : null,
            p.stream ? 'Offers itself as a way to play movies and shows, so other plugins can show a \u201cPlay with ' + p.name + '\u201d button.' : null,
            p.ui && p.ui.navTab ? `Adds a \u201c${p.ui.navTab}\u201d tab to PEK TV.` : null,
            p.ui && p.ui.reloadOnInstall ? 'PEK TV reloads right after installing. Then close and reopen PEK TV once so the plugin\u2019s Python part starts.' : null,
            p.ui && p.ui.closeOnRemove ? 'Removing it later means closing PEK TV once to restore the normal layout.' : null,
            p.hasBackend ? 'Includes Python code that runs on this device after a restart. PEK TV only runs it if it declares its permissions and passes a safety scan, and then it can only reach the hosts listed above and its own data folder.' : null,
            pi.replaced ? 'This replaces the version you already have (its saved data is kept).' : null,
            'It runs in a sandbox and can only do the things listed here. Only install plugins from people you trust.'
        ].filter(Boolean);

        const installing = pi.stage === 'installing';
        const body = createElement('div', {},
            createElement('div', { className: 'glass-panel' },
                ...lines.map(t => createElement('p', {}, t))
            ),
            ui.button(installing ? 'Installing\u2026' : (pi.replaced ? 'Update plugin' : 'Install plugin'),
                () => this.confirmPluginInstall(), { variant: 'primary' })
        );
        return ui.modal(`${pi.replaced ? 'Update' : 'Install'} \u201c${p.name}\u201d?`, body, close);
    }

    // ---- "close PEK TV" screen: shown after removing a plugin that changed the layout ----
    // Kept in sessionStorage so a page reload does not dismiss it; it only goes away when the
    // app is really closed (the WebView and its sessionStorage are discarded).
    _readCloseFlag() {
        try {
            const v = sessionStorage.getItem('hesper_close_required');
            return v ? { name: v } : null;
        } catch (e) { return null; }
    }

    _requireAppClose(name) {
        try { sessionStorage.setItem('hesper_close_required', String(name || 'The plugin')); } catch (e) { /* kept in memory only */ }
        this.setState({ appClose: { name: String(name || 'The plugin') } });
    }

    _renderAppCloseModal() {
        const ac = this.state.appClose;
        if (!ac) return null;
        const { createElement } = this.props.engine;
        return createElement('div', { className: 'theme-panel-overlay' },
            createElement('div', { className: 'theme-panel' },
                createElement('h2', {}, 'Close PEK TV to finish'),
                createElement('div', { className: 'glass-panel' },
                    createElement('p', {}, `\u201c${ac.name}\u201d was removed. It had changed PEK TV\u2019s layout.`),
                    createElement('p', {}, 'Close PEK TV completely (on Android, swipe it away from your recent apps), then open it again. Your Movies and TV Shows will look the way they did before.')
                )
            )
        );
    }

    _renderPluginRemoveModal() {
        const pr = this.state.pluginRemove;
        if (!pr) return null;
        const { createElement, ui } = this.props.engine;
        const body = createElement('div', {},
            createElement('div', { className: 'glass-panel' },
                createElement('p', {}, `This deletes the plugin and its files from this device. You can install it again from its .zip.`),
                pr.closeOnRemove ? createElement('p', {}, 'This plugin changed PEK TV\u2019s layout. After removing it you will need to close PEK TV and open it again.') : null,
                pr.error ? createElement('p', {}, pr.error) : null
            ),
            ui.button(pr.busy ? 'Removing\u2026' : 'Remove plugin', () => this.confirmRemovePlugin(), { variant: 'primary' })
        );
        return ui.modal(`Remove \u201c${pr.name}\u201d?`, body, () => this.cancelRemovePlugin());
    }
}

pekMixin(MainApp, MainAppPluginsMethods);
