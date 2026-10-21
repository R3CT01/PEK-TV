// ============================================================
// PEK TV: plugin installer (data side; the screens are in app_plugins.js).
//
//   pickZip()    opens the system file picker for a .zip
//   prepare(f)   unpacks it in memory, finds plugin.json, works out the plugin id
//   check(p)     asks the server to check it WITHOUT installing (dry run)
//   install(p)   asks the server to install it
//   remove(id)   asks the server to delete an installed plugin
//
// The server (plugin_install.h) is the one that decides what is allowed; this file
// only prepares the upload and reads plugin.json so the user can see what the
// plugin asks for before saying yes.
// ============================================================

const PekPluginInstaller = (() => {

    // Official plugins: the ones that ship with PEK TV (kept in step with plugin_install.h).
    // Everything else is third party.
    const BUILTIN = ['weather', 'sample_scraper', 'sample_counter', 'tmdb-discover'];
    const isBuiltin = (folder) => BUILTIN.indexOf(folder) !== -1;

    function slug(text) {
        return String(text || '').toLowerCase().replace(/\.zip$/, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    }

    function pickZip() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.zip,application/zip,application/x-zip-compressed';
            input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            let settled = false;
            const done = (f) => {
                if (settled) return;
                settled = true;
                if (input.parentNode) input.parentNode.removeChild(input);
                resolve(f || null);
            };
            input.addEventListener('change', () => done(input.files && input.files[0]));
            input.addEventListener('cancel', () => done(null));
            document.body.appendChild(input);
            input.click();
        });
    }

    function readFile(file) {
        if (file.arrayBuffer) return file.arrayBuffer();
        return new Promise((resolve, reject) => {          // older WebViews
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('could not read the file'));
            r.readAsArrayBuffer(file);
        });
    }

    const isJunk = (path) => path.split('/').some(part => part.charAt(0) === '.' || part.toLowerCase() === '__macosx');

    async function prepare(file) {
        if (!file) throw new Error('no file chosen');
        if (file.size > 10 * 1024 * 1024) throw new Error('that file is too large to be a plugin (limit 8 MB)');
        let entries = await PekZip.read(await readFile(file));
        const before = entries.length;
        entries = entries.filter(e => !isJunk(e.path));
        const skipped = before - entries.length;
        if (!entries.length) throw new Error('the zip is empty');

        const has = (p) => entries.some(e => e.path === p);
        // A zip is a plugin or a skin, never both. Say so clearly instead of "plugin.json was not found".
        const hasAt = (name) => {
            if (has(name)) return true;
            const tops = new Set(entries.map(e => e.path.split('/')[0]));
            if (tops.size !== 1) return false;
            const top = Array.from(tops)[0];
            return entries.every(e => e.path.indexOf(top + '/') === 0) && has(top + '/' + name);
        };
        if (hasAt('skin.json')) {
            throw new Error(hasAt('plugin.json')
                ? 'This zip has both plugin.json and skin.json, so PEK TV can\u2019t tell whether it is a plugin or a skin.'
                : 'This is a skin, not a plugin. Install it from Settings \u2192 Skins.');
        }
        let prefix = '', folder = '';
        if (!has('plugin.json')) {
            const tops = new Set(entries.map(e => e.path.split('/')[0]));
            if (tops.size === 1) {
                const top = Array.from(tops)[0];
                if (entries.every(e => e.path.indexOf(top + '/') === 0) && has(top + '/plugin.json')) {
                    prefix = top + '/';
                    folder = top;
                }
            }
        }
        if (!has(prefix + 'plugin.json')) {
            throw new Error('plugin.json was not found. It must be at the top of the zip, or inside one folder.');
        }
        const files = entries.map(e => ({ path: e.path.slice(prefix.length), data: e.data }));
        return buildPrep(files, folder, file.name, skipped);
    }

    // Optional "warning" in plugin.json: a screen the plugin's author wants shown before install.
    // Accepts a string, an array of paragraphs, or { title, text, button }. Plain text only, length-capped.
    // Returns null when the plugin declares none.
    function parseWarning(w) {
        if (w == null || w === false) return null;
        const obj = (typeof w === 'object' && !Array.isArray(w)) ? w : { text: w };
        const raw = Array.isArray(obj.text) ? obj.text : [obj.text];
        const text = raw.filter(t => typeof t === 'string' && t.trim()).slice(0, 5).map(t => t.trim().slice(0, 400));
        if (!text.length) return null;
        const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 60) : 'Before you install';
        const button = typeof obj.button === 'string' && obj.button.trim() ? obj.button.trim().slice(0, 40) : 'I understand, continue';
        return { title, text, button };
    }

    // Turns a list of files ({path, data: Uint8Array}) into what the install screen needs.
    // Used for a .zip (prepare) and for a plugin restored from the cloud (prepareFiles).
    function buildPrep(files, folder, fileName, skipped) {

        let raw;
        try {
            const text = new TextDecoder('utf-8').decode(files.find(f => f.path === 'plugin.json').data).replace(/^\uFEFF/, '');
            raw = JSON.parse(text);
        } catch (e) {
            throw new Error('plugin.json is not valid JSON');
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json must be a JSON object');

        // Same reading the sandbox applies at run time, so the screen shows what will really be allowed.
        const m = (typeof PekSandbox !== 'undefined' && PekSandbox.normalizeManifest)
            ? PekSandbox.normalizeManifest(raw)
            : { name: typeof raw.name === 'string' ? raw.name : null, version: null,
                permissions: { network: [], storage: false, library: false, torrent: false, favorites: false, providers: false, plugins: false, live: false, watched: false, device: false },
                provides: { stream: false },
                ui: { navTab: '', reloadOnInstall: false, closeOnRemove: false } };
        const js = files.find(f => /\.m?js$/i.test(f.path));
        if (js) {
            throw new Error('This plugin includes JavaScript (' + js.path + '). PEK TV only installs plugins written in Python, so plugins with .js files are no longer accepted.');
        }
        if (!files.some(f => f.path === 'screen.py')) {
            throw new Error('This plugin has no screen.py. PEK TV only installs plugins with a Python screen.');
        }
        if (!raw.flutter || typeof raw.flutter !== 'object') {
            throw new Error('plugin.json needs a "flutter" entry, for example "flutter": { "screen": "screen.py" }.');
        }
        const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
        const id = slug(folder) || slug(m.name) || slug(fileName) || 'plugin';

        return {
            id,
            name: m.name || id,
            version: m.version || '',
            author: str(raw.author, 80),
            description: str(raw.description, 200),
            warning: parseWarning(raw.warning),
            network: m.permissions.network,
            storage: m.permissions.storage === true,
            library: m.permissions.library === true,
            torrent: m.permissions.torrent === true,
            favorites: m.permissions.favorites === true,
            watched: m.permissions.watched === true,
            device: m.permissions.device === true,
            providers: m.permissions.providers === true,
            plugins: m.permissions.plugins === true,
            live: m.permissions.live === true,
            stream: !!(m.provides && m.provides.stream === true),
            ui: m.ui,
            files,
            skipped,
            hasBackend: files.some(f => /\.py$/i.test(f.path))
        };
    }

    function prepareFiles(id, files) {
        if (!Array.isArray(files) || !files.length) throw new Error('the backup has no files');
        if (!files.some(f => f.path === 'plugin.json')) throw new Error('the backup has no plugin.json');
        const prep = buildPrep(files, id, id, 0);
        prep.id = id;      // keep the exact id it was backed up under (slug() would turn _ into -)
        return prep;
    }

    async function post(url, form) {
        let res;
        try {
            res = await fetch(url, { method: 'POST', body: form });
        } catch (e) {
            throw new Error("Couldn't reach PEK TV's server.");
        }
        let data = null;
        try { data = await res.json(); } catch (e) { /* not JSON */ }
        if (res.status === 413) throw new Error('that plugin is too large to upload');
        if (!data) throw new Error('the server gave an unexpected answer (' + res.status + ')');
        if (!data.ok) throw new Error(data.error || 'the server refused the plugin');
        return data;
    }

    function uploadForm(prep, dry) {
        const fd = new FormData();
        fd.append('id', prep.id);
        if (dry) fd.append('dry', '1');
        // Each file = a "path" text field + a "file" part, in the same order.
        for (const f of prep.files) {
            fd.append('path', f.path);
            fd.append('file', new Blob([f.data]), 'f');
        }
        return fd;
    }

    // Reads a .zip chosen in PEK TV's own picker (local or network) through the server and
    // hands it back in the shape prepare() expects.
    async function fetchZip(path) {
        let res;
        try {
            res = await fetch('/api/plugins/fetch', { method: 'POST', body: new URLSearchParams({ path }) });
        } catch (e) {
            throw new Error("Couldn't reach PEK TV's server.");
        }
        const type = res.headers.get('content-type') || '';
        if (!res.ok || type.indexOf('application/json') === 0) {
            let msg = '';
            try { msg = (await res.json()).error; } catch (e) { /* not JSON */ }
            throw new Error(msg || 'the file could not be read');
        }
        const buf = await res.arrayBuffer();
        const name = String(path).replace(/\/+$/, '').split('/').pop() || 'plugin.zip';
        return { name, size: buf.byteLength, arrayBuffer: () => Promise.resolve(buf) };
    }

    const check = (prep) => post('/api/plugins/install', uploadForm(prep, true));
    const installedListeners = [];
    const onInstalled = (fn) => { if (typeof fn === 'function') installedListeners.push(fn); };
    const install = async (prep) => {
        const data = await post('/api/plugins/install', uploadForm(prep, false));
        installedListeners.forEach(fn => { try { fn(prep.id); } catch (e) { /* a listener must never break an install */ } });
        return data;
    };
    // Other parts of PEK TV (the cloud plugin backup) can ask to hear about a removal the user confirmed.
    const removedListeners = [];
    const onRemoved = (fn) => { if (typeof fn === 'function') removedListeners.push(fn); };
    const remove = async (id) => {
        const fd = new FormData(); fd.append('id', id);
        const data = await post('/api/plugins/uninstall', fd);
        removedListeners.forEach(fn => { try { fn(id); } catch (e) { /* a listener must never break a removal */ } });
        return data;
    };

    return { pickZip, fetchZip, prepare, prepareFiles, check, install, remove, onInstalled, onRemoved, isBuiltin, isOfficial: isBuiltin, slug };
})();

if (typeof window !== 'undefined') window.PekPluginInstaller = PekPluginInstaller;   // so other scripts can reach it as window.*
if (typeof module !== 'undefined' && module.exports) module.exports = PekPluginInstaller;
