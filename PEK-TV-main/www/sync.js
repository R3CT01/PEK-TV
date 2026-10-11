/* PEK TV watch history + cloud sync  (window.PekSync)
 *
 * Local part: a permanent "watched" record (kept after resume points are gone).
 * Cloud part: optional sync of watch history, resume positions AND favorites between devices,
 * through the Hesper Cloud worker (cloud/worker.js). An account is an email address and
 * a password; nothing is sent until the user signs in.
 *
 * Items are matched across devices by title (not file id), so a movie or episode
 * is the same item on a phone and a TV even though the files are different.
 */
(function () {
    'use strict';

    var API = 'https://pek-sync.aquariusibeats.workers.dev';
    var K = {
        token: 'hesper_sync_token',      // session token from signing in (never the password)
        email: 'hesper_sync_email',
        legacyKey: 'hesper_sync_key',    // the old 25-character key; removed on load
        cursor: 'hesper_sync_cursor_v1',
        last: 'hesper_sync_last_v1',
        seen: 'hesper_sync_seen_v1',       // what the cloud already has: { h:{key:updated}, p:{key:{u,d}}, f:{key:updated} }
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

    // ---------------- where something came from ----------------
    // Kept small: the cloud caps each history item at 2000 characters.
    //   lib   = 1 when it was played from a media library
    //   plug  = [{ id, name }] plugins that streamed it (max 4)
    //   image = artwork URL (poster or still) when one was known
    function cleanUrl(u) { u = String(u == null ? '' : u); return /^https?:\/\//i.test(u) && u.length <= 400 ? u : ''; }

    function sourceInfo(meta) {
        var out = { lib: 0, plug: [] };
        if (!meta) return out;
        var og = meta.origin && meta.origin.name ? meta.origin : null;
        if (og) out.plug.push({ id: String(og.id || '').slice(0, 80), name: String(og.name).slice(0, 60) });
        else if (meta.torrent) out.plug.push({ id: '', name: 'A plugin' });
        else out.lib = 1;
        return out;
    }

    // Joins what an entry already knows with new source info. Returns { fields, changed }.
    function mergeExtras(old, info, img) {
        old = old || {};
        var plug = [];
        (Array.isArray(old.plug) ? old.plug : []).concat(info && Array.isArray(info.plug) ? info.plug : []).forEach(function (p) {
            if (!p || typeof p !== 'object' || plug.length >= 4) return;
            var id = String(p.id || ''), name = String(p.name || '');
            if (!plug.some(function (q) { return q.id === id && (id || q.name === name); })) plug.push({ id: id.slice(0, 80), name: name.slice(0, 60) });
        });
        var fields = {};
        if (old.lib || (info && info.lib)) fields.lib = 1;
        if (plug.length) fields.plug = plug;
        var image = cleanUrl(img) || cleanUrl(old.image);
        if (image) fields.image = image;
        var before = JSON.stringify({ lib: old.lib ? 1 : undefined, plug: Array.isArray(old.plug) && old.plug.length ? old.plug : undefined, image: old.image || undefined });
        return { fields: fields, changed: JSON.stringify(fields) !== before };
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
        var info = sourceInfo(meta), img = meta.image;
        if (alive && now - old.watchedAt < REWATCH_WINDOW) {
            // Same watch, but it may tell us something new (seen in a plugin as well as the library, artwork found ...).
            var mx = mergeExtras(old, info, img);
            if (mx.changed) {
                map[key] = Object.assign({}, old, mx.fields, { updated: now });
                writeHistory(map);
                try { document.dispatchEvent(new CustomEvent('pek-history')); } catch (e) { /* no events */ }
            }
            return false;
        }
        map[key] = Object.assign(identity(meta), mergeExtras(alive ? old : null, info, img).fields,
            { watchedAt: now, count: alive ? (old.count || 1) + 1 : 1, updated: now });
        writeHistory(map);
        try { document.dispatchEvent(new CustomEvent('pek-history')); } catch (e) { /* no events */ }   // lets the app sync soon
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

    // ---------------- account (email + password) ----------------
    function cleanEmail(s) { return String(s || '').trim().toLowerCase(); }
    function validEmail(s) { var e = cleanEmail(s); return e.length >= 5 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
    function validPassword(s) { return typeof s === 'string' && s.length >= 8 && s.length <= 200; }

    function getToken() { return getRaw(K.token) || ''; }
    function getEmail() { return getRaw(K.email) || ''; }
    function lastSync() { return parseInt(getRaw(K.last), 10) || 0; }

    // Forget what we know about the cloud (cursor, what was already uploaded). Local history stays.
    function resetSyncState() {
        var HP = window.PekProfiles;
        if (HP && HP.clearSyncState) HP.clearSyncState();   // every profile's sync progress, not only the active one's
        [K.cursor, K.last, K.seen, K.pending].forEach(delRaw);
    }
    // Starts a signed-in session. Sync state is reset so this account gets a full two-way merge.
    function startSession(token, email) {
        resetSyncState();
        setRaw(K.token, token);
        setRaw(K.email, email);
    }
    // Signs this device out locally. Watch history and resume points on the device are kept.
    function unlink() {
        resetSyncState();
        [K.token, K.email].forEach(delRaw);
    }

    // The old key-based accounts no longer exist; drop the stale key.
    delRaw(K.legacyKey);

    // ---------------- network ----------------
    function request(method, path, body, withToken) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
        var headers = { 'Content-Type': 'application/json' };
        if (withToken) headers['Authorization'] = 'Bearer ' + getToken();
        var opts = { method: method, headers: headers };
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

    // Short error code for the screen to turn into words.
    function failure(status, body) {
        var e = body && body.error;
        if (status === 401 && e === 'bad_session') return 'session_expired';
        if (status === 401 && !e) return 'session_expired';
        if (status === 413) return 'too_large';
        if (status === 429) return 'rate_limited';
        return e || 'server';
    }

    // ---------------- sign up / sign in / reset ----------------
    function authCall(path, body) {
        return request('POST', path, body, false).then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) return { ok: true, body: r.body };
            return { ok: false, error: failure(r.status, r.body) };
        }, function () { return { ok: false, error: 'offline' }; });
    }
    function authSession(path, body) {
        return authCall(path, body).then(function (res) {
            if (!res.ok) return res;
            if (res.body.needsVerify) return { ok: true, needsVerify: true };   // account made; email code still to enter
            if (!res.body.token) return { ok: false, error: 'server' };
            startSession(res.body.token, res.body.email || cleanEmail(body.email));
            return { ok: true };
        });
    }
    function signUp(email, password) {
        if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'bad_email' });
        if (!validPassword(password)) return Promise.resolve({ ok: false, error: 'weak_password' });
        return authSession('/v1/auth/signup', { email: cleanEmail(email), password: password });
    }
    // Finishes sign-up with the 6-digit code from the email, and signs this device in.
    function verifyEmail(email, code) {
        if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'bad_email' });
        return authSession('/v1/auth/verify', { email: cleanEmail(email), code: String(code || '').replace(/\D/g, '') });
    }
    // Emails a new verification code (the server answers "ok" either way).
    function resendCode(email) {
        if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'bad_email' });
        return authCall('/v1/auth/resend', { email: cleanEmail(email) }).then(function (res) { return res.ok ? { ok: true } : res; });
    }
    function signIn(email, password) {
        if (!validEmail(email) || !password) return Promise.resolve({ ok: false, error: 'bad_credentials' });
        return authSession('/v1/auth/login', { email: cleanEmail(email), password: password });
    }
    // Emails a 6-digit code. The server answers "ok" whether or not the address has an account.
    function forgotPassword(email) {
        if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'bad_email' });
        return authCall('/v1/auth/forgot', { email: cleanEmail(email) }).then(function (res) { return res.ok ? { ok: true } : res; });
    }
    // Sets a new password using the emailed code, and signs this device in.
    function resetPassword(email, code, password) {
        if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'bad_email' });
        if (!validPassword(password)) return Promise.resolve({ ok: false, error: 'weak_password' });
        return authSession('/v1/auth/reset', { email: cleanEmail(email), code: String(code || '').replace(/\D/g, ''), password: password });
    }
    // Signs out here and (best effort) ends the session on the server.
    function signOut() {
        var had = !!getToken();
        var done = function () { unlink(); return { ok: true }; };
        if (!had) return Promise.resolve(done());
        return request('POST', '/v1/auth/logout', {}, true).then(done, done);
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
        var items = { history: [], progress: [], favorites: [] };
        seen.f = seen.f || {};

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

        var FV = window.PekFavorites;
        if (FV && FV.snapshot) {
            var snap = FV.snapshot();
            snap.items.forEach(function (f) {
                if (seen.f[f.key] === f.updated) return;
                var d = Object.assign({}, f); delete d.key; delete d.updated;
                items.favorites.push({ key: 'f|' + f.key, data: d, updated: f.updated, deleted: 0 });
            });
            Object.keys(snap.tombs).forEach(function (k) {   // removed here: tell the cloud
                if (seen.f[k] === snap.tombs[k]) return;
                items.favorites.push({ key: 'f|' + k, data: {}, updated: snap.tombs[k], deleted: 1 });
            });
        }
        return items;
    }

    function takeChunk(all) {
        var chunk = { history: [], progress: [], favorites: [] };
        var room = CHUNK;
        ['history', 'progress', 'favorites'].forEach(function (kind) {
            var n = Math.min(room, all[kind].length);
            chunk[kind] = all[kind].splice(0, n);
            room -= n;
        });
        return chunk;
    }

    function markPushed(chunk) {
        var seen = getJson(K.seen, { h: {}, p: {} });
        seen.h = seen.h || {}; seen.p = seen.p || {}; seen.f = seen.f || {};
        chunk.favorites.forEach(function (it) { seen.f[it.key.slice(2)] = it.updated; });
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
                    var next = r.deleted ? { deleted: 1, updated: r.updated } : Object.assign({}, r.data, { updated: r.updated });
                    // Keep what this device knew about where it came from (library AND plugin stay listed).
                    if (!r.deleted && local && !local.deleted) {
                        var rd = r.data || {};
                        Object.assign(next, mergeExtras(local, { lib: rd.lib ? 1 : 0, plug: Array.isArray(rd.plug) ? rd.plug : [] }, rd.image).fields);
                    }
                    hmap[r.key] = next;
                    changed = true;
                }
                seen.h[r.key] = r.updated;
            });
            writeHistory(hmap);

            var FV = window.PekFavorites;
            if (FV && FV.merge && (resp.favorites || []).length) {
                seen.f = seen.f || {};
                var fres = FV.merge(resp.favorites.map(function (r) {
                    return { key: String(r.key).slice(2), data: r.data, updated: r.updated, deleted: r.deleted };
                }));
                var byKey = {};
                resp.favorites.forEach(function (r) { byKey[String(r.key).slice(2)] = r.updated; });
                fres.settled.forEach(function (k) { seen.f[k] = byKey[k]; });
                if (fres.changed) changed = true;
            }

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

    // ---------------- profiles ----------------
    // The account belongs to the device; each profile (profiles.js) syncs its own favorites, history and resume points.
    // The original profile "p1" lives where an account's data always lived, so existing accounts need no migration.
    function currentProfile() {
        var HP = window.PekProfiles, c = HP && HP.enabled && HP.current ? HP.current() : null;
        return c ? c.id : 'p1';
    }

    // Tells the cloud about this device's profiles and takes in the household's (names, colours, additions, removals).
    function syncProfiles() {
        var HP = window.PekProfiles;
        if (!HP || !HP.enabled || !HP.snapshot) return Promise.resolve({ ok: true });
        var snap = HP.snapshot();
        var list = snap.list.map(function (p) { return { id: p.id, name: p.name, color: p.color, updated: p.updated || 0, deleted: 0 }; });
        Object.keys(snap.tombs).forEach(function (id) { list.push({ id: id, name: '', color: '', updated: snap.tombs[id], deleted: 1 }); });
        return request('POST', '/v1/profiles/sync', { profiles: list }, true).then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) { HP.mergeRemote(r.body.profiles || []); return { ok: true }; }
            return { ok: false, status: r.status, error: failure(r.status, r.body) };
        });
    }

    // opts: { resolve: fn }.  Resolves { ok, error?, pushed, changed }.
    function sync(opts) {
        opts = opts || {};
        if (inflight) return inflight;
        if (!getToken()) return Promise.resolve({ ok: false, error: 'not_linked' });

        var pid = currentProfile();
        var all, pushedCount, anyChange;

        function round(n, first) {
            var chunk = takeChunk(all);
            var cursor = parseInt(getRaw(K.cursor), 10) || 0;
            var body = { profile: pid, since: cursor, history: chunk.history, progress: chunk.progress, favorites: chunk.favorites };
            return request('POST', '/v1/sync', body, true).then(function (r) {
                if (r.status === 404 && r.body && r.body.error === 'unknown_profile') return { ok: false, error: 'unknown_profile' };
                if (r.status !== 200 || !r.body || !r.body.ok) return { ok: false, error: failure(r.status, r.body) };
                // An older cloud service ignores "profile" and would mix everybody's data into one: only the original profile may talk to it.
                if (pid !== 'p1' && r.body.profile !== pid) return { ok: false, error: 'cloud_outdated' };
                markPushed(chunk);
                return applyRemote(r.body, opts.resolve).then(function (changed) {
                    if (changed) anyChange = true;
                    setRaw(K.cursor, String(r.body.cursor || cursor));
                    var morePush = all.history.length + all.progress.length + all.favorites.length > 0;
                    if ((r.body.more || morePush) && n < MAX_ROUNDS) return round(n + 1, false);
                    setRaw(K.last, String(clock.now()));
                    return { ok: true, pushed: pushedCount, changed: anyChange };
                });
            });
        }

        function attempt(retried) {
            return syncProfiles().then(function (pr) {
                if (!pr.ok) {
                    if (pr.error === 'session_expired' || pr.error === 'rate_limited') return pr;
                    // No profile support in the cloud yet: the original profile still works, the others must wait.
                    if (pid !== 'p1') return { ok: false, error: pr.status === 404 ? 'cloud_outdated' : pr.error };
                }
                all = collectPush();
                pushedCount = all.history.length + all.progress.length + all.favorites.length;
                anyChange = false;
                return round(1, true);
            }).then(function (res) {
                if (res && res.error === 'unknown_profile' && !retried) {
                    // Removed on another device, but in use here: keep it (the newer change wins) and try once more.
                    var HP = window.PekProfiles;
                    if (HP && HP.touch) HP.touch(pid);
                    return attempt(true);
                }
                return res;
            });
        }

        inflight = attempt(false).catch(function () { return { ok: false, error: 'offline' }; })
            .then(function (res) {
                inflight = null;
                if (res && res.error === 'session_expired') unlink();   // signed out elsewhere or expired: ask the user to sign in again
                return res;
            });
        return inflight;
    }

    // Lets other parts of PEK TV (the plugin backup) talk to the cloud with this session.
    // Resolves { ok, body } or { ok: false, error }, and signs the device out if the session is gone.
    function cloud(method, path, body) {
        if (!getToken()) return Promise.resolve({ ok: false, error: 'not_linked' });
        return request(method, path, body, true).then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) return { ok: true, body: r.body };
            var e = failure(r.status, r.body);
            if (e === 'session_expired') unlink();
            return { ok: false, error: e };
        }, function () { return { ok: false, error: 'offline' }; });
    }

    // Permanently deletes the cloud account and all of its data, then signs this device out.
    function deleteAccount() {
        if (!getToken()) return Promise.resolve({ ok: false, error: 'not_linked' });
        return request('DELETE', '/v1/account', undefined, true).then(function (r) {
            if (r.status !== 200) return { ok: false, error: failure(r.status, r.body) };
            unlink();
            return { ok: true };
        }).catch(function () { return { ok: false, error: 'offline' }; });
    }

    window.PekSync = {
        histKey: histKey,
        recordWatched: recordWatched,
        listHistory: listHistory,
        clearHistory: clearHistory,
        validEmail: validEmail, validPassword: validPassword,
        signUp: signUp, signIn: signIn, signOut: signOut,
        verifyEmail: verifyEmail, resendCode: resendCode,
        forgotPassword: forgotPassword, resetPassword: resetPassword,
        getEmail: getEmail, lastSync: lastSync, unlink: unlink,
        sync: sync, deleteAccount: deleteAccount, cloud: cloud,
        isLinked: function () { return !!getToken(); },
        _setApi: function (u) { API = u; },
        _setClock: function (fn) { clock.now = fn; }
    };
})();
