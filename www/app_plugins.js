// ============================================================
// MainApp: Plugins tab actions: install a plugin from a .zip, remove an installed plugin
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppPluginsMethods {

    async startPluginInstall() {
        if (this.state.pluginInstall) return;
        const { ui } = this.props.engine;
        let file = null;
        try {
            file = await HesperPluginInstaller.pickZip();
        } catch (err) {
            ui.toast("Couldn't open the file picker on this device.");
            return;
        }
        if (!file) return;

        this.setState({ pluginInstall: { stage: 'checking' } });
        try {
            const prep = await HesperPluginInstaller.prepare(file);
            const verdict = await HesperPluginInstaller.check(prep);
            this.setState({ pluginInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
        } catch (err) {
            this.setState({ pluginInstall: { stage: 'error', error: String((err && err.message) || err) } });
        }
    }

    async confirmPluginInstall() {
        const pi = this.state.pluginInstall;
        if (!pi || pi.stage !== 'confirm') return;
        const { ui } = this.props.engine;
        this.setState({ pluginInstall: Object.assign({}, pi, { stage: 'installing' }) });
        try {
            await HesperPluginInstaller.install(pi.prep);
            await this._reloadPlugins();
            this.setState({ pluginInstall: null });
            ui.toast(`${pi.replaced ? 'Updated' : 'Installed'} ${pi.prep.name}` +
                (pi.prep.hasBackend ? '. Restart Hesper to start its Python backend.' : ''), pi.prep.hasBackend ? 7000 : 3500);
        } catch (err) {
            this.setState({ pluginInstall: { stage: 'error', error: String((err && err.message) || err) } });
        }
    }

    cancelPluginInstall() {
        const pi = this.state.pluginInstall;
        if (pi && (pi.stage === 'checking' || pi.stage === 'installing')) return;   // can't stop mid-way
        this.setState({ pluginInstall: null });
    }

    askRemovePlugin(p) {
        if (HesperPluginInstaller.isBuiltin(p.folder)) {
            this.props.engine.ui.toast(`${p.app_name} is built in and can't be removed.`);
            return;
        }
        this.setState({ pluginRemove: { folder: p.folder, name: p.app_name, busy: false, error: '' } });
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
            await HesperPluginInstaller.remove(pr.folder);
            await this._reloadPlugins();
            this.setState({ pluginRemove: null });
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
        const net = p.network.length ? `Can connect to: ${p.network.join(', ')}` : 'No network access';
        const lines = [
            [p.version ? `Version ${p.version}` : null, p.author ? `by ${p.author}` : null].filter(Boolean).join(' \u00b7 '),
            p.description,
            net,
            p.storage ? 'Can keep its own private data' : null,
            p.hasBackend ? 'Includes Python code that runs on this device after a restart. Hesper only runs it if it declares its permissions and passes a safety scan, and then it can only reach the hosts listed above and its own data folder.' : null,
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

    _renderPluginRemoveModal() {
        const pr = this.state.pluginRemove;
        if (!pr) return null;
        const { createElement, ui } = this.props.engine;
        const body = createElement('div', {},
            createElement('div', { className: 'glass-panel' },
                createElement('p', {}, `This deletes the plugin and its files from this device. You can install it again from its .zip.`),
                pr.error ? createElement('p', {}, pr.error) : null
            ),
            ui.button(pr.busy ? 'Removing\u2026' : 'Remove plugin', () => this.confirmRemovePlugin(), { variant: 'primary' })
        );
        return ui.modal(`Remove \u201c${pr.name}\u201d?`, body, () => this.cancelRemovePlugin());
    }
}

hesperMixin(MainApp, MainAppPluginsMethods);
