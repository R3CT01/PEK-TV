/* PEK favorites  (window.HesperFavorites)
 *
 * One list for the whole app: PEK Discover, Snake Skin (any plugin with the "favorites"
 * permission) add titles here, and the Favorites tab shows them.
 *
 * Plugins never touch this storage directly. plugin_sandbox.js passes their requests through
 * add() / remove() / keys(), and every entry is cleaned here: only a TMDb type + id, a title,
 * a year and a poster *path* are kept. The poster address is built by PEK (image.tmdb.org),
 * so a plugin cannot make the Favorites tab load a picture from anywhere else.
 */
(function () {
    'use strict';

    var KEY = 'hesper_favorites_v1';
    var TOMB = 'hesper_favorites_tomb_v1';   // { key: time removed }: lets a removal reach the cloud and other devices
    var MAX_TOMBS = 1000;
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

    function readTombs() {
        try {
            var o = JSON.parse(localStorage.getItem(TOMB) || '{}');
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
        } catch (e) { return {}; }
    }
    function writeTombs(t) {
        var keys = Object.keys(t);
        if (keys.length > MAX_TOMBS) {   // keep the newest
            keys.sort(function (a, b) { return t[b] - t[a]; }).slice(MAX_TOMBS).forEach(function (k) { delete t[k]; });
        }
        try { localStorage.setItem(TOMB, JSON.stringify(t)); } catch (e) { /* storage full or blocked */ }
    }

    // `remote` = the change came from the cloud, so the app should refresh but not sync again.
    function write(list, remote) {
        cache = list;
        try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* storage full or blocked: kept for this session */ }
        try { document.dispatchEvent(new CustomEvent('hesper-favorites', { detail: { remote: !!remote } })); } catch (e) { /* no events */ }
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
            added: Number(r.added) > 0 ? Number(r.added) : Date.now(),
            updated: Number(r.updated) > 0 ? Number(r.updated) : (Number(r.added) > 0 ? Number(r.added) : Date.now())
        };
    }

    window.HesperFavorites = {
        /** Newest first. */
        list: function () { return read().slice().sort(function (a, b) { return b.added - a.added; }); },
        keys: function () { return read().map(function (f) { return f.key; }); },
        has: function (key) { return read().some(function (f) { return f.key === key; }); },
        posterUrl: function (f) { return f && f.posterPath ? POSTER_BASE + f.posterPath : ''; },

        /** `source` is the plugin folder that asked (set by PEK, not by the plugin). */
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
                cur.updated = Date.now();
                write(list);
                return true;
            }
            if (list.length >= MAX) throw new Error('favorites are full (' + MAX + ')');
            e.from = src ? [src] : [];
            e.added = Date.now();
            e.updated = e.added;
            list.push(e);
            var tombs = readTombs();
            if (tombs[e.key]) { delete tombs[e.key]; writeTombs(tombs); }   // re-added after a removal
            write(list);
            return true;
        },

        remove: function (key) {
            var list = read().filter(function (f) { return f.key !== key; });
            if (list.length !== read().length) {
                var tombs = readTombs();
                tombs[key] = Date.now();
                writeTombs(tombs);
                write(list);
            }
            return true;
        },

        /** For cloud sync (sync.js): a copy of the list plus the removal markers. */
        snapshot: function () {
            return { items: read().map(function (f) { return Object.assign({}, f); }), tombs: readTombs() };
        },

        /** For cloud sync: merge what the cloud sent ([{key:'movie:603', data, updated, deleted}]).
         *  The newer side wins per title. Returns { changed, settled: [keys the cloud and this device now agree on] }. */
        merge: function (remote) {
            var list = read().slice(), tombs = readTombs(), changed = false, settled = [];
            (remote || []).forEach(function (r) {
                var i = list.findIndex(function (f) { return f.key === r.key; });
                var local = i >= 0 ? list[i] : null;
                var tomb = tombs[r.key] || 0;
                if (r.deleted) {
                    if (local && (local.updated || 0) > r.updated) return;      // re-added here later: ours wins and gets pushed
                    if (local) { list.splice(i, 1); changed = true; }
                    if (tomb < r.updated) tombs[r.key] = r.updated;
                    settled.push(r.key);
                    return;
                }
                if (tomb > r.updated) return;                                   // removed here later: ours wins and gets pushed
                var e = clean(Object.assign({}, r.data || {}, { updated: r.updated }));
                if (!e || e.key !== r.key) { settled.push(r.key); return; }     // not a usable entry: ignore it
                if (!local) {
                    if (list.length >= MAX) return;
                    list.push(e);
                    delete tombs[r.key];
                    changed = true;
                    settled.push(r.key);
                    return;
                }
                if ((local.updated || 0) > r.updated) return;                   // ours is newer
                if ((local.updated || 0) < r.updated) {
                    e.from = (local.from || []).concat(e.from).filter(function (v, n, a) { return a.indexOf(v) === n; }).slice(-6);
                    list[i] = e;
                    changed = true;
                }
                settled.push(r.key);
            });
            writeTombs(tombs);
            if (changed) write(list, true);
            return { changed: changed, settled: settled };
        }
    };
})();
