// ============================================================
// PEK TV plugin sandbox
//
// Plugin UI code (plugins/<id>/ui.js) runs inside an <iframe sandbox="allow-scripts">
// with NO allow-same-origin, so it gets an opaque origin: it cannot touch this page's
// DOM, cookies, localStorage, the PEK TV API, or window.PekAndroid. A CSP inside
// the frame also forbids every network request and every sub-frame.
//
// The only way out is postMessage to this file, which enforces plugin.json:
//   permissions.network  list of https host names the plugin may fetch from
//   permissions.storage  true => small private key/value store + its own data/ files
//   permissions.torrent  true => the plugin's UI may call pek.torrent.search / .play: PEK TV looks up
//                        releases with the provider YOU set in Settings and streams the one picked.
//                        The plugin never sees the provider address or key, only the results.
//                        A plugin with this permission may also (a) play a https .torrent link from a host it
//                        listed under network, and (b) have PEK TV's server fetch its allow-listed network
//                        hosts when the browser blocks the request (CORS).
//   permissions.library  true => the plugin's Python backend may read the titles and years
//                        in the user's library (hesper_host.library_titles); no UI effect here
//   permissions.favorites true => pek.favorites.list / add / remove: the shared Favorites list that
//                        PEK TV's Favorites tab shows. Only a TMDb type + id, title, year and poster path are kept.
//   permissions.providers true => ui.providerButton: a "Watch on <service>" button. PEK TV decides what it
//                        opens (the service's app on Android, its website elsewhere); the plugin only names the
//                        service and the title.
//   permissions.plugins  true => pek.plugins.streamers() lists installed plugins that can play titles
//                        (plugin.json "provides": {"stream": true}); pek.plugins.open(id, title) opens one of
//                        them on that title. Only from a tap.
//   permissions.live     true => pek.live.play({url, title}): opens an http(s) video address (live TV) in PEK TV's own
//                        player. The address must not point at this device (localhost, link-local). Nothing is added to
//                        Watch History. The stream's server sees the user's IP address; the install screen says so.
//   (no permission)      pek.readBundled(name): reads playlists/<name>.json from the plugin's OWN folder (files that
//                        shipped inside the plugin's .zip, JSON only, 1 MB each).
//   ui                   optional shell hints: navTab (a sidebar entry), reloadOnInstall,
//                        closeOnRemove. They only change how PEK TV's own screens behave.
//
// billboard / navbar / block / posterCard {wide, onFocus}: the Netflix-style screen pieces (see the NF section below). A
//                        billboard may carry trailer {id}: PEK TV plays it muted behind the text (its own /api/trailer stream when
//                        available, the YouTube frame otherwise; needs www.youtube-nocookie.com under network). onFocus fires once the
//                        D-pad highlight has rested on a tile for a moment (a passive 'input' message: no redraw by itself).
// hero: a wide backdrop billboard (picture + title + blurb + buttons). Same image rules as posterCard.
// Images: posterCard art is loaded by PEK TV's page (not by the frame), and only from https
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
//    network permission governs pek.fetch*, and the real protection is that a
//    plugin only ever holds data you gave it access to (its own storage and data
//    files, and what it fetched), never PEK TV's API, files, or saved logins.
// ============================================================

