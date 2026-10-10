// ============================================================
// MainApp: Skins actions: install a skin from a .zip, remove an installed skin.
// Loaded after app_plugins.js. These methods are added to MainApp.prototype.
// The .zip picker is the same one plugins use (startPluginInstall('skin')).
// ============================================================

class MainAppSkinsMethods {

    startSkinInstall() {
        this.startPluginInstall('skin');
    }

    // Reads the chosen .zip, shows what it is, and checks it with the server.
    async _checkSkinFile(file) {
        this.setState({ skinInstall: { stage: 'checking' } });
        try {
            const prep = await HesperSkinInstaller.prepare(file);
            const verdict = await HesperSkinInstaller.check(prep);
            this.setState({ skinInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
        } catch (err) {
            this.setState({ skinInstall: { stage: 'error', error: String((err && err.message) || err) } });
        }
    }

    async confirmSkinInstall() {
        const si = this.state.skinInstall;
        if (!si || si.stage !== 'confirm') return;
        const { ui } = this.props.engine;
        this.setState({ skinInstall: Object.assign({}, si, { stage: 'installing' }) });
        try {
            await HesperSkinInstaller.install(si.prep);
            await this.loadSkins();
            // A skin that was updated while it was in use is re-applied so the new look shows at once.
            if (this.state.activeSkin === si.prep.id) this.applySkin(si.prep.id);
            this.setState({ skinInstall: null });
            ui.toast(`${si.replaced ? 'Updated' : 'Installed'} ${si.prep.name}. Tap it in Skins to use it.`, 4500);
        } catch (err) {
            this.setState({ skinInstall: { stage: 'error', error: String((err && err.message) || err) } });
        }
    }

    cancelSkinInstall() {
        const si = this.state.skinInstall;
        if (si && (si.stage === 'checking' || si.stage === 'installing')) return;   // can't stop mid-way
        this.setState({ skinInstall: null });
    }

    _renderSkinInstallModal() {
        const si = this.state.skinInstall;
        if (!si) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.cancelSkinInstall();

        if (si.stage === 'checking') {
            return ui.modal('Install skin', createElement('div', { className: 'glass-panel' }, createElement('p', {}, 'Checking the skin\u2026')), close);
        }
        if (si.stage === 'error') {
            return ui.modal("Can't install this skin", createElement('div', { className: 'glass-panel' }, createElement('p', {}, si.error)), close);
        }

        const p = si.prep;
        const lines = [
            [p.version ? `Version ${p.version}` : null, p.author ? `by ${p.author}` : null].filter(Boolean).join(' \u00b7 '),
            p.description,
            p.tokenCount ? `Sets ${p.tokenCount} colours and sizes` + (p.hasCss ? ' and adds its own styling.' : '.') : (p.hasCss ? 'Adds its own styling.' : null),
            si.replaced ? 'This replaces the version you already have.' : null,
            'A skin only changes how PEK TV looks. It can\u2019t run code or reach the network.'
        ].filter(Boolean);
        const installing = si.stage === 'installing';
        const body = createElement('div', {},
            createElement('div', { className: 'glass-panel' }, ...lines.map(t => createElement('p', {}, t))),
            ui.button(installing ? 'Installing\u2026' : (si.replaced ? 'Update skin' : 'Install skin'),
                () => this.confirmSkinInstall(), { variant: 'primary' })
        );
        return ui.modal(`${si.replaced ? 'Update' : 'Install'} \u201c${p.name}\u201d?`, body, close);
    }

    // ---- remove ----

    askRemoveSkin(s) {
        if (HesperSkinInstaller.isBuiltin(s.id)) {
            this.props.engine.ui.toast(`${s.name} is built in and can't be removed.`);
            return;
        }
        this.setState({ skinRemove: { id: s.id, name: s.name, busy: false, error: '' } });
    }

    cancelRemoveSkin() {
        const sr = this.state.skinRemove;
        if (sr && sr.busy) return;
        this.setState({ skinRemove: null });
    }

    async confirmRemoveSkin() {
        const sr = this.state.skinRemove;
        if (!sr || sr.busy) return;
        const { ui } = this.props.engine;
        this.setState({ skinRemove: Object.assign({}, sr, { busy: true, error: '' }) });
        try {
            await HesperSkinInstaller.remove(sr.id);
            // If it was the skin in use, go back to the default look first.
            if (this.state.activeSkin === sr.id) this.applySkin('default');
            await this.loadSkins();
            this.setState({ skinRemove: null });
            ui.toast(`Removed ${sr.name}`);
        } catch (err) {
            this.setState({ skinRemove: Object.assign({}, sr, { busy: false, error: String((err && err.message) || err) }) });
        }
    }

    _renderSkinRemoveModal() {
        const sr = this.state.skinRemove;
        if (!sr) return null;
        const { createElement, ui } = this.props.engine;
        const body = createElement('div', {},
            createElement('div', { className: 'glass-panel' },
                createElement('p', {}, 'This deletes the skin and its files from this device. You can install it again from its .zip.'),
                this.state.activeSkin === sr.id ? createElement('p', {}, 'It is the skin in use, so PEK TV goes back to the default look.') : null,
                sr.error ? createElement('p', {}, sr.error) : null
            ),
            ui.button(sr.busy ? 'Removing\u2026' : 'Remove skin', () => this.confirmRemoveSkin(), { variant: 'primary' })
        );
        return ui.modal(`Remove \u201c${sr.name}\u201d?`, body, () => this.cancelRemoveSkin());
    }
}

hesperMixin(MainApp, MainAppSkinsMethods);
