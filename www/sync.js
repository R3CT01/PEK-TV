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
        username: 'hesper_sync_username',
        legacyKey: 'hesper_sync_key',    // the old 25-character key; removed on load
        cursor: 'hesper_sync_cursor_v1',
        last: 'hesper_sync_last_v1',
        seen: 'hesper_sync_seen_v1',       // what the cloud already has: { h:{key:updated}, p:{key:{u,d}}, f:{key:updated} }
        pending: 'hesper_sync_pending_v1', // remote resume points whose file isn't on this device (yet)
        history: 'hesper_history_v1',
        progress: 'hesper_progress_v1',
        setmeta: 'hesper-settings-meta'    // per profile: what each synced setting looked like at its last change { name: { v, u } }
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

    // ---------------- resume points from plugin streams ----------------
    // A plugin stream has no file in the library, so the other device needs the stream's source (magnet / https link)
    // to start it again. Kept small: the cloud caps each item at 2000 characters, so long magnet links lose their
    // tracker list (the hash is what matters) and anything still too big is simply not synced.
    var TOR_MAX_SOURCE = 900;
    var DATA_BUDGET = 1900;
    function shrinkSource(src) {
        src = String(src == null ? '' : src).trim();
        if (src.length > TOR_MAX_SOURCE && /^magnet:/i.test(src)) {
            src = src.split('&').filter(function (p, i) { return i === 0 || !/^tr=/i.test(p); }).join('&');
        }
        if (!src || src.length > TOR_MAX_SOURCE) return '';
        return (/^magnet:\?/i.test(src) || /^https:\/\//i.test(src)) ? src : '';
    }
    function cleanTorrent(t) {
        if (!t || typeof t !== 'object') return null;
        var source = shrinkSource(t.source);
        if (!source) return null;
        return { source: source, title: String(t.title || '').slice(0, 200), season: parseInt(t.season, 10) || 0, episode: parseInt(t.episode, 10) || 0 };
    }
    function cleanOrigin(o) {
        if (!o || typeof o !== 'object' || !o.name) return null;
        return { id: String(o.id || '').slice(0, 80), name: String(o.name).slice(0, 60) };
    }

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
    function getUsername() { return getRaw(K.username) || ''; }
    function lastSync() { return parseInt(getRaw(K.last), 10) || 0; }

    // Forget what we know about the cloud (cursor, what was already uploaded). Local history stays.
    function resetSyncState() {
        var HP = window.PekProfiles;
        if (HP && HP.clearSyncState) HP.clearSyncState();   // every profile's sync progress, not only the active one's
        [K.cursor, K.last, K.seen, K.pending].forEach(delRaw);
    }
    // Starts a signed-in session. Sync state is reset so this account gets a full two-way merge.
    function startSession(token, email, username) {
        resetSyncState();
        setRaw(K.token, token);
        setRaw(K.email, email);
        if (username) setRaw(K.username, username); else delRaw(K.username);
    }
    // Signs this device out locally. Watch history and resume points on the device are kept.
    function unlink() {
        resetSyncState();
        [K.token, K.email, K.username].forEach(delRaw);
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
            startSession(res.body.token, res.body.email || cleanEmail(body.email), res.body.username);
            return { ok: true };
        });
    }
    function signUp(email, password, invite, username) {
        if (!validEmail(email)) return Promise.resolve({ ok: false, error: 'bad_email' });
        if (!validPassword(password)) return Promise.resolve({ ok: false, error: 'weak_password' });
        var body = { email: cleanEmail(email), password: password };
        if (invite && String(invite).trim()) body.invite = String(invite).trim();   // only needed while the cloud is invite-only
        if (username && String(username).trim()) body.username = String(username).trim();
        return authSession('/v1/auth/signup', body);
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
    // The account's profiles as the cloud has them (sends none of ours). Resolves { ok, profiles } or { ok: false, error }.
    function peekProfiles() {
        if (!getToken()) return Promise.resolve({ ok: false, error: 'not_linked' });
        return request('POST', '/v1/profiles/sync', { profiles: [] }, true).then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) return { ok: true, profiles: r.body.profiles || [] };
            return { ok: false, error: failure(r.status, r.body) };
        }, function () { return { ok: false, error: 'offline' }; });
    }

    // Checks the account password against the cloud for the current session (used to reset a forgotten profile passcode).
    // Resolves { ok } or { ok: false, error }  ('bad_credentials', 'rate_limited', 'offline', 'not_found' on an older cloud service ...).
    function confirmPassword(password) {
        if (!getToken()) return Promise.resolve({ ok: false, error: 'not_linked' });
        if (!password) return Promise.resolve({ ok: false, error: 'bad_credentials' });
        return request('POST', '/v1/auth/confirm', { password: String(password).slice(0, 200) }, true).then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) return { ok: true };
            if (r.status === 401 && r.body && r.body.error === 'bad_credentials') return { ok: false, error: 'bad_credentials' };
            if (r.status === 404) return { ok: false, error: 'not_found' };
            return { ok: false, error: failure(r.status, r.body) };
        }, function () { return { ok: false, error: 'offline' }; });
    }
    // Signs out here and (best effort) ends the session on the server.
    function signOut() {
        var had = !!getToken();
        var done = function () { unlink(); return { ok: true }; };
        if (!had) return Promise.resolve(done());
        return request('POST', '/v1/auth/logout', {}, true).then(done, done);
    }

    // ---------------- sync ----------------
    // ---------------- settings (dashboard layout, look, weather city) ----------------
    // Small saved choices that follow the profile to other devices. Each one is a single synced item (s|dashboard, s|look,
    // s|weather), last writer wins. localStorage has no change times, so a change is noticed by comparing the stored value
    // with what it was at the last sync and stamped with the time it was noticed. A value that was already on the device
    // before it ever synced gets the oldest possible stamp (BASE_TS): it is uploaded when the cloud has nothing, and it
    // loses to anything already in the cloud (signing in to an existing account brings that account's choices).
    // Not synced: skins and colours (theme), and defaults that were never changed.
    var BASE_TS = 1;
    var SKEYS = ['dashboard', 'look', 'weather'];
    var settingsApplied = false;

    function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
    function parseStored(k) { try { return JSON.parse(getRaw(k) || 'null'); } catch (e) { return null; } }

    var DASH_TYPES = { clock: 1, weather: 1, 'continue': 1, recent: 1, favorites: 1, plugin: 1 };
    function cleanDash(o) {
        var raw = o && Array.isArray(o.list) ? o.list : null;
        if (!raw) return null;
        var seen = {}, out = [];
        raw.forEach(function (w) {
            if (!w || typeof w.type !== 'string' || !has(DASH_TYPES, w.type) || out.length >= 40) return;
            var folder = w.type === 'plugin' ? String(w.folder || '') : '';
            if (w.type === 'plugin' && !/^[A-Za-z0-9_-]{1,80}$/.test(folder)) return;
            var id = w.type === 'plugin' ? 'plugin:' + folder : w.type;
            if (seen[id]) return;
            seen[id] = 1;
            var e = { id: id, type: w.type, size: w.size === 'm' ? 'm' : 's' };
            if (folder) e.folder = folder;
            out.push(e);
        });
        while (out.length && JSON.stringify({ list: out }).length > DATA_BUDGET) out.pop();
        return { list: out };
    }
    function cleanLook(o) {
        if (!o || typeof o !== 'object') return null;
        var out = {};
        if (['classic', 'topbar', 'wall', 'compact'].indexOf(o.layout) >= 0) out.layout = o.layout;
        if (['auto', 's', 'm', 'l'].indexOf(o.poster) >= 0) out.poster = o.poster;
        if (['grid', 'list'].indexOf(o.view) >= 0) out.view = o.view;
        return Object.keys(out).length ? out : null;
    }
    function cleanWeather(o) {
        if (!o || typeof o !== 'object') return null;
        var out = {}, c = o.coords;
        if (c && typeof c === 'object' && typeof c.lat === 'number' && typeof c.lon === 'number' && isFinite(c.lat) && isFinite(c.lon) &&
            Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 && typeof c.label === 'string' && c.label && c.label.length <= 120) {
            out.coords = { lat: c.lat, lon: c.lon, label: c.label };
        }
        if (typeof o.city === 'string' && o.city && o.city.length <= 120) out.city = o.city;
        if (o.unit === 'F' || o.unit === 'C') out.unit = o.unit;
        return (out.coords || out.city || out.unit) ? out : null;
    }

    // read() = what this device has now (null when nothing was ever chosen); write() puts a cleaned value on this device.
    var SETTINGS = {
        dashboard: {
            clean: cleanDash,
            read: function () {
                var raw = parseStored('hesper-dashboard');
                return Array.isArray(raw) ? cleanDash({ list: raw }) : null;
            },
            write: function (o) { setRaw('hesper-dashboard', JSON.stringify(o.list)); }
        },
        look: {
            clean: cleanLook,
            read: function () { return cleanLook({ layout: getRaw('hesper-layout'), poster: getRaw('hesper-poster-size'), view: getRaw('hesper-view') }); },
            write: function (o) {
                if (o.layout) setRaw('hesper-layout', o.layout);
                if (o.poster) setRaw('hesper-poster-size', o.poster);
                if (o.view) setRaw('hesper-view', o.view);
            }
        },
        weather: {
            clean: cleanWeather,
            read: function () { return cleanWeather({ coords: parseStored('pek_weather_coords'), city: getRaw('pek_weather_city'), unit: getRaw('pek_weather_unit') }); },
            write: function (o) {
                var before = getRaw('pek_weather_city');
                if (o.coords) setRaw('pek_weather_coords', JSON.stringify(o.coords));
                var city = o.city || (o.coords && o.coords.label) || '';
                if (city) setRaw('pek_weather_city', city);
                if (o.unit) setRaw('pek_weather_unit', o.unit);
                // A different city: drop the old city's reading so the header badge doesn't show it until the new one loads.
                if (city && city !== before) delRaw('pek_weather_current_temp');
            }
        }
    };

    // Notices changes made on this device since the last look and stamps them. Returns { name: { v, u } }.
    function trackSettings() {
        var meta = getJson(K.setmeta, {}), changed = false, now = clock.now();
        SKEYS.forEach(function (n) {
            var o = SETTINGS[n].read();
            var cur = o ? JSON.stringify(o) : '';
            if (!cur) return;                                   // nothing chosen on this device: nothing to sync
            var m = meta[n];
            if (!m || typeof m.v !== 'string') { meta[n] = { v: cur, u: BASE_TS }; changed = true; }
            else if (m.v !== cur) { meta[n] = { v: cur, u: now }; changed = true; }
        });
        if (changed) setJson(K.setmeta, meta);
        return meta;
    }

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
        var items = { history: [], progress: [], favorites: [], settings: [] };
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
            var tor = cleanTorrent(e.torrent);
            if (tor) {   // a plugin stream: send what another device needs to start it again
                d.torrent = tor;
                var og = cleanOrigin(e.origin); if (og) d.origin = og;
                var im = cleanUrl(e.image); if (im) d.image = im;
                if (JSON.stringify(d).length > DATA_BUDGET) delete d.image;
                if (JSON.stringify(d).length > DATA_BUDGET) d.torrent.title = '';
                if (JSON.stringify(d).length > DATA_BUDGET) { delete d.torrent; delete d.origin; }
            }
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
        seen.s = seen.s || {};
        var smeta = trackSettings();
        SKEYS.forEach(function (n) {
            var m = smeta[n];
            if (!m || seen.s[n] === m.u) return;
            var o = SETTINGS[n].read();
            if (o) items.settings.push({ key: 's|' + n, data: o, updated: m.u, deleted: 0 });
        });
        return items;
    }

    function takeChunk(all) {
        var chunk = { history: [], progress: [], favorites: [], settings: [] };
        var room = CHUNK;
        ['history', 'progress', 'favorites', 'settings'].forEach(function (kind) {
            var n = Math.min(room, all[kind].length);
            chunk[kind] = all[kind].splice(0, n);
            room -= n;
        });
        return chunk;
    }

    // settingsStored: the cloud answered with a settings list, so it is new enough to have kept them (an older one ignores them).
    function markPushed(chunk, settingsStored) {
        var seen = getJson(K.seen, { h: {}, p: {} });
        seen.h = seen.h || {}; seen.p = seen.p || {}; seen.f = seen.f || {};
        chunk.favorites.forEach(function (it) { seen.f[it.key.slice(2)] = it.updated; });
        chunk.history.forEach(function (it) { seen.h[it.key] = it.updated; });
        chunk.progress.forEach(function (it) { seen.p[it.key] = { u: it.updated, d: it.deleted ? 1 : 0 }; });
        if (settingsStored) { seen.s = seen.s || {}; chunk.settings.forEach(function (it) { seen.s[it.key.slice(2)] = it.updated; }); }
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

            if (Array.isArray(resp.settings)) {
                seen.s = seen.s || {};
                var smeta = trackSettings();     // a change made while the request was in flight counts as newer than the cloud's copy
                resp.settings.forEach(function (r) {
                    var key = String(r.key || '');
                    var name = key.slice(2);
                    if (key.slice(0, 2) !== 's|' || !has(SETTINGS, name) || r.deleted) return;
                    var mine = smeta[name] ? smeta[name].u : 0;
                    if (r.updated < mine) return;                       // ours is newer; it gets pushed
                    if (r.updated === mine) { seen.s[name] = r.updated; return; }
                    var clean = SETTINGS[name].clean(r.data);
                    if (!clean) return;
                    SETTINGS[name].write(clean);
                    var now2 = SETTINGS[name].read();
                    if (!now2) return;
                    smeta[name] = { v: JSON.stringify(now2), u: r.updated };
                    seen.s[name] = r.updated;
                    settingsApplied = true;
                    changed = true;
                });
                setJson(K.setmeta, smeta);
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
                } else if (cleanTorrent(data.torrent)) {
                    // Not in this device's library, but it was a plugin stream: keep it as a plugin resume point
                    // (same id the player uses for plugin streams, see torrent.js).
                    var tid = 'tor:' + r.key;
                    var entry = Object.assign(identity(data), { id: tid, position: data.position || 0, duration: data.duration || 0, updated: r.updated, torrent: cleanTorrent(data.torrent) });
                    var tog = cleanOrigin(data.origin); if (tog) entry.origin = tog;
                    var tim = cleanUrl(data.image); if (tim) entry.image = tim;
                    pmap[tid] = entry;
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
        var list = snap.list.map(function (p) { return { id: p.id, name: p.name, color: p.color, updated: p.updated || 0, deleted: 0, avatar: p.avatar || '', pin: p.pin || '' }; });
        Object.keys(snap.tombs).forEach(function (id) { list.push({ id: id, name: '', color: '', updated: snap.tombs[id], deleted: 1 }); });
        return request('POST', '/v1/profiles/sync', { profiles: list }, true).then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) { HP.mergeRemote(r.body.profiles || []); return { ok: true }; }
            return { ok: false, status: r.status, error: failure(r.status, r.body) };
        });
    }

    // True when this device has something the cloud has not seen yet (cheap, local only, no network).
    function hasLocalChanges() {
        if (!getToken()) return false;
        var a = collectPush();
        return a.history.length + a.progress.length + a.favorites.length + a.settings.length > 0;
    }

    // opts: { resolve: fn, light: bool }.  Resolves { ok, error?, pushed, changed }.
    function sync(opts) {
        opts = opts || {};
        if (inflight) return inflight;
        if (!getToken()) return Promise.resolve({ ok: false, error: 'not_linked' });

        var pid = currentProfile();
        var all, pushedCount, anyChange;

        function round(n, first) {
            var chunk = takeChunk(all);
            var cursor = parseInt(getRaw(K.cursor), 10) || 0;
            var body = { profile: pid, since: cursor, history: chunk.history, progress: chunk.progress, favorites: chunk.favorites, settings: chunk.settings };
            return request('POST', '/v1/sync', body, true).then(function (r) {
                if (r.status === 404 && r.body && r.body.error === 'unknown_profile') return { ok: false, error: 'unknown_profile' };
                if (r.status !== 200 || !r.body || !r.body.ok) return { ok: false, error: failure(r.status, r.body) };
                // An older cloud service ignores "profile" and would mix everybody's data into one: only the original profile may talk to it.
                if (pid !== 'p1' && r.body.profile !== pid) return { ok: false, error: 'cloud_outdated' };
                markPushed(chunk, Array.isArray(r.body.settings));
                return applyRemote(r.body, opts.resolve).then(function (changed) {
                    if (changed) anyChange = true;
                    setRaw(K.cursor, String(r.body.cursor || cursor));
                    var morePush = all.history.length + all.progress.length + all.favorites.length + all.settings.length > 0;
                    if ((r.body.more || morePush) && n < MAX_ROUNDS) return round(n + 1, false);
                    setRaw(K.last, String(clock.now()));
                    return { ok: true, pushed: pushedCount, changed: anyChange, settings: settingsApplied };
                });
            });
        }

        function attempt(retried) {
            // light: skip the profile round trip (a stop-of-playback or favorite sync only needs to push what changed).
            return (opts.light ? Promise.resolve({ ok: true }) : syncProfiles()).then(function (pr) {
                if (!pr.ok) {
                    if (pr.error === 'session_expired' || pr.error === 'rate_limited') return pr;
                    // No profile support in the cloud yet: the original profile still works, the others must wait.
                    if (pid !== 'p1') return { ok: false, error: pr.status === 404 ? 'cloud_outdated' : pr.error };
                }
                all = collectPush();
                pushedCount = all.history.length + all.progress.length + all.favorites.length + all.settings.length;
                anyChange = false;
                settingsApplied = false;
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
        signUp: signUp, signIn: signIn, signOut: signOut, confirmPassword: confirmPassword, peekProfiles: peekProfiles,
        verifyEmail: verifyEmail, resendCode: resendCode,
        forgotPassword: forgotPassword, resetPassword: resetPassword,
        getEmail: getEmail, getUsername: getUsername, lastSync: lastSync, unlink: unlink,
        sync: sync, hasLocalChanges: hasLocalChanges, deleteAccount: deleteAccount, cloud: cloud,
        isLinked: function () { return !!getToken(); },
        _setApi: function (u) { API = u; },
        _setClock: function (fn) { clock.now = fn; }
    };
})();
