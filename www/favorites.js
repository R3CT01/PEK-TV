/* Hesper favorites  (window.HesperFavorites)
 *
 * One list for the whole app: TMDb Discover, Snake Skin (any plugin with the "favorites"
 * permission) add titles here, and the Favorites tab shows them.
 *
 * Plugins never touch this storage directly. plugin_sandbox.js passes their requests through
 * add() / remove() / keys(), and every entry is cleaned here: only a TMDb type + id, a title,
 * a year and a poster *path* are kept. The poster address is built by Hesper (image.tmdb.org),
 * so a plugin cannot make the Favorites tab load a picture from anywhere else.
 */
(function () {
    'use strict';

    var KEY = 'hesper_favorites_v1';
    var MAX = 500;
    var POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
    var cache = null;

    function read() {
        if (cache) return cache;
        var list = [];
        try {
            var raw = JSON.parse(localStorage.getItem(KEY) || '[]');
            if (Array.isArray(raw)) list = raw.map(clean).filter(Boolean);
        } catch (e) { /* unreadable: start empty */ }
        cache = list;
        return cache;
    }

    function write(list) {
        cache = list;
        try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage full or blocked: kept for this session */ }
        try { document.dispatchEvent(new CustomEvent('hesper-favorites')); } catch (e) { /* no events */ }
    }

    function str(v, max) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''; }

    // Returns a safe entry, or null when the request is not a usable title.
    function clean(r) {
        if (!r || typeof r !== 'object') return null;
        var type = r.type === 'tv' ? 'tv' : (r.type === 'movie' ? 'movie' : '');
        var id = Math.floor(Number(r.id));
        var title = str(r.title, 200);
        if (!type || !(id > 0) || id > 1e9 || !title) return null;
        var year = Math.floor(Number(r.year));
        var poster = typeof r.posterPath === 'string' && /^\/[A-Za-z0-9_-]{5,80}\.(jpg|jpeg|png|webp)$/.test(r.posterPath) ? r.posterPath : '';
        var from = Array.isArray(r.from) ? r.from.filter(function (f) { return typeof f === 'string' && /^[a-z0-9_-]{1,80}$/.test(f); }).slice(0, 6) : [];
        return {
            key: type + ':' + id, type: type, id: id, title: title,
            year: year > 1800 && year < 3000 ? year : 0,
            posterPath: poster, from: from,
            added: Number(r.added) > 0 ? Number(r.added) : Date.now()
        };
    }

    window.HesperFavorites = {
        /** Newest first. */
        list: function () { return read().slice().sort(function (a, b) { return b.added - a.added; }); },
        keys: function () { return read().map(function (f) { return f.key; }); },
        has: function (key) { return read().some(function (f) { return f.key === key; }); },
        posterUrl: function (f) { return f && f.posterPath ? POSTER_BASE + f.posterPath : ''; },

        /** `source` is the plugin folder that asked (set by Hesper, not by the plugin). */
        add: function (raw, source) {
            var e = clean(raw);
            if (!e) throw new Error('not a usable title');
            var list = read().slice();
            var i = list.findIndex(function (f) { return f.key === e.key; });
            var src = typeof source === 'string' && /^[a-z0-9_-]{1,80}$/.test(source) ? source : '';
            if (i >= 0) {
                // Already a favorite: remember one more place it can be opened from, fill in a missing poster.
                var cur = list[i];
                if (src && cur.from.indexOf(src) < 0) cur.from = cur.from.concat(src).slice(-6);
                if (!cur.posterPath && e.posterPath) cur.posterPath = e.posterPath;
                if (!cur.year && e.year) cur.year = e.year;
                write(list);
                return true;
            }
            if (list.length >= MAX) throw new Error('favorites are full (' + MAX + ')');
            e.from = src ? [src] : [];
            e.added = Date.now();
            list.push(e);
            write(list);
            return true;
        },

        remove: function (key) {
            var list = read().filter(function (f) { return f.key !== key; });
            if (list.length !== read().length) write(list);
            return true;
        }
    };
})();
