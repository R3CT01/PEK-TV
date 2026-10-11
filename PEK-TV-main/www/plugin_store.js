// ============================================================
// PEK Store (in the app): browse and install. Nothing else.
//
//   PEK Official      plugins published by the owner.
//   Community         plugins other people uploaded on the GitHub Pages site and the owner approved.
//
// Uploading is NOT done from the app. People upload on the GitHub Pages site (site/), signed in
// with GitHub; the owner reviews there too. Downloading needs no account.
// Installing goes through the usual checks: the server's safety checks, the author's warning screen
// and the permissions screen, then a confirm. Nothing is ever installed by itself.
//
// Setup: cloud/DEPLOY.md -> STORE-DEPLOY.md.
// ============================================================

// Shown to users as "want to share one? go to ...". Put your GitHub Pages address here (leave '' to hide the line).
const PEK_SUBMIT_SITE = '';

// The PEK Store worker (separate from the sync worker). See cloud/STORE-DEPLOY.md.
const PEK_STORE_API = 'https://pek-store.aquariusibeats.workers.dev';

const PekPluginStore = (() => {
    const I = () => window.PekPluginInstaller;
    const base = () => PEK_STORE_API;

    function fromB64(b64) {
        const bin = atob(b64), out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function fingerprint(str) {
        let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
            h2 ^= h2 >>> 13;
        }
        return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
    }

    async function get(path) {
        let res;
        try { res = await fetch(base() + path); }
        catch (e) { throw new Error("Couldn't reach the PEK Store. Check your connection."); }
        let data = null;
        try { data = await res.json(); } catch (e) { /* not JSON */ }
        if (!res.ok || !data || data.ok === false) {
            throw new Error(data && data.error === 'not_found' ? 'That plugin is no longer in the store.' : 'The PEK Store gave an unexpected answer.');
        }
        return data;
    }

    const list = async (shelf, kind) => (await get('/v1/store?shelf=' + shelf + '&kind=' + (kind === 'skin' ? 'skin' : 'plugin'))).items || [];

    // Downloads an item and turns it into what the install screen needs.
    async function download(item) {          // item.kind is 'plugin' or 'skin'
        const parts = [];
        for (let i = 0; i < item.chunks; i++) {
            parts.push((await get('/v1/store/chunk?id=' + encodeURIComponent(item.id) + '&fp=' + item.fp + '&i=' + i)).data);
        }
        const bundle = parts.join('');
        if (fingerprint(bundle) !== item.fp) throw new Error('The download was damaged. Try again.');
        let files;
        try { files = JSON.parse(bundle).files.map(f => ({ path: f.p, data: fromB64(f.d) })); }
        catch (e) { throw new Error('The download was damaged. Try again.'); }
        return item.kind === 'skin' ? window.PekSkinInstaller.prepareFiles(item.id, files) : I().prepareFiles(item.id, files);
    }

    return { list, download };
})();
if (typeof window !== 'undefined') window.PekPluginStore = PekPluginStore;


// ============================================================
// Screens. Added to MainApp.prototype (loaded after app_plugins.js).
// State lives in this.state.pluginStore = { stage: 'home' | 'list', ... }
// ============================================================
class MainAppPluginStoreMethods {

    _ps(patch) {
        const cur = this.state.pluginStore;
        if (!cur) return;
        this.setState({ pluginStore: Object.assign({}, cur, patch) });
    }

    openPluginStore(kind) {
        if (this.state.pluginInstall || this.state.skinInstall || this.state.pluginPick) return;
        this.setState({ pluginStore: { kind: kind === 'skin' ? 'skin' : 'plugin', stage: 'home', busy: false, error: '', items: [], note: '' } });
    }

    closePluginStore() {
        const ps = this.state.pluginStore;
        if (ps && ps.busy) return;
        this.setState({ pluginStore: null });
    }

    storeBack() {
        const ps = this.state.pluginStore;
        if (!ps || ps.busy) return;
        if (ps.stage === 'home') { this.closePluginStore(); return; }
        this._ps({ stage: 'home', error: '', note: '' });
    }

    async storeOpenShelf(shelf) {
        const ps0 = this.state.pluginStore || {};
        this._ps({ stage: 'list', shelf, busy: true, error: '', items: [], note: '' });
        try {
            const items = await PekPluginStore.list(shelf, ps0.kind);
            const ps = this.state.pluginStore;
            if (ps && ps.shelf === shelf) this._ps({ busy: false, items });
        } catch (err) {
            this._ps({ busy: false, error: String((err && err.message) || err) });
        }
    }

