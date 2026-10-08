// Snake Skin: trending / top rated / popular / now playing rows for movies and TV,
// streaming-service chips, search, a detail page with an auto-playing trailer, cast and
// related titles, numbered pages for every list, and a badge on titles you already own.
//
// Snake Skin also adds a Play button to every title: pick a movie, or a season and episode, and
// the built-in release search (see "release search" below) builds the query, fetches and parses
// the results, scores them (title / season / episode / year / quality / seeders) and hands the best
// one to PEK to buffer and play. No Torznab address or key is needed.
//
// Third-party PEK plugin. It runs in the plugin sandbox and talks straight to TMDb with the
// user's own free v3 API key (Settings tab), stored only in this plugin's private storage.
// Data: TMDb. Streaming availability: JustWatch (via TMDb). Trailers: YouTube.
(function () {
    'use strict';

    // ================================================================ release search (built in)
    // PASTE YOUR SEARCH LINKS BETWEEN THE TWO MARKER LINES (or run add_site.py, which does it for you).
    // Each link: inside quotes, ending with a comma, with {q} where the search words go.
    // Every site's host must also be listed under "network" in plugin.json.
    var SEARCH_SITES = [
        // SITES-START
        'https://yify.mobi/search/?q={q}',
        'https://1337x.to/search/{q}/1/',
        'https://thepiratebay.party/search/{q}/1/99/0',
        // SITES-END
    ];

    // Everything below this line is the search engine. You never need to edit it.
    var ReleaseSearch = (function () {
        var TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.tracker.cl:1337/announce',
            'udp://tracker.torrent.eu.org:451/announce'];

        function normalize(t) {
            var s = String(t || '').toLowerCase();
            try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old engine */ }
            return s.replace(/&/g, ' and ').replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
        }
        function pad2(n) { n = parseInt(n, 10); return (n < 10 ? '0' : '') + n; }
        function num(v) { var n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return isFinite(n) ? n : 0; }
        function pick(o, keys) { for (var i = 0; i < keys.length; i++) if (o[keys[i]] != null && o[keys[i]] !== '') return o[keys[i]]; return ''; }

        function qualityOf(name) {
            var n = normalize(name);
            if (/\b(2160p|4k|uhd)\b/.test(n)) return 2160;
            if (n.indexOf('1080p') >= 0) return 1080;
            if (n.indexOf('720p') >= 0) return 720;
            if (/\b(480p|dvdrip)\b/.test(n)) return 480;
            return 0;
        }
        function sizeText(b) {
            if (!b || b < 2) return 'size unknown';
            var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = b;
            while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
            return (i >= 3 ? v.toFixed(2) : Math.round(v)) + ' ' + u[i];
        }
        function parseSize(text) {
            var m = /(\d+(?:[.,]\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/i.exec(text || '');
            if (!m) return 0;
            var mult = { k: 1024, m: 1048576, g: 1073741824, t: 1099511627776 }[m[2][0].toLowerCase()];
            return Math.round(parseFloat(m[1].replace(',', '.')) * mult);
        }
        // Text of a result row with its cells separated, so "120" + "2.1 GB" is not read as 1202.1 GB.
        function rowText(row) {
            var cells = row.querySelectorAll('td');
            return cells.length ? Array.prototype.map.call(cells, function (c) { return c.textContent; }).join(' | ') : (row.textContent || '');
        }
        function magnetFrom(hash, name) {
            return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name) +
                TRACKERS.map(function (t) { return '&tr=' + encodeURIComponent(t); }).join('');
        }

        // ---- reading a site's answer: JSON lists or web pages that show magnet links
        function findItems(node, depth) {
            if (depth > 3 || node == null || typeof node !== 'object') return null;
            if (Array.isArray(node)) {
                var ok = node.length && node.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); }) &&
                    node.some(function (x) { return pick(x, ['name', 'title', 'torrent_name', 'release']); });
                return ok ? node : null;
            }
            var keys = Object.keys(node);
            for (var i = 0; i < keys.length; i++) { var f = findItems(node[keys[i]], depth + 1); if (f) return f; }
            return null;
        }
        function fromJson(data) {
            var out = [];
            (findItems(data, 0) || []).forEach(function (o) {
                var title = String(pick(o, ['name', 'title', 'torrent_name', 'release']));
                var magnet = String(pick(o, ['magnet', 'magnet_link', 'magnetLink', 'magnet_uri', 'magnetUri']));
                var hash = String(pick(o, ['info_hash', 'infohash', 'infoHash', 'hash', 'btih']));
                var seeders = num(pick(o, ['seeders', 'seeds', 'seed', 'se']));
                var ident = String(o.identifier || '');
                if (!/^magnet:\?/i.test(magnet)) {
                    if (/^[0-9a-f]{40}$/i.test(hash)) magnet = magnetFrom(hash, title);
                    else if (/^[A-Za-z0-9._-]+$/.test(ident)) {          // archive.org item: its .torrent file
                        magnet = 'https://archive.org/download/' + ident + '/' + ident + '_archive.torrent';
                        seeders = num(o.downloads);                       // popularity stands in for seeders
                    } else magnet = '';
                }
                if (title && magnet) out.push({ title: title, source: magnet, seeders: seeders,
                    size: num(pick(o, ['size', 'size_bytes', 'bytes', 'item_size', 'total_size'])) });
            });
            return out;
        }
        function fromHtml(text) {
            var doc = new DOMParser().parseFromString(text, 'text/html');
            var out = [], seen = {};
            Array.prototype.forEach.call(doc.querySelectorAll('a[href^="magnet:"]'), function (a) {
                var href = a.getAttribute('href') || '';
                var hm = /btih:([0-9a-z]{32,40})/i.exec(href);
                if (!hm || seen[hm[1].toLowerCase()]) return;
                seen[hm[1].toLowerCase()] = true;
                var row = a.closest('tr') || a.closest('li') || a.closest('article') ||
                    (a.parentElement && a.parentElement.parentElement) || a.parentElement || a;
                var title = '';
                var dn = /[?&]dn=([^&]+)/i.exec(href);
                if (dn) { try { title = decodeURIComponent(dn[1].replace(/\+/g, ' ')); } catch (e) { title = dn[1]; } }
                if (title.length < 6) {
                    Array.prototype.forEach.call(row.querySelectorAll('a'), function (l) {
                        var t = (l.textContent || '').trim();
                        if (!/^magnet:/i.test(l.getAttribute('href') || '') && t.length > title.length) title = t;
                    });
                }
                var seeders = -1;
                var se = row.querySelector('[class*="seed" i]:not([class*="leech" i])');
                if (se && /\d/.test(se.textContent)) seeders = num(se.textContent);
                if (seeders < 0) {
                    var cells = Array.prototype.map.call(row.querySelectorAll('td'), function (td) { return td.textContent.trim(); })
                        .filter(function (t) { return /^\d[\d,]*$/.test(t); });
                    if (cells.length >= 2) seeders = num(cells[0]);
                }
                out.push({ title: title, source: href, seeders: seeders, size: parseSize(rowText(row)) });
            });
            return out;
        }

        // Result pages of many sites (1337x, YTS clones...) list releases but keep the magnet link on each
        // release's own page. This returns the same-site links whose text matches the title, best first.
        function listingLinks(text, baseUrl, q) {
            var doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
            var base;
            try { base = new URL(baseUrl); } catch (e) { return []; }
            var toks = normalize(q.title).split(' ').filter(Boolean);
            var out = [], seen = {};
            Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
                var raw = a.getAttribute('href') || '';
                if (/^(magnet:|javascript:|#|mailto:)/i.test(raw)) return;
                var u;
                try { u = new URL(raw, base); } catch (e) { return; }
                if (u.protocol !== 'https:' || u.hostname !== base.hostname || u.href === base.href || seen[u.href]) return;
                var label = (a.textContent || '').trim();
                var padded = ' ' + normalize(label) + ' ';
                if (!toks.length || toks.some(function (t) { return padded.indexOf(' ' + t + ' ') < 0; })) return;
                seen[u.href] = true;
                var row = a.closest('tr') || a.closest('li') || a.closest('article') || a.parentElement || a;
                var seeders = -1;
                var se = row.querySelector('[class*="seed" i]:not([class*="leech" i])');
                if (se && /\d/.test(se.textContent)) seeders = num(se.textContent);
                var yearHit = q.year > 0 && label.indexOf(String(q.year)) >= 0 ? 1 : 0;
                out.push({ url: u.href, title: label, seeders: seeders, size: parseSize(rowText(row)), _y: yearHit });
            });
            out.sort(function (a, b) { return b._y - a._y; });
            return out.slice(0, 4);
        }

        function parseBody(text) {
            var t = String(text || '').trim();
            if (t.charAt(0) === '{' || t.charAt(0) === '[') {
                try { return fromJson(JSON.parse(t)); } catch (e) { /* fall through to HTML */ }
            }
            return fromHtml(t);
        }

        // ---- dropping wrong results and scoring the rest
        function episodeMatch(name, s, e) {
            var n = name.toLowerCase();
            if (new RegExp('s0*' + s + '[ ._-]?e0*' + e + '(?!\\d)').test(n) || new RegExp('(?:^|\\D)' + s + 'x0*' + e + '(?!\\d)').test(n)) return 'episode';
            if (new RegExp('s0*' + s + '(?!\\d|e)').test(n) || new RegExp('season[ ._-]*0*' + s + '(?!\\d)').test(n)) return 'pack';
            return null;
        }
        function rate(item, q) {
            var norm = normalize(item.title), padded = ' ' + norm + ' ';
            if (item.seeders === 0) return null;
            var toks = normalize(q.title).split(' ').filter(Boolean);
            for (var i = 0; i < toks.length; i++) if (padded.indexOf(' ' + toks[i] + ' ') < 0) return null;
            var total = 0, pack = false;
            if (q.season > 0 && q.episode > 0) {
                var k = episodeMatch(item.title, q.season, q.episode);
                if (!k) return null;
                pack = k === 'pack';
                total += pack ? 15 : 60;
            } else if (q.year > 0) {
                if (new RegExp('(?:^|\\D)' + q.year + '(?!\\d)').test(item.title)) total += 25;
                else if (/(?:^|\D)(19|20)\d\d(?!\d)/.test(item.title)) return null;
            }
            // Not a full movie/episode: trailers, commercials, clips and tiny files (Internet Archive is full of them).
            if (/\b(trailer|teaser|commercial|promo|featurette|behind the scenes|review|reaction|clip|clips|sample|soundtrack|ost)\b/.test(norm)) return null;
            if (item.size > 1 && item.size < (q.season > 0 && q.episode > 0 ? 40 : 350) * 1048576) return null;
            var ql = qualityOf(item.title);
            total += ql === 1080 ? 15 : ql === 2160 ? 12 : ql === 720 ? 8 : ql === 480 ? 2 : 0;
            if (/\b(cam|camrip|hdcam|ts|hdts|telesync|tc)\b/.test(norm)) return null;
            if (item.seeders > 0) total += Math.min(Math.log10(item.seeders + 1) * 20, 60);
            return { score: total, pack: pack, quality: ql };
        }

        function words(q, withYear) {
            var w = normalize(q.title);
            if (q.season > 0 && q.episode > 0) w += ' S' + pad2(q.season) + 'E' + pad2(q.episode);
            else if (withYear && q.year > 0) w += ' ' + q.year;
            return w;
        }

        function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return u; } }
        function errText(e) { return String((e && e.message) || e || 'failed').replace(/\s+/g, ' ').slice(0, 120); }

        // One site: fetch its result page; when the page has no magnet links, open the best-matching
        // release pages (same site) and read the magnets there. Never rejects: failures go in .error.
        function querySite(tmpl, w, q) {
            var url = tmpl.replace('{q}', encodeURIComponent(w)), host = hostOf(url);
            return hesper.fetchText(url).then(function (body) {
                var items = parseBody(body);
                if (items.length) return { host: host, items: items, note: items.length + ' parsed' };
                var links = [];
                try { links = listingLinks(body, url, q); } catch (e) { /* page was not HTML */ }
                if (!links.length) return { host: host, items: [], note: 'page loaded but no releases found on it' };
                return Promise.all(links.map(function (l) {
                    return hesper.fetchText(l.url).then(function (b2) {
                        var its = parseBody(b2);
                        its.forEach(function (it) {
                            if (it.seeders < 0) it.seeders = l.seeders;
                            if (!it.size) it.size = l.size;
                            if (it.title.length < 6) it.title = l.title;
                        });
                        return its;
                    }, function () { return []; });
                })).then(function (lists) {
                    var all = [].concat.apply([], lists);
                    return { host: host, items: all, note: all.length ? all.length + ' parsed (release pages)' : 'release pages had no magnet links' };
                });
            }, function (e) { return { host: host, items: [], error: errText(e) }; });
        }

        function querySites(w, q) {
            return Promise.all(SEARCH_SITES.map(function (tmpl) { return querySite(tmpl, w, q); })).then(function (sites) {
                return { items: [].concat.apply([], sites.map(function (s) { return s.items; })), sites: sites };
            });
        }

        function report(sites) {
            return sites.map(function (s) { return s.host + ': ' + (s.error || s.note); }).join(' | ');
        }
        var lastReport = '';

        // q = { title, season, episode, year }  ->  Promise<[{title, source, sizeText, seeders, quality, pack}]>, best first
        function searchReleases(q) {
            lastReport = '';
            if (!SEARCH_SITES.length) return Promise.reject(new Error('No search sites yet. Add one with add_site.py, then reinstall the plugin.'));
            return querySites(words(q, true), q).then(function (r) {
                if (r.items.length || !(q.year > 0) || q.season > 0) return r;
                return querySites(words(q, false), q);        // some sites do better without the year
            }).then(function (r) {
                lastReport = report(r.sites);
                var failed = r.sites.filter(function (s) { return s.error; }).length;
                if (!r.items.length && failed === r.sites.length) {
                    throw new Error('Search sites failed. ' + lastReport);
                }
                var seen = {}, out = [];
                r.items.forEach(function (it) {
                    var rt = rate(it, q);
                    var key = it.source.toLowerCase();
                    if (!rt || seen[key]) return;
                    seen[key] = true;
                    out.push({ title: it.title, source: it.source, size: it.size || 0, sizeText: sizeText(it.size),
                        seeders: Math.max(0, it.seeders | 0), quality: rt.quality, pack: rt.pack, _score: rt.score });
                });
                if (r.items.length && !out.length) lastReport += ' | ' + r.items.length + ' found but all filtered out (title/year/seeders/size)';
                out.sort(function (a, b) { return b._score - a._score; });
                return out.slice(0, 25).map(function (o) { delete o._score; return o; });
            });
        }
        return { searchReleases: searchReleases, parseBody: parseBody, rate: rate, report: function () { return lastReport; } };
    })();


    var API = 'https://api.themoviedb.org/3';
    var IMG = 'https://image.tmdb.org/t/p/w342';
    var IMG_PERSON = 'https://image.tmdb.org/t/p/w185';
    var PER_ROW = 18;
    var MAX_PAGES = 500;            // TMDb does not serve pages past 500

    // ---------------------------------------------------------------- state
    var loc = detectLocale();
    var S = {
        ready: false,
        key: '',
        keyDraft: '',
        keyMsg: '',
        lang: loc.lang,
        region: loc.region,
        regionDraft: '',
        autoplay: true,          // play the trailer when a detail page opens
        sound: true,             // trailer sound (turn off if the device blocks sound autoplay)
        pick: false,             // true = show the release list and let me choose; false = play the best match
        tab: 'movie',            // 'movie' | 'tv' | 'settings'
        provider: 0,             // TMDb provider id, 0 = all services
        providers: { movie: null, tv: null },
        provFail: { movie: false, tv: false },
        pages: {},               // pageKey -> { loading } | { items, total } | { error }
        list: null,              // null | { src, title, page, total, search }  (numbered pages)
        detail: null,            // null | { item, loading, info, error }
        hist: [],                // earlier screens, so Back returns to them
        query: '',
        lib: { movies: {}, shows: {}, nMovies: 0, nShows: 0, loaded: false },
        authError: false
    };

    // ---------------------------------------------------------------- helpers
    function detectLocale() {
        var lang = 'en-US', region = 'US';
        try {
            var l = navigator.language || (navigator.languages && navigator.languages[0]);
            if (l) lang = String(l).replace('_', '-');
        } catch (e) { /* keep default */ }
        var m = /^[A-Za-z]{2,3}-([A-Za-z]{2})(?:$|-)/.exec(lang);
        if (m) region = m[1].toUpperCase();
        else {
            try { region = new Intl.Locale(lang).maximize().region || 'US'; } catch (e) { /* keep US */ }
        }
        return { lang: lang, region: region };
    }

    // Same idea on both sides of the match: lower case, no accents, no punctuation,
    // no "(1999)" suffix, "&" = "and", leading "the/a/an" dropped.
    function norm(s) {
        var raw = String(s || '');
        var t = raw.toLowerCase();
        try { t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old engine */ }
        t = t.replace(/&/g, ' and ')
            .replace(/\(\s*(?:19|20)\d\d\s*\)\s*$/, ' ')
            .replace(/['\u2019`]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ').trim()
            .replace(/^(?:the|a|an) /, '');
        return t || raw.trim().toLowerCase();
    }

    function yearOf(date) {
        var y = parseInt(String(date || '').slice(0, 4), 10);
        return y > 1800 ? y : 0;
    }

    function mapItem(r, type) {
        var t = r.media_type === 'tv' || r.media_type === 'movie' ? r.media_type : type;
        var date = t === 'tv' ? r.first_air_date : r.release_date;
        return {
            id: r.id,
            type: t,
            title: String((t === 'tv' ? r.name : r.title) || r.title || r.name || 'Untitled'),
            alt: String((t === 'tv' ? r.original_name : r.original_title) || ''),
            year: yearOf(date),
            poster: r.poster_path ? IMG + r.poster_path : '',
            overview: String(r.overview || ''),
            rating: typeof r.vote_average === 'number' ? r.vote_average : 0,
            votes: r.vote_count || 0
        };
    }

    function owned(item) {
        var names = [norm(item.title)];
        if (item.alt) names.push(norm(item.alt));
        var i, years;
        if (item.type === 'tv') {
            for (i = 0; i < names.length; i++) if (S.lib.shows[names[i]]) return true;
            return false;
        }
        for (i = 0; i < names.length; i++) {
            years = S.lib.movies[names[i]];
            if (!years) continue;
            if (!item.year) return true;
            for (var j = 0; j < years.length; j++) {
                if (!years[j] || Math.abs(years[j] - item.year) <= 1) return true;
            }
        }
        return false;
    }

    function errText(e) {
        var m = String((e && e.message) || e || '');
        if (/HTTP (401|403)/.test(m)) return S.key
            ? 'TMDb rejected your API key. Check it in Settings.'
            : 'Add your TMDb API key in Settings first.';
        if (/HTTP 404/.test(m)) return 'TMDb could not find that (404).';
        if (/HTTP 429/.test(m)) return 'TMDb is busy right now (429). Try again in a moment.';
        if (/HTTP 5\d\d/.test(m)) return 'TMDb had a problem (' + m.replace('HTTP ', '') + '). Try again later.';
        if (/abort/i.test(m)) return 'TMDb took too long to answer.';
        if (/too large/i.test(m)) return 'TMDb sent more data than PEK allows.';
        return "Couldn't reach TMDb. Check your connection.";
    }

    function isAuth(e) { return /HTTP (401|403)/.test(String((e && e.message) || e || '')); }

    function api(path, params) {
        if (!S.key) return Promise.reject(new Error('HTTP 401 (no API key)'));
        var q = ['api_key=' + encodeURIComponent(S.key), 'language=' + encodeURIComponent(S.lang)];
        Object.keys(params || {}).forEach(function (k) {
            q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        });
        return hesper.fetchJSON(API + path + '?' + q.join('&'));
    }

    function redraw() { hesper.requestRender(); }
    function top() { if (hesper.scrollTop) hesper.scrollTop(); }
    function noop() { /* ignore */ }

    // Older PEK builds do not know spinner / toggle; fall back to plain text / a button.
    function spin(ui, text, big) { return ui.spinner ? ui.spinner(text, big) : ui.text(text); }

    function merge(a, b) {
        var o = {};
        Object.keys(a).forEach(function (k) { o[k] = a[k]; });
        Object.keys(b).forEach(function (k) { o[k] = b[k]; });
        return o;
    }

    // ---------------------------------------------------------------- numbered pages
    // A "source" describes one TMDb list: { path, params, type, multi?, credits?, paged? }.
    // Every page of every source is cached under its own key, so rows, the "See all" grid
    // and Next / Prev never fetch the same page twice.
    function pageKey(src, page) { return src.path + '?' + JSON.stringify(src.params || {}) + '#' + page; }

    function extract(src, j) {
        var res;
        if (src.credits) {                       // an actor's films and shows, best known first
            var seen = {};
            res = (j.cast || []).filter(function (r) {
                if (r.media_type !== 'movie' && r.media_type !== 'tv') return false;
                var k = r.media_type + r.id;
                if (seen[k]) return false;
                seen[k] = 1;
                return true;
            }).sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); }).slice(0, 60);
            return { items: res.map(function (r) { return mapItem(r, r.media_type); }), total: 1 };
        }
        res = j.results || [];
        if (src.multi) res = res.filter(function (r) { return r.media_type === 'movie' || r.media_type === 'tv'; });
        return {
            items: res.map(function (r) { return mapItem(r, src.type); }),
            total: Math.max(1, Math.min(j.total_pages || 1, MAX_PAGES))
        };
    }

    function loadPage(src, page) {
        var k = pageKey(src, page);
        if (S.pages[k]) return;
        S.pages[k] = { loading: true };
        var p = merge(src.params || {}, {});
        if (src.paged !== false) p.page = page;
        api(src.path, p).then(function (j) {
            S.pages[k] = extract(src, j);
            // First page of a list just arrived: now the page count is known, so fetch the next one.
            if (S.list && S.list.src === src && S.list.page === page) { S.list.total = S.pages[k].total; ensureLoaded(); }
        }, function (e) {
            if (isAuth(e)) S.authError = true;
            S.pages[k] = { error: errText(e) };
        }).then(redraw);
    }

    // ---------------------------------------------------------------- loading
    function sectionsFor(type) {
        var movie = type === 'movie';
        var reg = movie ? { region: S.region } : {};

        if (S.provider) {
            var base = {
                with_watch_providers: S.provider, watch_region: S.region,
                with_watch_monetization_types: 'flatrate', include_adult: 'false'
            };
            return [
                { title: 'Popular on this service', path: '/discover/' + type, type: type, params: merge(base, { sort_by: 'popularity.desc' }) },
                { title: 'Top rated on this service', path: '/discover/' + type, type: type, params: merge(base, { sort_by: 'vote_average.desc', 'vote_count.gte': 300 }) }
            ];
        }
        return [
            { title: 'Trending this week', path: '/trending/' + type + '/week', type: type, params: {} },
            { title: 'Top rated', path: '/' + type + '/top_rated', type: type, params: reg },
            { title: 'Popular', path: '/' + type + '/popular', type: type, params: reg },
            movie
                ? { title: 'Now playing in theaters', path: '/movie/now_playing', type: type, params: reg }
                : { title: 'On the air', path: '/tv/on_the_air', type: type, params: {} }
        ];
    }

    function loadProviders(type) {
        if (S.providers[type] !== null) return;
        S.providers[type] = [];
        S.provFail[type] = false;
        api('/watch/providers/' + type, { watch_region: S.region }).then(function (j) {
            S.providers[type] = pickProviders(j.results || [], S.region);
        }, function () { S.providers[type] = []; S.provFail[type] = true; }).then(redraw);
    }

    var PREFERRED = ['netflix', 'hulu', 'disney plus', 'max', 'hbo max', 'amazon prime video', 'prime video',
        'apple tv plus', 'apple tv+', 'paramount plus', 'paramount+', 'peacock', 'peacock premium', 'crunchyroll',
        'tubi tv', 'pluto tv', 'youtube'];
    var LABELS = { 'disney plus': 'Disney+', 'apple tv plus': 'Apple TV+', 'paramount plus': 'Paramount+',
        'amazon prime video': 'Prime Video', 'peacock premium': 'Peacock', 'tubi tv': 'Tubi', 'pluto tv': 'Pluto TV' };

    function pickProviders(list, region) {
        var rows = list.filter(function (p) {
            return p && p.provider_id && p.provider_name && !/channel|with ads|standard/i.test(p.provider_name);
        }).map(function (p) {
            var n = String(p.provider_name).toLowerCase();
            var pr = p.display_priorities && p.display_priorities[region];
            return { id: p.provider_id, label: LABELS[n] || p.provider_name, rank: PREFERRED.indexOf(n), prio: typeof pr === 'number' ? pr : 999 };
        });
        var pref = rows.filter(function (r) { return r.rank >= 0; }).sort(function (a, b) { return a.rank - b.rank; });
        var rest = rows.filter(function (r) { return r.rank < 0; }).sort(function (a, b) { return a.prio - b.prio; });
        var seen = {}, out = [];
        pref.concat(rest).forEach(function (r) {
            if (out.length < 12 && !seen[r.label]) { seen[r.label] = 1; out.push({ id: r.id, label: r.label }); }
        });
        return out;
    }

    function ensureLoaded() {
        if (S.tab === 'settings') return;
        if (S.list) {
            var L = S.list, cur = S.pages[pageKey(L.src, L.page)];
            if (!cur) loadPage(L.src, L.page);
            else if (cur.total) L.total = cur.total;
            if (L.src.paged !== false && L.page < (L.total || 0)) loadPage(L.src, L.page + 1);   // so Next is instant
            return;
        }
        loadProviders(S.tab);
        sectionsFor(S.tab).forEach(function (s) { loadPage(s, 1); });
    }

    function readLibrary() {
        return hesper.readJSON('library.json').then(function (j) {
            var movies = {}, shows = {}, nm = 0, ns = 0;
            (j.movies || []).forEach(function (m) {
                var k = norm(m.title);
                if (!k) return;
                (movies[k] = movies[k] || []).push(parseInt(m.year, 10) || 0);
                nm++;
            });
            (j.shows || []).forEach(function (s) {
                var k = norm(s.title);
                if (k) { shows[k] = true; ns++; }
            });
            S.lib = { movies: movies, shows: shows, nMovies: nm, nShows: ns, loaded: true };
        }, function () { /* backend has not written it yet */ });
    }

    // ---------------------------------------------------------------- navigation
    // Screens stack up: browse -> list of pages -> detail -> (another detail | an actor's list).
    // Back (the remote's Back key, Esc, or the on-screen button) steps out one screen at a time.
    function pushView() {
        if (S.detail || S.list) S.hist.push({ detail: S.detail, list: S.list });
    }

    function back() {
        if (S.hist.length) {
            var h = S.hist.pop();
            S.detail = h.detail; S.list = h.list;
        } else if (S.detail) S.detail = null;
        else if (S.list) S.list = null;
        ensureLoaded();
    }

    function resetViews() { S.detail = null; S.list = null; S.hist = []; }

    function selectTab(id) {
        S.tab = id; S.provider = 0; resetViews();
        if (id === 'settings') { S.keyDraft = ''; S.regionDraft = S.region; S.keyMsg = ''; }
        top();
        ensureLoaded();
    }

    function pickProvider(id) {
        S.provider = S.provider === id ? 0 : id;
        resetViews();
        ensureLoaded();
    }

    function refresh() {
        S.pages = {}; S.providers = { movie: null, tv: null }; S.authError = false;
        ensureLoaded();
    }

    function openList(src, title, extra) {
        pushView();
        S.detail = null;
        S.list = merge({ src: src, title: title, page: 1, total: 0, search: false }, extra || {});
        top();
        ensureLoaded();
    }

    function goPage(n) {
        var L = S.list;
        if (!L) return;
        L.page = Math.max(1, Math.min(n, L.total || MAX_PAGES));
        top();
        ensureLoaded();
    }

    function doSearch() {
        var term = S.query.trim();
        if (!term) { if (S.list && S.list.search) { S.list = null; } return; }
        S.detail = null; S.hist = []; S.list = null;
        openList({ path: '/search/multi', params: { query: term, include_adult: 'false' }, type: 'movie', multi: true },
            'Results for \u201c' + term + '\u201d', { search: true });
    }

    function clearSearch() { resetViews(); S.query = ''; }

    function openPerson(c) {
        openList({ path: '/person/' + c.id + '/combined_credits', params: {}, type: 'movie', credits: true, paged: false }, c.name);
    }

    function videoLangs() {
        var l = (S.lang.split('-')[0] || 'en').toLowerCase();
        return l === 'en' ? 'en,null' : l + ',en,null';
    }

    function openDetail(item) {
        pushView();
        var d = { item: item, loading: true };
        S.detail = d;
        top();
        api('/' + item.type + '/' + item.id, {
            append_to_response: 'watch/providers,videos,credits,recommendations,similar',
            include_video_language: videoLangs()
        }).then(function (j) {
            d.info = j;
            if (item.type === 'tv') { var ds = defaultSeason(j); if (ds) loadSeason(d, ds); }
        }, function (e) {
            if (isAuth(e)) S.authError = true;
            d.error = errText(e);
        }).then(function () { d.loading = false; redraw(); });
    }

    function saveKey() {
        var k = S.keyDraft.trim();
        if (!k) { S.keyMsg = 'Paste your TMDb API key first.'; return; }
        if (/^eyJ/.test(k) || k.length > 40) { S.keyMsg = 'That looks like the long v4 token. Use the shorter "API Key" (v3) from your TMDb account.'; return; }
        if (!/^[0-9a-fA-F]{32}$/.test(k)) { S.keyMsg = 'A v3 API key is 32 letters and digits. Check for missing characters.'; return; }
        S.keyMsg = 'Checking the key\u2026';
        var previous = S.key;
        S.key = k;
        api('/configuration', {}).then(function () {
            S.keyDraft = ''; S.authError = false;
            S.pages = {}; S.providers = { movie: null, tv: null };
            return hesper.storage.set('tmdb_key', k).then(function () {
                S.keyMsg = 'Key saved.';
            }, function () {
                S.keyMsg = 'The key works, but it could not be saved on this device. You will need to enter it again next time.';
            });
        }, function (e) {
            S.key = previous;
            S.keyMsg = errText(e);
        }).then(redraw, redraw);
    }

    function removeKey() {
        S.key = ''; S.keyDraft = ''; S.keyMsg = 'Key removed. Add a key to keep browsing.'; S.authError = false; S.pages = {}; resetViews();
        hesper.storage.remove('tmdb_key').then(redraw, redraw);
    }

    function saveRegion() {
        var r = S.regionDraft.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(r)) { S.keyMsg = 'Use a 2-letter country code, for example US or GB.'; return; }
        S.region = r; S.provider = 0; S.pages = {}; S.providers = { movie: null, tv: null }; resetViews();
        S.keyMsg = 'Region set to ' + r + '.';
        hesper.storage.set('region', r).then(redraw, redraw);
    }

    function autoRegion() {
        S.region = detectLocale().region; S.regionDraft = S.region; S.provider = 0; S.pages = {}; resetViews();
        S.providers = { movie: null, tv: null };
        S.keyMsg = 'Using your device region: ' + S.region + '.';
        hesper.storage.remove('region').then(redraw, redraw);
    }

    function setAutoplay(on) {
        S.autoplay = on;
        hesper.storage.set('autoplay', on ? '1' : '0').then(noop, noop);
    }

    function setPick(on) {
        S.pick = on;
        hesper.storage.set('pick', on ? '1' : '0').then(noop, noop);
    }

    function setSound(on) {
        S.sound = on;
        hesper.storage.set('sound', on ? '1' : '0').then(noop, noop);
    }

    // ---------------------------------------------------------------- views
    function poster(ui, item, focusKey) {
        var sub = [item.year || '', item.type === 'tv' ? 'TV' : 'Movie'].filter(Boolean).join(' \u00b7 ');
        var mine = owned(item);
        var opts = {};
        if (mine) opts.badge = 'In library';
        if (focusKey) opts.autofocus = focusKey;
        return ui.posterCard(item.title, mine ? sub + ' \u00b7 In your library' : sub, item.poster,
            function () { openDetail(item); }, opts);
    }

    function posterRow(ui, items, focusKey) {
        return ui.grid(items.map(function (it, i) { return poster(ui, it, i === 0 ? focusKey : ''); }),
            { minColWidth: '150px', scroll: true });
    }

    function row(ui, sec, rowIdx) {
        var e = S.pages[pageKey(sec, 1)];
        var head = ui.row(ui.heading(sec.title), ui.button('See all \u203a', function () { openList(sec, sec.title); }));
        if (!e || e.loading) return ui.column(head, spin(ui, 'Loading\u2026'));
        if (e.error) return ui.column(head, ui.text(e.error), ui.button('Try again', function () { delete S.pages[pageKey(sec, 1)]; ensureLoaded(); }));
        if (!e.items.length) return ui.column(head, ui.text('Nothing to show here.'));
        var cards = e.items.slice(0, PER_ROW).map(function (it) { return poster(ui, it); });
        cards.push(ui.card('See all', 'Browse every page', function () { openList(sec, sec.title); }));
        return ui.column(head, ui.grid(cards, { minColWidth: '150px', scroll: true }));
    }

    function chips(ui) {
        var list = S.providers[S.tab];
        if (list === null) return null;
        if (S.provFail[S.tab]) return ui.row(ui.text('Could not load streaming services.'), ui.button('Try again', function () { S.providers[S.tab] = null; ensureLoaded(); }));
        if (!list.length) return ui.text('Streaming service filters are not available for region ' + S.region + '.');
        var all = ui.button('All services', function () { S.provider = 0; resetViews(); ensureLoaded(); }, { selected: S.provider === 0 });
        return ui.column(
            ui.text('Streaming in ' + S.region),
            ui.row.apply(ui, [all].concat(list.map(function (p) {
                return ui.button(p.label, function () { pickProvider(p.id); }, { selected: S.provider === p.id });
            })))
        );
    }

    function attribution(ui) {
        return ui.column(
            ui.text('This product uses the TMDB API but is not endorsed or certified by TMDB.'),
            ui.text('Streaming availability data provided by JustWatch. Trailers play from YouTube.')
        );
    }

    function pickTrailer(info) {
        var vids = ((info && info.videos && info.videos.results) || []).filter(function (x) {
            return x && x.site === 'YouTube' && /^[A-Za-z0-9_-]{11}$/.test(x.key || '') &&
                (x.type === 'Trailer' || x.type === 'Teaser');
        });
        if (!vids.length) return null;
        var want = (S.lang.split('-')[0] || 'en').toLowerCase();
        function score(x) {
            return (x.type === 'Trailer' ? 4 : 2) + (x.official ? 2 : 0) + (x.iso_639_1 === want ? 1 : 0);
        }
        vids.sort(function (a, b) { return score(b) - score(a); });
        return vids[0];
    }

    function providerLine(info) {
        var wp = info && info['watch/providers'] && info['watch/providers'].results && info['watch/providers'].results[S.region];
        function names(list) { return (list || []).map(function (p) { return p.provider_name; }).filter(Boolean).slice(0, 8).join(', '); }
        if (!wp) return ['Not listed for streaming in ' + S.region + '.'];
        var lines = [];
        var stream = names((wp.flatrate || []).concat(wp.free || [], wp.ads || []));
        if (stream) lines.push('Stream: ' + stream);
        var buy = names((wp.rent || []).concat(wp.buy || []));
        if (buy) lines.push('Rent or buy: ' + buy);
        return lines.length ? lines : ['Not listed for streaming in ' + S.region + '.'];
    }

    function castRow(ui, info) {
        var cast = ((info.credits && info.credits.cast) || []).filter(function (c) { return c && c.id && c.name; }).slice(0, 20);
        if (!cast.length) return null;
        return ui.column(
            ui.heading('Cast'),
            ui.grid(cast.map(function (c) {
                var label = c.character ? c.name + ' \u00b7 ' + c.character : c.name;
                return ui.posterCard(label, 'See their other titles', c.profile_path ? IMG_PERSON + c.profile_path : '',
                    function () { openPerson(c); });
            }), { minColWidth: '130px', scroll: true })
        );
    }

    function relatedRow(ui, it, info) {
        var rec = (info.recommendations && info.recommendations.results) || [];
        var sim = (info.similar && info.similar.results) || [];
        var list = (rec.length ? rec : sim).slice(0, PER_ROW).map(function (r) { return mapItem(r, it.type); });
        if (!list.length) return null;
        return ui.column(ui.heading('More like this'), posterRow(ui, list, ''));
    }

    // ---------------------------------------------------------------- watch (torrent)
    function haveTorrent() { return !!(hesper.torrent && hesper.torrent.play); }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function today() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

    function playState(d) {
        if (!d.play) d.play = { season: 0, episodes: {}, epLoading: false, searching: false, busy: false, error: '', results: null, label: '', ep: 0 };
        return d.play;
    }

    function torrentErr(e) {
        var m = String((e && e.message) || e || '');
        if (/^Search sites failed/.test(m)) return 'Could not get results from any search site. ' + m.replace(/^Search sites failed\.\s*/, '');
        if (/network permissions/i.test(m)) return 'A search site is missing from this plugin\'s network list. Add its host to plugin.json and reinstall.';
        if (/No search sites/i.test(m)) return m;
        if (/Unknown release|Not an allowed release link/i.test(m)) return 'PEK refused this download link. Update PEK to the latest build (older builds only accept links from their own search), or pick a release that has a magnet link.';
        if (/HTTP (403|429)/.test(m)) return 'The release source refused the request. Try again later.';
        if (/HTTP \d\d\d|network|fetch|reach/i.test(m)) return 'Could not reach the release source. Check your connection.';
        if (/torrent. permission/i.test(m)) return 'This plugin was installed without the torrent permission. Reinstall it.';
        if (/not available|not built/i.test(m)) return 'This build of PEK cannot play torrents.';
        return m || 'Something went wrong.';
    }

    function defaultSeason(info) {
        var list = (info.seasons || []).filter(function (s) { return s.season_number > 0 && s.episode_count > 0; });
        if (!list.length) return 0;
        var t = today(), best = list[0].season_number;
        list.forEach(function (s) { if (s.air_date && s.air_date <= t) best = s.season_number; });
        return best;
    }

    function loadSeason(d, n) {
        var P = playState(d);
        P.season = n;
        if (!n || P.episodes[n]) { redraw(); return; }
        P.epLoading = true;
        redraw();
        api('/tv/' + d.item.id + '/season/' + n, {}).then(function (j) {
            P.episodes[n] = (j.episodes || []).map(function (e) {
                return { n: e.episode_number, name: e.name || '', air: e.air_date || '' };
            });
        }, function (e) { P.error = errText(e); }).then(function () { P.epLoading = false; redraw(); });
    }

    function releaseTitle(r) {
        return (r.quality ? r.quality + 'p' : 'Quality not listed') + ' \u00b7 ' + r.sizeText + ' \u00b7 ' + r.seeders + ' seeds' + (r.pack ? ' \u00b7 season pack' : '');
    }

    function playRelease(d, r, season, episode, label) {
        var P = playState(d);
        P.busy = true; P.error = '';
        redraw();
        hesper.torrent.play({ source: r.source, title: label, season: season, episode: episode }).then(function () {
            P.busy = false;
        }, function (e) {
            P.busy = false;
            if (String((e && e.message) || e) !== 'Cancelled') P.error = torrentErr(e);
        }).then(redraw);
    }

    function searchOnce(it, season, episode, title) {
        return ReleaseSearch.searchReleases({
            title: title,
            season: it.type === 'tv' ? season : 0,
            episode: it.type === 'tv' ? episode : 0,
            year: it.type === 'tv' ? 0 : it.year
        });
    }

    // Find releases for a movie (season = episode = 0) or one episode, then play the best one
    // (or show the list when "Choose the release myself" is on).
    function findAndPlay(d, season, episode, label) {
        var P = playState(d), it = d.item;
        if (P.searching || P.busy) return;
        P.searching = true; P.error = ''; P.results = null; P.label = label; P.ep = episode;
        redraw();
        searchOnce(it, season, episode, it.title).then(function (list) {
            list = Array.isArray(list) ? list : [];
            if (list.length || !it.alt || it.alt === it.title) return list;
            return searchOnce(it, season, episode, it.alt).then(function (l2) { return Array.isArray(l2) ? l2 : []; });
        }).then(function (list) {
            P.searching = false;
            P.results = list;
            if (!list.length) { P.error = 'No release with seeders found for ' + label + '.' + (ReleaseSearch.report() ? ' (' + ReleaseSearch.report() + ')' : ''); redraw(); return; }
            if (S.pick) { redraw(); return; }
            playRelease(d, list[0], season, episode, label);
        }, function (e) {
            P.searching = false;
            P.error = torrentErr(e);
            redraw();
        });
    }

    function watchBlock(ui, d) {
        var it = d.item, info = d.info || {}, P = playState(d), kids = [];
        kids.push(ui.heading('Watch'));
        if (!haveTorrent()) {
            kids.push(ui.text('Update PEK to play titles from here.'));
            return ui.column.apply(ui, kids);
        }
        var working = P.searching || P.busy;

        if (it.type === 'movie') {
            var label = it.title + (it.year ? ' (' + it.year + ')' : '');
            kids.push(ui.button(P.searching ? 'Searching\u2026' : (P.busy ? 'Starting\u2026' : '\u25b6  Play'),
                function () { findAndPlay(d, 0, 0, label); }, { primary: true }));
        } else {
            var seasons = (info.seasons || []).filter(function (s) { return s.season_number > 0 && s.episode_count > 0; });
            if (!seasons.length) {
                kids.push(ui.text('No episodes are listed for this show yet.'));
            } else {
                kids.push(ui.text('Pick a season, then tap an episode to play it.'));
                kids.push(ui.tabs(seasons.map(function (s) { return { id: String(s.season_number), label: 'S' + s.season_number }; }),
                    String(P.season || ''), function (id) { loadSeason(d, parseInt(id, 10) || 0); }));
                if (P.epLoading) kids.push(spin(ui, 'Loading episodes\u2026'));
                var eps = P.episodes[P.season] || [];
                var t = today();
                eps.forEach(function (e) {
                    var aired = !!e.air && e.air <= t;
                    kids.push(ui.listRow('E' + e.n + ' \u00b7 ' + (e.name || 'Episode ' + e.n),
                        aired ? e.air : (e.air ? 'Airs ' + e.air : 'Not announced yet'),
                        function () {
                            if (!aired) { P.error = 'That episode has not aired yet.'; return; }
                            findAndPlay(d, P.season, e.n, it.title + ' S' + pad2(P.season) + 'E' + pad2(e.n));
                        }));
                });
            }
        }

        if (P.searching) kids.push(spin(ui, 'Looking for ' + P.label + '\u2026'));
        if (P.busy) kids.push(ui.text('Starting the stream\u2026'));
        if (P.error) kids.push(ui.text(P.error));

        if (P.results && P.results.length && !P.searching) {
            kids.push(ui.heading(S.pick ? 'Choose a release' : 'Other releases'));
            P.results.slice(0, 10).forEach(function (r) {
                kids.push(ui.listRow(releaseTitle(r), r.title, function () {
                    if (working) return;
                    playRelease(d, r, it.type === 'tv' ? P.season : 0, it.type === 'tv' ? P.ep : 0, P.label);
                }));
            });
        }
        return ui.column.apply(ui, kids);
    }

    function detailView(ui) {
        var d = S.detail, it = d.item, info = d.info || {};
        var kids = [];

        // The trailer goes first: PEK pins it to the very top of the page.
        if (d.loading) kids.push(spin(ui, 'Loading\u2026', true));
        else if (!d.error && ui.video) {
            var tr = pickTrailer(info);
            if (tr) kids.push(ui.video({ id: tr.key, autoplay: S.autoplay, muted: !S.sound, title: it.title + ' trailer' }));
        }

        var meta = [it.year || '', it.type === 'tv' ? 'TV show' : 'Movie'];
        if (it.rating) meta.push('\u2605 ' + it.rating.toFixed(1) + ' (' + it.votes + ' votes)');
        if (info.runtime) meta.push(info.runtime + ' min');
        if (info.number_of_seasons) meta.push(info.number_of_seasons + (info.number_of_seasons === 1 ? ' season' : ' seasons'));
        kids.push(ui.button('\u2190 Back', back, { autofocus: 'detail:' + it.type + it.id }));
        kids.push(ui.heading(it.title));
        kids.push(ui.text(meta.filter(Boolean).join(' \u00b7 ')));
        if (owned(it)) kids.push(ui.text('\u2713 In your library'));
        if (info.tagline) kids.push(ui.text('\u201c' + info.tagline + '\u201d'));
        var overview = info.overview || it.overview;
        kids.push(ui.text(overview || (d.loading ? 'Loading\u2026' : 'No description available.')));
        if (info.genres && info.genres.length) kids.push(ui.text('Genres: ' + info.genres.map(function (g) { return g.name; }).join(', ')));
        if (d.error) kids.push(ui.text(d.error));
        if (!d.loading && !d.error) {
            kids.push(watchBlock(ui, d));
            providerLine(info).forEach(function (l) { kids.push(ui.text(l)); });
            var c = castRow(ui, info);
            if (c) kids.push(c);
            var r = relatedRow(ui, it, info);
            if (r) kids.push(r);
        }
        kids.push(attribution(ui));
        return ui.column.apply(ui, kids);
    }

    function pager(ui, L) {
        var total = L.total || 0;
        if (total <= 1 && L.page <= 1) return null;
        var kids = [];
        if (L.page > 10) kids.push(ui.button('\u00ab 10', function () { goPage(L.page - 10); }));
        if (L.page > 1) kids.push(ui.button('\u2039 Prev', function () { goPage(L.page - 1); }));
        kids.push(ui.text('Page ' + L.page + (total ? ' of ' + total : '')));
        if (!total || L.page < total) kids.push(ui.button('Next \u203a', function () { goPage(L.page + 1); }));
        if (total && L.page + 10 <= total) kids.push(ui.button('10 \u00bb', function () { goPage(L.page + 10); }));
        return ui.row.apply(ui, kids);
    }

    function listView(ui) {
        var L = S.list;
        var e = S.pages[pageKey(L.src, L.page)];
        if (e && e.total) L.total = e.total;
        var kids = [ui.row(ui.button('\u2190 Back', back), ui.heading(L.title))];
        var pg = L.src.paged === false ? null : pager(ui, L);
        if (pg) kids.push(pg);
        if (!e || e.loading) {
            kids.push(spin(ui, 'Loading page ' + L.page + '\u2026', true));
        } else if (e.error) {
            kids.push(ui.text(e.error));
            kids.push(ui.button('Try again', function () { delete S.pages[pageKey(L.src, L.page)]; ensureLoaded(); }));
        } else if (!e.items.length) {
            kids.push(ui.text('Nothing to show here.'));
        } else {
            var fk = 'list:' + L.title + ':' + L.page;
            kids.push(ui.grid(e.items.map(function (it, i) { return poster(ui, it, i === 0 ? fk : ''); }), { minColWidth: '150px' }));
            if (pg) kids.push(pager(ui, L));
        }
        return ui.column.apply(ui, kids);
    }

    function settingsView(ui) {
        var kids = [];
        kids.push(ui.heading('TMDb access'));
        kids.push(ui.text(S.key
            ? 'Using your own TMDb key. It is stored only inside this plugin on this device.'
            : 'Paste your free v3 API key (themoviedb.org > Settings > API) to start browsing. It is stored only inside this plugin on this device and is sent only to api.themoviedb.org.'));
        kids.push(ui.textInput('API Key (v3)', S.keyDraft, function (v) { S.keyDraft = v; },
            { type: 'password', placeholder: '32-character key', onSubmit: saveKey }));
        kids.push(ui.row(
            ui.button('Use my key', saveKey, { primary: true }),
            S.key ? ui.button('Remove key', removeKey) : null
        ));
        kids.push(ui.heading('Trailers'));
        if (ui.toggle) {
            kids.push(ui.toggle('Auto-play trailers when a title opens', S.autoplay, function (v) { setAutoplay(v === 'true'); }));
            kids.push(ui.toggle('Trailer sound', S.sound, function (v) { setSound(v === 'true'); }));
        } else {
            kids.push(ui.text('Update PEK to change the trailer settings.'));
        }
        kids.push(ui.text('Trailers play from YouTube. If your device blocks sound from starting by itself, turn Trailer sound off.'));
        kids.push(ui.heading('Playing'));
        if (ui.toggle) {
            kids.push(ui.toggle('Let me choose the release (otherwise the best match plays)', S.pick, function (v) { setPick(v === 'true'); }));
        }
        kids.push(ui.text(haveTorrent()
            ? 'Releases are found by this plugin\'s built-in search (no Torznab setup needed) and played through PEK.'
            : 'This version of PEK cannot play torrents. Update PEK.'));
        kids.push(ui.heading('Region'));
        kids.push(ui.text('Streaming services and "now playing" follow your device region (' + detectLocale().region + '). Using: ' + S.region + '.'));
        kids.push(ui.textInput('Country code', S.regionDraft, function (v) { S.regionDraft = v; },
            { placeholder: 'US', onSubmit: saveRegion }));
        kids.push(ui.row(ui.button('Set region', saveRegion), ui.button('Use device region', autoRegion)));
        if (S.keyMsg) kids.push(ui.text(S.keyMsg));
        kids.push(ui.heading('Your library'));
        kids.push(ui.text(S.lib.loaded
            ? S.lib.nMovies + ' movies and ' + S.lib.nShows + ' shows are marked "In library". The list is refreshed each time PEK starts.'
            : 'Library list not available yet. It is created when PEK starts, so close and reopen PEK once after installing.'));
        kids.push(attribution(ui));
        return ui.column.apply(ui, kids);
    }

    function browseView(ui) {
        if (S.authError || !S.key) {
            return ui.column(
                ui.card(S.key ? 'TMDb rejected your API key' : 'Add your TMDb API key',
                    S.key ? 'Tap to open Settings and check it.' : 'Tap to open Settings and paste your free v3 key.',
                    function () { selectTab('settings'); }));
        }
        var kids = [chips(ui)];
        sectionsFor(S.tab).forEach(function (sec, i) { kids.push(row(ui, sec, i)); });
        return ui.column.apply(ui, kids);
    }

    hesper.render(function (ui) {
        if (!S.ready) return ui.column(spin(ui, 'Loading\u2026', true));
        if (hesper.setBack) hesper.setBack((S.detail || S.list) ? back : null);
        if (S.detail) return detailView(ui);

        var kids = [];
        if (S.tab !== 'settings') {
            kids.push(ui.textInput('', S.query, function (v) { S.query = v; },
                { placeholder: 'Search any movie or TV show', onSubmit: doSearch }));
            kids.push(ui.row(
                ui.button('Search', doSearch, { primary: true }),
                (S.list && S.list.search) ? ui.button('Clear search', clearSearch) : null,
                ui.button('Refresh', refresh)
            ));
        }
        if (!S.list) {
            kids.push(ui.tabs([
                { id: 'movie', label: 'Movies' },
                { id: 'tv', label: 'TV Shows' },
                { id: 'settings', label: 'Settings' }
            ], S.tab, selectTab));
        }

        if (S.tab === 'settings') kids.push(settingsView(ui));
        else if (S.authError) kids.push(browseView(ui));
        else if (S.list) kids.push(listView(ui));
        else kids.push(browseView(ui));

        if (S.tab !== 'settings') kids.push(attribution(ui));
        return ui.column.apply(ui, kids);
    });

    // ---------------------------------------------------------------- start
    function get(k) { return hesper.storage.get(k).then(function (v) { return v || ''; }, function () { return ''; }); }

    Promise.all([get('tmdb_key'), get('region'), get('autoplay'), get('sound'), readLibrary(), get('pick')]).then(function (r) {
        S.key = r[0];
        if (/^[A-Z]{2}$/.test(r[1])) S.region = r[1];
        S.autoplay = r[2] !== '0';
        S.sound = r[3] !== '0';
        S.pick = r[5] === '1';
        S.regionDraft = S.region;
        S.tab = 'movie';
        S.ready = true;
        ensureLoaded();
        redraw();
    });
})();
