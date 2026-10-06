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
//   permissions.torrent  true => the plugin's UI may call hesper.torrent.search / .play: Hesper looks up
//                        releases with the provider YOU set in Settings and streams the one picked.
//                        The plugin never sees the provider address or key, only the results.
//                        A plugin with this permission may also (a) play a https .torrent link from a host it
//                        listed under network, and (b) have Hesper's server fetch its allow-listed network
//                        hosts when the browser blocks the request (CORS).
//   permissions.library  true => the plugin's Python backend may read the titles and years
//                        in the user's library (hesper_host.library_titles); no UI effect here
//   ui                   optional shell hints: navTab (a sidebar entry), reloadOnInstall,
//                        closeOnRemove. They only change how Hesper's own screens behave.
//
// Images: posterCard art is loaded by Hesper's page (not by the frame), and only from https
// hosts the plugin listed under permissions.network.
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

    function request(op, args, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var id = nextReq++;
            var timer = setTimeout(function () {
                pending.delete(id); reject(new Error('Hesper did not answer in time'));
            }, timeoutMs || 15000);
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
        button:  function (label, fn, opts) { return { t: 'button', label: str(label), on: on(fn), primary: !!(opts && opts.primary), selected: !!(opts && opts.selected), autofocus: str(opts && opts.autofocus) }; },
        spinner: function (label, big) { return { t: 'spinner', text: str(label), big: !!big }; },
        toggle:  function (label, checked, fn) { return { t: 'toggle', label: str(label), checked: !!checked, on: on(fn) }; },
        video:   function (o) { o = o || {}; return { t: 'video', provider: str(o.provider || 'youtube'), id: str(o.id), autoplay: !!o.autoplay, muted: !!o.muted, title: str(o.title) }; },
        listRow: function (title, sub, fn) { return { t: 'listRow', title: str(title), subtitle: str(sub), on: on(fn) }; },
        column:  function () { return { t: 'column', children: flat(arguments) }; },
        row:     function () { return { t: 'row', children: flat(arguments) }; },
        posterCard: function (title, sub, posterUrl, fn, opts) {
            return { t: 'posterCard', title: str(title), subtitle: str(sub), poster: str(posterUrl), badge: str(opts && opts.badge), autofocus: str(opts && opts.autofocus), on: on(fn) };
        },
        grid:    function (children, opts) {
            return { t: 'grid', children: flat([children]), minColWidth: str(opts && opts.minColWidth), scroll: !!(opts && opts.scroll) };
        },
        tabs:    function (items, activeId, fn) {
            return { t: 'tabs', items: (Array.isArray(items) ? items : []).map(function (i) { return { id: str(i && i.id), label: str(i && i.label) }; }), active: str(activeId), on: on(fn) };
        },
        textInput: function (label, value, onInput, opts) {
            return { t: 'textInput', label: str(label), value: str(value), placeholder: str(opts && opts.placeholder),
                type: (opts && opts.type === 'password') ? 'password' : 'text', on: on(onInput), submit: on(opts && opts.onSubmit) };
        }
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

    var backFn = null, backSet = false;
    var api = {
        ui: ui,
        // Register what the Back key / Back button should do inside the plugin (or null when
        // there is nothing to step out of). Hesper then calls it before closing the plugin.
        setBack: function (fn) {
            backFn = typeof fn === 'function' ? fn : null;
            if (backSet !== !!backFn) { backSet = !!backFn; post({ t: 'canBack', v: backSet }); }
        },
        scrollTop: function () { post({ t: 'scrollTop' }); },
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
        // Needs "torrent": true in plugin.json. search -> [{title, source, sizeText, seeders, quality, pack}];
        // play opens Hesper's buffering box and then the player, and resolves once the player is open.
        torrent: {
            info: function () { return request('torrentInfo', {}, 20000).then(JSON.parse); },
            search: function (q) {
                q = q || {};
                return request('torrentSearch', { kind: str(q.kind), title: str(q.title), year: Number(q.year) || 0,
                    season: Number(q.season) || 0, episode: Number(q.episode) || 0 }, 45000).then(JSON.parse);
            },
            play: function (o) {
                o = o || {};
                return request('torrentPlay', { source: str(o.source), title: str(o.title),
                    season: Number(o.season) || 0, episode: Number(o.episode) || 0 }, 15 * 60 * 1000);
            }
        },
        log: function () { post({ t: 'log', text: [].map.call(arguments, str).join(' ') }); }
    };
    Object.freeze(ui); Object.freeze(api.storage); Object.freeze(api.torrent); Object.freeze(api);
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
        } else if (m.t === 'back') {
            if (backFn) { try { backFn(); } catch (e) { post({ t: 'log', text: 'back handler threw: ' + e }); } }
            requestRender();
        } else if (m.t === 'res') {
            var p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id); clearTimeout(p.timer);
            if (m.ok) p.resolve(m.value); else p.reject(new Error(String(m.error || 'denied')));
        } else if (m.t === 'event' || m.t === 'input') {
            // 'event' = a tap / Enter (redraws afterwards); 'input' = a keystroke in a text
            // field (hands the plugin the new text but does not redraw, so typing is not interrupted).
            var h = handlers.get(m.id);
            if (h) {
                var arg = typeof m.value === 'string' ? m.value.slice(0, 500) : undefined;
                try {
                    var r = h(arg);
                    if (m.t === 'event' && r && typeof r.then === 'function') r.then(requestRender, requestRender);
                } catch (e) { post({ t: 'log', text: 'handler threw: ' + e }); }
                if (m.t === 'event') requestRender();
            }
        }
    });
    post({ t: 'ready' });
})();
<\/script></body></html>`;

class HesperSandbox {
    /** Validates a plugin.json object; anything unexpected simply means "no permission". */
    static normalizeManifest(raw) {
        const out = {
            name: null, version: null,
            permissions: { network: [], storage: false, library: false, torrent: false },
            ui: { navTab: '', reloadOnInstall: false, closeOnRemove: false }
        };
        if (!raw || typeof raw !== 'object') return out;
        if (typeof raw.name === 'string') out.name = raw.name.slice(0, 60);
        if (typeof raw.version === 'string') out.version = raw.version.slice(0, 20);
        const perms = raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : {};
        if (Array.isArray(perms.network)) {
            out.permissions.network = perms.network.filter(h =>
                typeof h === 'string' && /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(h) && !/^[\d.]+$/.test(h.replace('*.', '')));
        }
        out.permissions.storage = perms.storage === true;
        out.permissions.library = perms.library === true;
        out.permissions.torrent = perms.torrent === true;
        const u = raw.ui && typeof raw.ui === 'object' ? raw.ui : {};
        if (typeof u.navTab === 'string') out.ui.navTab = u.navTab.replace(/[^A-Za-z0-9 &+'.-]/g, '').trim().slice(0, 20);
        out.ui.reloadOnInstall = u.reloadOnInstall === true;
        out.ui.closeOnRemove = u.closeOnRemove === true;
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
        this.canBack = false;        // the plugin has a screen it can step back out of
        this.body = null;            // rebuilt on every redraw
        this.slot = null;            // the trailer player; kept across redraws so it keeps playing
        this._videoKey = '';
        this._afKey = null;          // which screen the plugin last asked to focus
        this._focusMemo = {};        // screen key -> element that had focus when we left it
        this._onMessage = this._onMessage.bind(this);
        HesperSandbox._initNav();
    }

    // Remember whether the last input was a key press (remote / keyboard) or a touch / click,
    // so autofocus only draws a highlight ring for the D-pad.
    static _initNav() {
        if (HesperSandbox._navInit) return;
        HesperSandbox._navInit = true;
        HesperSandbox._keyNav = false;
        window.addEventListener('keydown', (e) => { if (/^Arrow|^Enter$/.test(e.key)) HesperSandbox._keyNav = true; }, true);
        ['pointerdown', 'mousedown', 'touchstart'].forEach(n =>
            window.addEventListener(n, () => { HesperSandbox._keyNav = false; }, true));
    }

    /** Returns the DOM node that shows this plugin's screen, starting the frame on first use. */
    mount(engine) {
        this.engine = engine;
        this.container = engine.createElement('div', { className: 'plugin-sandbox' });
        this.body = engine.createElement('div', { className: 'plugin-sandbox-body' });
        this.container.appendChild(this.body);
        this.slot = null; this._videoKey = ''; this._afKey = null;
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
        this.canBack = false;
        if (this.container && this.engine) {
            this.slot = null; this._videoKey = '';
            this.container.replaceChildren(this.engine.ui.card(this.manifest.name || this.folder, 'This plugin was stopped (' + reason + ').'));
        }
    }

    _send(msg) {
        if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage(msg, '*');
    }

    /** Hesper's Back key / button asks here first. True = the plugin stepped back inside itself. */
    handleBack() {
        if (!this.canBack || !this.frame || !this.container || !this.container.isConnected) return false;
        this._send({ t: 'back' });
        return true;
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
            case 'canBack': this.canBack = m.v === true; break;
            case 'scrollTop':
                if (this.container && this.container.isConnected) this.container.scrollIntoView({ block: 'start' });
                break;
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
                case 'torrentInfo': reply(true, await this._torrentInfo()); break;
                case 'torrentSearch': reply(true, await this._torrentSearch(a)); break;
                case 'torrentPlay': reply(true, await this._torrentPlay(a)); break;
                default: throw new Error('unknown request');
            }
        } catch (err) {
            reply(false, (err && err.message) || 'denied');
        }
    }

    // ---------------- torrent (permission "torrent") ----------------
    // Hesper does the work; the plugin only gets search results and the result of play().

    _torrentGuard() {
        if (!this.manifest.permissions.torrent) throw new Error("plugin.json does not request the 'torrent' permission");
        if (!window.HesperTorrent) throw new Error('Torrent playback is not available in this Hesper');
    }

    async _torrentInfo() {
        this._torrentGuard();
        return JSON.stringify(await window.HesperTorrent.info());
    }

    async _torrentSearch(a) {
        this._torrentGuard();
        const kind = a.kind === 'episode' ? 'episode' : 'movie';
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : '';
        if (!title) throw new Error('missing title');
        const int = (v, max) => { const n = Math.floor(Number(v)); return n > 0 && n <= max ? n : 0; };
        const results = await window.HesperTorrent.search({
            kind, title, year: int(a.year, 2200), season: int(a.season, 200), episode: int(a.episode, 2000)
        });
        // Only plain data goes back to the plugin.
        return JSON.stringify(results.slice(0, 25).map(r => ({
            title: String(r.title || '').slice(0, 300), source: String(r.source || '').slice(0, 4000),
            sizeText: String(r.sizeText || ''), seeders: r.seeders | 0, quality: r.quality | 0, pack: r.pack === true
        })));
    }

    async _torrentPlay(a) {
        this._torrentGuard();
        const source = typeof a.source === 'string' ? a.source : '';
        if (!/^(magnet:\?|https?:\/\/)/i.test(source) || source.length > 4000) throw new Error('invalid release');
        if (!/^magnet:\?/i.test(source)) {
            // A .torrent link: only https, and only from a host this plugin declared in plugin.json.
            // Hesper's server then agrees to download it (it refuses links nobody vouched for).
            let ru;
            try { ru = new URL(source); } catch (e) { throw new Error('invalid release'); }
            if (ru.protocol !== 'https:' || !HesperSandbox.hostAllowed(ru.hostname, this.manifest.permissions.network)) {
                throw new Error(`release host "${ru.hostname}" is not in this plugin's network permissions`);
            }
            await window.HesperTorrent.allowLink(source);
        }
        const int = (v, max) => { const n = Math.floor(Number(v)); return n > 0 && n <= max ? n : 0; };
        await window.HesperTorrent.open({
            source, title: typeof a.title === 'string' ? a.title.slice(0, 200) : '',
            season: int(a.season, 200), episode: int(a.episode, 2000)
        });
        return true;
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
            let res;
            try {
                res = await fetch(u.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal });
            } catch (e) {
                // Browser refused (most sites do not send CORS headers). Plugins with the torrent permission
                // may ask Hesper's server to fetch the same, already allow-listed address instead.
                if (!(e instanceof TypeError) || !this.manifest.permissions.torrent) throw e;
                res = await fetch('/api/torrent/fetch?url=' + encodeURIComponent(u.href), { cache: 'no-store', signal: ctl.signal });
            }
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

    // A redraw rebuilds every element. Keep what the user is in the middle of: the text
    // field they are typing in, how far a poster row was scrolled, and the page position.
    _captureView() {
        const c = this.container;
        const keep = { height: c.offsetHeight, scroll: {}, input: null, focusKey: '' };
        const fo = c.querySelector('.focused');
        if (fo && fo.dataset) keep.focusKey = fo.dataset.sxFocus || '';
        c.querySelectorAll('[data-sx-scroll]').forEach(el => { keep.scroll[el.dataset.sxScroll] = el.scrollLeft; });
        const a = document.activeElement;
        if (a && a.dataset && a.dataset.sxKey && c.contains(a)) {
            keep.input = { key: a.dataset.sxKey, value: a.value, start: a.selectionStart, end: a.selectionEnd };
        }
        return keep;
    }

    _restoreView(keep) {
        const c = this.container;
        if (keep.height) {
            c.style.minHeight = keep.height + 'px';       // no shrink-then-grow, so the page does not jump
            requestAnimationFrame(() => { c.style.minHeight = ''; });
        }
        c.querySelectorAll('[data-sx-scroll]').forEach(el => {
            const x = keep.scroll[el.dataset.sxScroll];
            if (x) el.scrollLeft = x;
        });
        if (keep.input) {
            const inp = c.querySelector('input[data-sx-key="' + keep.input.key + '"]');
            if (inp) {
                if (inp.value !== keep.input.value) inp.value = keep.input.value;
                inp.focus();
                try { inp.setSelectionRange(keep.input.start, keep.input.end); } catch (e) { /* not supported for this type */ }
            }
        }
    }

    // Poster art is fetched by this page, so it follows the same rule as hesper.fetch*:
    // https only, and only hosts listed in plugin.json permissions.network.
    _imageUrl(raw) {
        if (typeof raw !== 'string' || !raw || raw.length > 500) return '';
        let u;
        try { u = new URL(raw); } catch (e) { return ''; }
        if (u.protocol !== 'https:' || u.username || u.password) return '';
        if (!HesperSandbox.hostAllowed(u.hostname, this.manifest.permissions.network)) return '';
        return u.href;
    }

    // Every focusable element gets a key made from its section heading and its label, so after
    // a redraw (rows finishing loading, a page changing) the D-pad highlight stays on the same
    // element instead of jumping to whatever now sits at the same position in the list. The
    // heading matters: Trending and Popular often show the same titles.
    _tagFocus() {
        const seen = {};
        let section = '';
        this.body.querySelectorAll('.focusable, h3').forEach(el => {
            if (el.tagName === 'H3') {
                if (!el.closest('.focusable')) section = (el.textContent || '').slice(0, 40);
                return;
            }
            const base = (section + '>' + el.tagName + '|' +
                (el.getAttribute('title') || el.dataset.sxKey || el.textContent || '')).slice(0, 120);
            seen[base] = (seen[base] || 0) + 1;
            el.dataset.sxFocus = base + '#' + seen[base];
        });
    }

    _placeFocus(keep, budget) {
        const eng = this.engine;
        if (!eng.focusableElements || !this.body.isConnected) return;
        const find = (key) => key ? Array.from(this.body.querySelectorAll('[data-sx-focus]')).find(e => e.dataset.sxFocus === key) : null;
        const af = budget.af;
        const newKey = af ? af.key : null;
        let target = null, moved = false;
        if (newKey !== this._afKey) {
            // A different screen: go back to where focus was last time, else the plugin's pick.
            if (this._afKey && keep.focusKey) this._focusMemo[this._afKey] = keep.focusKey;
            if (newKey) {
                target = find(this._focusMemo[newKey]);
                if (!target && HesperSandbox._keyNav) target = af.el;
                moved = !!target;
            }
            this._afKey = newKey;
        } else {
            target = find(keep.focusKey);
        }
        if (!target) return;
        const i = eng.focusableElements.indexOf(target);
        if (i < 0) return;
        eng.currentIndex = i;
        eng._applyFocus(false);
        if (moved) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // The trailer player lives outside the part that is rebuilt on each redraw. Moving or
    // re-creating an iframe restarts it, so it is only replaced when the trailer or the
    // autoplay / sound setting actually changes.
    _syncVideo(v) {
        let key = '', src = '';
        if (v && v.provider === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(v.id) &&
            HesperSandbox.hostAllowed('www.youtube-nocookie.com', this.manifest.permissions.network)) {
            src = 'https://www.youtube-nocookie.com/embed/' + v.id + '?playsinline=1&rel=0&modestbranding=1' +
                (v.autoplay ? '&autoplay=1' : '') + (v.muted ? '&mute=1' : '');
            key = src;
        }
        if (key === this._videoKey) return;
        if (this.slot) { this.slot.remove(); this.slot = null; }
        this._videoKey = key;
        if (!key) return;
        const f = document.createElement('iframe');
        f.src = src;
        f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
        f.setAttribute('allowfullscreen', '');
        // Hesper sends "Referrer-Policy: no-referrer" by default and YouTube refuses to play
        // an embed that sends no referrer, so this one frame gets its own policy.
        f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
        f.setAttribute('title', (v.title || 'Trailer').slice(0, 100));
        f.tabIndex = -1;
        const box = this.engine.createElement('div', { className: 'sx-video-box' }, f);
        this.slot = this.engine.createElement('div', { className: 'sx-video' }, box);
        this.container.insertBefore(this.slot, this.body);
    }

    _renderTree() {
        if (!this.container || !this.body) return;
        const { ui } = this.engine;
        let content;
        const keep = this._captureView();
        const budget = { nodes: 0, inputs: 0, scrolls: 0, video: null, af: null };
        if (this.tree) {
            content = this._build(this.tree, 0, budget) || ui.card(this.manifest.name || this.folder, 'Nothing to show.');
        } else if (this.started) {
            content = ui.card(this.manifest.name || this.folder,
                'This plugin did not draw anything. Plugins in sandboxed mode must call hesper.render(ui => ...).');
        } else {
            content = ui.card(this.manifest.name || this.folder, 'Starting\u2026');
        }
        this.body.replaceChildren(content);
        this._syncVideo(budget.video);
        this._restoreView(keep);
        this._tagFocus();
        if (this.engine.refreshFocusList) this.engine.refreshFocusList();
        this._placeFocus(keep, budget);
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
            case 'button': {
                const b = ui.button(s(n.label), click(n.on) || (() => {}), { variant: n.primary === true ? 'primary' : 'secondary' });
                if (n.selected === true) b.classList.add('sx-selected');
                if (n.autofocus && typeof n.autofocus === 'string' && !budget.af) budget.af = { key: n.autofocus.slice(0, 60), el: b };
                return b;
            }
            case 'spinner':
                return createElement('div', { className: 'hs-loading' },
                    createElement('span', { className: 'hs-ring' + (n.big === true ? ' lg' : '') }),
                    s(n.text) ? createElement('span', {}, s(n.text).slice(0, 120)) : null);
            case 'toggle': {
                const on = (typeof n.on === 'number' && n.on > 0) ? n.on : 0;
                return ui.toggle(s(n.label).slice(0, 120), n.checked === true, (next) => {
                    if (on) this._send({ t: 'event', id: on, value: String(next) });
                });
            }
            case 'video':
                // Only one player per screen. It is placed above everything else by _syncVideo.
                if (!budget.video) {
                    budget.video = { provider: s(n.provider).slice(0, 20), id: s(n.id).slice(0, 20),
                        autoplay: n.autoplay === true, muted: n.muted === true, title: s(n.title) };
                }
                return null;
            case 'posterCard': {
                const el = ui.posterCard(s(n.title), s(n.subtitle), this._imageUrl(n.poster), click(n.on));
                const img = el.querySelector('img');
                if (img) {
                    img.setAttribute('referrerpolicy', 'no-referrer');
                    img.setAttribute('loading', 'lazy');
                    img.setAttribute('decoding', 'async');
                    img.setAttribute('draggable', 'false');
                }
                if (n.autofocus && typeof n.autofocus === 'string' && !budget.af) budget.af = { key: n.autofocus.slice(0, 60), el };
                const badge = s(n.badge).slice(0, 24);
                if (badge) {
                    if (!img) el.style.position = 'relative';
                    el.appendChild(createElement('div', {
                        style: {
                            position: 'absolute', top: '8px', left: '8px', zIndex: '1', pointerEvents: 'none',
                            padding: '2px 8px', borderRadius: '999px', fontSize: '0.7rem', fontWeight: '700',
                            background: 'var(--sx-accent)', color: '#fff'
                        }
                    }, badge));
                }
                return el;
            }
            case 'grid': {
                const list = Array.isArray(n.children) ? n.children : [];
                const kids = list.slice(0, 200).map(c => this._build(c, depth + 1, budget)).filter(Boolean);
                const min = /^\d{2,3}px$/.test(n.minColWidth) ? n.minColWidth : '150px';
                const el = ui.grid(kids, { minColWidth: min, className: 'sx-poster-grid' });
                if (n.scroll === true) {                  // one sideways-scrolling row, like a streaming app
                    Object.assign(el.style, {
                        gridTemplateColumns: 'none', gridAutoFlow: 'column', gridAutoColumns: 'var(--sx-grid-min)',
                        overflowX: 'auto', overflowY: 'hidden', padding: '0.5rem 0.25rem 0.75rem'
                    });
                    const first = list[0] && typeof list[0].title === 'string' ? list[0].title.slice(0, 40) : '';
                    el.dataset.sxScroll = (budget.scrolls++) + '|' + first;
                }
                return el;
            }
            case 'tabs': {
                const items = (Array.isArray(n.items) ? n.items : []).slice(0, 12)
                    .filter(i => i && typeof i.id === 'string')
                    .map(i => ({ id: i.id.slice(0, 40), label: s(i.label).slice(0, 40) }));
                const on = n.on;
                return ui.tabs(items, typeof n.active === 'string' ? n.active : '', (id) => {
                    if (typeof on === 'number' && on > 0) this._send({ t: 'event', id: on, value: id });
                });
            }
            case 'textInput': {
                const key = 'k' + (budget.inputs++);
                const onInput = (typeof n.on === 'number' && n.on > 0) ? n.on : 0;
                const onSubmit = (typeof n.submit === 'number' && n.submit > 0) ? n.submit : 0;
                const el = ui.textInput(s(n.label), s(n.value), (v) => {
                    if (onInput) this._send({ t: 'input', id: onInput, value: String(v).slice(0, 500) });
                }, { type: n.type === 'password' ? 'password' : 'text', placeholder: s(n.placeholder) });
                const input = el.querySelector('input');
                input.dataset.sxKey = key;
                input.setAttribute('autocomplete', 'off');
                input.setAttribute('autocapitalize', 'off');
                input.setAttribute('spellcheck', 'false');
                input.setAttribute('enterkeyhint', onSubmit ? 'search' : 'done');
                input.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    if (onSubmit) this._send({ t: 'event', id: onSubmit, value: String(input.value).slice(0, 500) });
                    input.blur();
                });
                return el;
            }
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