const PEK_SANDBOX_LIMITS = {
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
const PEK_SANDBOX_BOOTSTRAP = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
</head><body><script>
(function () {
    'use strict';
    var post = function (m) { parent.postMessage(m, '*'); };
    var pending = new Map(), nextReq = 1;
    var handlers = new Map(), nextHandler = 1;
    var renderFn = null, drawQueued = false;
    var launchFn = null, pendingLaunch = null, nextFn = null, liveFn = null, tvFlag = false;

    function request(op, args, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var id = nextReq++;
            var timer = setTimeout(function () {
                pending.delete(id); reject(new Error('PEK TV did not answer in time'));
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
    function flushLaunch() {
        if (!launchFn || !pendingLaunch) return;
        var l = pendingLaunch; pendingLaunch = null;
        try { launchFn(l); } catch (e) { post({ t: 'log', text: 'launch handler threw: ' + e }); }
        requestRender();
    }

    var ui = {
        text:    function (s) { return { t: 'text', text: str(s) }; },
        heading: function (s) { return { t: 'heading', text: str(s) }; },
        card:    function (title, sub, fn) { return { t: 'card', title: str(title), subtitle: str(sub), on: on(fn) }; },
        button:  function (label, fn, opts) { return { t: 'button', label: str(label), on: on(fn), primary: !!(opts && opts.primary), selected: !!(opts && opts.selected), autofocus: str(opts && opts.autofocus) }; },
        spinner: function (label, big) { return { t: 'spinner', text: str(label), big: !!big }; },
        toggle:  function (label, checked, fn) { return { t: 'toggle', label: str(label), checked: !!checked, on: on(fn) }; },
        video:   function (o) { o = o || {}; return { t: 'video', provider: str(o.provider || 'youtube'), id: str(o.id), autoplay: !!o.autoplay, muted: !!o.muted, title: str(o.title) }; },
        // A "Watch on <service>" button (needs permissions.providers). name = the service's name as TMDb gives it,
        // logo = TMDb's logo_path for it. PEK TV picks what the button opens; the plugin gets no callback.
        providerButton: function (o) {
            o = o || {};
            return { t: 'providerButton', name: str(o.name), logo: str(o.logo), title: str(o.title),
                type: o.type === 'tv' ? 'tv' : 'movie', tmdbId: Number(o.tmdbId) || 0, region: str(o.region) };
        },
        listRow: function (title, sub, fn) { return { t: 'listRow', title: str(title), subtitle: str(sub), on: on(fn) }; },
        // One episode of a show: a still picture on the left (https, from a host the plugin listed under network), then the title,
        // one line of facts and the description. Same image rules as posterCard. dim: true greys it out (not aired yet).
        episodeRow: function (o) {
            o = o || {};
            return { t: 'episodeRow', title: str(o.title), meta: str(o.meta), text: str(o.text), image: str(o.image), dim: !!o.dim, autofocus: str(o.autofocus), on: on(o.on) };
        },
        column:  function () { return { t: 'column', children: flat(arguments) }; },
        row:     function () { return { t: 'row', children: flat(arguments) }; },
        posterCard: function (title, sub, posterUrl, fn, opts) {
            return { t: 'posterCard', title: str(title), subtitle: str(sub), poster: str(posterUrl), badge: str(opts && opts.badge), autofocus: str(opts && opts.autofocus), on: on(fn),
                wide: !!(opts && opts.wide), focus: on(opts && opts.onFocus) };
        },
        // A wide billboard: backdrop picture, title, one line of facts, a short blurb and up to 3 buttons.
        // image must be an https picture from a host the plugin listed under network (same rule as posterCard).
        hero:    function (o) {
            o = o || {};
            return { t: 'hero', title: str(o.title), meta: str(o.meta), text: str(o.text), image: str(o.image), badge: str(o.badge),
                actions: (Array.isArray(o.actions) ? o.actions : []).slice(0, 3).map(function (a) {
                    a = a || {};
                    return { label: str(a.label), on: on(a.on), primary: !!a.primary, autofocus: str(a.autofocus) };
                }) };
        },
        // Netflix-style screen pieces. A PEK TV that does not know them draws nothing for them, so a plugin
        // checks that ui.billboard exists first and falls back to ui.hero.
        // billboard: the big title area (backdrop, title, facts, blurb, up to 3 buttons). With trailer {id} PEK TV plays that
        // YouTube trailer muted behind the text after a moment (direct stream when PEK TV can get one, YouTube frame otherwise).
        billboard: function (o) {
            o = o || {};
            var tr = o.trailer && o.trailer.id ? { id: str(o.trailer.id), title: str(o.trailer.title) } : null;
            return { t: 'billboard', title: str(o.title), meta: str(o.meta), text: str(o.text), image: str(o.image), badge: str(o.badge),
                chip: str(o.chip), key: str(o.key), trailer: tr, muted: o.muted !== false,
                actions: (Array.isArray(o.actions) ? o.actions : []).slice(0, 3).map(function (a) {
                    a = a || {};
                    return { label: str(a.label), on: on(a.on), primary: !!a.primary, autofocus: str(a.autofocus) };
                }) };
        },
        // navbar: brand + tabs (on(id) when one is chosen) + a few round action buttons on the right.
        navbar: function (o) {
            o = o || {};
            return { t: 'navbar', brand: str(o.brand), active: str(o.active), on: on(o.on),
                items: (Array.isArray(o.items) ? o.items : []).slice(0, 8).map(function (i) { return { id: str(i && i.id), label: str(i && i.label) }; }),
                actions: (Array.isArray(o.actions) ? o.actions : []).slice(0, 4).map(function (a) {
                    a = a || {};
                    return { label: str(a.label), icon: str(a.icon), on: on(a.on), selected: !!a.selected, autofocus: str(a.autofocus) };
                }) };
        },
        // block: a plain wrapper the page styles by name (stage | rows | detail | pad | strip).
        block: function (kind) {
            return { t: 'block', kind: str(kind), children: flat([].slice.call(arguments, 1)) };
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
        // there is nothing to step out of). PEK TV then calls it before closing the plugin.
        setBack: function (fn) {
            backFn = typeof fn === 'function' ? fn : null;
            if (backSet !== !!backFn) { backSet = !!backFn; post({ t: 'canBack', v: backSet }); }
        },
        scrollTop: function () { post({ t: 'scrollTop' }); },
        // True while PEK TV is in its TV / D-pad mode (Settings), even on a touch device. A plugin can use it to pick its TV layout.
        isTv: function () { return tvFlag; },
        // Called when PEK TV opens this plugin on a particular title (the Favorites tab, or another plugin):
        // fn({type: 'movie' | 'tv', id: <TMDb id>, title, year}).
        onLaunch: function (fn) { launchFn = typeof fn === 'function' ? fn : null; flushLaunch(); },
        // Called when the player nears the end of an episode this plugin started and PEK TV wants to offer the next one.
        // fn({phase: 'check' | 'play', showTitle, season, episode}) returns a promise of {ok, season, episode, name}.
        //   'check': the episode that was playing; answer with the NEXT one and ok:true only if it can be played.
        //   'play':  season/episode are the one to start now (the player is already closed); resolve once it is playing.
        onNextEpisode: function (fn) { nextFn = typeof fn === 'function' ? fn : null; },
        // Needs permissions.favorites. list() -> ['movie:603', 'tv:1396', ...]
        favorites: {
            list: function () { return request('favList', {}).then(JSON.parse); },
            add: function (it) {
                it = it || {};
                return request('favAdd', { type: str(it.type), id: Number(it.id) || 0, title: str(it.title),
                    year: Number(it.year) || 0, posterPath: str(it.posterPath) });
            },
            remove: function (key) { return request('favRemove', { key: str(key) }); }
        },
        // Needs permissions.plugins. streamers() -> [{id, name}]; open(id, {type, id, title, year}) must come from a tap.
        plugins: {
            streamers: function () { return request('pluginStreamers', {}).then(JSON.parse); },
            open: function (id, it) {
                it = it || {};
                return request('pluginOpen', { id: str(id), type: str(it.type), tmdbId: Number(it.id) || 0,
                    title: str(it.title), year: Number(it.year) || 0 });
            }
        },
        // Needs permissions.live. play({url, title}) opens an http(s) video address in PEK TV's player.
        // Optional channel: an id of your own. With it PEK TV opens a live session: the player shows a now/next banner, a channel
        // switcher and a guide, and asks the function you gave to onQuery for the data ({op:'list'|'now'|'guide'|'url', ...}).
        live: {
            play: function (o) { o = o || {}; return request('livePlay', { url: str(o.url), title: str(o.title), channel: str(o.channel) }, 30000); },
            onQuery: function (fn) { liveFn = typeof fn === 'function' ? fn : null; }
        },
        // Reads playlists/<name> (a .json file) from this plugin's own folder.
        readBundled: function (name) { return request('readBundled', { name: str(name) }, 20000); },
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
        // play opens PEK TV's buffering box and then the player, and resolves once the player is open.
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
                    season: Number(o.season) || 0, episode: Number(o.episode) || 0,
                    kind: str(o.kind), name: str(o.name), year: Number(o.year) || 0, image: str(o.image) }, 15 * 60 * 1000);
            }
        },
        log: function () { post({ t: 'log', text: [].map.call(arguments, str).join(' ') }); }
    };
    Object.freeze(ui); Object.freeze(api.storage); Object.freeze(api.torrent);
    Object.freeze(api.live); Object.freeze(api.favorites); Object.freeze(api.plugins); Object.freeze(api);
    Object.defineProperty(window, 'pek', { value: api, writable: false, configurable: false });
    Object.defineProperty(window, 'hesper', { value: api, writable: false, configurable: false });   // old name, kept so existing plugins keep working

    window.addEventListener('message', function (ev) {
        if (ev.source !== parent) return;
        var m = ev.data;
        if (!m || typeof m !== 'object') return;
        if (m.t === 'init') {
            tvFlag = m.tv === true;
            try {
                var s = document.createElement('script');
                s.textContent = String(m.code);
                document.body.appendChild(s);
            } catch (e) { post({ t: 'log', text: 'plugin failed to start: ' + e }); }
            post({ t: 'started', hasRender: !!renderFn });
        } else if (m.t === 'env') {
            var tvNow = m.tv === true;
            if (tvNow !== tvFlag) { tvFlag = tvNow; requestRender(); }
        } else if (m.t === 'next') {
            var nrid = m.rid, nreq = m.req;
            var nreply = function (ok, v) { post({ t: 'nextRes', rid: nrid, ok: ok, value: v }); };
            if (!nextFn || !nreq || typeof nreq !== 'object') { nreply(false, 'no handler'); return; }
            try {
                Promise.resolve(nextFn(nreq)).then(function (v) { nreply(true, v); }, function (e) { nreply(false, String((e && e.message) || e)); });
            } catch (e) { nreply(false, String(e)); }
        } else if (m.t === 'liveq') {
            var lrid = m.rid, lreq = m.req;
            var lreply = function (ok, v) { post({ t: 'liveqRes', rid: lrid, ok: ok, value: v }); };
            if (!liveFn || !lreq || typeof lreq !== 'object') { lreply(false, 'no handler'); return; }
            try {
                Promise.resolve(liveFn(lreq)).then(function (v) { lreply(true, v); }, function (e) { lreply(false, String((e && e.message) || e)); });
            } catch (e) { lreply(false, String(e)); }
        } else if (m.t === 'launch') {
            if (m.intent && typeof m.intent === 'object') { pendingLaunch = m.intent; flushLaunch(); }
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

// Small inline pictures for the Netflix-style top bar and billboard (written here, never taken from a plugin).
const PEK_NF_ICONS = {
    search: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><g class="nf-ic-on"><path d="M15.5 9a4.5 4.5 0 0 1 0 6"/><path d="M18.3 6.5a8 8 0 0 1 0 11"/></g><g class="nf-ic-off"><path d="M16 9.5l5 5M21 9.5l-5 5"/></g></svg>',
    back: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>'
};

class PekSandbox {
    /** Validates a plugin.json object; anything unexpected simply means "no permission". */
    static normalizeManifest(raw) {
        const out = {
            name: null, version: null,
            permissions: { network: [], storage: false, library: false, torrent: false,
                favorites: false, providers: false, plugins: false, live: false },
            provides: { stream: false },
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
        out.permissions.favorites = perms.favorites === true;
        out.permissions.providers = perms.providers === true;
        out.permissions.plugins = perms.plugins === true;
        out.permissions.live = perms.live === true;
        // "provides": {"stream": true} = this plugin can play movies / shows. Other plugins with the
        // "plugins" permission are offered it as a "Play with ..." button.
        const pv = raw.provides && typeof raw.provides === 'object' ? raw.provides : {};
        out.provides.stream = pv.stream === true;
        const u = raw.ui && typeof raw.ui === 'object' ? raw.ui : {};
        if (typeof u.navTab === 'string') out.ui.navTab = u.navTab.replace(/[^A-Za-z0-9 &+'.-]/g, '').trim().slice(0, 20);
        out.ui.reloadOnInstall = u.reloadOnInstall === true;
        out.ui.closeOnRemove = u.closeOnRemove === true;
        return out;
    }

    // A short fingerprint of a Netflix-style rows list (its first headings), so a saved scroll position is only reused for the
    // same list and not for another tab or screen.
    static _rowsSig(rows) {
        const hs = rows.querySelectorAll('h3');
        let out = '';
        for (let i = 0; i < hs.length && i < 2; i++) out += (hs[i].textContent || '').slice(0, 30) + '|';
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
        this._lastTap = 0;           // when the user last tapped something in this plugin
        this._pendingLaunch = null;  // a title to open as soon as the plugin has started
        this._nextPending = new Map(); // next-episode questions waiting for the plugin's answer
        this._nextId = 0;
        this._liveQ = new Map();       // live-session questions waiting for the plugin's answer
        this._liveQId = 0;
        this._focusMemo = {};        // screen key -> element that had focus when we left it
        this._onMessage = this._onMessage.bind(this);
        PekSandbox._initNav();
    }

    // Remember whether the last input was a key press (remote / keyboard) or a touch / click,
    // so autofocus only draws a highlight ring for the D-pad.
    static _initNav() {
        if (PekSandbox._navInit) return;
        PekSandbox._navInit = true;
        PekSandbox._keyNav = false;
        window.addEventListener('keydown', (e) => { if (/^Arrow|^Enter$/.test(e.key)) PekSandbox._keyNav = true; }, true);
        ['pointerdown', 'mousedown', 'touchstart'].forEach(n =>
            window.addEventListener(n, () => { PekSandbox._keyNav = false; }, true));
    }

    /** Returns the DOM node that shows this plugin's screen, starting the frame on first use. */
    mount(engine) {
        this.engine = engine;
        this.container = engine.createElement('div', { className: 'plugin-sandbox' });
        this.body = engine.createElement('div', { className: 'plugin-sandbox-body' });
        this.container.appendChild(this.body);
        this._dropVideo(); this._videoKey = ''; this._afKey = null;
        this._bindTrailerKeys();
        this._bindPlayerEvents();
        this._bindNfFocus();
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
        f.srcdoc = PEK_SANDBOX_BOOTSTRAP;
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
        this._trStop();
        document.documentElement.classList.remove('nf-on');
        this.tree = null;
        this.canBack = false;
        if (this.container && this.engine) {
            this._dropVideo(); this._videoKey = '';
            this.container.replaceChildren(this.engine.ui.card(this.manifest.name || this.folder, 'This plugin was stopped (' + reason + ').'));
        }
    }

    _send(msg) {
        if (msg && msg.t === 'event') this._lastTap = Date.now();     // every 'event' is a tap / Enter / toggle by the user
        if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage(msg, '*');
    }

    /** Ask the plugin about the next episode (see hesper.onNextEpisode). Always resolves: { ok, season, episode, name, error }. */
    nextEpisode(req, timeoutMs) {
        return new Promise((resolve) => {
            if (!this.started || !this.frame) { resolve({ ok: false, error: 'not running' }); return; }
            const int = (v, max) => { const n = Math.floor(Number(v)); return n > 0 && n <= max ? n : 0; };
            const clean = {
                phase: req && req.phase === 'play' ? 'play' : 'check',
                showTitle: String((req && req.showTitle) || '').slice(0, 200),
                season: Math.max(0, Math.floor(Number(req && req.season)) || 0) % 201,
                episode: int(req && req.episode, 2000)
            };
            const rid = ++this._nextId;
            const timer = setTimeout(() => { this._nextPending.delete(rid); resolve({ ok: false, error: 'timeout' }); }, timeoutMs || 60000);
            this._nextPending.set(rid, (m) => {
                clearTimeout(timer);
                const v = (m.ok && m.value && typeof m.value === 'object') ? m.value : {};
                resolve({
                    ok: v.ok === true, season: Math.max(0, Math.min(200, Math.floor(Number(v.season)) || 0)), episode: int(v.episode, 2000),
                    name: typeof v.name === 'string' ? v.name.slice(0, 120) : '',
                    error: String(v.error || (m.ok ? '' : m.value) || '').slice(0, 200)
                });
            });
            this._send({ t: 'next', rid, req: clean });
        });
    }

    _onNextRes(m) {
        const cb = typeof m.rid === 'number' ? this._nextPending.get(m.rid) : null;
        if (cb) { this._nextPending.delete(m.rid); cb(m); }
    }

    /** Live session: ask the plugin a question for the player's channel list / guide. Resolves with the plugin's answer. */
    liveQuery(req) {
        return new Promise((resolve, reject) => {
            if (!this.started || !this.frame) { reject(new Error('plugin not running')); return; }
            const op = req && req.op;
            if (['list', 'now', 'guide', 'url'].indexOf(op) < 0) { reject(new Error('bad request')); return; }
            const s = (v) => String(v == null ? '' : v).slice(0, 200);
            const clean = { op: op, from: Math.floor(Number(req.from)) || 0, to: Math.floor(Number(req.to)) || 0 };
            if (Array.isArray(req.ids)) clean.ids = req.ids.slice(0, 40).map(s);
            if (req.id != null) clean.id = s(req.id);
            const rid = ++this._liveQId;
            const timer = setTimeout(() => { this._liveQ.delete(rid); reject(new Error('timeout')); }, 15000);
            this._liveQ.set(rid, (m) => {
                clearTimeout(timer);
                if (m.ok) resolve(m.value); else reject(new Error(String(m.value || 'failed').slice(0, 200)));
            });
            this._send({ t: 'liveq', rid, req: clean });
        });
    }

    _onLiveRes(m) {
        const cb = typeof m.rid === 'number' ? this._liveQ.get(m.rid) : null;
        if (cb) { this._liveQ.delete(m.rid); cb(m); }
    }

    /** Ask the plugin to open a title ({type, id, title, year}). Held until the plugin has started. */
    launch(intent) {
        this._pendingLaunch = intent;
        this._flushLaunch();
    }

    _flushLaunch() {
        if (!this._pendingLaunch || !this.started || !this.frame) return;
        const intent = this._pendingLaunch;
        this._pendingLaunch = null;
        this._send({ t: 'launch', intent });
    }

    /** PEK TV's Back key / button asks here first. True = the plugin stepped back inside itself. */
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
            case 'ready': this._send({ t: 'init', code: this.source, tv: PekSandbox._tvOn() }); break;
            case 'started':
                this.started = true;
                this._bindEnv();
                if (window.PekActivity) window.PekActivity.note((this.manifest.name || this.folder) + ' started', true);
                if (!m.hasRender) this._log('this plugin never called pek.render(); nothing to show');
                this._renderTree();
                this._flushLaunch();
                break;
            case 'view': this.tree = m.tree; this._renderTree(); break;
            case 'canBack': this.canBack = m.v === true; break;
            case 'scrollTop':
                if (this.container && this.container.isConnected) this.container.scrollIntoView({ block: 'start' });
                break;
            case 'log': this._log(m.text); break;
            case 'req': this._handleRequest(m); break;
            case 'nextRes': this._onNextRes(m); break;
            case 'liveqRes': this._onLiveRes(m); break;
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
                case 'favList': this._need('favorites'); reply(true, JSON.stringify(window.PekFavorites.keys())); break;
                case 'favAdd': reply(true, this._favAdd(a)); break;
                case 'favRemove': reply(true, this._favRemove(a)); break;
                case 'pluginStreamers': reply(true, this._pluginStreamers()); break;
                case 'pluginOpen': reply(true, this._pluginOpen(a)); break;
                case 'livePlay': reply(true, this._livePlay(a)); break;
                case 'readBundled': reply(true, await this._readBundled(a.name)); break;
                default: throw new Error('unknown request');
            }
        } catch (err) {
            reply(false, (err && err.message) || 'denied');
        }
    }

    // ---------------- favorites / plugins (permissions "favorites", "plugins") ----------------

    _need(perm) {
        if (!this.manifest.permissions[perm]) throw new Error("plugin.json does not request the '" + perm + "' permission");
        if (perm === 'favorites' && !window.PekFavorites) throw new Error('Favorites are not available in this PEK TV');
        if (perm === 'plugins' && !(window.PekHost && window.PekHost.streamers)) throw new Error('Plugin launching is not available in this PEK TV');
    }

    _favAdd(a) {
        this._need('favorites');
        // PEK TV tags the entry with this plugin's folder, so the Favorites tab knows where to open it.
        return window.PekFavorites.add({ type: a.type, id: a.id, title: a.title, year: a.year, posterPath: a.posterPath }, this.folder);
    }

    _favRemove(a) {
        this._need('favorites');
        if (typeof a.key !== 'string' || !/^(movie|tv):\d{1,10}$/.test(a.key)) throw new Error('invalid key');
        return window.PekFavorites.remove(a.key);
    }

    _pluginStreamers() {
        this._need('plugins');
        return JSON.stringify(window.PekHost.streamers(this.folder));
    }

    _pluginOpen(a) {
        this._need('plugins');
        // Only as the answer to a tap, so a plugin cannot open screens on its own.
        if (Date.now() - this._lastTap > 4000) throw new Error('other plugins can only be opened from a tap');
        const type = a.type === 'tv' ? 'tv' : (a.type === 'movie' ? 'movie' : '');
        const id = Math.floor(Number(a.tmdbId));
        if (!type || !(id > 0) || id > 1e9) throw new Error('missing title');
        const year = Math.floor(Number(a.year));
        const intent = { type, id, title: typeof a.title === 'string' ? a.title.slice(0, 200) : '', year: year > 1800 && year < 3000 ? year : 0 };
        if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(a.id) || a.id === this.folder) throw new Error('unknown plugin');
        return window.PekHost.openPlugin(a.id, intent) === true;
    }

    // ---------------- torrent (permission "torrent") ----------------
    // PEK TV does the work; the plugin only gets search results and the result of play().

    _torrentGuard() {
        if (!this.manifest.permissions.torrent) throw new Error("plugin.json does not request the 'torrent' permission");
        if (!window.PekTorrent) throw new Error('Torrent playback is not available in this PEK TV');
    }

    async _torrentInfo() {
        this._torrentGuard();
        return JSON.stringify(await window.PekTorrent.info());
    }

    async _torrentSearch(a) {
        this._torrentGuard();
        const kind = a.kind === 'episode' ? 'episode' : 'movie';
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : '';
        if (!title) throw new Error('missing title');
        const int = (v, max) => { const n = Math.floor(Number(v)); return n > 0 && n <= max ? n : 0; };
        const results = await window.PekTorrent.search({
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
            // PEK TV's server then agrees to download it (it refuses links nobody vouched for).
            let ru;
            try { ru = new URL(source); } catch (e) { throw new Error('invalid release'); }
            if (ru.protocol !== 'https:' || !PekSandbox.hostAllowed(ru.hostname, this.manifest.permissions.network)) {
                throw new Error(`release host "${ru.hostname}" is not in this plugin's network permissions`);
            }
            await window.PekTorrent.allowLink(source);
        }
        const int = (v, max) => { const n = Math.floor(Number(v)); return n > 0 && n <= max ? n : 0; };
        // Optional: what is being watched. With it, PEK TV keeps the position under Resume Watching
        // and a later "resume" starts the same release again at that position.
        let track = null;
        const kind = a.kind === 'movie' || a.kind === 'episode' ? a.kind : '';
        const name = typeof a.name === 'string' ? a.name.trim().slice(0, 200) : '';
        if (kind && name) {
            const meta = { kind };
            const sn = int(a.season, 200), ep = int(a.episode, 2000);
            if (kind === 'movie') { meta.title = name; meta.year = int(a.year, 3000); }
            else if (sn && ep) { meta.showTitle = name; meta.season = sn; meta.episode = ep; }
            if (meta.title || meta.showTitle) {
                if (typeof a.image === 'string' && a.image.length <= 500) {
                    try {
                        const iu = new URL(a.image);
                        if (iu.protocol === 'https:' && !iu.username && !iu.password &&
                            PekSandbox.hostAllowed(iu.hostname, this.manifest.permissions.network)) meta.image = iu.href;
                    } catch (e) { /* no artwork */ }
                }
                track = { meta };
            }
        }
        // A plugin that gave no usable kind/name is still remembered, under the title it gave.
        const plainTitle = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : '';
        if (!track && plainTitle) track = { meta: { kind: 'other', title: plainTitle, season: int(a.season, 200), episode: int(a.episode, 2000) } };
        // Where it was started: set here by PEK TV from the plugin's own folder/name, so a plugin cannot claim to be another one.
        if (track) track.origin = { id: String(this.folder || '').slice(0, 80), name: String(this.manifest.name || this.folder || '').slice(0, 60) };
        await window.PekTorrent.open({
            source, title: typeof a.title === 'string' ? a.title.slice(0, 200) : '',
            season: int(a.season, 200), episode: int(a.episode, 2000), track
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
        if (!PekSandbox.hostAllowed(u.hostname, allowed)) {
            throw new Error(`host "${u.hostname}" is not in this plugin's network permissions`);
        }
        const L = PEK_SANDBOX_LIMITS;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), L.fetchTimeoutMs);
        const actId = 'net:' + this.folder;
        if (window.PekActivity) window.PekActivity.begin(actId, (this.manifest.name || this.folder) + ': loading from ' + u.hostname, true);
        try {
            // No cookies, no credentials, and a redirect to another host is not followed.
            let res, viaServer = false;
            try {
                res = await fetch(u.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal });
            } catch (e) {
                // Browser refused (most sites do not send CORS headers). Plugins with the torrent permission
                // may ask PEK TV's server to fetch the same, already allow-listed address instead.
                if (!(e instanceof TypeError) || !this.manifest.permissions.torrent) throw e;
                viaServer = true;
                res = await fetch('/api/torrent/fetch?url=' + encodeURIComponent(u.href), { cache: 'no-store', signal: ctl.signal });
            }
            if (!res.ok) {
                // PEK TV's server explains why it could not get the page ({"error": "..."}): pass that on,
                // so a bare "HTTP 502" becomes e.g. "HTTP 502 - Could not reach the site (SSL server verification failed)".
                let why = '';
                if (viaServer) {
                    try {
                        const j = JSON.parse((await res.text()).slice(0, 2000));
                        if (j && typeof j.error === 'string') why = ' - ' + j.error.replace(/\s+/g, ' ').slice(0, 110);
                    } catch (e2) { /* no explanation available */ }
                }
                throw new Error('HTTP ' + res.status + why);
            }
            const declared = Number(res.headers.get('content-length') || 0);
            if (declared > L.maxFetchBytes) throw new Error('response too large');
            const text = await res.text();
            if (text.length > L.maxFetchBytes) throw new Error('response too large');
            return text;
        } finally { clearTimeout(timer); if (window.PekActivity) window.PekActivity.end(actId); }
    }

    // ---------------- live streams (permission "live") ----------------
    // The plugin only names an address; PEK TV's own player opens it. Nothing is added to Watch History.

    static isLocalHost(host) {
        const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
        if (h === '::' || h === '::1' || h.startsWith('fe80:') || h.startsWith('::ffff:')) return true;
        const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (m) { const a = +m[1], b = +m[2]; return a === 0 || a === 127 || (a === 169 && b === 254); }
        return false;
    }

    _livePlay(a) {
        this._need('live');
        if (!(window.PekHost && typeof window.PekHost.playStream === 'function')) throw new Error('PEK TV cannot play streams here');
        const raw = typeof a.url === 'string' ? a.url.trim() : '';
        if (!raw || raw.length > 2000) throw new Error('invalid stream address');
        let u;
        try { u = new URL(raw); } catch (e) { throw new Error('invalid stream address'); }
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) {
            throw new Error('only plain http:// or https:// stream addresses are allowed');
        }
        if (PekSandbox.isLocalHost(u.hostname)) throw new Error('stream addresses on this device are not allowed');
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 120) : '';
        window.PekHost.playStream(u.href, title, null, null, this._liveCtl(a, title));
        return true;
    }

    // The same address rules as pek.live.play, for a channel the player switches to later. Returns the checked address.
    _checkStreamUrl(raw) {
        raw = typeof raw === 'string' ? raw.trim() : '';
        if (!raw || raw.length > 2000) throw new Error('invalid stream address');
        let u;
        try { u = new URL(raw); } catch (e) { throw new Error('invalid stream address'); }
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error('only plain http:// or https:// stream addresses are allowed');
        if (PekSandbox.isLocalHost(u.hostname)) throw new Error('stream addresses on this device are not allowed');
        return u.href;
    }

    // A live session exists only when the plugin named a channel. The player never sees the plugin itself, only these three things.
    _liveCtl(a, title) {
        const ch = typeof a.channel === 'string' ? a.channel.slice(0, 200) : '';
        if (!ch) return null;
        return { channel: ch, title: title, query: (req) => this.liveQuery(req), check: (u) => this._checkStreamUrl(u) };
    }

    // ---------------- files shipped inside the plugin (no permission needed) ----------------

    async _readBundled(name) {
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(name)) throw new Error('invalid file name');
        const res = await fetch(`/plugins/${encodeURIComponent(this.folder)}/playlists/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('no such file');
        const text = await res.text();
        if (text.length > PEK_SANDBOX_LIMITS.maxFetchBytes) throw new Error('file too large');
        return text;
    }

    async _readData(name) {
        if (!this.manifest.permissions.storage) throw new Error("plugin.json does not request the 'storage' permission");
        if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error('invalid file name');
        const res = await fetch(`/plugins/${encodeURIComponent(this.folder)}/data/${encodeURIComponent(name)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('no such data file');
        const text = await res.text();
        if (text.length > PEK_SANDBOX_LIMITS.maxFetchBytes) throw new Error('file too large');
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
        if (typeof value !== 'string' || value.length > PEK_SANDBOX_LIMITS.maxValueBytes) throw new Error('value too large');
        const existing = (localStorage.getItem(k) || '').length;
        if (this._storageUsed() - existing + value.length > PEK_SANDBOX_LIMITS.storageBytesPerPlugin) throw new Error('storage quota exceeded');
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
        // The Netflix-style TV screen scrolls inside .nf-rows (not the page). A redraw builds a new one, which starts at the
        // top, so remember how far it was scrolled (and which list it was) or the rows jump back up after every redraw.
        const nfRows = c.querySelector('.nf-stage > .nf-rows');
        if (nfRows) { keep.rowsTop = nfRows.scrollTop; keep.rowsSig = PekSandbox._rowsSig(nfRows); }
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
        if (keep.rowsTop > 0) {
            const nr = c.querySelector('.nf-stage > .nf-rows');
            if (nr && PekSandbox._rowsSig(nr) === keep.rowsSig) nr.scrollTop = keep.rowsTop;   // same list: stay where we were
        }
        if (keep.input) {
            const inp = c.querySelector('input[data-sx-key="' + keep.input.key + '"]');
            if (inp) {
                if (inp.value !== keep.input.value) inp.value = keep.input.value;
                inp.focus();
                try { inp.setSelectionRange(keep.input.start, keep.input.end); } catch (e) { /* not supported for this type */ }
            }
        }
    }

    // Poster art is fetched by this page, so it follows the same rule as pek.fetch*:
    // https only, and only hosts listed in plugin.json permissions.network.
    _imageUrl(raw) {
        if (typeof raw !== 'string' || !raw || raw.length > 500) return '';
        let u;
        try { u = new URL(raw); } catch (e) { return ''; }
        if (u.protocol !== 'https:' || u.username || u.password) return '';
        if (!PekSandbox.hostAllowed(u.hostname, this.manifest.permissions.network)) return '';
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
                if (!target && PekSandbox._keyNav) target = af.el;
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
        if (this._playerActive) v = null;          // a movie is playing: no trailer (and no iframe kept in memory)
        if (v && v.provider === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(v.id) &&
            PekSandbox.hostAllowed('www.youtube-nocookie.com', this.manifest.permissions.network)) {
            src = 'https://www.youtube-nocookie.com/embed/' + v.id + '?playsinline=1&rel=0&modestbranding=1' +
                (v.autoplay ? '&autoplay=1' : '') + (v.muted ? '&mute=1' : '');
            key = src;
        }
        if (key === this._videoKey) return;
        this._dropVideo();
        this._videoKey = key;
        if (!key) return;
        this._vsrc = src;
        this._vtitle = (v.title || 'Trailer').slice(0, 100);
        // The black 16:9 box is placed at once (so the page does not jump); the YouTube frame itself
        // is only created after a short pause and only while the box is on screen. A YouTube player is
        // heavy on a TV WebView: it must not be built for every page flicked past, nor keep decoding
        // video that was scrolled out of view.
        this._vbox = this.engine.createElement('div', { className: 'sx-video-box' });
        this.slot = this.engine.createElement('div', { className: 'sx-video' }, this._vbox);
        this.container.insertBefore(this.slot, this.body);
        if (this._keepScroll) this._keepScroll = false; else this._showTrailer();
        this._watchVideo();
        this._scheduleFrame(1200);
    }

    // Removes the trailer completely and frees the YouTube frame (blanking it first lets the WebView
    // release the player's memory straight away instead of at some later garbage collection).
    _dropVideo() {
        if (this._vtimer) { clearTimeout(this._vtimer); this._vtimer = 0; }
        if (this._vio) { try { this._vio.disconnect(); } catch (e) { /* ignore */ } this._vio = null; }
        this._unmountFrame();
        if (this.slot) { this.slot.remove(); this.slot = null; }
        this._vbox = null; this._vsrc = ''; this._vvisible = undefined;
    }

    _mountFrame() {
        const box = this._vbox;
        if (!box || !box.isConnected || !this._vsrc || box.querySelector('iframe')) return;
        const f = document.createElement('iframe');
        f.src = this._vsrc;
        f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
        f.setAttribute('allowfullscreen', '');
        // PEK TV sends "Referrer-Policy: no-referrer" by default and YouTube refuses to play
        // an embed that sends no referrer, so this one frame gets its own policy.
        f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
        f.setAttribute('title', this._vtitle || 'Trailer');
        f.tabIndex = -1;
        box.appendChild(f);
    }

    _unmountFrame() {
        const box = this._vbox;
        const f = box && box.querySelector('iframe');
        if (!f) return;
        try { f.src = 'about:blank'; } catch (e) { /* ignore */ }
        f.remove();
    }

    _scheduleFrame(ms) {
        if (this._vtimer) clearTimeout(this._vtimer);
        this._vtimer = setTimeout(() => {
            this._vtimer = 0;
            if (this._vvisible !== false) this._mountFrame();
        }, ms);
    }

    // Frees the frame while the trailer is mostly scrolled out of view (or the screen is left) and
    // brings it back when it is seen again.
    _watchVideo() {
        if (typeof IntersectionObserver !== 'function' || !this.slot) return;
        try {
            this._vio = new IntersectionObserver((entries) => {
                const en = entries[entries.length - 1];
                const vis = en.intersectionRatio >= 0.3;
                if (vis === this._vvisible) return;
                this._vvisible = vis;
                if (vis) this._scheduleFrame(400);
                else {
                    if (this._vtimer) { clearTimeout(this._vtimer); this._vtimer = 0; }
                    this._unmountFrame();
                }
            }, { threshold: [0, 0.3, 1] });
            this._vio.observe(this.slot);
        } catch (e) { this._vio = null; }
    }

    // ---------------- Netflix-style pieces: billboard, trailer preview, focus preview ----------------
    // The billboard's picture + trailer layer is ONE element that survives redraws (moved into each new billboard), so a
    // trailer keeps playing while the text / buttons around it are rebuilt. A trailer plays muted behind the text unless the
    // viewer unmuted it (the speaker button). Source order: (1) PEK TV's own /api/trailer (a direct video stream, played in a
    // plain <video>: no player chrome, no embed errors), (2) the YouTube frame, only if (1) is not available here.

    static _trailerInfo(id) {
        const cache = PekSandbox._trCache || (PekSandbox._trCache = new Map());
        const hit = cache.get(id);
        if (hit && Date.now() - hit.t < (hit.ok ? 900000 : 120000)) return hit.p;
        const p = (async () => {
            if (PekSandbox._noTrailerApi) return null;
            let r;
            try { r = await fetch('/api/trailer?id=' + encodeURIComponent(id), { cache: 'no-store' }); } catch (e) { return null; }
            if (r.status === 404) { PekSandbox._noTrailerApi = true; return null; }     // an older PEK TV backend: use the YouTube frame
            if (!r.ok) return null;
            let j; try { j = await r.json(); } catch (e) { return null; }
            const okUrl = (u) => typeof u === 'string' && /^\/api\/trailer\/stream\?/.test(u);
            if (!j || j.ok !== true || !okUrl(j.video)) return null;
            return { video: j.video, audio: okUrl(j.audio) ? j.audio : '', hasAudio: j.hasAudio === true, height: Number(j.height) || 0 };
        })();
        const rec = { t: Date.now(), p, ok: false };
        cache.set(id, rec);
        p.then(v => { rec.ok = !!v; });
        if (cache.size > 60) cache.delete(cache.keys().next().value);
        return p;
    }

    _trailerAllowed() {
        if (window.PekLite && window.PekLite.noVideo()) return false;   // performance mode: no trailer video behind the billboard
        return PekSandbox.hostAllowed('www.youtube-nocookie.com', this.manifest.permissions.network);
    }

    // The persistent picture + trailer layer. url = the artwork to show (crossfades from the previous one).
    _bbMedia(url) {
        const { createElement } = this.engine;
        let m = this._bbEl;
        if (!m) {
            const mk = (cls) => {
                const im = createElement('img', { className: 'nf-bb-img ' + cls, alt: '' });
                im.setAttribute('referrerpolicy', 'no-referrer'); im.setAttribute('decoding', 'async'); im.setAttribute('draggable', 'false');
                return im;
            };
            m = this._bbEl = createElement('div', { className: 'nf-bb-media' }, mk('nf-prev'), mk('nf-cur'), createElement('div', { className: 'nf-bb-trailer' }));
            if (typeof IntersectionObserver === 'function') {
                try {
                    new IntersectionObserver((es) => {
                        const seen = es[es.length - 1].intersectionRatio >= 0.2;
                        if (seen === this._bbSeen) return;
                        this._bbSeen = seen;
                        this._trVisible(seen);
                    }, { threshold: [0, 0.2, 1] }).observe(m);
                } catch (e) { /* no observer: the trailer just keeps playing */ }
            }
            if (!this._bbDocBound) {
                this._bbDocBound = true;
                document.addEventListener('visibilitychange', () => this._trVisible(!document.hidden && this._bbSeen !== false));
            }
        }
        const cur = m.querySelector('.nf-cur'), prev = m.querySelector('.nf-prev');
        if (url && cur.getAttribute('data-src') !== url) {
            if (cur.getAttribute('src')) { prev.src = cur.getAttribute('src'); prev.classList.add('nf-in'); }
            cur.setAttribute('data-src', url);
            cur.classList.remove('nf-in');
            cur.onload = () => { cur.classList.add('nf-in'); prev.classList.remove('nf-in'); };
            cur.onerror = () => { prev.classList.remove('nf-in'); };
            cur.src = url;
        } else if (!url) {
            cur.removeAttribute('src'); cur.removeAttribute('data-src'); cur.classList.remove('nf-in'); prev.classList.remove('nf-in');
        }
        return m;
    }

    _bbSync(bb) {
        if (!bb || this._playerActive || !this._trailerAllowed()) { this._trStop(); return; }
        const cur = this._tr;
        if (cur && cur.id === bb.id) {            // same trailer, the billboard around it was rebuilt: keep it going
            if (cur.v && cur.v.paused && !cur.v.ended && this._bbSeen !== false && !document.hidden) {
                const p = cur.v.play(); if (p && p.catch) p.catch(() => {});
            }
            return;
        }
        this._trStop();
        const tr = { id: bb.id, v: null, a: null, f: null, info: null, kind: '', timer: 0, tmo: 0 };
        tr.sound = typeof this._bbSoundPref === 'boolean' ? this._bbSoundPref : bb.muted === false;
        this._tr = tr;
        if (this._bbEl) this._bbEl.classList.toggle('nf-snd', tr.sound);
        tr.timer = setTimeout(() => { tr.timer = 0; this._trResolve(tr); }, 250);
    }

    _trLive(tr) { return this._tr === tr && !!this.container && this.container.isConnected && !this._playerActive; }

    _trResolve(tr) {
        if (!this._trLive(tr)) return;
        PekSandbox._trailerInfo(tr.id).then((info) => {
            if (!this._trLive(tr)) return;
            if (info) this._trVideo(tr, info); else this._trEmbed(tr);
        }, () => { if (this._trLive(tr)) this._trEmbed(tr); });
    }

    _trVideo(tr, info) {
        const layer = this._bbEl && this._bbEl.querySelector('.nf-bb-trailer');
        if (!layer) return;
        tr.kind = 'video'; tr.info = info;
        const v = document.createElement('video');
        v.className = 'nf-bb-video';
        v.muted = !(tr.sound && info.hasAudio); v.defaultMuted = v.muted;
        v.playsInline = true; v.preload = 'auto'; v.tabIndex = -1;
        v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('disablepictureinpicture', '');
        v.setAttribute('aria-hidden', 'true');
        tr.v = v;
        const bad = () => { if (this._trLive(tr) && tr.kind === 'video') this._trEmbed(tr); };
        v.addEventListener('error', bad);
        v.addEventListener('playing', () => {
            if (tr.tmo) { clearTimeout(tr.tmo); tr.tmo = 0; }
            if (this._trLive(tr) && this._bbEl) this._bbEl.classList.add('nf-playing');
        });
        v.addEventListener('ended', () => {            // like Netflix: the trailer ends and the artwork comes back
            if (this._bbEl && this._tr === tr) { this._bbEl.classList.remove('nf-playing'); this._bbEl.classList.add('nf-ended'); }
        });
        tr.tmo = setTimeout(bad, 12000);               // nothing playing after 12 s: use the YouTube frame instead
        layer.appendChild(v);
        v.src = info.video;
        const go = v.play();
        if (go && go.catch) go.catch(() => {            // sound not allowed to start by itself: play muted
            tr.sound = false; v.muted = true;
            if (this._bbEl) this._bbEl.classList.remove('nf-snd');
            const g2 = v.play(); if (g2 && g2.catch) g2.catch(bad);
        });
        if (tr.sound && !info.hasAudio && info.audio) this._trAudio(tr, true);
    }

    // Trailers whose picture and sound come as two streams: a hidden <audio> kept in step with the <video>.
    _trAudio(tr, on) {
        if (!tr.v || !tr.info || !tr.info.audio) return;
        if (!on) { if (tr.a) { try { tr.a.pause(); } catch (e) { /* ignore */ } } return; }
        if (!tr.a) {
            const a = new Audio();
            a.preload = 'auto'; a.src = tr.info.audio; tr.a = a;
            const v = tr.v;
            v.addEventListener('play', () => { if (tr.sound && tr.a) { try { tr.a.currentTime = v.currentTime; } catch (e) { /* not ready */ } const p = tr.a.play(); if (p && p.catch) p.catch(() => {}); } });
            v.addEventListener('pause', () => { if (tr.a) tr.a.pause(); });
            v.addEventListener('seeking', () => { if (tr.a) { try { tr.a.currentTime = v.currentTime; } catch (e) { /* not ready */ } } });
        }
        try { tr.a.currentTime = tr.v.currentTime || 0; } catch (e) { /* not ready */ }
        const p = tr.a.play(); if (p && p.catch) p.catch(() => {});
    }

    _trEmbed(tr) {
        if (!this._trLive(tr) || tr.kind === 'embed' || !this._trailerAllowed()) return;
        const layer = this._bbEl && this._bbEl.querySelector('.nf-bb-trailer');
        if (!layer) return;
        this._trClear(tr);
        tr.kind = 'embed';
        const f = document.createElement('iframe');
        f.className = 'nf-bb-embed';
        f.src = 'https://www.youtube-nocookie.com/embed/' + tr.id + '?autoplay=1&mute=1&controls=0&disablekb=1&fs=0&iv_load_policy=3' +
            '&modestbranding=1&playsinline=1&rel=0&showinfo=0&enablejsapi=1&loop=1&playlist=' + tr.id;
        f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
        f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');   // YouTube refuses an embed that sends no referrer
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
        f.setAttribute('title', 'Trailer'); f.setAttribute('aria-hidden', 'true');
        f.tabIndex = -1;
        f.addEventListener('load', () => {
            setTimeout(() => {
                if (!this._trLive(tr) || tr.f !== f) return;
                if (this._bbEl) this._bbEl.classList.add('nf-playing');
                if (tr.sound) this._trSound(tr, true);
            }, 1500);
        });
        tr.f = f;
        layer.appendChild(f);
    }

    _trCmd(tr, func) {
        try { if (tr.f && tr.f.contentWindow) tr.f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*'); } catch (e) { /* frame gone */ }
    }

    _trSound(tr, on) {
        tr.sound = on;
        if (this._bbEl) this._bbEl.classList.toggle('nf-snd', on);
        if (tr.kind === 'video' && tr.v) {
            if (tr.info && tr.info.hasAudio) tr.v.muted = !on; else this._trAudio(tr, on);
        } else if (tr.kind === 'embed') this._trCmd(tr, on ? 'unMute' : 'mute');
    }

    _bbToggleSound() {
        const tr = this._tr; if (!tr) return;
        this._bbSoundPref = !tr.sound;
        this._trSound(tr, this._bbSoundPref);
    }

    _trVisible(seen) {
        const tr = this._tr; if (!tr) return;
        if (tr.v) {
            if (seen) { if (!tr.v.ended) { const p = tr.v.play(); if (p && p.catch) p.catch(() => {}); } } else tr.v.pause();
        } else if (tr.f) this._trCmd(tr, seen ? 'playVideo' : 'pauseVideo');
    }

    _trClear(tr) {
        [tr.v, tr.a].forEach((m) => {
            if (!m) return;
            try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) { /* ignore */ }
            if (m.remove) m.remove();
        });
        if (tr.f) { try { tr.f.src = 'about:blank'; } catch (e) { /* ignore */ } tr.f.remove(); }
        tr.v = tr.a = tr.f = null;
    }

    _trStop() {
        const tr = this._tr; this._tr = null;
        if (this._bbEl) this._bbEl.classList.remove('nf-playing', 'nf-ended');
        if (!tr) return;
        if (tr.timer) clearTimeout(tr.timer);
        if (tr.tmo) clearTimeout(tr.tmo);
        this._trClear(tr);
    }

    // The dark Netflix look is switched on for the whole page while one of these screens is showing, and off again
    // when the plugin window is closed (checked on a short timer, because closing removes the screen without telling us).
    _nfSync(budget) {
        const on = budget.nf === true;
        if (this.container) this.container.classList.toggle('nf-root', on);
        document.documentElement.classList.toggle('nf-on', on);
        if (on && !this._nfTimer) {
            this._nfTimer = setInterval(() => {
                if (this.container && this.container.isConnected) return;
                clearInterval(this._nfTimer); this._nfTimer = 0;
                document.documentElement.classList.remove('nf-on');
                this._trStop();
            }, 700);
        }
        this._bbSync(budget.bb);
    }

    // Holding the D-pad on a tile (one with a focus handler) tells the plugin which title is highlighted, once the
    // highlight has settled for a moment, so it can show that title in the billboard and start its trailer.
    static _tvOn() { return !!(document.documentElement && document.documentElement.classList.contains('pek-tv')); }

    // Tells the plugin when TV / D-pad mode is switched on or off while it is open.
    _bindEnv() {
        if (this._envBound || typeof MutationObserver !== 'function') return;
        this._envBound = true;
        let last = PekSandbox._tvOn();
        new MutationObserver(() => {
            const now = PekSandbox._tvOn();
            if (now === last) return;
            last = now;
            this._send({ t: 'env', tv: now });
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }

    _bindNfFocus() {
        if (this._nfFocusBound || typeof MutationObserver !== 'function' || !this.container) return;
        this._nfFocusBound = true;
        const fire = () => {
            this._nfFocusTimer = 0;
            if (!this.container || !this.container.isConnected) return;
            const el = this.container.querySelector('.focused');
            const id = el && el.dataset ? Number(el.dataset.nfFocus) : 0;
            if (id > 0) this._send({ t: 'input', id });
        };
        new MutationObserver(() => {
            const el = this.container.querySelector('.focused');
            const key = el && el.dataset && el.dataset.nfFocus ? (el.dataset.sxFocus || el.dataset.nfFocus) : '';
            if (key === this._nfFocusKey) return;
            this._nfFocusKey = key;
            if (this._nfFocusTimer) clearTimeout(this._nfFocusTimer);
            this._nfFocusTimer = key ? setTimeout(fire, 260) : 0;
        }).observe(this.container, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    // The element that actually scrolls this plugin's page: the plugin window's body, or the
    // main content area when the plugin is shown as a tab.
    _scroller() {
        let el = this.slot ? this.slot.parentElement : null;
        while (el && el !== document.body && el !== document.documentElement) {
            const oy = window.getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
            el = el.parentElement;
        }
        return null;
    }

    // A new trailer must be seen whole: scroll the page back to the top (the focus code scrolls
    // the page to the first button, which used to leave the trailer cut off at the top while its
    // sound kept playing). Done a little later too, because the page is attached after this runs.
    _showTrailer() {
        const toTop = () => {
            if (!this.slot || !this.slot.isConnected) return;
            const sp = this._scroller();
            if (sp && sp.scrollTop > 0) sp.scrollTop = 0;
        };
        toTop();
        setTimeout(toTop, 60);
        setTimeout(toTop, 300);
    }

    // While a player is open (full screen or the mini bar) the trailer is removed, which stops its
    // sound and frees the YouTube frame. When the player closes the page is drawn again.
    _bindPlayerEvents() {
        if (this._playerEvents) return;
        this._playerEvents = true;
        document.addEventListener('pek-player', (e) => {
            const active = !!(e && e.detail && e.detail.active);
            if (active === !!this._playerActive) return;
            this._playerActive = active;
            if (!this.container || !this.container.isConnected) return;
            if (active) {
                this._syncVideo(null);
                this._trStop();
            } else {
                this._keepScroll = true;              // coming back from a movie: do not jump the page to the top
                this._renderTree();
                this._keepScroll = false;
            }
        });
    }

    // Pressing Up / Left toward the first row under a half-hidden trailer brings the trailer back.
    _bindTrailerKeys() {
        if (this._trailerKeys) return;
        this._trailerKeys = true;
        window.addEventListener('keyup', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowLeft') return;
            if (!this.slot || !this.slot.isConnected || !this.body) return;
            const sp = this._scroller();
            const f = this.body.querySelector('.focused');
            if (!sp || !f) return;
            const slotRect = this.slot.getBoundingClientRect();
            const hidden = slotRect.top < sp.getBoundingClientRect().top - 1;
            const nearSlot = f.getBoundingClientRect().top - slotRect.bottom < 200;
            if (hidden && nearSlot) {
                if (sp.scrollTo) { try { sp.scrollTo({ top: 0, behavior: 'smooth' }); return; } catch (err) { /* old WebView */ } }
                sp.scrollTop = 0;
            }
        });
    }

    _renderTree() {
        if (!this.container || !this.body) return;
        const { ui } = this.engine;
        let content;
        const keep = this._captureView();
        const budget = { nodes: 0, inputs: 0, scrolls: 0, video: null, af: null, nf: false, bb: null };
        if (this.tree) {
            content = this._build(this.tree, 0, budget) || ui.card(this.manifest.name || this.folder, 'Nothing to show.');
        } else if (this.started) {
            content = ui.card(this.manifest.name || this.folder,
                'This plugin did not draw anything. Plugins in sandboxed mode must call pek.render(ui => ...).');
        } else {
            content = ui.card(this.manifest.name || this.folder, 'Starting\u2026');
        }
        this.body.replaceChildren(content);
        this._nfSync(budget);
        this._syncVideo(budget.video);
        this._restoreView(keep);
        this._tagFocus();
        if (this.engine.refreshFocusList) this.engine.refreshFocusList();
        this._placeFocus(keep, budget);
    }

    _build(n, depth, budget) {
        const L = PEK_SANDBOX_LIMITS;
        const { createElement, ui } = this.engine;
        if (!n || typeof n !== 'object' || depth > L.maxDepth || ++budget.nodes > L.maxNodes) return null;
        const s = (v) => (typeof v === 'string' ? v.slice(0, L.maxString) : '');
        const click = (id) => (typeof id === 'number' && id > 0) ? () => this._send({ t: 'event', id }) : null;

        switch (n.t) {
            case 'text': return createElement('p', {}, s(n.text));
            case 'heading': return createElement('h3', {}, s(n.text));
            case 'card': return ui.card(s(n.title), s(n.subtitle), click(n.on));
            case 'listRow': return ui.listRow(s(n.title), s(n.subtitle), click(n.on));
            case 'episodeRow': {
                const img = this._imageUrl(n.image);
                const title = s(n.title).slice(0, 160), meta = s(n.meta).slice(0, 160), text = s(n.text).slice(0, 700);
                budget.nodes += 4;
                const thumb = createElement('div', { className: 'sx-ep-thumb' });
                if (img) {
                    const im = createElement('img', { className: 'sx-ep-img', src: img, alt: '' });
                    im.setAttribute('referrerpolicy', 'no-referrer');
                    im.setAttribute('loading', 'lazy');
                    im.setAttribute('decoding', 'async');
                    im.setAttribute('draggable', 'false');
                    im.addEventListener('error', () => { if (im.parentNode) im.parentNode.removeChild(im); });
                    thumb.appendChild(im);
                }
                const el = createElement('div', { className: 'plugin-row focusable sx-list-row sx-ep-row' + (n.dim === true ? ' sx-ep-dim' : ''), onClick: click(n.on) || (() => {}) },
                    thumb,
                    createElement('div', { className: 'sx-ep-body' },
                        createElement('h3', {}, title),
                        meta ? createElement('p', { className: 'sx-ep-meta' }, meta) : null,
                        text ? createElement('p', { className: 'sx-ep-text' }, text) : null));
                if (n.autofocus && typeof n.autofocus === 'string' && !budget.af) budget.af = { key: n.autofocus.slice(0, 60), el };
                return el;
            }
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
            case 'providerButton': {
                // PEK TV, not the plugin, decides what this opens: see providers.js.
                if (!this.manifest.permissions.providers || !window.PekProviders) return null;
                const name = s(n.name).slice(0, 60);
                if (!name) return null;
                const spec = { name, title: s(n.title).slice(0, 200), type: n.type === 'tv' ? 'tv' : 'movie',
                    tmdbId: Number(n.tmdbId) || 0, region: s(n.region).slice(0, 2) };
                const known = window.PekProviders.find(name);
                const label = known ? known.name : name;
                const b = ui.button(label, () => { window.PekProviders.open(spec); }, { variant: 'secondary' });
                b.classList.add('sx-provider');
                b.setAttribute('aria-label', 'Watch ' + (spec.title || 'this title') + ' on ' + label);
                // The logo is TMDb's own picture of the service, loaded only from a host the plugin may use.
                const logo = typeof n.logo === 'string' && /^\/[A-Za-z0-9_-]{5,80}\.(jpg|jpeg|png|webp)$/.test(n.logo) ? n.logo : '';
                const logoUrl = logo ? this._imageUrl('https://image.tmdb.org/t/p/w92' + logo) : '';
                if (logoUrl) {
                    const im = createElement('img', { className: 'sx-provider-logo', src: logoUrl, alt: '' });
                    im.setAttribute('referrerpolicy', 'no-referrer');
                    im.setAttribute('decoding', 'async');
                    im.setAttribute('draggable', 'false');
                    im.addEventListener('error', () => { if (im.parentNode) im.parentNode.removeChild(im); });
                    b.insertBefore(im, b.firstChild);
                }
                return b;
            }
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
                if (n.wide === true) el.classList.add('nf-wide');
                if (typeof n.focus === 'number' && n.focus > 0) el.dataset.nfFocus = String(n.focus);
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
            case 'hero': {
                const img = this._imageUrl(n.image);
                const actions = (Array.isArray(n.actions) ? n.actions : []).slice(0, 3).map(a => {
                    if (!a || typeof a !== 'object') return null;
                    const b = ui.button(s(a.label).slice(0, 40), click(a.on) || (() => {}), { variant: a.primary === true ? 'primary' : 'secondary' });
                    if (a.autofocus && typeof a.autofocus === 'string' && !budget.af) budget.af = { key: a.autofocus.slice(0, 60), el: b };
                    return b;
                }).filter(Boolean);
                budget.nodes += actions.length + 4;
                const badge = s(n.badge).slice(0, 30), meta = s(n.meta).slice(0, 160);
                let text = s(n.text).slice(0, 600);
                // Narrow phone screens: end the description at a sentence (or clause) instead of letting it be cut off with "...".
                try {
                    if (window.matchMedia && window.matchMedia('(max-width: 700px), (max-height: 500px)').matches && text.length > 150) {
                        let cut = -1, m; const re = /[.!?](?=\s|$)/g;
                        while ((m = re.exec(text)) && m.index < 150) cut = m.index + 1;
                        if (cut > 40) text = text.slice(0, cut);
                        else { const c = text.lastIndexOf(', ', 150); if (c > 40) text = text.slice(0, c) + '.'; }
                    }
                } catch (e) { /* keep the full text */ }
                const el = createElement('div', { className: 'sx-hero' + (img ? '' : ' sx-hero-noimg') });
                if (img) {
                    const im = createElement('img', { className: 'sx-hero-img', src: img, alt: '' });
                    im.setAttribute('referrerpolicy', 'no-referrer');
                    im.setAttribute('decoding', 'async');
                    im.setAttribute('draggable', 'false');
                    im.addEventListener('error', () => { if (im.parentNode) im.parentNode.removeChild(im); el.classList.add('sx-hero-noimg'); });
                    el.appendChild(im);
                }
                el.appendChild(createElement('div', { className: 'sx-hero-shade' }));
                el.appendChild(createElement('div', { className: 'sx-hero-body' },
                    badge ? createElement('span', { className: 'sx-hero-badge' }, badge) : null,
                    createElement('h2', { className: 'sx-hero-title' }, s(n.title).slice(0, 120)),
                    meta ? createElement('p', { className: 'sx-hero-meta' }, meta) : null,
                    text ? createElement('p', { className: 'sx-hero-text' }, text) : null,
                    actions.length ? createElement('div', { className: 'sx-hero-actions' }, ...actions) : null));
                return el;
            }
            case 'block': {
                const kind = /^(stage|rows|detail|pad|strip|top)$/.test(n.kind) ? n.kind : 'pad';
                const kids = (Array.isArray(n.children) ? n.children : []).slice(0, 200).map(c => this._build(c, depth + 1, budget)).filter(Boolean);
                return createElement('div', { className: 'nf-' + kind + (kind === 'top' ? ' nf-pad' : '') }, ...kids);
            }
            case 'navbar': {
                budget.nf = true;
                const on = n.on;
                const items = (Array.isArray(n.items) ? n.items : []).slice(0, 8).filter(i => i && typeof i.id === 'string');
                const tabs = items.map(i => {
                    const b = createElement('div', {
                        className: 'focusable nf-nav-item' + (i.id === n.active ? ' nf-active' : ''), role: 'tab', title: s(i.label).slice(0, 30),
                        onClick: () => { if (typeof on === 'number' && on > 0) this._send({ t: 'event', id: on, value: i.id.slice(0, 40) }); }
                    }, s(i.label).slice(0, 30));
                    return b;
                });
                const acts = (Array.isArray(n.actions) ? n.actions : []).slice(0, 4).map(a => {
                    if (!a || typeof a !== 'object') return null;
                    const label = s(a.label).slice(0, 30);
                    const b = createElement('div', {
                        className: 'focusable nf-nav-act' + (a.selected === true ? ' nf-active' : ''), role: 'button', title: label,
                        onClick: click(a.on) || (() => {})
                    });
                    const ic = PEK_NF_ICONS[typeof a.icon === 'string' ? a.icon : ''];
                    if (ic) b.innerHTML = ic; else b.textContent = label;
                    if (a.autofocus && typeof a.autofocus === 'string' && !budget.af) budget.af = { key: a.autofocus.slice(0, 60), el: b };
                    return b;
                }).filter(Boolean);
                budget.nodes += tabs.length + acts.length + 3;
                const brand = s(n.brand).slice(0, 24);
                return createElement('div', { className: 'nf-nav' },
                    brand ? createElement('div', { className: 'nf-brand' }, brand) : null,
                    createElement('div', { className: 'nf-nav-items', role: 'tablist' }, ...tabs),
                    createElement('div', { className: 'nf-nav-acts' }, ...acts));
            }
            case 'billboard': {
                const img = this._imageUrl(n.image);
                const actions = (Array.isArray(n.actions) ? n.actions : []).slice(0, 3).map(a => {
                    if (!a || typeof a !== 'object') return null;
                    const b = ui.button(s(a.label).slice(0, 40), click(a.on) || (() => {}), { variant: a.primary === true ? 'primary' : 'secondary' });
                    b.classList.add('nf-btn', a.primary === true ? 'nf-btn-play' : 'nf-btn-more');
                    if (a.autofocus && typeof a.autofocus === 'string' && !budget.af) budget.af = { key: a.autofocus.slice(0, 60), el: b };
                    return b;
                }).filter(Boolean);
                budget.nodes += actions.length + 8; budget.nf = true;
                const tid = n.trailer && typeof n.trailer.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(n.trailer.id) ? n.trailer.id : '';
                if (tid && !budget.bb) budget.bb = { id: tid, title: s(n.trailer.title).slice(0, 100), muted: n.muted !== false };
                const media = this._bbMedia(img);
                const badge = s(n.badge).slice(0, 30), meta = s(n.meta).slice(0, 160), text = s(n.text).slice(0, 600), chip = s(n.chip).slice(0, 12);
                const mute = createElement('div', { className: 'focusable nf-bb-mute', role: 'button', title: 'Sound', onClick: () => this._bbToggleSound() });
                mute.innerHTML = PEK_NF_ICONS.sound;
                return createElement('div', { className: 'nf-bb' + (tid ? ' nf-has-trailer' : '') },
                    media,
                    createElement('div', { className: 'nf-bb-shade' }),
                    createElement('div', { className: 'nf-bb-body' },
                        badge ? createElement('span', { className: 'nf-bb-badge' }, badge) : null,
                        createElement('h2', { className: 'nf-bb-title' }, s(n.title).slice(0, 120)),
                        meta ? createElement('p', { className: 'nf-bb-meta' }, meta) : null,
                        text ? createElement('p', { className: 'nf-bb-text' }, text) : null,
                        actions.length ? createElement('div', { className: 'nf-bb-actions' }, ...actions) : null),
                    tid ? mute : null,
                    chip ? createElement('div', { className: 'nf-bb-chip' }, chip) : null);
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
