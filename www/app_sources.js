// ============================================================
// MainApp: Sources: folder picker, network picker/discovery, adding/removing/scanning sources
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppSourcesMethods {

    // ---------------- Online / offline ----------------
    // net.js draws the green/red dot and reports changes. Offline mode: the local
    // library keeps working, internet-only things wait until the network is back.
    _watchNetwork() {
        const net = window.HesperNet;
        if (!net) return;
        const { ui } = this.props.engine;
        net.onChange((online) => {
            ui.toast(online ? 'Back online' : 'Offline mode: your local library only');
            if (online) {
                this._autoSync();
                // fetch the poster art that was skipped while offline
                ['movies', 'shows'].forEach(t => {
                    const d = this.state.library[t];
                    if (d && !d.error) this._queuePostersFor(t, d);
                });
            }
        });
    }

    // ---------------- Media sources / folder picker ----------------

    async loadSources() {
        try {
            const res = await fetch('/api/sources');
            const data = await res.json();
            this.setState({ sources: data.sources || [] });
        } catch (err) {
            console.warn('[Hesper] Could not load sources:', err);
        }
    }

    async openPicker(path) {
        const previous = this.state.picker || {};
        this.setState({ picker: { ...previous, loading: true, error: null } });
        try {
            const url = '/api/browse' + (path ? `?path=${encodeURIComponent(path)}` : '');
            const res = await fetch(url);
            const data = await res.json();
            if (!this.state.picker) return; // closed while loading
            this.setState({
                picker: {
                    loading: false,
                    error: null,
                    path: data.path,
                    parent: data.parent,
                    dirs: data.directories || []
                }
            });
        } catch (err) {
            if (!this.state.picker) return;
            this.setState({
                picker: { loading: false, error: 'Could not reach /api/browse', path: path || '', parent: '', dirs: [] }
            });
        }
    }

    closePicker() {
        this.setState({ picker: null });
    }

    async _addSourceImpl(path) {
        try {
            const res = await fetch(`/api/sources?path=${encodeURIComponent(path)}`, { method: 'POST' });
            if (!res.ok) throw new Error('Server rejected folder');
            this.closePicker();
            await this.loadSources();
            // The scan runs in the background on the server; refresh the library shortly after.
            setTimeout(() => this.refreshLibrary(), 4000);
        } catch (err) {
            this.setState({ picker: { ...this.state.picker, error: 'Could not add that folder.' } });
        }
    }

    // ---------------- Network folders (SMB, NFS, FTP, WebDAV and DLNA found on the local network) ----------------

    // Wi-Fi drops multicast packets unless Android is told to let them through
    // (the app holds a MulticastLock only while searching).
    _multicast(on) {
        try {
            if (window.HesperAndroid && typeof window.HesperAndroid.setMulticast === 'function') window.HesperAndroid.setMulticast(!!on);
        } catch (e) { /* the port scan still finds hosts without it */ }
    }

    async openNetPicker() {
        this._netUser = ''; this._netPass = ''; this._netManual = ''; this._netShare = ''; this._netTried = false;
        this._netHosts = []; this._netUnsupported = [];
        this._netSig = '';
        this.setState({ netPicker: { stage: 'hosts', scanning: true, hosts: [], unsupported: [], error: null } });
        await this._startDiscovery();
    }

    async _startDiscovery() {
        this._multicast(true);
        try { await fetch('/api/discover', { method: 'POST' }); } catch (e) { /* polled below anyway */ }
        this._pollDiscovery(0);
    }

    async searchNetwork() {
        const np = this.state.netPicker;
        if (!np || np.scanning) return;
        this._netSig = '';
        this.setState({ netPicker: { ...np, stage: 'hosts', scanning: true, error: null } });
        await this._startDiscovery();
    }

    async _pollDiscovery(n) {
        try {
            const res = await fetch('/api/discover');
            const data = await res.json();
            const np = this.state.netPicker;
            if (!np) { this._multicast(false); return; }
            this._netHosts = data.hosts || [];
            this._netUnsupported = data.unsupported || [];
            // Re-render only when something visible changed: every re-render replays
            // the window's fade-in, which showed up as the window blinking once a second.
            const sig = JSON.stringify([this._netHosts, !!data.scanning, this._netUnsupported]);
            if (sig !== this._netSig) {
                this._netSig = sig;
                if (np.stage === 'hosts') {
                    this.setState({ netPicker: { ...np, hosts: this._netHosts, scanning: !!data.scanning, unsupported: this._netUnsupported } });
                }
            }
            if (data.scanning && n < 20) { setTimeout(() => this._pollDiscovery(n + 1), 1000); return; }
        } catch (e) { /* stop searching */ }
        this._multicast(false);
        const np = this.state.netPicker;
        if (np && np.stage === 'hosts' && np.scanning) this.setState({ netPicker: { ...np, scanning: false } });
    }

    closeNetPicker() {
        this._multicast(false);
        this.setState({ netPicker: null });
    }

    // What the user typed in "Or type an address": a full URL (ftp://nas, dav://nas:8080/files,
    // nfs://nas ...) is used as is; a bare name or IP means an SMB share.
    _netTypedUrl(text) {
        const t = String(text || '').trim();
        if (!t) return '';
        return /^[a-z]+:\/\//i.test(t) ? t : 'smb://' + t;
    }

    _netOpenTyped() {
        this._netUser = ''; this._netPass = ''; this._netTried = false;
        const url = this._netTypedUrl(this._netManual);
        if (!url) {
            this.setState({ netPicker: { ...this.state.netPicker, error: 'Enter the address of the device first.' } });
            return;
        }
        return this.netBrowse(url, false);
    }

    _netOpenHost(host) {
        this._netUser = ''; this._netPass = ''; this._netTried = false;
        return this.netBrowse(host.url, false);
    }

    // Shows the shares of a host or the folders inside a location (url = smb://..., ftp://..., etc.).
    async netBrowse(url, withCreds) {
        this.setState({ netPicker: { ...this.state.netPicker, loading: true, error: null } });
        const body = new URLSearchParams({ url });
        if (withCreds) { body.set('user', this._netUser || ''); body.set('pass', this._netPass || ''); }
        try {
            const res = await fetch('/api/net/browse', { method: 'POST', body });
            const data = await res.json();
            if (!this.state.netPicker) return;
            if (!data.ok) {
                if (data.auth) {
                    this.setState({ netPicker: { stage: 'login', url, loading: false,
                        error: this._netTried ? 'Wrong user name or password.' : null } });
                } else if (data.canTypeShare) {
                    this.setState({ netPicker: { stage: 'share', url, loading: false, error: data.error } });
                } else {
                    this.setState({ netPicker: { ...this.state.netPicker, loading: false, error: data.error || 'Could not open that location.' } });
                }
                return;
            }
            this.setState({ netPicker: {
                stage: 'browse', loading: false, error: null, scheme: data.scheme,
                path: data.path, parent: data.parent, addable: !!data.addable, shares: data.shares || [], dirs: data.directories || []
            } });
        } catch (err) {
            if (!this.state.netPicker) return;
            this.setState({ netPicker: { ...this.state.netPicker, loading: false, error: 'Could not reach the PEK TV server.' } });
        }
    }

    netSignIn() {
        const np = this.state.netPicker;
        this._netTried = true;
        return this.netBrowse(np.url, true);
    }

    // The window goes back to the device list: re-render it with what was found.
    _netToHosts() {
        this.setState({ netPicker: { stage: 'hosts', scanning: false, hosts: this._netHosts || [], unsupported: this._netUnsupported || [], error: null } });
    }

    // Back inside the network picker: up a folder, then back to the device list, then close.
    netBack() {
        const np = this.state.netPicker;
        if (!np) return;
        if (np.stage === 'browse' && np.parent) { this.netBrowse(np.parent, false); return; }
        if (np.stage !== 'hosts') { this._netToHosts(); return; }
        this.closeNetPicker();
    }

    async _addNetSourceImpl(url) {
        const body = new URLSearchParams({ path: url });
        if (this._netUser) { body.set('user', this._netUser); body.set('pass', this._netPass || ''); }
        try {
            const res = await fetch('/api/sources', { method: 'POST', body });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                this.setState({ netPicker: { ...this.state.netPicker, error: data.message || 'Could not add that folder.' } });
                return;
            }
            this.closeNetPicker();
            await this.loadSources();
            // The first scan of a network folder takes longer than a local one.
            setTimeout(() => this.refreshLibrary(), 4000);
            setTimeout(() => this.refreshLibrary(), 15000);
        } catch (err) {
            this.setState({ netPicker: { ...this.state.netPicker, error: 'Could not reach the PEK TV server.' } });
        }
    }

    async removeSource(path) {
        try {
            await fetch(`/api/sources?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
        } catch (err) {
            console.warn('[Hesper] Could not remove source:', err);
        }
        await this.loadSources();
        this.refreshLibrary();
    }

    // Manual refresh: rate limited to once per 10 seconds (the server enforces
    // the same limit), then waits for the scan to finish and reloads the list.
    _startCooldown(seconds) {
        clearInterval(this._cooldownTimer);
        this.setState({ refreshCooldown: seconds });
        this._cooldownTimer = setInterval(() => {
            const left = this.state.refreshCooldown - 1;
            if (left <= 0) {
                clearInterval(this._cooldownTimer);
                this.setState({ refreshCooldown: 0 });
            } else {
                this.setState({ refreshCooldown: left });
            }
        }, 1000);
    }

    // ---------------- Loading ring ----------------
    _ring(big) {
        return this.props.engine.createElement('div', { className: 'hs-ring' + (big ? ' lg' : '') });
    }

    _loadingBlock(text) {
        const { createElement } = this.props.engine;
        return createElement('div', { className: 'hs-loading' }, this._ring(false), createElement('span', { className: 'sub' }, text));
    }

    _setBusy(msg) { this.setState({ busy: msg || '' }); }

    // Waits for the server's background scan to finish (checks once a second).
    async _waitForScan(maxSec) {
        window.HesperActivity.begin('scan', 'Scanning your media folders\u2026');
        for (let i = 0; i < maxSec; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const st = await fetch('/api/scan-status').then(r => r.json()).catch(() => ({ scanning: false }));
            if (!st.scanning) break;
        }
        window.HesperActivity.end('scan', 'Scan finished');
    }

    _renderBusy() {
        const { createElement } = this.props.engine;
        const np = this.state.netPicker;
        const text = this.state.busy
            || (this.state.refreshing ? 'Scanning your library\u2026' : '')
            || (np && np.loading ? 'Connecting\u2026' : '');
        if (!text) return null;
        return createElement('div', { className: 'hs-busy' }, this._ring(true), createElement('div', {}, text));
    }

    async addSource(path) {
        this._setBusy('Adding folder\u2026');
        try {
            await this._addSourceImpl(path);
            this._setBusy('Scanning your library\u2026');
            await this._waitForScan(60);
            this.refreshLibrary();
        } finally { this._setBusy(''); }
    }

    async addNetSource(url) {
        this._setBusy('Adding network folder\u2026');
        try {
            await this._addNetSourceImpl(url);
            this._setBusy('Scanning your library\u2026');
            await this._waitForScan(120);
            this.refreshLibrary();
        } finally { this._setBusy(''); }
    }

    async rescan() {
        if (this.state.refreshCooldown > 0 || this.state.refreshing) return;
        this._startCooldown(10);
        this.setState({ refreshing: true });
        window.HesperActivity.begin('scan', 'Scanning your media folders\u2026');
        try {
            const res = await fetch('/api/rescan', { method: 'POST' });
            if (res.status === 429) {
                const d = await res.json().catch(() => ({}));
                this._startCooldown(d.retry_after || 10);
            } else {
                // Poll until the server says the scan is done (max ~60 s).
                for (let i = 0; i < 60; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const st = await fetch('/api/scan-status').then(r => r.json()).catch(() => ({ scanning: false }));
                    if (!st.scanning) break;
                }
            }
        } catch (err) {
            console.warn('[Hesper] Rescan failed:', err);
        }
        window.HesperActivity.end('scan', 'Scan finished');
        this.setState({ refreshing: false });
        this.refreshLibrary();
    }

    _renderPicker() {
        const { picker } = this.state;
        if (!picker) return null;
        const { createElement, ui } = this.props.engine;

        let body;
        if (picker.loading && !picker.path) {
            body = this._loadingBlock('Loading folders\u2026');
        } else {
            const rows = [];
            if (picker.parent && picker.parent !== picker.path) {
                rows.push(ui.listRow('.. (up one level)', picker.parent, () => this.openPicker(picker.parent)));
            }
            (picker.dirs || []).forEach(d => {
                rows.push(ui.listRow(d.name, null, () => this.openPicker(d.path)));
            });
            if (!(picker.dirs || []).length) {
                rows.push(createElement('p', { className: 'sub' }, 'No subfolders here.'));
            }

            body = createElement('div', {},
                createElement('p', { className: 'sub' }, 'Current folder:'),
                createElement('div', { className: 'browse-path' }, picker.path || ''),
                picker.error ? createElement('p', { className: 'browse-error' }, picker.error) : null,
                createElement('div', { className: 'browse-list plugin-list' }, ...rows),
                createElement('div', { className: 'section-actions' },
                    ui.button('Add this folder', () => this.addSource(picker.path), { variant: 'primary' })
                )
            );
        }

        return ui.modal('Choose a Media Folder', body, () => this.closePicker());
    }

    _renderNetPicker() {
        const np = this.state.netPicker;
        if (!np) return null;
        const { createElement, ui } = this.props.engine;
        const err = np.error ? createElement('p', { className: 'browse-error' }, np.error) : null;
        let body;

        if (np.stage === 'hosts') {
            const hosts = np.hosts || [];
            const rows = hosts.map(h => ui.listRow(h.name, `${h.label}${h.name === h.address ? '' : ' \u00b7 ' + h.address}`, () => this._netOpenHost(h)));
            if (!hosts.length) {
                rows.push(createElement('p', { className: 'sub' }, np.scanning
                    ? 'Searching your network\u2026'
                    : 'Nothing found. Check that this device and the share are on the same Wi-Fi, or type the address below.'));
            } else if (np.scanning) {
                rows.push(createElement('p', { className: 'sub' }, 'Still searching\u2026'));
            }
            const missing = (np.unsupported || []).map(x => x.toUpperCase());
            body = createElement('div', {},
                missing.length
                    ? createElement('p', { className: 'browse-error' }, `This build can find ${missing.join(' / ')} devices but cannot open them (no ${missing.join(' / ')} support).`)
                    : null,
                createElement('p', { className: 'sub' }, 'Devices sharing files on your network:'),
                createElement('div', { className: 'browse-list plugin-list' }, ...rows),
                err,
                ui.textInput('Or type an address', this._netManual || '', (v) => { this._netManual = v; }, { placeholder: 'my-nas   or   ftp://192.168.1.20   or   dav://nas:8080' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Open', () => this._netOpenTyped(), { variant: 'primary' }),
                    ui.button(np.scanning ? 'Searching\u2026' : 'Search again', () => this.searchNetwork())
                )
            );
        } else if (np.stage === 'login') {
            body = createElement('div', {},
                createElement('p', { className: 'sub' }, `Sign in to ${np.url}`),
                err,
                ui.textInput('User name', this._netUser || '', (v) => { this._netUser = v; }, { placeholder: 'user or DOMAIN\\user' }),
                ui.textInput('Password', this._netPass || '', (v) => { this._netPass = v; }, { type: 'password' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Sign in', () => this.netSignIn(), { variant: 'primary' }),
                    ui.button('Back', () => this.netBack())
                )
            );
        } else if (np.stage === 'share') {
            const base = String(np.url || '').replace(/\/+$/, '');
            body = createElement('div', {},
                createElement('p', { className: 'sub' }, `Could not list the shares on ${base}. Type the share name instead.`),
                np.error ? createElement('p', { className: 'browse-error' }, np.error) : null,
                ui.textInput('Share name', this._netShare || '', (v) => { this._netShare = v; }, { placeholder: 'Media' }),
                createElement('div', { className: 'section-actions' },
                    ui.button('Open', () => {
                        const name = (this._netShare || '').trim().replace(/^\/+/, '');
                        // NFS exports are paths (/srv/media); the server expects them percent-encoded.
                        const seg = base.startsWith('nfs://') ? encodeURIComponent(name.startsWith('/') ? name : '/' + name) : name;
                        if (name) this.netBrowse(base + '/' + seg, false);
                    }, { variant: 'primary' }),
                    ui.button('Back', () => this.netBack())
                )
            );
        } else {
            const rows = [];
            rows.push(ui.listRow(np.parent ? '.. (up one level)' : '.. (back to devices)', np.parent || null, () => this.netBack()));
            (np.shares || []).forEach(sh => rows.push(ui.listRow(sh.name, 'Share', () => this.netBrowse(sh.path, false))));
            (np.dirs || []).forEach(d => rows.push(ui.listRow(d.name, null, () => this.netBrowse(d.path, false))));
            if (!(np.shares || []).length && !(np.dirs || []).length) {
                rows.push(createElement('p', { className: 'sub' }, np.addable ? 'No subfolders here.' : 'No shares found on this device.'));
            }
            body = createElement('div', {},
                createElement('p', { className: 'sub' }, np.addable ? 'Current folder:' : 'Choose a share:'),
                createElement('div', { className: 'browse-path' }, np.path || ''),
                err,
                createElement('div', { className: 'browse-list plugin-list' }, ...rows),
                np.addable
                    ? createElement('div', { className: 'section-actions' },
                        ui.button('Add this folder', () => this.addNetSource(np.path), { variant: 'primary' }))
                    : null
            );
        }
        return ui.modal('Add Network Folder', body, () => this.closeNetPicker());
    }
}

hesperMixin(MainApp, MainAppSourcesMethods);
