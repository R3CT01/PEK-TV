// ============================================================
// Hesper plugin sandbox
//
// Plugin UI code (plugins/<id>/ui.js) runs inside an <iframe sandbox="allow-scripts">
// with NO allow-same-origin, so it gets an opaque origin: it cannot touch this page's
// DOM, cookies, localStorage, the Hesper API, or window.HesperAndroid. A CSP inside
// the frame also forbids every network request and every sub-frame.
//
// The only way out is postMessage to this file, which enforces plugin.json:
//   permissions.network  list of https host names the plugin may fetch from
//   permissions.storage  true => small private key/value store + its own data/ files
//
// A plugin describes its screen as plain data (card, button, ...). THIS file turns
// that into DOM, using text nodes only, so a plugin can never inject HTML or script.
//
// Limits worth knowing:
//  - A plugin that spins forever can still make the frame (and on some browsers the
//    page) unresponsive. The sandbox limits what a plugin can read and send, not how
//    much CPU it burns.
//  - A sandboxed frame can still navigate itself. That is detected and the frame is
//    dropped, but a single request to the new address may already have left. So the
//    network permission governs hesper.fetch*, and the real protection is that a
//    plugin only ever holds data you gave it access to (its own storage and data
//    files, and what it fetched), never Hesper's API, files, or saved logins.
// ============================================================

const HESPER_SANDBOX_LIMITS = {
    maxNodes: 600,
    maxDepth: 10,
    maxString: 2000,
    maxFetchBytes: 1000000,
    fetchTimeoutMs: 8000,
    storageBytesPerPlugin: 256 * 1024,
    maxValueBytes: 64 * 1024,
    requestTimeoutMs: 15000
};

