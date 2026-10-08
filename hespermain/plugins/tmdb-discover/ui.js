// PEK Discover: trending / top rated / popular / now playing rows for movies and TV,
// streaming-service chips, search, a detail page with an auto-playing trailer, cast and
// related titles, numbered pages for every list, and a badge on titles you already own.
//
// Official PEK plugin. It still runs in the plugin sandbox, but it uses PEK's built-in
// TMDb access (a proxy that holds PEK's key), so nobody has to enter a key. Settings has an
// optional "use my own key" override, stored only in this plugin's private storage.
// Data: TMDb. Streaming availability: JustWatch (via TMDb). Trailers: YouTube.
(function () {
    'use strict';

    var API = 'https://api.themoviedb.org/3';                       // only used with a personal key
    var PROXY = 'https://hesper-tmdb.aquariusibeats.workers.dev';   // PEK's built-in access (holds the key)
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
        authError: false,
        favs: {},                // 'movie:603' -> true  (the shared Favorites list in PEK)
        favMsg: '',
        streamers: [],           // other plugins that can play titles: [{ id, name }]
        pendingLaunch: null      // a title PEK asked us to open before we were ready
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
            posterPath: r.poster_path || '',
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
            : "PEK's built-in TMDb access was refused. Try again later, or add your own key in Settings.";
        if (/HTTP 404/.test(m)) return 'TMDb could not find that (404).';
        if (/HTTP 429/.test(m)) return 'TMDb is busy right now (429). Try again in a moment.';
        if (/HTTP 5\d\d/.test(m)) return 'TMDb had a problem (' + m.replace('HTTP ', '') + '). Try again later.';
        if (/abort/i.test(m)) return 'TMDb took too long to answer.';
        if (/too large/i.test(m)) return 'TMDb sent more data than PEK allows.';
        return "Couldn't reach TMDb. Check your connection.";
    }

    function isAuth(e) { return /HTTP (401|403)/.test(String((e && e.message) || e || '')); }

    function api(path, params) {
        var q = ['language=' + encodeURIComponent(S.lang)];
        if (S.key) q.unshift('api_key=' + encodeURIComponent(S.key));
        Object.keys(params || {}).forEach(function (k) {
            q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        });
        // Personal key: straight to TMDb. No key: PEK's built-in access (the proxy adds the key).
        return hesper.fetchJSON((S.key ? API : PROXY) + path + '?' + q.join('&'));
    }

    function today() {
        var d = new Date(), p = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    // ---------------------------------------------------------------- favorites, providers, other plugins
    function favKey(it) { return it.type + ':' + it.id; }

    function loadFavs() {
        if (!hesper.favorites) return Promise.resolve();
        return hesper.favorites.list().then(function (keys) {
            var m = {};
            (keys || []).forEach(function (k) { m[k] = true; });
            S.favs = m;
        }, noop).then(redraw);
    }

    function toggleFav(it) {
        if (!hesper.favorites) return;
        var k = favKey(it), on = !S.favs[k];
        if (on) S.favs[k] = true; else delete S.favs[k];
        S.favMsg = '';
        redraw();
        var job = on
            ? hesper.favorites.add({ type: it.type, id: it.id, title: it.title, year: it.year, posterPath: it.posterPath || '' })
            : hesper.favorites.remove(k);
        job.then(noop, function () {
            if (on) delete S.favs[k]; else S.favs[k] = true;       // undo: it did not save
            S.favMsg = 'Could not update your favorites.';
        }).then(redraw);
    }

    function loadStreamers() {
        if (!hesper.plugins) return;
        hesper.plugins.streamers().then(function (l) { S.streamers = l || []; }, noop).then(redraw);
    }

    // Is this title released? (If it is not, there is nothing to watch yet.)
    function isOut(it, info) {
        info = info || {};
        var date = (it.type === 'tv' ? info.first_air_date : info.release_date) || '';
        var status = String(info.status || '');
        if (/^(Rumored|Planned)$/i.test(status)) return false;
        if (it.type === 'movie' && /^(In Production|Post Production)$/i.test(status)) return false;
        if (date) return date <= today();
        return /^(Released|Ended|Returning Series|Canceled)$/i.test(status);
    }

    // Where this title can be watched in the chosen region, as logo buttons. Nothing is listed
    // when it is not on any service. The buttons open the service's app (Android) or website.
    var SHOW_RENT_BUY = true;
    function providerButtons(ui, it, info) {
        if (!ui.providerButton) return [];
        var wp = info && info['watch/providers'] && info['watch/providers'].results && info['watch/providers'].results[S.region];
        if (!wp) return [];
        var seen = {};
        function uniq(list) {
            return (list || []).filter(function (p) {
                if (!p || !p.provider_id || !p.provider_name || seen[p.provider_id]) return false;
                seen[p.provider_id] = 1;
                return true;
            }).slice(0, 12);
        }
        function btns(list) {
            return ui.row.apply(ui, list.map(function (p) {
                return ui.providerButton({ name: p.provider_name, logo: p.logo_path, title: it.title, type: it.type, tmdbId: it.id, region: S.region });
            }));
        }
        var stream = uniq((wp.flatrate || []).concat(wp.free || [], wp.ads || []));
        var buy = SHOW_RENT_BUY ? uniq((wp.rent || []).concat(wp.buy || [])) : [];
        var out = [];
        if (stream.length) { out.push(ui.heading('Watch on')); out.push(btns(stream)); }
        if (buy.length) { out.push(ui.heading('Rent or buy')); out.push(btns(buy)); }
        return out;
    }

    // "Play with <plugin>" for every other installed plugin that can play movies and shows.
    function streamerButtons(ui, it, info) {
        if (!hesper.plugins || !S.streamers.length || !isOut(it, info)) return [];
        return [ui.heading('Play with a plugin'), ui.row.apply(ui, S.streamers.map(function (p) {
            return ui.button('\u25b6  ' + p.name, function () {
                return hesper.plugins.open(p.id, { type: it.type, id: it.id, title: it.title, year: it.year })
                    .then(noop, function () { S.favMsg = 'Could not open ' + p.name + '.'; });
            }, { primary: true });
        }))];
    }

    // PEK opened this plugin on a title (Favorites tab, or another plugin's button).
    function launch(intent) {
        if (!intent || !intent.id || !intent.type) return;
        if (!S.ready) { S.pendingLaunch = intent; return; }
        S.tab = intent.type === 'tv' ? 'tv' : 'movie';
        S.provider = 0; S.query = '';
        resetViews();
        ensureLoaded();
        openDetail({ id: intent.id, type: S.tab, title: intent.title || 'Loading\u2026', alt: '', year: intent.year || 0,
            poster: '', posterPath: '', overview: '', rating: 0, votes: 0 });
    }
    if (hesper.onLaunch) hesper.onLaunch(launch);

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
        var it0 = item;
        S.detail = d;
        top();
        api('/' + item.type + '/' + item.id, {
            append_to_response: 'watch/providers,videos,credits,recommendations,similar',
            include_video_language: videoLangs()
        }).then(function (j) {
            d.info = j;
            // A title opened from Favorites only knew its id: fill in the rest from TMDb's answer.
            if (j.title || j.name) it0.title = String((item.type === 'tv' ? j.name : j.title) || it0.title);
            if (!it0.posterPath && j.poster_path) { it0.posterPath = j.poster_path; it0.poster = IMG + j.poster_path; }
            if (!it0.rating) { it0.rating = j.vote_average || 0; it0.votes = j.vote_count || 0; }
            if (!it0.year) it0.year = yearOf(j.release_date || j.first_air_date);
            if (!it0.overview) it0.overview = String(j.overview || '');
        }, function (e) {
            if (isAuth(e)) S.authError = true;
            d.error = errText(e);
        }).then(function () { d.loading = false; redraw(); });
        loadFavs();
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
        S.key = ''; S.keyDraft = ''; S.keyMsg = "Key removed. Using PEK's built-in access."; S.authError = false; S.pages = {}; resetViews();
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
        var backBtn = ui.button('\u2190 Back', back, { autofocus: 'detail:' + it.type + it.id });
        if (hesper.favorites && !d.loading) {
            var isFav = !!S.favs[favKey(it)];
            kids.push(ui.row(backBtn, ui.button(isFav ? '\u2665  In your favorites' : '\u2661  Add to favorites',
                function () { toggleFav(it); }, { selected: isFav })));
            if (S.favMsg) kids.push(ui.text(S.favMsg));
        } else kids.push(backBtn);
        kids.push(ui.heading(it.title));
        kids.push(ui.text(meta.filter(Boolean).join(' \u00b7 ')));
        if (owned(it)) kids.push(ui.text('\u2713 In your library'));
        if (info.tagline) kids.push(ui.text('\u201c' + info.tagline + '\u201d'));
        var overview = info.overview || it.overview;
        kids.push(ui.text(overview || (d.loading ? 'Loading\u2026' : 'No description available.')));
        if (info.genres && info.genres.length) kids.push(ui.text('Genres: ' + info.genres.map(function (g) { return g.name; }).join(', ')));
        if (d.error) kids.push(ui.text(d.error));
        if (!d.loading && !d.error) {
            if (!isOut(it, info)) kids.push(ui.text('Not out yet' + (((it.type === 'tv' ? info.first_air_date : info.release_date) || '') > today() ? ' \u2014 ' + (it.type === 'tv' ? info.first_air_date : info.release_date) : '') + '.'));
            providerButtons(ui, it, info).forEach(function (k) { kids.push(k); });
            streamerButtons(ui, it, info).forEach(function (k) { kids.push(k); });
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
            ? 'Using your own TMDb key. Remove it to go back to the built-in access.'
            : "Built in: PEK's own TMDb access is used, so there is nothing to set up. Optional: paste your own free v3 API key (themoviedb.org > Settings > API) to use that instead. It is stored only inside this plugin on this device."));
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
        if (S.authError) {
            return ui.column(
                ui.card(S.key ? 'TMDb rejected your API key' : "PEK's built-in TMDb access was refused",
                    S.key ? 'Tap to open Settings and check it.' : 'Tap to open Settings and add your own key instead.',
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

    Promise.all([get('tmdb_key'), get('region'), get('autoplay'), get('sound'), readLibrary()]).then(function (r) {
        S.key = r[0];
        if (/^[A-Z]{2}$/.test(r[1])) S.region = r[1];
        S.autoplay = r[2] !== '0';
        S.sound = r[3] !== '0';
        S.regionDraft = S.region;
        S.tab = 'movie';
        S.ready = true;
        ensureLoaded();
        loadFavs();
        loadStreamers();
        if (S.pendingLaunch) { var l = S.pendingLaunch; S.pendingLaunch = null; launch(l); }
        redraw();
    });
})();
