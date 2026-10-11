// ============================================================
// PEK TV: skin installer (data side; the screens are in app_skins.js).
//
// A skin is a .zip with skin.json (name, author, description, version, tokens) and, optionally,
// skin.css plus images and fonts. It works like a plugin install:
//
//   prepare(f)   unpacks the zip in memory, finds skin.json, reads name / author / description
//   check(p)     asks the server to check it WITHOUT installing (dry run)
//   install(p)   asks the server to install it
//   remove(id)   asks the server to delete an installed skin
//
// A zip is either a plugin or a skin, never both: a plugin zip (plugin.json) is refused here,
// and plugin_installer.js refuses a skin zip (skin.json). The server (skin_install.h) checks
// the same thing again, plus the file types and what skin.css may load.
// ============================================================

const PekSkinInstaller = (() => {

    // Skins that ship with PEK TV (kept in step with skin_install.h). They can't be replaced or removed.
    const BUILTIN = ['default', 'green', 'neon'];
    const isBuiltin = (id) => BUILTIN.indexOf(id) !== -1;

    const NOT_A_SKIN = 'This is a plugin, not a skin. Install it from Settings \u2192 Plugins.';

    function slug(text) {
        return String(text || '').toLowerCase().replace(/\.zip$/, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    }

    const isJunk = (path) => path.split('/').some(part => part.charAt(0) === '.' || part.toLowerCase() === '__macosx');

    // Where is `name` in the zip: at the top, or inside the single folder that holds everything?
    // Returns the prefix ('' or 'folder/') or null.
    function locate(entries, name) {
        const has = (p) => entries.some(e => e.path === p);
        if (has(name)) return '';
        const tops = new Set(entries.map(e => e.path.split('/')[0]));
        if (tops.size === 1) {
            const top = Array.from(tops)[0];
            if (entries.every(e => e.path.indexOf(top + '/') === 0) && has(top + '/' + name)) return top + '/';
        }
        return null;
    }

    async function prepare(file) {
        if (!file) throw new Error('no file chosen');
        if (file.size > 8 * 1024 * 1024) throw new Error('that file is too large to be a skin (limit 6 MB)');
        const buf = file.arrayBuffer ? await file.arrayBuffer() : await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('could not read the file'));
            r.readAsArrayBuffer(file);
        });
        let entries = await PekZip.read(buf);
        const before = entries.length;
        entries = entries.filter(e => !isJunk(e.path));
        const skipped = before - entries.length;
        if (!entries.length) throw new Error('the zip is empty');

        const skinAt = locate(entries, 'skin.json');
        const pluginAt = locate(entries, 'plugin.json');
        if (pluginAt !== null) {
            throw new Error(skinAt !== null
                ? 'This zip has both plugin.json and skin.json, so PEK TV can\u2019t tell whether it is a plugin or a skin.'
                : NOT_A_SKIN);
        }
        if (skinAt === null) {
            throw new Error('skin.json was not found. It must be at the top of the zip, or inside one folder.');
        }
        const folder = skinAt ? skinAt.replace(/\/$/, '') : '';
        const files = entries.map(e => ({ path: e.path.slice(skinAt.length), data: e.data }));

        let raw;
        try {
            const text = new TextDecoder('utf-8').decode(files.find(f => f.path === 'skin.json').data).replace(/^\uFEFF/, '');
            raw = JSON.parse(text);
        } catch (e) {
            throw new Error('skin.json is not valid JSON');
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('skin.json must be a JSON object');
        if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('skin.json needs a \u201cname\u201d');
        if (raw.tokens !== undefined && (typeof raw.tokens !== 'object' || raw.tokens === null || Array.isArray(raw.tokens))) {
            throw new Error('\u201ctokens\u201d in skin.json must be an object of colours and sizes');
        }

        const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        const id = slug(folder) || slug(raw.name) || slug(file.name) || 'skin';
        if (isBuiltin(id)) throw new Error(`\u201c${id}\u201d is the id of a skin that ships with PEK TV. Rename the skin (or the folder inside the zip) and try again.`);

        return {
            id,
            name: str(raw.name, 60),
            author: str(raw.author, 80),
            description: str(raw.description, 200),
            version: str(raw.version, 20),
            tokenCount: raw.tokens ? Object.keys(raw.tokens).length : 0,
            hasCss: files.some(f => f.path === 'skin.css'),
            files,
            skipped
        };
    }

    // For a skin downloaded from the Skin Store: the files are already in memory, so there is no zip to open.
    function prepareFiles(id, files) {
        if (!Array.isArray(files) || !files.some(f => f.path === 'skin.json')) throw new Error('the download has no skin.json');
        let raw;
        try { raw = JSON.parse(new TextDecoder('utf-8').decode(files.find(f => f.path === 'skin.json').data).replace(/^\uFEFF/, '')); }
        catch (e) { throw new Error('skin.json is not valid JSON'); }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('skin.json needs a \u201cname\u201d');
        const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        return {
            id,
            name: str(raw.name, 60), author: str(raw.author, 80), description: str(raw.description, 200), version: str(raw.version, 20),
            tokenCount: raw.tokens && typeof raw.tokens === 'object' ? Object.keys(raw.tokens).length : 0,
            hasCss: files.some(f => f.path === 'skin.css'),
            files, skipped: 0
        };
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
        if (res.status === 413) throw new Error('that skin is too large to upload');
        if (!data) throw new Error('the server gave an unexpected answer (' + res.status + ')');
        if (!data.ok) throw new Error(data.error || 'the server refused the skin');
        return data;
    }

    function uploadForm(prep, dry) {
        const fd = new FormData();
        fd.append('id', prep.id);
        if (dry) fd.append('dry', '1');
        for (const f of prep.files) {          // each file = a "path" text field + a "file" part, in order
            fd.append('path', f.path);
            fd.append('file', new Blob([f.data]), 'f');
        }
        return fd;
    }

    const check = (prep) => post('/api/skins/install', uploadForm(prep, true));
    const install = (prep) => post('/api/skins/install', uploadForm(prep, false));
    const remove = (id) => { const fd = new FormData(); fd.append('id', id); return post('/api/skins/uninstall', fd); };

    return { prepare, prepareFiles, check, install, remove, isBuiltin, slug };
})();
window.PekSkinInstaller = PekSkinInstaller;
