// ============================================================
// MainApp: Torrent settings
// Loaded after app.js. These methods are added to MainApp.prototype.
//
// PEK has no built-in torrent search site. You give it the address of your own Torznab
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
                'Stream a torrent while it downloads. Add your own search provider (a Torznab address from Jackett or Prowlarr) so plugins can look up releases for a movie or episode.'),
            createElement('div', { className: 'section-actions' },
                ui.button('Torrent settings', () => this.openTorrentSettings(), { variant: 'primary' }),
                ui.button('Play a magnet link', () => this.setState({ torrentModal: { stage: 'magnet', error: '' } }))
            )
        );
    }

    async openTorrentSettings() {
        this._tProvUrl = '';
        this._tProvKey = '';
        this.setState({ torrentModal: { stage: 'settings', loading: true, error: '', note: '' } });
        try {
            const [info, cfg] = await Promise.all([window.HesperTorrent.info(), window.HesperTorrent.getSettings()]);
            this._tProvUrl = cfg.url || '';
            this.setState({ torrentModal: { stage: 'settings', loading: false, error: '', note: '', info, hasKey: cfg.hasKey } });
        } catch (e) {
            this.setState({ torrentModal: { stage: 'settings', loading: false, error: e.message, note: '' } });
        }
    }

    async saveTorrentSettings() {
        const m = this.state.torrentModal || {};
        try {
            await window.HesperTorrent.saveSettings((this._tProvUrl || '').trim(), (this._tProvKey || '').trim());
            this._tProvKey = '';
            const cfg = await window.HesperTorrent.getSettings();
            this.setState({ torrentModal: { ...m, error: '', note: cfg.url ? 'Saved.' : 'Provider removed.', hasKey: cfg.hasKey } });
        } catch (e) {
            this.setState({ torrentModal: { ...m, error: e.message, note: '' } });
        }
    }

    async testTorrentSettings() {
        const m = this.state.torrentModal || {};
        this.setState({ torrentModal: { ...m, error: '', note: 'Testing\u2026' } });
        try {
            const r = await window.HesperTorrent.search({ kind: 'movie', title: 'Sintel', year: 2010 });
            this.setState({ torrentModal: { ...m, error: '', note: `The provider answered (${r.length} matching release${r.length === 1 ? '' : 's'} for a test search).` } });
        } catch (e) {
            this.setState({ torrentModal: { ...m, error: e.message, note: '' } });
        }
    }

    async playMagnetLink() {
        const link = (this._tMagnet || '').trim();
        if (!/^magnet:\?/i.test(link)) {
            this.setState({ torrentModal: { stage: 'magnet', error: 'Paste a link that starts with magnet:?' } });
            return;
        }
        this.setState({ torrentModal: null });
        try {
            await window.HesperTorrent.open({ source: link, title: 'Magnet link' });
        } catch (e) {
            if (e.message !== 'Cancelled') this.props.engine.ui.toast(e.message, 6000);
        }
    }

    _renderTorrentModal() {
        const m = this.state.torrentModal;
        if (!m) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this.setState({ torrentModal: null });
        const err = m.error ? createElement('p', { className: 'browse-error' }, m.error) : null;

        if (m.stage === 'magnet') {
            return ui.modal('Play a magnet link', createElement('div', {},
                createElement('p', { className: 'sub' }, 'Paste a magnet link. PEK downloads the start, then opens the player while the rest arrives.'),
                err,
                ui.textInput('Magnet link', this._tMagnet || '', (v) => { this._tMagnet = v; }, { placeholder: 'magnet:?xt=urn:btih:\u2026' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Play', () => this.playMagnetLink(), { variant: 'primary' }))
            ), close);
        }

        if (m.loading) {
            return ui.modal('Torrent settings', createElement('div', { className: 'glass-panel' }, createElement('p', {}, 'Loading\u2026')), close);
        }
        const built = m.info && m.info.available;
        return ui.modal('Torrent settings', createElement('div', {},
            createElement('p', { className: 'sub' }, m.info
                ? (built ? 'Torrent playback is built into this PEK.'
                         : 'This build of PEK does not include the torrent engine, so releases can be searched but not played.')
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

hesperMixin(MainApp, MainAppTorrentMethods);
