/* Hesper watch history + cloud sync  (window.HesperSync)
 *
 * Local part: a permanent "watched" record (kept after resume points are gone).
 * Cloud part: optional sync of watch history AND resume positions between devices,
 * through the Hesper Cloud worker (cloud/worker.js). An account is just a secret
 * sync key made on the device; nothing is sent until the user links one.
 *
 * Items are matched across devices by title (not file id), so a movie or episode
 * is the same item on a phone and a TV even though the files are different.
 */
(function () {
    'use strict';

    var API = 'https://hesper-sync-9275.aquariusibeats.workers.dev';
    var K = {
        key: 'hesper_sync_key',
        cursor: 'hesper_sync_cursor_v1',
        last: 'hesper_sync_last_v1',
        seen: 'hesper_sync_seen_v1',       // what the cloud already has: { h:{key:updated}, p:{key:{u,d}} }
        pending: 'hesper_sync_pending_v1', // remote resume points whose file isn't on this device (yet)
        history: 'hesper_history_v1',
        progress: 'hesper_progress_v1'
    };
    var REWATCH_WINDOW = 12 * 60 * 60 * 1000;   // finishing the same thing again within 12h is one watch
    var CHUNK = 800;                            // items per sync request
    var MAX_ROUNDS = 20;

    var clock = { now: function () { return Date.now(); } };

    // ---------------- storage helpers ----------------
    function getRaw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
    function delRaw(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    function getJson(k, dflt) {
        try {
            var o = JSON.parse(getRaw(k) || 'null');
            return (o && typeof o === 'object') ? o : dflt;
        } catch (e) { return dflt; }
    }
    function setJson(k, o) { setRaw(k, JSON.stringify(o)); }

    // ---------------- identity of an item ----------------
    function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

    function histKey(meta) {
        if (!meta) return null;
        if (meta.kind === 'movie') {
            if (!norm(meta.title)) return null;
            return 'm|' + norm(meta.title) + '|' + (parseInt(meta.year, 10) || 0);
        }
        if (meta.kind === 'episode') {
            if (!norm(meta.showTitle)) return null;
            return 'e|' + norm(meta.showTitle) + '|' + (parseInt(meta.season, 10) || 0) + '|' + (parseInt(meta.episode, 10) || 0);
        }
        return null;
    }

    function identity(m) {
        return { kind: m.kind, title: m.title || '', year: m.year || 0, showTitle: m.showTitle || '', season: m.season || 0, episode: m.episode || 0 };
    }

    // ---------------- local watch history ----------------
    function readHistory() { return getJson(K.history, {}); }
    function writeHistory(map) { setJson(K.history, map); }

    // Called when something is watched to the end. Returns true if a new watch was recorded.
    function recordWatched(meta) {
        var key = histKey(meta);
        if (!key) return false;
        var now = clock.now();
        var map = readHistory();
        var old = map[key];
        var alive = old && !old.deleted;
        if (alive && now - old.watchedAt < REWATCH_WINDOW) return false;
        map[key] = Object.assign(identity(meta), { watchedAt: now, count: alive ? (old.count || 1) + 1 : 1, updated: now });
        writeHistory(map);
        return true;
    }

    // Newest first.
    function listHistory() {
        var map = readHistory();
        return Object.keys(map).map(function (k) { return Object.assign({ key: k }, map[k]); })
            .filter(function (e) { return !e.deleted; })
            .sort(function (a, b) { return (b.watchedAt || 0) - (a.watchedAt || 0); });
    }

    // Removes everything from the history (kept as a "deleted" marker so the removal syncs too).
    function clearHistory() {
        var now = clock.now();
        var map = readHistory();
        Object.keys(map).forEach(function (k) {
            if (!map[k].deleted) map[k] = { deleted: 1, updated: now };
        });
        writeHistory(map);
    }

    // ---------------- sync key ----------------
    var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    function newKey() {
        var bytes = new Uint8Array(25);
        crypto.getRandomValues(bytes);
        var s = '';
        for (var i = 0; i < 25; i++) {
            s += ALPHABET.charAt(bytes[i] % 32);     // 256 % 32 == 0, so no bias
            if (i % 5 === 4 && i < 24) s += '-';
        }
        return s;
    }
    function normKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
    function prettyKey(s) { return normKey(s).replace(/(.{5})(?=.)/g, '$1-'); }
    function validKey(s) { var k = normKey(s); return k.length >= 20 && k.length <= 64; }

    function getKey() { return getRaw(K.key) || ''; }
    function setKey(s) { setRaw(K.key, prettyKey(s)); }
    function lastSync() { return parseInt(getRaw(K.last), 10) || 0; }

    function unlink() {
        [K.key, K.cursor, K.last, K.seen, K.pending].forEach(delRaw);
    }

    // ---------------- network ----------------
    function request(method, path, body) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
        var opts = {
            method: method,
            headers: { 'Authorization': 'Bearer ' + getKey(), 'Content-Type': 'application/json' }
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        if (ctl) opts.signal = ctl.signal;
        return fetch(API + path, opts).then(function (res) {
            if (timer) clearTimeout(timer);
            return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, body: j }; });
        }, function (err) {
            if (timer) clearTimeout(timer);
            throw err;
        });
    }

    function failure(status, body) {
        if (status === 404) return 'no_account';
        if (status === 401) return 'bad_key';
        if (status === 413) return 'too_large';
        return (body && body.error) || 'server';
    }

    // ---------------- sync ----------------
    var inflight = null;

    function progressByKey(pmap) {
        var out = {};
        Object.keys(pmap).forEach(function (id) {
            var e = pmap[id];
            var k = histKey(e);
            if (!k) return;
            if (!out[k] || (e.updated || 0) > (out[k].entry.updated || 0)) out[k] = { id: id, entry: e };
        });
        return out;
    }

    function collectPush() {
        var seen = getJson(K.seen, { h: {}, p: {} });
        seen.h = seen.h || {}; seen.p = seen.p || {};
        var items = { history: [], progress: [] };

        var hmap = readHistory();
        Object.keys(hmap).forEach(function (k) {
            var e = hmap[k];
            if (seen.h[k] === e.updated) return;
            if (e.deleted) {
                items.history.push({ key: k, data: {}, updated: e.updated, deleted: 1 });
            } else {
                var d = Object.assign({}, e); delete d.updated; delete d.deleted;
                items.history.push({ key: k, data: d, updated: e.updated, deleted: 0 });
            }
        });

        var local = progressByKey(getJson(K.progress, {}));
        Object.keys(local).forEach(function (k) {
            var e = local[k].entry;
            var s = seen.p[k];
            if (s && !s.d && s.u === e.updated) return;
            var d = Object.assign(identity(e), { position: e.position || 0, duration: e.duration || 0 });
            items.progress.push({ key: k, data: d, updated: e.updated || clock.now(), deleted: 0 });
        });
        Object.keys(seen.p).forEach(function (k) {   // finished or removed here: tell the cloud
            if (!seen.p[k].d && !local[k]) items.progress.push({ key: k, data: {}, updated: clock.now(), deleted: 1 });
        });
        return items;
    }

    function takeChunk(all) {
        var chunk = { history: [], progress: [] };
        var room = CHUNK;
        ['history', 'progress'].forEach(function (kind) {
            var n = Math.min(room, all[kind].length);
            chunk[kind] = all[kind].splice(0, n);
            room -= n;
        });
        return chunk;
    }

    function markPushed(chunk) {
        var seen = getJson(K.seen, { h: {}, p: {} });
        seen.h = seen.h || {}; seen.p = seen.p || {};
        chunk.history.forEach(function (it) { seen.h[it.key] = it.updated; });
        chunk.progress.forEach(function (it) { seen.p[it.key] = { u: it.updated, d: it.deleted ? 1 : 0 }; });
        setJson(K.seen, seen);
    }

    // Merge what the cloud sent. opts.resolve(meta) -> Promise<local file id | null>.
    function applyRemote(resp, resolve) {
        var pending = getJson(K.pending, {});
        var remoteP = (resp.progress || []).slice();
        Object.keys(pending).forEach(function (k) {   // retry resume points that had no local file before
            if (!remoteP.some(function (r) { return r.key === k; })) remoteP.push(pending[k]);
        });

        // 1) look up local file ids (async) for live resume points we don't have yet
        var pmap0 = getJson(K.progress, {});
        var have = progressByKey(pmap0);
        var need = remoteP.filter(function (r) { return !r.deleted && !have[r.key]; });
        var resolved = {};
        var chain = Promise.resolve();
        need.forEach(function (r) {
            chain = chain.then(function () {
                if (!resolve) return null;
                return Promise.resolve(resolve(identity(r.data || {}))).then(function (id) { if (id) resolved[r.key] = id; }, function () { /* leave unresolved */ });
            });
        });

        return chain.then(function () {
            // 2) apply everything in one synchronous step (player may write progress meanwhile)
            var changed = false;
            var seen = getJson(K.seen, { h: {}, p: {} });
            seen.h = seen.h || {}; seen.p = seen.p || {};
            var hmap = readHistory();

            (resp.history || []).forEach(function (r) {
                var local = hmap[r.key];
                if (local && local.updated > r.updated) return;                 // ours is newer; it gets pushed
                if (!local || local.updated < r.updated) {
                    hmap[r.key] = r.deleted ? { deleted: 1, updated: r.updated } : Object.assign({}, r.data, { updated: r.updated });
                    changed = true;
                }
                seen.h[r.key] = r.updated;
            });
            writeHistory(hmap);

            var pmap = getJson(K.progress, {});
            var local = progressByKey(pmap);
            var newPending = {};
            remoteP.forEach(function (r) {
                var mine = local[r.key];
                if (r.deleted) {
                    if (mine && (mine.entry.updated || 0) >= r.updated) return;   // we resumed it later
                    if (mine) { delete pmap[mine.id]; changed = true; }
                    seen.p[r.key] = { u: r.updated, d: 1 };
                    return;
                }
                var h = hmap[r.key];
                if (h && !h.deleted && (h.watchedAt || 0) >= r.updated) return;    // finished since that position
                var data = r.data || {};
                if (mine) {
                    if (r.updated > (mine.entry.updated || 0)) {
                        pmap[mine.id] = Object.assign({}, mine.entry, { position: data.position || 0, duration: data.duration || 0, updated: r.updated });
                        changed = true;
                        seen.p[r.key] = { u: r.updated, d: 0 };
                    } else if (r.updated === (mine.entry.updated || 0)) {
                        seen.p[r.key] = { u: r.updated, d: 0 };
                    }
                    return;
                }
                var id = resolved[r.key];
                if (id) {
                    pmap[id] = Object.assign(identity(data), { id: id, position: data.position || 0, duration: data.duration || 0, updated: r.updated });
                    seen.p[r.key] = { u: r.updated, d: 0 };
                    changed = true;
                } else {
                    newPending[r.key] = r;
                }
            });
            setJson(K.progress, pmap);
            setJson(K.seen, seen);
            setJson(K.pending, newPending);
            return changed;
        });
    }

    // opts: { create: bool, resolve: fn }.  Resolves { ok, error?, pushed, changed }.
    function sync(opts) {
        opts = opts || {};
        if (inflight) return inflight;
        if (!getKey()) return Promise.resolve({ ok: false, error: 'not_linked' });

        var all = collectPush();
        var pushedCount = all.history.length + all.progress.length;
        var anyChange = false;

        function round(n, first) {
            var chunk = takeChunk(all);
            var cursor = parseInt(getRaw(K.cursor), 10) || 0;
            var body = { since: cursor, history: chunk.history, progress: chunk.progress };
            if (opts.create) body.create = true;
            return request('POST', '/v1/sync', body).then(function (r) {
                if (r.status !== 200 || !r.body || !r.body.ok) return { ok: false, error: failure(r.status, r.body) };
                markPushed(chunk);
                return applyRemote(r.body, opts.resolve).then(function (changed) {
                    if (changed) anyChange = true;
                    setRaw(K.cursor, String(r.body.cursor || cursor));
                    var morePush = all.history.length + all.progress.length > 0;
                    if ((r.body.more || morePush) && n < MAX_ROUNDS) return round(n + 1, false);
                    setRaw(K.last, String(clock.now()));
                    return { ok: true, pushed: pushedCount, changed: anyChange };
                });
            });
        }

        inflight = round(1, true).catch(function () { return { ok: false, error: 'offline' }; })
            .then(function (res) { inflight = null; return res; });
        return inflight;
    }

    // Permanently deletes the cloud account and all of its data, then unlinks this device.
    function deleteAccount() {
        if (!getKey()) return Promise.resolve({ ok: false, error: 'not_linked' });
        return request('DELETE', '/v1/account').then(function (r) {
            if (r.status !== 200) return { ok: false, error: failure(r.status, r.body) };
            unlink();
            return { ok: true };
        }).catch(function () { return { ok: false, error: 'offline' }; });
    }

    window.HesperSync = {
        histKey: histKey,
        recordWatched: recordWatched,
        listHistory: listHistory,
        clearHistory: clearHistory,
        newKey: newKey, normKey: normKey, prettyKey: prettyKey, validKey: validKey,
        getKey: getKey, setKey: setKey, lastSync: lastSync, unlink: unlink,
        sync: sync, deleteAccount: deleteAccount,
        isLinked: function () { return !!getKey(); },
        _setApi: function (u) { API = u; },
        _setClock: function (fn) { clock.now = fn; }
    };
})();
