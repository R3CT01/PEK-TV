// PEK Discover: trending / top rated / popular / now playing rows for movies and TV,
// streaming-service chips, search, descriptions, and a badge on titles you already own.
//
// Runs in PEK's plugin sandbox. It talks to TMDb with your own v3 API key
// (entered in this screen's Settings tab, stored only in this plugin's private storage).
// Data: TMDb. Streaming availability: JustWatch (via TMDb).
(function () {
    'use strict';

    var API = 'https://api.themoviedb.org/3';
    var IMG = 'https://image.tmdb.org/t/p/w342';
    var PER_ROW = 18;

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
        tab: 'movie',            // 'movie' | 'tv' | 'settings'
        provider: 0,             // TMDb provider id, 0 = all services
        providers: { movie: null, tv: null },
        data: {},                // section id -> { loading } | { items } | { error }
        query: '',
        search: null,            // null | { term, loading } | { term, items } | { term, error }
        detail: null,            // null | { item, loading, info, error }
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
        try { t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engine */ }
        t = t.replace(/&/g, ' and ')
            .replace(/\(\s*(?:19|20)\d\d\s*\)\s*$/, ' ')
            .replace(/['’`]/g, '')
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
        if (/HTTP 401/.test(m)) return 'TMDb rejected your API key (401). Check it in Settings.';
        if (/HTTP 404/.test(m)) return 'TMDb could not find that (404).';
        if (/HTTP 429/.test(m)) return 'TMDb is busy right now (429). Try again in a moment.';
        if (/HTTP 5\d\d/.test(m)) return 'TMDb had a problem (' + m.replace('HTTP ', '') + '). Try again later.';
        if (/abort/i.test(m)) return 'TMDb took too long to answer.';
        if (/too large/i.test(m)) return 'TMDb sent more data than PEK allows.';
        return "Couldn't reach TMDb. Check your connection.";
    }

    function api(path, params) {
        var q = ['api_key=' + encodeURIComponent(S.key), 'language=' + encodeURIComponent(S.lang)];
        Object.keys(params || {}).forEach(function (k) {
            q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
        });
        return hesper.fetchJSON(API + path + '?' + q.join('&'));
    }

    function redraw() { hesper.requestRender(); }

    // ---------------------------------------------------------------- loading
    function sectionsFor(type) {
        var movie = type === 'movie';
        var reg = movie ? { region: S.region } : {};
        function merge(a, b) { var o = {}; Object.keys(a).forEach(function (k) { o[k] = a[k]; }); Object.keys(b).forEach(function (k) { o[k] = b[k]; }); return o; }

        if (S.provider) {
            var base = {
                with_watch_providers: S.provider, watch_region: S.region,
                with_watch_monetization_types: 'flatrate', include_adult: 'false'
            };
            return [
                { id: type + ':p:pop', title: 'Popular on this service', path: '/discover/' + type, params: merge(base, { sort_by: 'popularity.desc' }) },
                { id: type + ':p:top', title: 'Top rated on this service', path: '/discover/' + type, params: merge(base, { sort_by: 'vote_average.desc', 'vote_count.gte': 300 }) }
            ].map(function (s) { s.id += ':' + S.provider + ':' + S.region; return s; });
        }
        return [
            { id: type + ':trending', title: 'Trending this week', path: '/trending/' + type + '/week', params: {} },
            { id: type + ':top', title: 'Top rated', path: '/' + type + '/top_rated', params: reg },
            { id: type + ':popular', title: 'Popular', path: '/' + type + '/popular', params: reg },
            movie
                ? { id: 'movie:now', title: 'Now playing in theaters', path: '/movie/now_playing', params: reg }
                : { id: 'tv:air', title: 'On the air', path: '/tv/on_the_air', params: {} }
        ].map(function (s) { s.id += ':' + S.region; return s; });
    }

    function loadSection(sec, type) {
        if (S.data[sec.id]) return;
        S.data[sec.id] = { loading: true };
        api(sec.path, sec.params).then(function (j) {
            S.data[sec.id] = { items: (j.results || []).slice(0, PER_ROW).map(function (r) { return mapItem(r, type); }) };
        }, function (e) {
            if (/HTTP 401/.test(String(e && e.message))) S.authError = true;
            S.data[sec.id] = { error: errText(e) };
        }).then(redraw);
    }

    function loadProviders(type) {
        if (S.providers[type] !== null) return;
        S.providers[type] = [];
        api('/watch/providers/' + type, { watch_region: S.region }).then(function (j) {
            S.providers[type] = pickProviders(j.results || [], S.region);
        }, function () { S.providers[type] = []; }).then(redraw);
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
        if (!S.key || S.tab === 'settings') return;
        loadProviders(S.tab);
        sectionsFor(S.tab).forEach(function (s) { loadSection(s, S.tab); });
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

    // ---------------------------------------------------------------- actions
    function selectTab(id) {
        S.tab = id; S.detail = null; S.provider = 0;
        if (id === 'settings') { S.keyDraft = ''; S.regionDraft = S.region; S.keyMsg = ''; }
        ensureLoaded();
    }

    function pickProvider(id) {
        S.provider = S.provider === id ? 0 : id;
        S.search = null;
        ensureLoaded();
    }

    function refresh() {
        S.data = {}; S.providers = { movie: null, tv: null }; S.authError = false;
        S.search = null;
        ensureLoaded();
    }

    function doSearch() {
        var term = S.query.trim();
        if (!term) { S.search = null; return; }
        if (!S.key) { selectTab('settings'); return; }
        S.detail = null;
        S.search = { term: term, loading: true };
        api('/search/multi', { query: term, include_adult: 'false', page: 1 }).then(function (j) {
            var items = (j.results || []).filter(function (r) { return r.media_type === 'movie' || r.media_type === 'tv'; })
                .slice(0, 30).map(function (r) { return mapItem(r, r.media_type); });
            if (S.search && S.search.term === term) S.search = { term: term, items: items };
        }, function (e) {
            if (/HTTP 401/.test(String(e && e.message))) S.authError = true;
            if (S.search && S.search.term === term) S.search = { term: term, error: errText(e) };
        }).then(redraw);
    }

    function clearSearch() { S.search = null; S.query = ''; }

    function openDetail(item) {
        var d = { item: item, loading: true };
        S.detail = d;
        api('/' + item.type + '/' + item.id, { append_to_response: 'watch/providers' }).then(function (j) {
            d.info = j;
        }, function (e) { d.error = errText(e); }).then(function () { d.loading = false; redraw(); });
    }

    function saveKey() {
        var k = S.keyDraft.trim();
        if (!k) { S.keyMsg = 'Paste your TMDb API key first.'; return; }
        if (/^eyJ/.test(k) || k.length > 40) { S.keyMsg = 'That looks like the long v4 token. Use the shorter "API Key" (v3) from your TMDb account.'; return; }
        if (!/^[0-9a-fA-F]{32}$/.test(k)) { S.keyMsg = 'A v3 API key is 32 letters and digits. Check for missing characters.'; return; }
        S.keyMsg = 'Checking the key…';
        var previous = S.key;
        S.key = k;
        api('/configuration', {}).then(function () {
            return hesper.storage.set('tmdb_key', k).then(function () {
                S.keyDraft = ''; S.keyMsg = 'Key saved.'; S.authError = false;
                S.data = {}; S.providers = { movie: null, tv: null };
            });
        }, function (e) {
            S.key = previous;
            S.keyMsg = errText(e);
        }).then(redraw);
    }

    function removeKey() {
        S.key = ''; S.keyDraft = ''; S.keyMsg = 'Key removed.'; S.data = {}; S.search = null;
        hesper.storage.remove('tmdb_key').then(redraw, redraw);
    }

    function saveRegion() {
        var r = S.regionDraft.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(r)) { S.keyMsg = 'Use a 2-letter country code, for example US or GB.'; return; }
        S.region = r; S.provider = 0; S.data = {}; S.providers = { movie: null, tv: null };
        S.keyMsg = 'Region set to ' + r + '.';
        hesper.storage.set('region', r).then(redraw, redraw);
    }

    function autoRegion() {
        S.region = detectLocale().region; S.regionDraft = S.region; S.provider = 0; S.data = {};
        S.providers = { movie: null, tv: null };
        S.keyMsg = 'Using your device region: ' + S.region + '.';
        hesper.storage.remove('region').then(redraw, redraw);
    }

    // ---------------------------------------------------------------- views
    function poster(ui, item) {
        var sub = [item.year || '', item.type === 'tv' ? 'TV' : 'Movie'].filter(Boolean).join(' · ');
        var mine = owned(item);
        return ui.posterCard(item.title, mine ? sub + ' · In your library' : sub, item.poster,
            function () { openDetail(item); }, mine ? { badge: 'In library' } : undefined);
    }

    function row(ui, sec) {
        var d = S.data[sec.id];
        var head = ui.heading(sec.title);
        if (!d || d.loading) return ui.column(head, ui.text('Loading…'));
        if (d.error) return ui.column(head, ui.text(d.error), ui.button('Try again', function () { delete S.data[sec.id]; ensureLoaded(); }));
        if (!d.items.length) return ui.column(head, ui.text('Nothing to show here.'));
        return ui.column(head, ui.grid(d.items.map(function (it) { return poster(ui, it); }), { minColWidth: '150px', scroll: true }));
    }

    function chips(ui) {
        var list = S.providers[S.tab];
        if (list === null) return null;
        if (!list.length) return ui.text('Streaming service filters are not available for region ' + S.region + '.');
        var all = ui.button('All services', function () { S.provider = 0; ensureLoaded(); }, { selected: S.provider === 0 });
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
            ui.text('Streaming availability data provided by JustWatch.')
        );
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

    function detailView(ui) {
        var d = S.detail, it = d.item, info = d.info || {};
        var meta = [it.year || '', it.type === 'tv' ? 'TV show' : 'Movie'];
        if (it.rating) meta.push('★ ' + it.rating.toFixed(1) + ' (' + it.votes + ' votes)');
        if (info.runtime) meta.push(info.runtime + ' min');
        if (info.number_of_seasons) meta.push(info.number_of_seasons + (info.number_of_seasons === 1 ? ' season' : ' seasons'));
        var kids = [
            ui.button('← Back', function () { S.detail = null; }),
            ui.heading(it.title),
            ui.text(meta.filter(Boolean).join(' · '))
        ];
        if (owned(it)) kids.push(ui.text('✓ In your library'));
        if (info.tagline) kids.push(ui.text('“' + info.tagline + '”'));
        var overview = info.overview || it.overview;
        kids.push(ui.text(overview || (d.loading ? 'Loading…' : 'No description available.')));
        if (info.genres && info.genres.length) kids.push(ui.text('Genres: ' + info.genres.map(function (g) { return g.name; }).join(', ')));
        if (d.error) kids.push(ui.text(d.error));
        if (!d.loading && !d.error) {
            providerLine(info).forEach(function (l) { kids.push(ui.text(l)); });
        }
        kids.push(attribution(ui));
        return ui.column.apply(ui, kids);
    }

    function settingsView(ui) {
        var kids = [];
        kids.push(ui.heading('TMDb API key'));
        kids.push(ui.text(S.key
            ? 'A key is saved. Paste a new one below to replace it.'
            : 'This screen needs your own free TMDb key. Create one at themoviedb.org under Settings > API, then paste the "API Key" (v3) here. It is stored only inside this plugin on this device.'));
        kids.push(ui.textInput('API Key (v3)', S.keyDraft, function (v) { S.keyDraft = v; },
            { type: 'password', placeholder: '32-character key', onSubmit: saveKey }));
        kids.push(ui.row(
            ui.button('Save key', saveKey, { primary: true }),
            S.key ? ui.button('Remove key', removeKey) : null
        ));
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

    function searchView(ui) {
        var s = S.search;
        var kids = [ui.heading('Results for “' + s.term + '”')];
        if (s.loading) kids.push(ui.text('Searching…'));
        else if (s.error) kids.push(ui.text(s.error));
        else if (!s.items.length) kids.push(ui.text('No movies or TV shows found.'));
        else kids.push(ui.grid(s.items.map(function (it) { return poster(ui, it); }), { minColWidth: '150px' }));
        return ui.column.apply(ui, kids);
    }

    function browseView(ui) {
        if (S.authError) {
            return ui.column(
                ui.card('TMDb rejected your API key', 'Tap to open Settings and check it.', function () { selectTab('settings'); }));
        }
        var kids = [chips(ui)];
        sectionsFor(S.tab).forEach(function (sec) { kids.push(row(ui, sec)); });
        return ui.column.apply(ui, kids);
    }

    hesper.render(function (ui) {
        if (!S.ready) return ui.column(ui.text('Loading…'));
        if (S.detail) return detailView(ui);

        var tabs = ui.tabs([
            { id: 'movie', label: 'Movies' },
            { id: 'tv', label: 'TV Shows' },
            { id: 'settings', label: 'Settings' }
        ], S.tab, selectTab);

        var kids = [];
        if (S.tab !== 'settings') {
            kids.push(ui.textInput('', S.query, function (v) { S.query = v; },
                { placeholder: 'Search any movie or TV show', onSubmit: doSearch }));
            kids.push(ui.row(
                ui.button('Search', doSearch, { primary: true }),
                S.search ? ui.button('Clear search', clearSearch) : null,
                S.key ? ui.button('Refresh', refresh) : null
            ));
        }
        kids.push(tabs);

        if (S.tab === 'settings') kids.push(settingsView(ui));
        else if (!S.key) {
            kids.push(ui.card('Add your TMDb API key', 'Tap here to open Settings and paste it.', function () { selectTab('settings'); }));
        } else if (S.search) kids.push(searchView(ui));
        else kids.push(browseView(ui));

        if (S.tab !== 'settings') kids.push(attribution(ui));
        return ui.column.apply(ui, kids);
    });

    // ---------------------------------------------------------------- start
    function get(k) { return hesper.storage.get(k).then(function (v) { return v || ''; }, function () { return ''; }); }

    Promise.all([get('tmdb_key'), get('region'), readLibrary()]).then(function (r) {
        S.key = r[0];
        if (/^[A-Z]{2}$/.test(r[1])) S.region = r[1];
        S.regionDraft = S.region;
        S.tab = S.key ? 'movie' : 'settings';
        S.ready = true;
        ensureLoaded();
        redraw();
    });
})();
