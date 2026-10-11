// ============================================================
// MainApp: Torrent settings
// Loaded after app.js. These methods are added to MainApp.prototype.
//
// PEK TV has no built-in torrent search site. You give it the address of your own Torznab
// provider (Jackett, Prowlarr, ...) here; plugins with the "torrent" permission then search
// and stream through it without ever seeing the address or key.
// ============================================================

class MainAppTorrentMethods {

    // The "Torrents" block shown in Settings.
    _renderTorrentSettings() {
        const { createElement, ui } = this.props.engine;
        return createElement('div', { className: 'settings-section' },
            createElement('h2', {}, 'Torrents'),
            createElement('p', { className: 'sub' },
                'Add a Torznab search provider (Jackett or Prowlarr) so plugins can look up releases.',
                createElement('span', { className: 'sub-more' }, ' Plugins with the torrent permission do the streaming.')),
            createElement('div', { className: 'section-actions' },
                ui.button('Torrent settings', () => this.openTorrentSettings(), { variant: 'primary' })
            )
        );
    }

    async openTorrentSettings() {
        this._tProvUrl = '';
        this._tProvKey = '';
        this.setState({ torrentModal: { stage: 'settings', loading: true, error: '', note: '' } });
        try {
            const [info, cfg] = await Promise.all([window.PekTorrent.info(), window.PekTorrent.getSettings()]);
            this._tProvUrl = cfg.url || '';
            this.setState({ torrentModal: { stage: 'settings', loading: false, error: '', note: '', info, hasKey: cfg.hasKey } });
        } catch (e) {
            this.setState({ torrentModal: { stage: 'settings', loading: false, error: e.message, note: '' } });
        }
    }

    async saveTorrentSettings() {
        const m = this.state.torrentModal || {};
        try {
            await window.PekTorrent.saveSettings((this._tProvUrl || '').trim(), (this._tProvKey || '').trim());
            this._tProvKey = '';
            const cfg = await window.PekTorrent.getSettings();
            this.setState({ torrentModal: { ...m, error: '', note: cfg.url ? 'Saved.' : 'Provider removed.', hasKey: cfg.hasKey } });
        } catch (e) {
            this.setState({ torrentModal: { ...m, error: e.message, note: '' } });
        }
    }

    async testTorrentSettings() {
        const m = this.state.torrentModal || {};
        this.setState({ torrentModal: { ...m, error: '', note: 'Testing\u2026' } });
        try {
            const r = await window.PekTorrent.search({ kind: 'movie', title: 'Sintel', year: 2010 });
            this.setState({ torrentModal: { ...m, error: '', note: `The provider answered (${r.length} matching release${r.length === 1 ? '' : 's'} for a test search).` } });
        } catch (e) {
            this.setState({ torrentModal: { ...m, error: e.message, note: '' } });
        }
    }

    _renderTorrentModal() {
        const m = this.state.torrentModal;
        if (!m) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.setState({ torrentModal: null });
        const err = m.error ? createElement('p', { className: 'browse-error' }, m.error) : null;

        if (m.loading) {
            return ui.modal('Torrent settings', createElement('div', { className: 'glass-panel' }, createElement('p', {}, 'Loading\u2026')), close);
        }
        const built = m.info && m.info.available;
        return ui.modal('Torrent settings', createElement('div', {},
            createElement('p', { className: 'sub' }, m.info
                ? (built ? 'Torrent playback is built into this PEK TV.'
                         : 'This build of PEK TV does not include the torrent engine, so releases can be searched but not played.')
                : ''),
            err,
            m.note ? createElement('p', { className: 'sub' }, m.note) : null,
            ui.textInput('Search provider address (Torznab)', this._tProvUrl || '', (v) => { this._tProvUrl = v; },
                { placeholder: 'http://192.168.1.10:9117/api/v2.0/indexers/all/results/torznab/api' }),
            ui.textInput(m.hasKey ? 'API key (saved \u2014 leave blank to keep it)' : 'API key', this._tProvKey || '', (v) => { this._tProvKey = v; }, { type: 'password' }),
            createElement('p', { className: 'sub' }, 'Clear the address and save to remove the provider and its key. The key is stored on this device and never shown again.'),
            createElement('div', { className: 'section-actions' },
                ui.button('Save', () => this.saveTorrentSettings(), { variant: 'primary' }),
                ui.button('Test', () => this.testTorrentSettings()))
        ), close);
    }
}

pekMixin(MainApp, MainAppTorrentMethods);
