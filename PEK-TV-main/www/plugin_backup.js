/* PEK TV plugin backup  (window.PekPluginBackup)
 *
 * Backs up the plugins you installed from a .zip to your Hesper Cloud account, and lets you
 * bring them back on another device (or after reinstalling PEK TV).
 *
 *  - Only third-party plugins are backed up. Built-in ones ship with PEK TV.
 *  - Only the plugin's own files are saved (never its data/ folder, which is private to a device).
 *  - Backing up is automatic once you are signed in (switch it off in Settings > Cloud Sync).
 *  - Getting plugins BACK is never automatic: a cloud copy is only offered, and installing it goes
 *    through the same permission screen and server checks as installing a .zip.
 *  - Removing a plugin in PEK TV marks it removed in the cloud so your other devices stop offering it.
 *    They keep their own copy; nothing is ever deleted on a device because of the cloud.
 */
(function () {
    'use strict';

    var K = {
        on: 'hesper_plugin_backup_on',          // '0' = off (default is on)
        seen: 'hesper_plugin_backup_seen_v1',   // { email, plugins: { id: { sig, fp, u } } }
        pending: 'hesper_plugin_backup_pending_v1',
        skip: 'hesper_plugin_backup_skip_v1'    // { id: cloud "updated" the user said "not now" to }
    };
    var CHUNK = 400000;     // characters per upload piece (the server expects this size or less)
    var MAX_RAW = 8 * 1024 * 1024;

    function getRaw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
    function getJson(k, d) { try { var o = JSON.parse(getRaw(k) || 'null'); return (o && typeof o === 'object') ? o : d; } catch (e) { return d; } }
    function setJson(k, o) { setRaw(k, JSON.stringify(o)); }

    function S() { return window.PekSync; }
    function Inst() { return window.PekPluginInstaller || (typeof PekPluginInstaller !== 'undefined' ? PekPluginInstaller : null); }

    function enabled() { return getRaw(K.on) !== '0'; }
    function setEnabled(v) { setRaw(K.on, v ? '1' : '0'); }

    // ---------------- helpers ----------------
    function validId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id); }

    function toB64(buf) {
        var bytes = new Uint8Array(buf), s = '';
        for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }
    function fromB64(b64) {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    // Two FNV-1a passes with different seeds: a cheap fingerprint to spot changes and damaged downloads.
    function fingerprint(str) {
        var h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
            h2 ^= h2 >>> 13;
        }
        return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
    }
    function getJsonFetch(url) {
        return fetch(url).then(function (r) { return r.json(); });
    }

    // ---------------- reading what is installed on this device ----------------
    // Resolves an array of plugin folder names, or null when the list could not be read
    // (then nothing is backed up this time, so a hiccup can never look like "everything was removed").
    function localIds() {
        var I = Inst();
        return getJsonFetch('/api/plugins').then(function (d) {
            if (!d || !Array.isArray(d.plugins)) return null;
            return d.plugins.map(function (p) { return p.folder; })
                .filter(function (id) { return validId(id) && !(I && I.isBuiltin(id)); });
        }, function () { return null; });
    }

    // Quick signature from the file list, sizes and modified times (no file contents read).
    function listLocal(id) {
        return getJsonFetch('/api/plugins/files?id=' + encodeURIComponent(id)).then(function (d) {
            if (!d || !d.ok || !Array.isArray(d.files) || !d.files.length) return null;
            var total = d.files.reduce(function (a, f) { return a + (f.size || 0); }, 0);
            if (total > MAX_RAW) return null;
            return { files: d.files, sig: d.files.map(function (f) { return f.path + ':' + f.size + ':' + (f.mtime || 0); }).join('|') };
        }, function () { return null; });
    }

    // Reads every file and builds one text bundle. Order is fixed so the fingerprint is stable.
    function pack(id, listing) {
        var files = [], chain = Promise.resolve(), raw = 0;
        listing.files.forEach(function (f) {
            chain = chain.then(function () {
                return fetch('/api/plugins/file?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(f.path))
                    .then(function (r) { if (!r.ok) throw new Error('read'); return r.arrayBuffer(); })
                    .then(function (buf) { raw += buf.byteLength; files.push({ p: f.path, d: toB64(buf) }); });
            });
        });
        return chain.then(function () {
            var name = id, version = '';
            files.forEach(function (f) {
                if (f.p !== 'plugin.json') return;
                try {
                    var m = JSON.parse(new TextDecoder('utf-8').decode(fromB64(f.d)).replace(/^\uFEFF/, ''));
                    if (typeof m.name === 'string') name = m.name.slice(0, 80);
                    if (typeof m.version === 'string') version = m.version.slice(0, 40);
                } catch (e) { /* keep the id as the name */ }
            });
            var bundle = JSON.stringify({ v: 1, files: files });
            return { bundle: bundle, fp: fingerprint(bundle), raw: raw, name: name, version: version };
        });
    }

    // ---------------- talking to the cloud ----------------
    function upload(id, packed) {
        var total = Math.max(1, Math.ceil(packed.bundle.length / CHUNK));
        var chain = Promise.resolve();
        for (var i = 0; i < total; i++) {
            (function (i) {
                chain = chain.then(function () {
                    return S().cloud('POST', '/v1/plugins/chunk', {
                        id: id, fp: packed.fp, index: i, total: total, data: packed.bundle.slice(i * CHUNK, (i + 1) * CHUNK)
                    }).then(function (r) { if (!r.ok) throw r; });
                });
            })(i);
        }
        return chain.then(function () {
            var updated = Date.now();
            return S().cloud('POST', '/v1/plugins/commit', {
                id: id, fp: packed.fp, total: total, name: packed.name, version: packed.version, size: packed.raw, updated: updated
            }).then(function (r) { if (!r.ok) throw r; return { updated: updated, stored: r.body.stored !== false }; });
        });
    }

    function download(id, entry) {
        var parts = [], chain = Promise.resolve();
        for (var i = 0; i < entry.chunks; i++) {
            (function (i) {
                chain = chain.then(function () {
                    return S().cloud('GET', '/v1/plugins/chunk?id=' + encodeURIComponent(id) + '&fp=' + encodeURIComponent(entry.fp) + '&i=' + i)
                        .then(function (r) { if (!r.ok) throw r; parts.push(r.body.data); });
                });
            })(i);
        }
        return chain.then(function () {
            var bundle = parts.join('');
            if (fingerprint(bundle) !== entry.fp) throw { ok: false, error: 'damaged' };   // never install a damaged download
            var obj;
            try { obj = JSON.parse(bundle); } catch (e) { throw { ok: false, error: 'damaged' }; }
            if (!obj || obj.v !== 1 || !Array.isArray(obj.files)) throw { ok: false, error: 'damaged' };
            return obj.files.map(function (f) { return { path: String(f.p), data: fromB64(String(f.d)) }; });
        });
    }

    // ---------------- the backup pass ----------------
    var running = null;

    // opts: { force }  force = re-read every plugin even if its files look unchanged.
    // Resolves { ok, error?, uploaded, pending }.
    function run(opts) {
        opts = opts || {};
        if (running) return running;
        if (!S() || !S().isLinked()) return Promise.resolve({ ok: false, error: 'not_linked' });

        var email = S().getEmail();
        var state = getJson(K.seen, {});
        if (state.email !== email) state = { email: email, plugins: {} };   // a different account: start fresh
        state.plugins = state.plugins || {};
        var skip = getJson(K.skip, {});
        var pending = [];
        var uploaded = 0;

        running = Promise.all([localIds(), S().cloud('GET', '/v1/plugins')]).then(function (res) {
            var ids = res[0], list = res[1];
            if (ids === null) return { ok: false, error: 'local' };
            if (!list.ok) return { ok: false, error: list.error };
            var cloud = {};
            (list.body.plugins || []).forEach(function (p) { cloud[p.id] = p; });

            var all = {};
            ids.forEach(function (id) { all[id] = 1; });
            Object.keys(cloud).forEach(function (id) { if (validId(id)) all[id] = 1; });

            var chain = Promise.resolve(), failed = null;
            Object.keys(all).forEach(function (id) {
                chain = chain.then(function () {
                    var C = cloud[id], live = C && !C.deleted, seen = state.plugins[id];
                    var isLocal = ids.indexOf(id) !== -1;

                    if (!isLocal) {
                        // Only on the cloud: offer it (unless the user said "not now" to this version).
                        if (live && !(skip[id] && skip[id] >= C.updated)) {
                            pending.push({ id: id, name: C.name || id, version: C.version || '', kind: 'new', updated: C.updated, size: C.size });
                        }
                        return;
                    }
                    return listLocal(id).then(function (listing) {
                        if (!listing) return;          // nothing readable: leave it alone
                        var sameSizes = !!seen && seen.sig === listing.sig && !opts.force;

                        // The cloud has no copy (or it was removed there)
                        if (!live) {
                            if (C && C.deleted && sameSizes) return;     // removed elsewhere, unchanged here: stay local-only
                            return pack(id, listing).then(function (p) { return upload(id, p).then(function (u) {
                                uploaded++;
                                state.plugins[id] = { sig: listing.sig, fp: p.fp, u: u.updated };
                            }); });
                        }

                        // Both have it. If sizes are unchanged we already know this device's fingerprint.
                        var localFp = sameSizes ? seen.fp : null;
                        var getFp = localFp ? Promise.resolve(null) : pack(id, listing);
                        return getFp.then(function (p) {
                            if (p) localFp = p.fp;
                            if (localFp === C.fp) { state.plugins[id] = { sig: listing.sig, fp: localFp, u: C.updated }; return; }
                            var localChanged = !seen || seen.fp !== localFp;
                            var cloudChanged = !seen || seen.fp !== C.fp;
                            if (localChanged && !cloudChanged) {
                                return (p ? Promise.resolve(p) : pack(id, listing)).then(function (pp) {
                                    return upload(id, pp).then(function (u) {
                                        uploaded++;
                                        state.plugins[id] = { sig: listing.sig, fp: pp.fp, u: u.updated };
                                    });
                                });
                            }
                            if (!(skip[id] && skip[id] >= C.updated)) {
                                pending.push({ id: id, name: C.name || id, version: C.version || '', kind: localChanged ? 'conflict' : 'update', updated: C.updated, size: C.size });
                            }
                            state.plugins[id] = { sig: listing.sig, fp: localFp, u: (seen && seen.u) || 0 };
                        });
                    }).catch(function (e) {
                        // One plugin failing must not stop the others. A signed-out session or no network stops everything.
                        if (e && (e.error === 'session_expired' || e.error === 'offline' || e.error === 'rate_limited')) failed = e.error;
                    });
                });
            });
            return chain.then(function () {
                setJson(K.seen, state);
                setJson(K.pending, pending);
                if (failed) return { ok: false, error: failed, uploaded: uploaded, pending: pending };
                return { ok: true, uploaded: uploaded, pending: pending };
            });
        }).catch(function () { return { ok: false, error: 'offline' }; }).then(function (r) {
            running = null;
            return r;
        });
        return running;
    }

    // ---------------- actions the screen can take ----------------
    function pendingList() { return getJson(K.pending, []); }
    function dropPending(id) { setJson(K.pending, pendingList().filter(function (p) { return p.id !== id; })); }

    // Downloads one cloud plugin and returns the files, ready for PekPluginInstaller.prepareFiles.
    function fetchForRestore(id) {
        return S().cloud('GET', '/v1/plugins').then(function (list) {
            if (!list.ok) throw list;
            var entry = (list.body.plugins || []).filter(function (p) { return p.id === id && !p.deleted; })[0];
            if (!entry) throw { ok: false, error: 'gone' };
            return download(id, entry);
        });
    }

    // "Not now": hide this cloud version until a newer one appears.
    function dismiss(id) {
        var p = pendingList().filter(function (x) { return x.id === id; })[0];
        var skip = getJson(K.skip, {});
        skip[id] = p ? p.updated : Date.now();
        setJson(K.skip, skip);
        dropPending(id);
    }

    // "Keep mine": replace the cloud copy with the one on this device.
    function keepLocal(id) {
        return listLocal(id).then(function (listing) {
            if (!listing) throw { ok: false, error: 'local' };
            return pack(id, listing).then(function (p) { return upload(id, p).then(function (u) {
                var state = getJson(K.seen, {});
                if (state.email !== S().getEmail()) state = { email: S().getEmail(), plugins: {} };
                state.plugins = state.plugins || {};
                state.plugins[id] = { sig: listing.sig, fp: p.fp, u: u.updated };
                setJson(K.seen, state);
                dropPending(id);
                return { ok: true };
            }); });
        }).catch(function (e) { return { ok: false, error: (e && e.error) || 'server' }; });
    }

    // The user removed this plugin in PEK TV: tell the cloud so other devices stop offering it.
    function forget(id) {
        if (!enabled() || !S() || !S().isLinked() || !validId(id)) return;
        S().cloud('POST', '/v1/plugins/delete', { id: id, updated: Date.now() }).then(function (r) {
            if (!r.ok) return;
            var state = getJson(K.seen, {});
            if (state.plugins) { delete state.plugins[id]; setJson(K.seen, state); }
            dropPending(id);
        });
    }

    var I0 = Inst();
    if (I0 && I0.onRemoved) I0.onRemoved(forget);

    window.PekPluginBackup = {
        enabled: enabled, setEnabled: setEnabled,
        run: function (o) { return enabled() ? run(o) : Promise.resolve({ ok: true, off: true, uploaded: 0, pending: [] }); },
        pending: function () { return enabled() ? pendingList() : []; },
        fetchForRestore: fetchForRestore, dismiss: dismiss, keepLocal: keepLocal, forget: forget,
        _fingerprint: fingerprint
    };
})();
