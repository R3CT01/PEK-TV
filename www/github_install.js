// ============================================================
// Install a plugin from GitHub by name (owner/repo), for plugins that are NOT in the PEK Store.
//
//   PekGithub        parseRepo(), findRelease(), download()   (data side)
//   PekPluginSources remembers where each plugin came from (device level)
//   MainApp screens     the first-time warning, the owner/repo box, the file picker, and the
//                       labels shown in the Plugins tab and on the install screen
//
// Rules this follows:
//  - PEK TV lists nothing. The person types the name; there is no catalog of repositories.
//  - The download goes through the same checks as a .zip the person picked (server safety checks,
//    permissions screen, confirm). Nothing from GitHub gets extra trust, and nothing is ever
//    installed or updated by itself.
//  - Plugins that came from here are labeled "unverified" so nobody mistakes them for the store.
//  - A switch in Settings turns it off; PEK_ALLOW_GITHUB=0 turns it off in the server.
// The download itself is done by the server (backend/github_install.h).
// ============================================================

const GITHUB_ON_KEY = 'pek_github_enabled';          // '0' = switched off (anything else = on)
const GITHUB_WARNED_KEY = 'pek_github_warned';       // '1' = the first-time warning was accepted
const PLUGIN_SOURCES_KEY = 'pek_plugin_sources_v1';  // { folder: { type, ... } }

const PekPluginSources = (() => {
    function read() {
        try {
            const o = JSON.parse(localStorage.getItem(PLUGIN_SOURCES_KEY) || '{}');
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
        } catch (e) { return {}; }
    }
    function write(o) { try { localStorage.setItem(PLUGIN_SOURCES_KEY, JSON.stringify(o)); } catch (e) { /* not saved */ } }
    return {
        get: (folder) => read()[folder] || null,
        set: (folder, src) => { const o = read(); o[folder] = src; write(o); },
        remove: (folder) => { const o = read(); if (o[folder]) { delete o[folder]; write(o); } }
    };
})();
window.PekPluginSources = PekPluginSources;

