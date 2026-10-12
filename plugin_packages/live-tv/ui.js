// PEK Live TV Guide
//
// Shows the channels that shipped inside this plugin (playlists/*.json, added by add_m3u.py) as a TV
// directory: what is on now, what is up next, and how long until the next show. Tapping a channel opens
// PEK TV's own player through pek.live.play. Guide data comes from an XMLTV snapshot bundled with the
// plugin and/or live XMLTV addresses the developer listed; with neither, channels are simply listed.
(function () {
    'use strict';

    var PAGE = 24;
    var TITLE = 'Live TV';      // the screen heading (the Cable Shot copy of this file uses its own name)

    // ---------------- helpers (also used by the tests) ----------------

    function lc(s) { return String(s == null ? '' : s).toLowerCase(); }

    // Same rule as add_m3u.py: letters and digits only, trailing quality tags removed.
    // Built with new RegExp so an engine without Unicode property escapes still loads the plugin
    // (it then treats every character above Latin-1 as a letter).
    var NON_ALNUM;
    try { NON_ALNUM = new RegExp('[^\\p{L}\\p{N}]+', 'gu'); } catch (e) { NON_ALNUM = /[^a-z0-9\u00c0-\uffff]+/g; }
    function normName(s) {
        var n = lc(s).replace(NON_ALNUM, '');
        var t = n.replace(/(fhd|uhd|hevc|4k|hd|sd)+$/, '');
        return t || n;
    }

    function epgKey(ch) { return ch.i ? 'i:' + lc(ch.i) : 'n:' + normName(ch.n); }

    function cyrb53(str) {
        var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 2654435761);
            h2 = Math.imul(h2 ^ c, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    function decodeEntities(s) {
        return String(s || '')
            // CDATA is literal text: escape it so it survives the tag stripping below
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (m, t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); })
            .replace(/<[^>]+>/g, '')
            .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
            .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(parseInt(d, 10)); })
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').trim();
    }

    // "20261012180000 +0200" -> epoch seconds (no zone means UTC)
    function xmltvTime(s) {
        var m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?\s*$/.exec(String(s || ''));
        if (!m) return 0;
        var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
        if (m[7]) {
            var off = (+m[7].slice(1, 3)) * 3600 + (+m[7].slice(3, 5)) * 60;
            t -= (m[7][0] === '-' ? -off : off);
        }
        return t;
    }

    function attrs(str) {
        var out = {}, re = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, m;
        while ((m = re.exec(str))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3];
        return out;
    }

    // XMLTV text -> { byId: {id: [[start, stop, title, desc], ...]}, names: {id: [display names]} }
    // Keeps only programmes from 3 hours ago to 48 hours ahead (this runs inside a 1 MB download limit anyway).
    function parseXmltv(text, nowSec) {
        var lo = nowSec - 3 * 3600, hi = nowSec + 48 * 3600;
        var byId = {}, names = {}, m;
        var chRe = /<channel\s+([^>]*)>([\s\S]*?)<\/channel>/g;
        while ((m = chRe.exec(text))) {
            var id = attrs(m[1]).id;
            if (!id) continue;
            var dn = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g, d;
            names[id] = names[id] || [];
            while ((d = dn.exec(m[2]))) names[id].push(decodeEntities(d[1]));
        }
        var prRe = /<programme\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/programme>)/g;
        while ((m = prRe.exec(text))) {
            var a = attrs(m[1]);
            var s = xmltvTime(a.start), e = xmltvTime(a.stop);
            if (!a.channel || !s || !e || e <= lo || s >= hi) continue;
            var body = m[2] || '';
            var t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(body);
            var ds = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(body);
            var title = t ? decodeEntities(t[1]) : '';
            if (!title) continue;
            (byId[a.channel] = byId[a.channel] || []).push([s, e, title.slice(0, 120), ds ? decodeEntities(ds[1]).slice(0, 240) : '']);
        }
        Object.keys(byId).forEach(function (k) { byId[k].sort(function (x, y) { return x[0] - y[0]; }); });
        return { byId: byId, names: names };
    }

    // What is on at nowSec: { cur, next, upcoming: [...] }
    function around(arr, nowSec) {
        var i = 0;
        while (i < arr.length && arr[i][1] <= nowSec) i++;
        if (i >= arr.length) return { cur: null, next: null, upcoming: [] };
        var cur = null;
        if (arr[i][0] <= nowSec) { cur = arr[i]; i++; }
        return { cur: cur, next: arr[i] || null, upcoming: arr.slice(i, i + 6) };
    }

    function span(sec) {
        var min = Math.max(0, Math.round(sec / 60));
        if (min < 1) return 'under a minute';
        if (min < 60) return min + ' min';
        var h = Math.floor(min / 60), r = min % 60;
        if (h >= 48) return Math.floor(h / 24) + ' days';
        return h + ' h' + (r ? ' ' + r + ' min' : '');
    }

    function bar(frac) {
        var n = Math.max(0, Math.min(10, Math.round(frac * 10)));
        return new Array(n + 1).join('\u25b0') + new Array(11 - n).join('\u25b1');
    }

    function cut(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; }

    var exported = { normName: normName, epgKey: epgKey, xmltvTime: xmltvTime, parseXmltv: parseXmltv, around: around, span: span, cyrb53: cyrb53 };
    if (typeof module !== 'undefined' && module.exports) { module.exports = exported; return; }
    if (typeof pek === 'undefined') return;

    // ---------------- state ----------------

    var S = {
        loading: true, error: '', idx: null,
        channels: [], groups: [], byKey: {},
        snap: null, live: null, liveAt: 0, liveNote: '', liveBusy: false,
        gmap: {}, matched: 0,
        view: 'list', tab: 'guide', group: null, query: '', draft: '', shows: null,
        page: 1, gpage: 1, sel: null, msg: '',
        fav: {}, last: '',
        set: { quick: false, h12: true, onlyGuide: false, tiles: false }
    };

    function nowSec() { return Math.floor(Date.now() / 1000); }

    function clock(sec) {
        try { return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !!S.set.h12 }); }
        catch (e) { return new Date(sec * 1000).toTimeString().slice(0, 5); }
    }

    function dayClock(sec, now) {
        var d = new Date(sec * 1000), n = new Date(now * 1000);
        var same = d.toDateString() === n.toDateString();
        var day = '';
        if (!same) { try { day = d.toLocaleDateString([], { weekday: 'short' }) + ' '; } catch (e) { day = ''; } }
        return day + clock(sec);
    }

    // ---------------- guide ----------------

    function fresh(arr, now) { return !!arr && arr.length > 0 && arr[arr.length - 1][1] > now; }

    function indexGuide() {
        var now = nowSec(), g = {}, n = 0;
        S.channels.forEach(function (ch) {
            var live = null, snap = null;
            if (S.live) {
                if (ch.i) live = S.live.byId[lc(ch.i)];
                if (!live) live = S.live.byName[ch.nn];
            }
            if (S.snap) snap = S.snap[epgKey(ch)];
            var pick = fresh(live, now) ? live : (fresh(snap, now) ? snap : null);
            if (pick) { g[ch.k] = pick; n++; }
        });
        S.gmap = g; S.matched = n;
    }

    function addLive(parsed, into) {
        Object.keys(parsed.byId).forEach(function (id) {
            var key = lc(id);
            into.byId[key] = (into.byId[key] || []).concat(parsed.byId[id]).sort(function (x, y) { return x[0] - y[0]; });
            (parsed.names[id] || []).forEach(function (nm) {
                var nn = normName(nm);
                if (nn && !into.byName[nn]) into.byName[nn] = into.byId[key];
            });
        });
    }

    // Runs fn(item) for each item, one after the other.
    function seq(list, fn) {
        var p = Promise.resolve();
        list.forEach(function (item) { p = p.then(function () { return fn(item); }); });
        return p;
    }

    function loadLive() {
        var urls = (S.idx && S.idx.epg && S.idx.epg.urls) || [];
        if (!urls.length || S.liveBusy) return Promise.resolve();
        S.liveBusy = true; pek.requestRender();
        var merged = { byId: {}, byName: {} }, ok = 0, bad = [];
        return seq(urls, function (u) {
            return pek.fetchText(u).then(function (txt) {
                addLive(parseXmltv(txt, nowSec()), merged);
                ok++;
            }, function (e) {
                bad.push(u.replace(/^https?:\/\//, '').split('/')[0] + ': ' + ((e && e.message) || e));
            });
        }).then(function () {
            S.live = ok ? merged : null;
            S.liveAt = Date.now();
            S.liveNote = ok + ' of ' + urls.length + ' live guide address' + (urls.length === 1 ? '' : 'es') + ' loaded' + (bad.length ? ' (' + cut(bad.join('; '), 200) + ')' : '');
            S.liveBusy = false;
            indexGuide();
            pek.requestRender();
        });
    }

    // ---------------- loading ----------------

    function readJson(name) { return pek.readBundled(name).then(JSON.parse); }

    function loadAll() {
        S.loading = true; S.error = ''; pek.requestRender();
        return Promise.all([pek.storage.get('fav'), pek.storage.get('settings'), pek.storage.get('last')]).then(function (st) {
            try { (JSON.parse(st[0] || '[]') || []).forEach(function (k) { S.fav[k] = true; }); } catch (e) { /* none */ }
            try { var sv = JSON.parse(st[1] || '{}') || {}; Object.keys(S.set).forEach(function (k) { if (typeof sv[k] === 'boolean') S.set[k] = sv[k]; }); } catch (e) { /* defaults */ }
            S.last = st[2] || '';
            return readJson('index.json').catch(function () { return { playlists: [], epg: { urls: [], parts: [] } }; });
        }).then(function (idx) {
            S.idx = idx;
            var jobs = [], chans = [], seen = {};
            (idx.playlists || []).forEach(function (pl) {
                (pl.parts || []).forEach(function (name) { jobs.push({ pl: pl, name: name }); });
            });
            return seq(jobs, function (j) {
                return readJson(j.name).then(function (part) {
                    (part.c || []).forEach(function (r) {
                        var ch = { n: String(r[0] || ''), u: String(r[1] || ''), g: String(r[2] || ''), i: String(r[3] || ''), l: String(r[4] || ''), pl: j.pl.name };
                        if (!ch.u) return;
                        ch.k = cyrb53(ch.u);
                        if (seen[ch.k]) return;       // the same stream listed twice
                        seen[ch.k] = true;
                        ch.nn = normName(ch.n); ch.nl = lc(ch.n);
                        chans.push(ch);
                    });
                });
            }).then(function () { return chans; });
        }).then(function (chans) {
            S.channels = chans;
            chans.forEach(function (c) { S.byKey[c.k] = c; });
            var gc = {};
            chans.forEach(function (c) { gc[c.g] = (gc[c.g] || 0) + 1; });
            S.groups = Object.keys(gc).sort(function (a, b) {
                if (!a) return 1;
                if (!b) return -1;
                return lc(a) < lc(b) ? -1 : 1;
            }).map(function (g) { return { name: g, count: gc[g] }; });

            var snap = {}, any = false, idx = S.idx;
            S.snapAt = (idx.epg && idx.epg.generated) || 0;
            return seq((idx.epg && idx.epg.parts) || [], function (name) {
                return readJson(name).then(function (ep) {
                    Object.keys(ep.p || {}).forEach(function (k) { snap[k] = ep.p[k]; any = true; });
                }, function () { /* a missing part only means less guide info */ });
            }).then(function () { S.snap = any ? snap : null; indexGuide(); });
        }).catch(function (e) {
            S.error = 'Could not load the channel lists: ' + ((e && e.message) || e);
        }).then(function () {
            S.loading = false;
            pek.requestRender();
            loadLive();
        });
    }

    // ---------------- actions ----------------

    function saveFav() { pek.storage.set('fav', JSON.stringify(Object.keys(S.fav))).catch(function () { S.msg = 'Could not save favorites (storage is full).'; }); }
    function saveSet() { pek.storage.set('settings', JSON.stringify(S.set)).catch(function () { /* ignore */ }); }

    function play(ch) {
        S.msg = '';
        return pek.live.play({ url: ch.u, title: ch.n }).then(function () {
            S.last = ch.k;
            pek.storage.set('last', ch.k).catch(function () { /* ignore */ });
        }).catch(function (e) {
            S.msg = 'Could not start "' + ch.n + '": ' + ((e && e.message) || e);
        });
    }

    function openChannel(ch) {
        if (S.set.quick) return play(ch);
        S.sel = ch; S.view = 'channel'; S.msg = '';
        pek.scrollTop();
    }

    function toggleFav(ch) {
        if (S.fav[ch.k]) delete S.fav[ch.k]; else S.fav[ch.k] = true;
        saveFav();
    }

    // switching tabs starts from a clean slate (a leftover filter would make Favorites look empty)
    function setTab(t) { S.tab = t; S.page = 1; S.gpage = 1; S.group = null; S.query = ''; S.draft = ''; S.shows = null; pek.scrollTop(); }

    function findShows(q) {
        var now = nowSec(), ql = lc(q), out = [];
        S.channels.forEach(function (ch) {
            var arr = S.gmap[ch.k];
            if (!arr) return;
            for (var i = 0; i < arr.length; i++) {
                var p = arr[i];
                if (p[1] <= now || p[0] > now + 36 * 3600) continue;
                if (lc(p[2]).indexOf(ql) >= 0) { out.push({ ch: ch, p: p }); break; }
            }
        });
        out.sort(function (a, b) { return a.p[0] - b.p[0]; });
        return out.slice(0, 12);
    }

    function visible() {
        var list = S.channels;
        if (S.tab === 'fav') list = list.filter(function (c) { return S.fav[c.k]; });
        if (S.group !== null) list = list.filter(function (c) { return c.g === S.group; });
        if (S.set.onlyGuide) list = list.filter(function (c) { return !!S.gmap[c.k]; });
        if (S.query) { var q = lc(S.query); list = list.filter(function (c) { return c.nl.indexOf(q) >= 0; }); }
        return list;
    }

    // ---------------- screens ----------------

    function lineFor(ch, now) {
        var arr = S.gmap[ch.k];
        if (!arr) return (ch.g || ch.pl) + ' \u00b7 no guide info';
        var a = around(arr, now);
        if (!a.cur && !a.next) return (ch.g || ch.pl) + ' \u00b7 no guide info';
        var parts = [];
        if (a.cur) parts.push('Now: ' + cut(a.cur[2], 44) + ' (' + span(a.cur[1] - now) + ' left)');
        if (a.next) parts.push('Next: ' + cut(a.next[2], 36) + ' ' + dayClock(a.next[0], now));
        return parts.join(' \u00b7 ');
    }

    function pager(ui, page, total, set) {
        var pages = Math.max(1, Math.ceil(total / PAGE));
        if (pages <= 1) return null;
        var kids = [], from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
        function go(p) { return function () { set(p); pek.scrollTop(); }; }
        if (page > 1) kids.push(ui.button('\u2039 Prev', go(page - 1)));
        if (from > 1) { kids.push(ui.button('1', go(1), { selected: page === 1 })); if (from > 2) kids.push(ui.text('\u2026')); }
        for (var p = from; p <= to; p++) kids.push(ui.button(String(p), go(p), { selected: p === page }));
        if (to < pages) { if (to < pages - 1) kids.push(ui.text('\u2026')); kids.push(ui.button(String(pages), go(pages), { selected: page === pages })); }
        if (page < pages) kids.push(ui.button('Next \u203a', go(page + 1)));
        return ui.row(kids);
    }

    function channelRow(ui, ch, now) {
        var title = (S.fav[ch.k] ? '\u2605 ' : '') + ch.n;
        return ui.listRow(title, lineFor(ch, now), function () { return openChannel(ch); });
    }

    function channelTile(ui, ch, now) {
        var a = S.gmap[ch.k] ? around(S.gmap[ch.k], now) : null;
        var badge = a && a.cur ? span(a.cur[1] - now) : '';
        return ui.posterCard((S.fav[ch.k] ? '\u2605 ' : '') + ch.n, lineFor(ch, now), ch.l, function () { return openChannel(ch); }, { badge: badge });
    }

    function listScreen(ui) {
        var now = nowSec(), kids = [];
        kids.push(ui.heading(TITLE));
        if (S.msg) kids.push(ui.text(S.msg));

        var top = [ui.button('Settings', function () { S.view = 'settings'; pek.scrollTop(); })];
        var last = S.last && S.byKey[S.last];
        if (last) top.push(ui.button('\u25b6 Last: ' + cut(last.n, 28), function () { return play(last); }));
        kids.push(ui.row(top));

        kids.push(ui.tabs([{ id: 'guide', label: 'Guide' }, { id: 'groups', label: 'Categories' }, { id: 'fav', label: 'Favorites' }], S.tab, setTab));

        if (S.tab === 'groups') {
            kids.push(ui.text(S.groups.length + ' categories'));
            S.groups.slice((S.gpage - 1) * PAGE, S.gpage * PAGE).forEach(function (g) {
                kids.push(ui.listRow(g.name || 'Uncategorized', g.count + ' channel' + (g.count === 1 ? '' : 's'), function () {
                    S.group = g.name; S.tab = 'guide'; S.page = 1; pek.scrollTop();
                }));
            });
            var gp = pager(ui, S.gpage, S.groups.length, function (p) { S.gpage = p; });
            if (gp) kids.push(gp);
            return ui.column(kids);
        }

        kids.push(ui.textInput('Search channels or shows', S.draft, function (t) { S.draft = t; }, {
            placeholder: 'Channel name, or a show to find',
            onSubmit: function (t) {
                S.draft = t; S.query = t.trim(); S.page = 1;
                S.shows = S.query ? findShows(S.query) : null;
            }
        }));
        var chips = [];
        if (S.group !== null) chips.push(ui.button('Category: ' + (S.group || 'Uncategorized') + '  \u2715', function () { S.group = null; S.page = 1; }));
        if (S.query) chips.push(ui.button('Search: ' + cut(S.query, 20) + '  \u2715', function () { S.query = ''; S.draft = ''; S.shows = null; S.page = 1; }));
        if (chips.length) kids.push(ui.row(chips));

        if (S.shows && S.shows.length) {
            kids.push(ui.heading('Shows matching \u201c' + cut(S.query, 24) + '\u201d'));
            S.shows.forEach(function (r) {
                var when = r.p[0] <= now ? 'On now, ' + span(r.p[1] - now) + ' left' : 'Starts ' + dayClock(r.p[0], now) + ' (in ' + span(r.p[0] - now) + ')';
                kids.push(ui.listRow(cut(r.p[2], 60) + ' \u2014 ' + r.ch.n, when, function () { return openChannel(r.ch); }));
            });
        }

        var list = visible();
        if (S.shows && S.shows.length && list.length) kids.push(ui.heading('Channels'));
        if (!list.length) {
            if (!(S.shows && S.shows.length)) kids.push(ui.text(S.tab === 'fav' ? 'No favorites yet. Open a channel and add it.' :
                (S.channels.length ? 'No channels match.' : 'No channels in this plugin yet. The developer adds .m3u files with add_m3u.py before zipping it.')));
            return ui.column(kids);
        }
        var withGuide = list.filter(function (c) { return !!S.gmap[c.k]; }).length;
        kids.push(ui.text(list.length + ' channel' + (list.length === 1 ? '' : 's') + (withGuide ? ' \u00b7 guide info for ' + withGuide : '')));
        var pageItems = list.slice((S.page - 1) * PAGE, S.page * PAGE);
        if (S.set.tiles) kids.push(ui.grid(pageItems.map(function (c) { return channelTile(ui, c, now); }), { minColWidth: '190px' }));
        else pageItems.forEach(function (c) { kids.push(channelRow(ui, c, now)); });
        var pg = pager(ui, S.page, list.length, function (p) { S.page = p; });
        if (pg) kids.push(pg);
        return ui.column(kids);
    }

    function channelScreen(ui) {
        var ch = S.sel, now = nowSec(), kids = [];
        kids.push(ui.heading(ch.n));
        kids.push(ui.text((lc(ch.g) === lc(ch.pl) ? [ch.g] : [ch.g, ch.pl]).filter(Boolean).join(' \u00b7 ')));
        if (S.msg) kids.push(ui.text(S.msg));
        kids.push(ui.button('\u25b6  Watch live', function () { return play(ch); }, { primary: true, autofocus: 'play' }));
        kids.push(ui.button(S.fav[ch.k] ? '\u2605 Remove from favorites' : '\u2606 Add to favorites', function () { toggleFav(ch); }));

        var arr = S.gmap[ch.k], a = arr ? around(arr, now) : null;
        if (!a || (!a.cur && !a.next)) {
            kids.push(ui.text('No guide information for this channel.'));
        } else {
            if (a.cur) {
                var total = a.cur[1] - a.cur[0], done = now - a.cur[0];
                kids.push(ui.heading('On now'));
                kids.push(ui.text(a.cur[2]));
                kids.push(ui.text(clock(a.cur[0]) + ' \u2013 ' + clock(a.cur[1]) + ' \u00b7 ' + span(a.cur[1] - now) + ' left'));
                kids.push(ui.text(bar(total > 0 ? done / total : 0) + '  ' + Math.round(100 * Math.max(0, Math.min(1, total > 0 ? done / total : 0))) + '%'));
                if (a.cur[3]) kids.push(ui.text(a.cur[3]));
                if (a.next) kids.push(ui.text('Next up: ' + a.next[2] + ' in ' + span(a.next[0] - now)));
            }
            if (a.upcoming.length) {
                kids.push(ui.heading('Coming up'));
                a.upcoming.forEach(function (p) {
                    kids.push(ui.text(dayClock(p[0], now) + '  \u00b7  in ' + span(p[0] - now) + '  \u00b7  ' + p[2] + ' (' + span(p[1] - p[0]) + ')'));
                });
            }
        }
        kids.push(ui.button('Back', function () { S.view = 'list'; S.sel = null; pek.scrollTop(); }));
        return ui.column(kids);
    }

    function settingsScreen(ui) {
        var kids = [ui.heading(TITLE + ' settings')];
        kids.push(ui.toggle('Tap a channel to watch it right away', S.set.quick, function (v) { S.set.quick = v === 'true'; saveSet(); }));
        kids.push(ui.toggle('Show channels as tiles', S.set.tiles, function (v) { S.set.tiles = v === 'true'; S.page = 1; saveSet(); }));
        kids.push(ui.toggle('12-hour clock', S.set.h12, function (v) { S.set.h12 = v === 'true'; saveSet(); }));
        kids.push(ui.toggle('Only channels with guide info', S.set.onlyGuide, function (v) { S.set.onlyGuide = v === 'true'; S.page = 1; saveSet(); }));

        var liveUrls = (S.idx && S.idx.epg && S.idx.epg.urls) || [];
        kids.push(ui.heading('Guide'));
        kids.push(ui.text(S.channels.length + ' channels in ' + ((S.idx && S.idx.playlists) || []).length + ' list(s); guide info for ' + S.matched + '.'));
        if (S.snap) kids.push(ui.text('Bundled guide snapshot from ' + (S.snapAt ? new Date(S.snapAt * 1000).toLocaleString() : 'an unknown date') + '.'));
        if (liveUrls.length) kids.push(ui.text(S.liveBusy ? 'Loading live guide\u2026' : (S.liveNote || 'Live guide not loaded yet.')));
        if (liveUrls.length) kids.push(ui.button('Reload live guide', function () { loadLive(); }));
        if (!S.snap && !liveUrls.length) kids.push(ui.text('This plugin has no guide data, so channels are listed without schedules.'));
        kids.push(ui.button('Back', function () { S.view = 'list'; pek.scrollTop(); }));
        return ui.column(kids);
    }

    pek.render(function (ui) {
        pek.setBack(S.view !== 'list' ? function () { S.view = 'list'; S.sel = null; pek.scrollTop(); } : null);
        if (S.loading) return ui.column(ui.heading(TITLE), ui.spinner('Loading channels\u2026', true));
        if (S.error) return ui.column(ui.heading(TITLE), ui.text(S.error), ui.button('Try again', function () { loadAll(); }));
        if (S.view === 'channel' && S.sel) return channelScreen(ui);
        if (S.view === 'settings') return settingsScreen(ui);
        return listScreen(ui);
    });

    // keep "minutes left" honest, and refresh the live guide now and then
    setInterval(function () {
        if (S.loading) return;
        if (S.view !== 'settings') pek.requestRender();
        if (S.idx && S.idx.epg && S.idx.epg.urls && S.idx.epg.urls.length && Date.now() - S.liveAt > 30 * 60 * 1000) loadLive();
        else indexGuide();
    }, 60000);

    loadAll();
})();