// What runs inside the frame. Kept as a string so the frame has no other source.
const HESPER_SANDBOX_BOOTSTRAP = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
</head><body><script>
(function () {
    'use strict';
    var post = function (m) { parent.postMessage(m, '*'); };
    var pending = new Map(), nextReq = 1;
    var handlers = new Map(), nextHandler = 1;
    var renderFn = null, drawQueued = false;

    function request(op, args) {
        return new Promise(function (resolve, reject) {
            var id = nextReq++;
            var timer = setTimeout(function () {
                pending.delete(id); reject(new Error('Hesper did not answer in time'));
            }, 15000);
            pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            post({ t: 'req', id: id, op: op, args: args });
        });
    }

    var str = function (v) { return v == null ? '' : String(v); };
    function on(fn) {
        if (typeof fn !== 'function') return 0;
        var id = nextHandler++; handlers.set(id, fn); return id;
    }
    function flat(list) { return [].concat.apply([], list).filter(function (c) { return c != null; }); }

    var ui = {
        text:    function (s) { return { t: 'text', text: str(s) }; },
        heading: function (s) { return { t: 'heading', text: str(s) }; },
        card:    function (title, sub, fn) { return { t: 'card', title: str(title), subtitle: str(sub), on: on(fn) }; },
        button:  function (label, fn, opts) { return { t: 'button', label: str(label), on: on(fn), primary: !!(opts && opts.primary) }; },
        listRow: function (title, sub, fn) { return { t: 'listRow', title: str(title), subtitle: str(sub), on: on(fn) }; },
        column:  function () { return { t: 'column', children: flat(arguments) }; },
        row:     function () { return { t: 'row', children: flat(arguments) }; }
    };

    function draw() {
        drawQueued = false;
        if (!renderFn) return;
        handlers.clear();
        var tree;
        try { tree = renderFn(ui); } catch (e) { post({ t: 'log', text: 'render() threw: ' + e }); return; }
        post({ t: 'view', tree: tree });
    }
    function requestRender() {
        if (drawQueued) return;
        drawQueued = true; setTimeout(draw, 0);
    }

    var api = {
        ui: ui,
        render: function (fn) { renderFn = fn; requestRender(); },
        requestRender: requestRender,
        fetchText: function (url) { return request('fetch', { url: str(url) }); },
        fetchJSON: function (url) { return request('fetch', { url: str(url) }).then(JSON.parse); },
        readData: function (name) { return request('readData', { name: str(name) }); },
        readJSON: function (name) { return request('readData', { name: str(name) }).then(JSON.parse); },
        storage: {
            get: function (k) { return request('storageGet', { key: str(k) }); },
            set: function (k, v) { return request('storageSet', { key: str(k), value: str(v) }); },
            remove: function (k) { return request('storageRemove', { key: str(k) }); }
        },
        log: function () { post({ t: 'log', text: [].map.call(arguments, str).join(' ') }); }
    };
    Object.freeze(ui); Object.freeze(api.storage); Object.freeze(api);
    Object.defineProperty(window, 'hesper', { value: api, writable: false, configurable: false });

    window.addEventListener('message', function (ev) {
        if (ev.source !== parent) return;
        var m = ev.data;
        if (!m || typeof m !== 'object') return;
        if (m.t === 'init') {
            try {
                var s = document.createElement('script');
                s.textContent = String(m.code);
                document.body.appendChild(s);
            } catch (e) { post({ t: 'log', text: 'plugin failed to start: ' + e }); }
            post({ t: 'started', hasRender: !!renderFn });
        } else if (m.t === 'res') {
            var p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id); clearTimeout(p.timer);
            if (m.ok) p.resolve(m.value); else p.reject(new Error(String(m.error || 'denied')));
        } else if (m.t === 'event') {
            var h = handlers.get(m.id);
            if (h) {
                try {
                    var r = h();
                    if (r && typeof r.then === 'function') r.then(requestRender, requestRender);
                } catch (e) { post({ t: 'log', text: 'handler threw: ' + e }); }
                requestRender();
            }
        }
    });
    post({ t: 'ready' });
})();
<\/script></body></html>`;

class HesperSandbox {
    /** Validates a plugin.json object; anything unexpected simply means "no permission". */
    static normalizeManifest(raw) {
        const out = { name: null, version: null, permissions: { network: [], storage: false } };
        if (!raw || typeof raw !== 'object') return out;
        if (typeof raw.name === 'string') out.name = raw.name.slice(0, 60);
        if (typeof raw.version === 'string') out.version = raw.version.slice(0, 20);
        const perms = raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : {};
        if (Array.isArray(perms.network)) {
            out.permissions.network = perms.network.filter(h =>
                typeof h === 'string' && /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(h) && !/^[\d.]+$/.test(h.replace('*.', '')));
        }
        out.permissions.storage = perms.storage === true;
        return out;
    }

    static hostAllowed(host, allowed) {
        host = host.toLowerCase().replace(/\.$/, '');
        return allowed.some(p => {
            p = p.toLowerCase();
            return p.startsWith('*.') ? (host.endsWith(p.slice(1)) && host !== p.slice(2)) : host === p;
        });
    }

    constructor(folder, manifest, source) {
        this.folder = folder;
        this.manifest = manifest;
        this.source = source;
        this.frame = null;
        this.tree = null;
        this.container = null;
        this.logs = [];
        this.started = false;
        this._onMessage = this._onMessage.bind(this);
    }

    /** Returns the DOM node that shows this plugin's screen, starting the frame on first use. */
    mount(engine) {
        this.engine = engine;
        this.container = engine.createElement('div', { className: 'plugin-sandbox' });
        if (!this.frame) this._start();
        this._renderTree();
        return this.container;
    }

    _start() {
        window.addEventListener('message', this._onMessage);
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');       // deliberately NOT allow-same-origin
        f.setAttribute('referrerpolicy', 'no-referrer');
        f.setAttribute('aria-hidden', 'true');
        f.tabIndex = -1;
        f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
        f.srcdoc = HESPER_SANDBOX_BOOTSTRAP;
        // The frame loads once (our srcdoc). A second load means the plugin navigated
        // itself somewhere, which could carry data out in a URL, so the frame is dropped.
        let loads = 0;
        f.addEventListener('load', () => { if (++loads > 1) this._kill('tried to navigate away'); });
        this.frame = f;
        document.body.appendChild(f);
    }

    _kill(reason) {
        this._log('stopped: ' + reason);
        window.removeEventListener('message', this._onMessage);
        if (this.frame) this.frame.remove();
        this.frame = null;
        this.stopped = reason;
        this.tree = null;
        if (this.container && this.engine) {
            this.container.replaceChildren(this.engine.ui.card(this.manifest.name || this.folder, 'This plugin was stopped (' + reason + ').'));
        }
    }

    _send(msg) {
        if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage(msg, '*');
    }

    _log(text) {
        this.logs.push(String(text).slice(0, 500));
        if (this.logs.length > 100) this.logs.shift();
        console.log(`[plugin ${this.folder}]`, text);
    }

    _onMessage(ev) {
        if (!this.frame || ev.source !== this.frame.contentWindow) return;   // only our own frame
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        switch (m.t) {
            case 'ready': this._send({ t: 'init', code: this.source }); break;
            case 'started':
                this.started = true;
                if (!m.hasRender) this._log('this plugin never called hesper.render(); nothing to show');
                this._renderTree();
                break;
            case 'view': this.tree = m.tree; this._renderTree(); break;
            case 'log': this._log(m.text); break;
            case 'req': this._handleRequest(m); break;
        }
    }

    // ---------------- requests from the plugin ----------------

    async _handleRequest(m) {
        const reply = (ok, v) => this._send({ t: 'res', id: m.id, ok, [ok ? 'value' : 'error']: v });
        try {
            if (typeof m.id !== 'number' || !m.args || typeof m.args !== 'object') throw new Error('bad request');
            const a = m.args;
            switch (m.op) {
                case 'fetch': reply(true, await this._fetch(a.url)); break;
                case 'readData': reply(true, await this._readData(a.name)); break;
                case 'storageGet': reply(true, this._storageGet(a.key)); break;
                case 'storageSet': reply(true, this._storageSet(a.key, a.value)); break;
                case 'storageRemove': reply(true, this._storageRemove(a.key)); break;
                default: throw new Error('unknown request');
            }
        } catch (err) {
            reply(false, (err && err.message) || 'denied');
        }
    }

    async _fetch(url) {
        if (typeof url !== 'string' || url.length > 2000) throw new Error('invalid URL');
        let u;
        try { u = new URL(url); } catch (e) { throw new Error('invalid URL'); }
        const allowed = this.manifest.permissions.network;
        if (u.protocol !== 'https:') throw new Error('only https:// URLs are allowed');
        if (u.username || u.password) throw new Error('invalid URL');
        if (!HesperSandbox.hostAllowed(u.hostname, allowed)) {
            throw new Error(`host "${u.hostname}" is not in this plugin's network permissions`);
        }
        const L = HESPER_SANDBOX_LIMITS;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), L.fetchTimeoutMs);
        try {
            // No cookies, no credentials, and a redirect to another host is not followed.
            const res = await fetch(u.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const declared = Number(res.headers.get('content-length') || 0);
            if (declared > L.maxFetchBytes) throw new Error('response too large');
            const text = await res.text();
            if (text.length > L.maxFetchBytes) throw new Error('response too large');
            return text;
        } finally { clearTimeout(timer); }
    }

    async _readData(name) {
        if (!this.manifest.permissions.storage) throw new Error("plugin.json does not request the 'storage' permission");
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error('invalid file name');
        const res = await fetch(`/plugins/${encodeURIComponent(this.folder)}/data/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('no such data file');
        const text = await res.text();
        if (text.length > HESPER_SANDBOX_LIMITS.maxFetchBytes) throw new Error('file too large');
        return text;
    }

    _storageKey(key) {
        if (!this.manifest.permissions.storage) throw new Error("plugin.json does not request the 'storage' permission");
        if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw new Error('invalid key');
        return `hesper-plugin:${this.folder}:${key}`;
    }

    _storageUsed() {
        const prefix = `hesper-plugin:${this.folder}:`;
        let n = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) n += k.length + (localStorage.getItem(k) || '').length;
        }
        return n;
    }

    _storageGet(key) { return localStorage.getItem(this._storageKey(key)); }
    _storageRemove(key) { localStorage.removeItem(this._storageKey(key)); return true; }
    _storageSet(key, value) {
        const k = this._storageKey(key);
        if (typeof value !== 'string' || value.length > HESPER_SANDBOX_LIMITS.maxValueBytes) throw new Error('value too large');
        const existing = (localStorage.getItem(k) || '').length;
        if (this._storageUsed() - existing + value.length > HESPER_SANDBOX_LIMITS.storageBytesPerPlugin) throw new Error('storage quota exceeded');
        localStorage.setItem(k, value);
        return true;
    }

    // ---------------- drawing the plugin's description ----------------

    _renderTree() {
        if (!this.container) return;
        const { createElement, ui } = this.engine;
        let content;
        if (this.tree) {
            const budget = { nodes: 0 };
            content = this._build(this.tree, 0, budget) || ui.card(this.manifest.name || this.folder, 'Nothing to show.');
        } else if (this.started) {
            content = ui.card(this.manifest.name || this.folder,
                'This plugin did not draw anything. Plugins in sandboxed mode must call hesper.render(ui => ...).');
        } else {
            content = ui.card(this.manifest.name || this.folder, 'Starting\u2026');
        }
        this.container.replaceChildren(content);
        if (this.engine.refreshFocusList) this.engine.refreshFocusList();
    }

    _build(n, depth, budget) {
        const L = HESPER_SANDBOX_LIMITS;
        const { createElement, ui } = this.engine;
        if (!n || typeof n !== 'object' || depth > L.maxDepth || ++budget.nodes > L.maxNodes) return null;
        const s = (v) => (typeof v === 'string' ? v.slice(0, L.maxString) : '');
        const click = (id) => (typeof id === 'number' && id > 0) ? () => this._send({ t: 'event', id }) : null;

        switch (n.t) {
            case 'text': return createElement('p', {}, s(n.text));
            case 'heading': return createElement('h3', {}, s(n.text));
            case 'card': return ui.card(s(n.title), s(n.subtitle), click(n.on));
            case 'listRow': return ui.listRow(s(n.title), s(n.subtitle), click(n.on));
            case 'button': return ui.button(s(n.label), click(n.on) || (() => {}), { variant: n.primary === true ? 'primary' : 'secondary' });
            case 'column':
            case 'row': {
                const kids = (Array.isArray(n.children) ? n.children : []).slice(0, 200)
                    .map(c => this._build(c, depth + 1, budget)).filter(Boolean);
                return createElement('div', {
                    style: n.t === 'row'
                        ? { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }
                        : { display: 'flex', flexDirection: 'column', gap: '0.75rem' }
                }, ...kids);
            }
            default: return null;
        }
    }
}