const PekGithub = (() => {
    const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
    const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
    const MAX_ZIP = 10 * 1024 * 1024;

    // "owner/repo", "github.com/owner/repo" or a full link -> { owner, repo } (or null).
    function parseRepo(text) {
        let t = String(text || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        t = t.replace(/^github\.com\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
        const parts = t.split('/');
        if (parts.length < 2) return null;
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/i, '');
        if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
        return { owner, repo };
    }

    async function api(path) {
        let res;
        try { res = await fetch('https://api.github.com' + path, { headers: { Accept: 'application/vnd.github+json' } }); }
        catch (e) { throw new Error("Couldn't reach GitHub. Check your connection."); }
        if (res.status === 403 || res.status === 429) {
            throw new Error('GitHub is limiting requests from this connection. Try again in a few minutes.');
        }
        return res;
    }

    const safeSeg = (s) => /^[A-Za-z0-9._+%~-]{1,200}$/.test(s) && s.indexOf('..') === -1;

    // Finds what can be installed from owner/repo: the latest release's .zip files and its source.
    async function findRelease(owner, repo) {
        const name = owner + '/' + repo;
        const base = '/repos/' + owner + '/' + repo;
        const res = await api(base + '/releases/latest');
        const options = [];

        if (res.status === 404) {
            // No release: say so clearly, or fall back to the repository's own source code.
            const rr = await api(base);
            if (rr.status === 404) throw new Error('GitHub has no public repository called ' + name + '. Check the spelling.');
            if (!rr.ok) throw new Error('GitHub gave an unexpected answer (HTTP ' + rr.status + ').');
            const info = await rr.json();
            const branch = String((info && info.default_branch) || '');
            if (branch && safeSeg(encodeURIComponent(branch))) {
                options.push({
                    kind: 'source', label: 'Source code (' + branch + ' branch, no release)', size: 0,
                    url: 'https://api.github.com' + base + '/zipball/' + encodeURIComponent(branch)
                });
            }
            return { owner, repo, tag: '', title: '', options };
        }
        if (!res.ok) throw new Error('GitHub gave an unexpected answer (HTTP ' + res.status + ').');
        const rel = await res.json();
        const tag = String((rel && rel.tag_name) || '');
        const prefix = ('https://github.com/' + owner + '/' + repo + '/releases/download/').toLowerCase();

        ((rel && rel.assets) || []).forEach(a => {
            const url = String((a && a.browser_download_url) || '');
            const file = String((a && a.name) || '');
            if (!/\.zip$/i.test(file) || url.toLowerCase().indexOf(prefix) !== 0) return;
            if (!(a.size > 0) || a.size > MAX_ZIP) return;        // empty, or too big to be a plugin
            options.push({ kind: 'asset', label: file, size: a.size, url });
        });
        const zipball = String((rel && rel.zipball_url) || '');
        if (zipball.indexOf('https://api.github.com' + base + '/zipball/') === 0) {
            options.push({ kind: 'source', label: 'Source code of ' + (tag || 'this release'), size: 0, url: zipball });
        }
        return { owner, repo, tag, title: String((rel && rel.name) || ''), options };
    }

    // Downloads one option through the server and prepares it like a picked .zip.
    async function download(owner, repo, opt) {
        let res;
        try {
            res = await fetch('/api/plugins/github-zip', { method: 'POST', body: new URLSearchParams({ owner, repo, url: opt.url }) });
        } catch (e) {
            throw new Error("Couldn't reach PEK TV's server.");
        }
        const type = res.headers.get('content-type') || '';
        if (!res.ok || type.indexOf('application/json') === 0) {
            let msg = '';
            try { msg = (await res.json()).error; } catch (e) { /* not JSON */ }
            throw new Error(msg || 'The download failed.');
        }
        const buf = await res.arrayBuffer();
        const file = { name: opt.kind === 'asset' ? opt.label : repo + '.zip', size: buf.byteLength, arrayBuffer: () => Promise.resolve(buf) };
        const prep = await PekPluginInstaller.prepare(file);
        // A source zip unpacks into a folder named after the commit, which changes every time:
        // use the repository name so a later update replaces the same plugin.
        if (opt.kind === 'source') prep.id = PekPluginInstaller.slug(repo) || prep.id;
        prep.source = { type: 'github', owner, repo, tag: opt.tag || '', kind: opt.kind, size: buf.byteLength };
        return prep;
    }

    return { parseRepo, findRelease, download };
})();
window.PekGithub = PekGithub;

// Forget where a plugin came from once it is removed.
if (window.PekPluginInstaller && PekPluginInstaller.onRemoved) {
    PekPluginInstaller.onRemoved((id) => PekPluginSources.remove(id));
}


// ============================================================
// Screens. Added to MainApp.prototype.
// State: this.state.githubFlow = { stage: 'warn' | 'enter' | 'pick', busy, error, note, release }
// ============================================================
class MainAppGithubMethods {

    _githubEnabled() {
        try { return localStorage.getItem(GITHUB_ON_KEY) !== '0'; } catch (e) { return true; }
    }

    _setGithubEnabled(on) {
        try { localStorage.setItem(GITHUB_ON_KEY, on ? '1' : '0'); } catch (e) { /* lasts until restart only */ }
        this.setState({});
    }

    _gh(patch) {
        const cur = this.state.githubFlow;
        if (!cur) return;
        this.setState({ githubFlow: Object.assign({}, cur, patch) });
    }

    openGithubInstall() {
        const { ui } = this.props.engine;
        if (!this._githubEnabled()) { ui.toast('Installing from GitHub is switched off in Settings.'); return; }
        if (this.state.pluginInstall || this.state.skinInstall || this.state.pluginPick || this.state.pluginStore || this.state.githubFlow) return;
        let warned = false;
        try { warned = localStorage.getItem(GITHUB_WARNED_KEY) === '1'; } catch (e) { /* ask every time */ }
        this._ghText = '';
        this.setState({ githubFlow: { stage: warned ? 'enter' : 'warn', busy: false, error: '', note: '', release: null } });
    }

    githubAccept() {
        try { localStorage.setItem(GITHUB_WARNED_KEY, '1'); } catch (e) { /* will ask again next time */ }
        this._gh({ stage: 'enter', error: '' });
    }

    githubBack() {
        const gf = this.state.githubFlow;
        if (!gf || gf.busy) return;
        if (gf.stage === 'pick') { this._gh({ stage: 'enter', error: '', release: null }); return; }
        this.setState({ githubFlow: null });
    }

    async githubFind() {
        const gf = this.state.githubFlow;
        if (!gf || gf.busy) return;
        const parsed = PekGithub.parseRepo(this._ghText || '');
        if (!parsed) { this._gh({ error: 'Type it like owner/repo, for example someone/my-plugin.' }); return; }
        this._gh({ stage: 'enter', busy: true, error: '', note: 'Looking up ' + parsed.owner + '/' + parsed.repo + '\u2026' });
        try {
            const rel = await PekGithub.findRelease(parsed.owner, parsed.repo);
            if (!this.state.githubFlow) return;
            if (!rel.options.length) throw new Error('There is nothing in ' + parsed.owner + '/' + parsed.repo + ' that PEK TV can install (no .zip release file).');
            if (rel.options.length === 1) { await this._githubDownload(rel, rel.options[0]); return; }
            this._gh({ stage: 'pick', busy: false, note: '', release: rel });
        } catch (err) {
            this._gh({ busy: false, note: '', error: String((err && err.message) || err) });
        }
    }

    async _githubDownload(rel, opt) {
        this._gh({ busy: true, error: '', note: 'Downloading from ' + rel.owner + '/' + rel.repo + '\u2026' });
        try {
            const prep = await PekGithub.download(rel.owner, rel.repo, Object.assign({ tag: rel.tag }, opt));
            const verdict = await PekPluginInstaller.check(prep);
            // Hand over to the normal install screens (permissions, then confirm).
            this.setState({ githubFlow: null, pluginInstall: { stage: 'confirm', prep, replaced: !!verdict.replaced } });
        } catch (err) {
            this._gh({ busy: false, note: '', stage: (rel.options || []).length > 1 ? 'pick' : 'enter', error: String((err && err.message) || err) });
        }
    }

    // Where a plugin in the Plugins tab came from, in the words shown under its name.
    _pluginSourceNote(folder) {
        const s = PekPluginSources.get(folder);
        if (s && s.type === 'github') return 'unverified \u00b7 from GitHub ' + s.owner + '/' + s.repo + ' \u00b7 sandboxed \u00b7 hold to remove';
        if (s && s.type === 'store') {
            return (s.shelf === 'official' ? 'PEK Store official' : 'approved \u00b7 community store') + ' \u00b7 sandboxed \u00b7 hold to remove';
        }
        return 'third party \u00b7 sandboxed \u00b7 hold to remove';
    }

    // Extra lines at the top of the install screen for a plugin that came from GitHub.
    _githubNotice(pi) {
        const p = pi && pi.prep;
        const s = p && p.source;
        if (!s || s.type !== 'github') return [];
        const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
        const out = [
            'Unverified plugin from GitHub: ' + s.owner + '/' + s.repo + (s.tag ? ' \u00b7 ' + s.tag : '') + (s.size ? ' \u00b7 ' + kb(s.size) : ''),
            'PEK TV did not make, review or approve it. It is published by its developer, who is responsible for it.'
        ];
        if (s.kind === 'source') out.push('This is the repository\u2019s source code, not a packaged release.');
        if (pi.replaced) {
            const prev = PekPluginSources.get(p.id);
            const same = prev && prev.type === 'github' && (prev.owner + '/' + prev.repo).toLowerCase() === (s.owner + '/' + s.repo).toLowerCase();
            if (!same) out.push('Careful: this replaces a plugin with the same name that you installed from somewhere else.');
        }
        return out;
    }

    _renderGithubModal() {
        const gf = this.state.githubFlow;
        if (!gf) return null;
        const { createElement, ui } = this.props.engine;
        const back = () => this.githubBack();
        const kb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
        const err = gf.error ? createElement('p', { className: 'browse-error' }, gf.error) : null;
        const note = gf.note ? createElement('p', { className: 'sub' }, gf.note) : null;
        const busy = gf.busy ? this._loadingBlock('Please wait\u2026') : null;

        if (gf.stage === 'warn') {
            return ui.modal('Before you install from GitHub', createElement('div', {},
                createElement('div', { className: 'glass-panel' },
                    createElement('p', {}, 'This installs a plugin straight from a GitHub repository that you name.'),
                    createElement('p', {}, 'PEK TV did not make, review or approve these plugins, and they are not part of the PEK Store. Each one is published by its own developer, who is responsible for it.'),
                    createElement('p', {}, 'PEK TV still runs it in a sandbox and shows you what it asks for before anything is installed, but it cannot check what the plugin really does. Only install plugins from developers you trust.'),
                    createElement('p', {}, 'Make sure you have the right to use whatever the plugin gives you access to.')
                ),
                ui.button('I understand, continue', () => this.githubAccept(), { variant: 'primary' })
            ), back);
        }

        if (gf.stage === 'pick') {
            const rel = gf.release || { owner: '', repo: '', options: [] };
            const rows = [ui.listRow('.. (back)', null, back)];
            (rel.options || []).forEach(o => rows.push(ui.listRow(
                o.label, [rel.tag ? rel.tag : '', o.size ? kb(o.size) : ''].filter(Boolean).join(' \u00b7 '),
                () => this._githubDownload(rel, o))));
            return ui.modal('Choose what to install', createElement('div', {},
                createElement('p', { className: 'sub' }, rel.owner + '/' + rel.repo + (rel.tag ? ' \u00b7 ' + rel.tag : '') + '. Tap one to download it. You will see what it asks for before anything is installed.'),
                err, note, busy,
                createElement('div', { className: 'browse-list plugin-list' }, ...rows)
            ), back);
        }

        // stage 'enter'
        const input = createElement('input', {
            className: 'focusable sx-text-input',
            type: 'text',
            value: this._ghText || '',
            placeholder: 'owner/repo',
            autocapitalize: 'off',
            autocomplete: 'off',
            spellcheck: 'false',
            onInput: (e) => { this._ghText = e.target.value; },
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.githubFind(); } }
        });
        return ui.modal('Install from GitHub', createElement('div', {},
            createElement('p', { className: 'sub' }, 'Type the developer\u2019s GitHub name, a slash, and the plugin\u2019s repository name, like someone/my-plugin. Pasting a github.com link works too.'),
            createElement('div', { className: 'sx-field' },
                createElement('label', { className: 'sx-field-label' }, 'GitHub repository'),
                input),
            createElement('p', { className: 'sub' }, 'These plugins are unverified: PEK TV does not review them.'),
            err, note, busy,
            ui.button(gf.busy ? 'Working\u2026' : 'Find plugin', () => this.githubFind(), { variant: 'primary' })
        ), back);
    }
}

pekMixin(MainApp, MainAppGithubMethods);
