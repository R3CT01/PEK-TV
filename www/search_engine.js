// ============================================================
//  Search engine for the sites listed in search_sites.js.  You never need to edit this file.
//
//  What it does when a plugin (or the Torrents test button) searches for a movie or episode:
//    1. builds the search words ("dune 2021" or "show name S01E02"),
//    2. asks Hesper's server to fetch each site you listed (the server does the web request),
//    3. reads the answer: JSON lists, or web pages that show magnet links,
//    4. throws away wrong titles / wrong episodes, scores the rest (episode, year, quality, seeders),
//    5. returns the list best-first. The first one is what a plugin plays.
//  If you also set up a Torznab provider in Settings > Torrents, its results are merged in.
// ============================================================
(function () {
    'use strict';
    const API = '/api/torrent';
    const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.tracker.cl:1337/announce',
        'udp://tracker.torrent.eu.org:451/announce'];

    // ------------------------------------------------------------ text helpers
    function normalize(t) {
        let s = String(t || '').toLowerCase();
        try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old engine */ }
        return s.replace(/&/g, ' and ').replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    }
    const pad2 = n => (n < 10 ? '0' : '') + n;
    function num(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return isFinite(n) ? n : 0; }

    function qualityOf(name) {
        const n = normalize(name);
        if (/\b(2160p|4k|uhd)\b/.test(n)) return 2160;
        if (n.indexOf('1080p') >= 0) return 1080;
        if (n.indexOf('720p') >= 0) return 720;
        if (/\b(480p|dvdrip)\b/.test(n)) return 480;
        return 0;
    }

    function sizeText(b) {
        if (!b || b < 2) return 'size unknown';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = b;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return (i >= 3 ? v.toFixed(2) : Math.round(v)) + ' ' + u[i];
    }

    function parseSize(text) {
        const m = /(\d+(?:[.,]\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/i.exec(text || '');
        if (!m) return 0;
        const mult = { k: 1024, m: 1048576, g: 1073741824, t: 1099511627776 }[m[2][0].toLowerCase()];
        return Math.round(parseFloat(m[1].replace(',', '.')) * mult);
    }

    function magnetFrom(hash, name) {
        return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name) +
            TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('');
    }

    // ------------------------------------------------------------ reading a site's answer
    function pick(o, keys) {
        for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
        return '';
    }

    function findItems(node, depth) {
        if (depth > 3 || node == null || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
            if (node.length && node.every(x => x && typeof x === 'object' && !Array.isArray(x)) &&
                node.some(x => pick(x, ['name', 'title', 'torrent_name', 'release']))) return node;
            return null;
        }
        for (const k of Object.keys(node)) {
            const f = findItems(node[k], depth + 1);
            if (f) return f;
        }
        return null;
    }

    function fromJson(data) {
        const items = findItems(data, 0) || [];
        const out = [];
        for (const o of items) {
            const title = String(pick(o, ['name', 'title', 'torrent_name', 'release']));
            let magnet = String(pick(o, ['magnet', 'magnet_link', 'magnetLink', 'magnet_uri', 'magnetUri']));
            const hash = String(pick(o, ['info_hash', 'infohash', 'infoHash', 'hash', 'btih']));
            if (!/^magnet:\?/i.test(magnet)) magnet = /^[0-9a-f]{40}$/i.test(hash) ? magnetFrom(hash, title) : '';
            if (!title || !magnet) continue;
            out.push({
                title: title, source: magnet,
                seeders: num(pick(o, ['seeders', 'seeds', 'seed', 'se'])),
                size: num(pick(o, ['size', 'size_bytes', 'bytes', 'total_size']))
            });
        }
        return out;
    }

    function fromHtml(text) {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const out = [], seen = {};
        doc.querySelectorAll('a[href^="magnet:"]').forEach(a => {
            const href = a.getAttribute('href') || '';
            const hm = /btih:([0-9a-z]{32,40})/i.exec(href);
            if (!hm) return;
            const key = hm[1].toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            const row = a.closest('tr') || a.closest('li') || a.closest('article') ||
                (a.parentElement && a.parentElement.parentElement) || a.parentElement || a;
            // title: the magnet's own name, else the longest other link text in the row
            let title = '';
            const dn = /[?&]dn=([^&]+)/i.exec(href);
            if (dn) { try { title = decodeURIComponent(dn[1].replace(/\+/g, ' ')); } catch (e) { title = dn[1]; } }
            if (title.length < 6) {
                row.querySelectorAll('a').forEach(l => {
                    const t = (l.textContent || '').trim();
                    if (!/^magnet:/i.test(l.getAttribute('href') || '') && t.length > title.length) title = t;
                });
            }
            // seeders: an element whose class says "seed", else the first plain number cell
            let seeders = -1;
            const se = row.querySelector('[class*="seed" i]:not([class*="leech" i])');
            if (se && /\d/.test(se.textContent)) seeders = num(se.textContent);
            if (seeders < 0) {
                const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim()).filter(t => /^\d[\d,]*$/.test(t));
                if (cells.length >= 2) seeders = num(cells[0]);
            }
            out.push({ title: title, source: href, seeders: seeders, size: parseSize(row.textContent) });
        });
        return out;
    }

    function parseBody(text) {
        const t = String(text || '').trim();
        if (t[0] === '{' || t[0] === '[') {
            try { return fromJson(JSON.parse(t)); } catch (e) { /* fall through to HTML */ }
        }
        return fromHtml(t);
    }

    // ------------------------------------------------------------ filtering + scoring
    function episodeMatch(name, s, e) {
        const n = name.toLowerCase();
        if (new RegExp('s0*' + s + '[ ._-]?e0*' + e + '(?!\\d)').test(n) || new RegExp('(?:^|\\D)' + s + 'x0*' + e + '(?!\\d)').test(n)) return 'episode';
        if (new RegExp('s0*' + s + '(?!\\d|e)').test(n) || new RegExp('season[ ._-]*0*' + s + '(?!\\d)').test(n)) return 'pack';
        return null;
    }

    // Returns { score, pack } or null when this result should be dropped.
    function rate(item, q) {
        const norm = normalize(item.title), padded = ' ' + norm + ' ';
        if (item.seeders === 0) return null;                        // known to have nobody sharing it
        const toks = normalize(q.title).split(' ').filter(Boolean);
        for (const t of toks) if (padded.indexOf(' ' + t + ' ') < 0) return null;

        let total = 0, pack = false;
        if (q.kind === 'episode' && q.season > 0 && q.episode > 0) {
            const k = episodeMatch(item.title, q.season, q.episode);
            if (!k) return null;
            pack = k === 'pack';
            total += pack ? 15 : 60;
        } else if (q.year > 0) {
            if (new RegExp('(?:^|\\D)' + q.year + '(?!\\d)').test(item.title)) total += 25;
            else if (/(?:^|\D)(19|20)\d\d(?!\d)/.test(item.title)) return null;   // a different year = a different film
        }
        const ql = qualityOf(item.title);
        total += ql === 1080 ? 15 : ql === 2160 ? 12 : ql === 720 ? 8 : ql === 480 ? 2 : 0;
        if (/\b(cam|camrip|hdcam|ts|hdts|telesync|tc)\b/.test(norm)) return null;
        if (item.seeders > 0) total += Math.min(Math.log10(item.seeders + 1) * 20, 60);
        return { score: total, pack: pack, quality: ql };
    }

    function searchWords(q) {
        let w = normalize(q.title);
        if (q.kind === 'episode' && q.season > 0 && q.episode > 0) w += ' S' + pad2(q.season) + 'E' + pad2(q.episode);
        else if (q.year > 0) w += ' ' + q.year;
        return w;
    }

    // ------------------------------------------------------------ talking to Hesper's server
    const sites = (Array.isArray(window.HESPER_SEARCH_SITES) ? window.HESPER_SEARCH_SITES : [])
        .map(s => String(s || '').trim()).filter(Boolean);
    let registered = null;
    function register() {
        if (!registered) {
            registered = fetch(API + '/sites', { method: 'POST', body: new URLSearchParams({ sites: sites.join('\n') }) })
                .then(r => r.json()).catch(() => { registered = null; return null; });
        }
        return registered;
    }

    async function searchSite(i, words) {
        const res = await fetch(API + '/site?i=' + i + '&q=' + encodeURIComponent(words));
        if (!res.ok) {
            let m = 'Request failed (' + res.status + ')';
            try { m = (await res.json()).error || m; } catch (e) { /* keep */ }
            throw new Error(m);
        }
        return parseBody(await res.text());
    }

    async function searchSites(q) {
        await register();
        const words = searchWords(q);
        const settled = await Promise.all(sites.map((_, i) => searchSite(i, words).then(r => ({ ok: r }), e => ({ err: e }))));
        const items = [], errors = [];
        settled.forEach(s => s.ok ? items.push.apply(items, s.ok) : errors.push(s.err));
        return { items: items, errors: errors };
    }

    function rank(items, q) {
        const seen = {}, out = [];
        items.forEach(it => {
            const r = rate(it, q);
            if (!r) return;
            const key = (/btih:([0-9a-z]+)/i.exec(it.source) || [it.source, it.source])[1].toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            out.push({
                title: it.title, source: it.source, size: it.size || 0, sizeText: sizeText(it.size),
                seeders: Math.max(0, it.seeders | 0), quality: r.quality, pack: r.pack, _score: r.score
            });
        });
        out.sort((a, b) => b._score - a._score);
        return out.slice(0, 25).map(o => { delete o._score; return o; });
    }

    // ------------------------------------------------------------ hook into HesperTorrent.search
    function install() {
        const T = window.HesperTorrent;
        if (!T || typeof T.search !== 'function' || T._sitesInstalled) return;
        T._sitesInstalled = true;
        if (!sites.length) return;                                  // nothing pasted: behave exactly as before
        const original = T.search.bind(T);
        T.search = async function (q) {
            const [mine, torznab] = await Promise.all([
                searchSites(q),
                original(q).catch(() => [])                         // Torznab is optional now
            ]);
            const ranked = rank(mine.items.concat(torznab), q);
            if (!ranked.length && mine.errors.length && !torznab.length) throw new Error(mine.errors[0].message);
            return ranked;
        };
    }

    window.HesperSearchEngine = { parseBody: parseBody, rank: rank, searchWords: searchWords, rate: rate };  // exposed for testing
    install();
})();