    async storeInstall(item) {
        const ps = this.state.pluginStore;
        if (!ps || ps.busy) return;
        this._ps({ busy: true, error: '', note: 'Downloading ' + item.name + '\u2026' });
        try {
            const prep = await PekPluginStore.download(item);
            // Hand over to the normal install screens (warning, permissions, confirm).
            if (item.kind === 'skin') {
                const verdict = await PekSkinInstaller.check(prep);
                this.setState({ pluginStore: null, skinInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
            } else {
                const verdict = await PekPluginInstaller.check(prep);
                this.setState({ pluginStore: null, pluginInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
            }
        } catch (err) {
            this._ps({ busy: false, note: '', error: String((err && err.message) || err) });
        }
    }

    _storeInstalledVersion(id, kind) {
        if (kind === 'skin') {
            const sk = (this.state.skins || []).find(x => x.id === id);
            return sk ? String(sk.version || '') : null;
        }
        const p = (this.state.pluginsList || []).find(x => x.folder === id);
        if (!p) return null;
        return String((p.manifest && p.manifest.version) || '');
    }

    _renderPluginStoreModal() {
        const ps = this.state.pluginStore;
        if (!ps) return null;
        const { createElement, ui } = this.props.engine;
        const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
        const sub = (t) => createElement('p', { className: 'sub' }, t);
        const err = ps.error ? createElement('p', { className: 'browse-error' }, ps.error) : null;
        const note = ps.note ? createElement('p', { className: 'sub' }, ps.note) : null;
        const busy = ps.busy ? this._loadingBlock('Please wait\u2026') : null;
        const list = (...rows) => createElement('div', { className: 'browse-list plugin-list' }, ...rows);
        const wrap = (title, ...kids) => ui.modal(title, createElement('div', {}, ...kids), () => this.storeBack());

        if (ps.stage === 'list') {
            const official = ps.shelf === 'official';
            const rows = [ui.listRow('.. (back)', null, () => this.storeBack())];
            (ps.items || []).forEach(it => {
                const have = this._storeInstalledVersion(it.id, ps.kind);
                const state = have === null ? '' : (have === String(it.version || '') ? 'installed' : 'update available');
                rows.push(ui.listRow(
                    it.name,
                    [it.version ? 'v' + it.version : '', it.author ? 'by ' + it.author : '', kb(it.size), state, it.description].filter(Boolean).join(' \u00b7 '),
                    () => this.storeInstall(it)
                ));
            });
            if (!ps.busy && !(ps.items || []).length && !ps.error) rows.push(sub(official ? 'Nothing on the Official shelf yet.' : (ps.kind === 'skin' ? 'No community skins yet.' : 'No community plugins yet.')));
            const skin = ps.kind === 'skin';
            return wrap(official ? 'PEK Official' : (skin ? 'Community skins' : 'Community plugins'),
                sub(official ? 'Published by the PEK owner. Tap one to install it.'
                             : (skin ? 'Uploaded by other people and approved by the owner. A skin only changes how PEK looks. Tap one to install it.'
                                     : 'Uploaded by other people and approved by the owner. Only install plugins from people you trust. Tap one to see what it asks for.')),
                err, note, busy, list(...rows));
        }

        const skin = ps.kind === 'skin';
        const rows = [
            ui.listRow('PEK Official', 'Published by the PEK owner', () => this.storeOpenShelf('official')),
            ui.listRow(skin ? 'Community skins' : 'Community plugins', 'Made by other people, approved by the owner', () => this.storeOpenShelf('community'))
        ];
        return wrap('PEK Store',
            sub((skin ? 'Skins. ' : 'Plugins. ') + 'Tap a shelf, tap ' + (skin ? 'a skin' : 'a plugin') + ', tap Install. No web addresses to type.'),
            PEK_SUBMIT_SITE ? sub('Made ' + (skin ? 'a skin' : 'a plugin') + '? Share it at ' + PEK_SUBMIT_SITE + ' (a GitHub account is needed).') : null,
            err, note, busy, list(...rows));
    }
}

pekMixin(MainApp, MainAppPluginStoreMethods);
