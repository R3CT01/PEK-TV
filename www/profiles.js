/* PEK TV profiles  (window.PekProfiles)
 *
 * Netflix-style profiles: each person has their own favorites, watch history, resume points,
 * skip settings, look (theme / skin / layout) and cloud sign-in. Plugins, the library and the
 * server are shared by everybody on the device.
 *
 * How it works: every other script keeps calling localStorage exactly as before. This file is
 * loaded FIRST and wraps localStorage.getItem / setItem / removeItem so that the keys listed in
 * SCOPED are stored as  p/<profileId>/<key>.  Everything else (plugins' own storage, the poster
 * cache, the clock, trusted plugins ...) stays shared. A key not listed here is shared, never lost.
 *
 * First run after the update: the data that was already there becomes the first profile
 * ("Profile 1"), moved to p/p1/..., so nothing is lost and nothing looks different.
 *
 * Profiles need a cloud account: with no email account signed in, none of the profile screens or settings are shown
 * and the app runs as the active profile (data is kept; it all returns on sign-in).
 *
 * With an account: every app session starts on "Who's watching?" and cannot go past it until a profile is picked
 * (or made there, Netflix-style). The first time an account is used, a mandatory setup screen (name + picture) turns the
 * existing local profile ("p1", which already holds everything watched before the account) into the main profile.
 * A profile can have an optional 4-digit passcode (stored only as a salted, iterated hash; it syncs with the profile).
 * Pictures are either one of the built-in avatars or a small photo from the device (shrunk to a ~100px JPEG).
 *
 * The "Who's watching?" screen is shown once per app session when there is more than one profile
 * (the app itself is not started until a profile is picked). Switching or managing profiles
 * reloads the page, which keeps every screen free of the previous person's data.
 *
 * Cloud sync: the cloud account (email + password) belongs to the device and is shared by every profile;
 * each profile syncs its own favorites / history / resume points under it. The profile list itself
 * (names + colours) syncs too, so a profile made on the phone shows up on the TV. sync.js calls
 * snapshot() / mergeRemote() for that.
 */
(function () {
    'use strict';

    var REG_KEY = 'hesper_profiles_v1';        // { v, active, list: [{ id, name, color }] }  (shared, not scoped)
    var LASTMAIL = 'hesper_profiles_lastmail';  // the account this device last signed in to (so signing back in to the same one merges instead of replacing)
    var PICKED = 'hesper_profile_picked';       // sessionStorage: a profile was chosen in this app session
    var MANAGE = 'hesper_profiles_manage';      // sessionStorage: open the picker in "manage" mode
    var MAX = 5;
    var NAME_MAX = 20;
    var COLORS = ['#E04A00', '#C2185B', '#7B1FA2', '#3949AB', '#0277BD', '#00897B', '#689F38', '#F9A825'];

    // Personal data: stored per profile.
    var SCOPED = /^(hesper_(favorites|progress|history|skip)|hesper_sync_(cursor|last|seen|pending)|hesper-(theme|skin|layout|poster-size|view|ember-seen|dashboard|settings))/;
    // Device level (shared by all profiles): the cloud sign-in and the plugin backup, which belongs to the account.
    var ACCOUNT_KEYS = ['hesper_sync_token', 'hesper_sync_email', 'hesper_plugin_backup_on', 'hesper_plugin_backup_seen_v1', 'hesper_plugin_backup_pending_v1', 'hesper_plugin_backup_skip_v1'];
    var SYNC_STATE_KEYS = ['hesper_sync_cursor_v1', 'hesper_sync_last_v1', 'hesper_sync_seen_v1', 'hesper_sync_pending_v1'];

    var disabled = { enabled: false, pending: false, max: MAX, list: function () { return []; }, current: function () { return null; }, openPicker: function () {},
        hasAccount: function () { return false; }, afterSignIn: function () {}, afterSignOut: function () {}, adoptCloudProfiles: function () { return false; }, snapshot: function () { return { list: [], tombs: {} }; }, mergeRemote: function () { return false; }, clearSyncState: function () {}, touch: function () {} };

    var PIN_LEN = 4;
    var PIN_ROUNDS = 3000;
    var AV_MAX = 12000;     // longest custom-photo data URL kept (it syncs with the profile)

    // ---------------- passcode hashing (pure JS: the same answer on every device, with or without crypto.subtle) -------------
    var K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function sha256hex(str) {   // ASCII input only (digits and hex)
        var b = [], i, j;
        for (i = 0; i < str.length; i++) b.push(str.charCodeAt(i) & 255);
        var len = b.length;
        b.push(0x80);
        while (b.length % 64 !== 56) b.push(0);
        var hi = Math.floor(len / 0x20000000), lo = (len << 3) >>> 0;
        b.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
        var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Array(64);
        function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
        for (i = 0; i < b.length; i += 64) {
            for (j = 0; j < 16; j++) w[j] = ((b[i + j * 4] << 24) | (b[i + j * 4 + 1] << 16) | (b[i + j * 4 + 2] << 8) | b[i + j * 4 + 3]) | 0;
            for (j = 16; j < 64; j++) {
                var s0 = rr(w[j - 15], 7) ^ rr(w[j - 15], 18) ^ (w[j - 15] >>> 3), s1 = rr(w[j - 2], 17) ^ rr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
                w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
            }
            var a = H[0], bb = H[1], c = H[2], d2 = H[3], e = H[4], f = H[5], g2 = H[6], h = H[7];
            for (j = 0; j < 64; j++) {
                var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g2), t1 = (h + S1 + ch + K256[j] + w[j]) | 0;
                var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), mj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + mj) | 0;
                h = g2; g2 = f; f = e; e = (d2 + t1) | 0; d2 = c; c = bb; bb = a; a = (t1 + t2) | 0;
            }
            H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d2) | 0;
            H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g2) | 0; H[7] = (H[7] + h) | 0;
        }
        return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
    }
    function pinDigest(pin, salt) {
        var h = sha256hex(salt + ':' + pin);
        for (var i = 0; i < PIN_ROUNDS; i++) h = sha256hex(h + salt + pin);
        return h;
    }
    function randomHex(n) {
        var out = '';
        try { var a = new Uint8Array(n); (window.crypto || window.msCrypto).getRandomValues(a); for (var i = 0; i < n; i++) out += ('0' + a[i].toString(16)).slice(-2); return out; } catch (e) { /* fallback */ }
        for (var j = 0; j < n; j++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
        return out;
    }
    function makePin(pin) { var salt = randomHex(8); return salt + ':' + pinDigest(pin, salt); }   // "<16 hex salt>:<64 hex hash>"
    function okPin(v) { return v === '' || (typeof v === 'string' && /^[0-9a-f]{16}:[0-9a-f]{64}$/.test(v)); }
    function checkPin(stored, pin) {
        var i = String(stored || '').indexOf(':');
        if (i < 0) return false;
        return pinDigest(pin, stored.slice(0, i)) === stored.slice(i + 1);
    }

    // ---------------- avatars ----------------
    // Built-in pictures (drawn here, no files needed) sit on the profile's colour. A profile may also carry a small photo.
    var AV = {
        smile: '<circle cx="50" cy="54" r="30" fill="#FFD59A"/><circle cx="40" cy="48" r="4" fill="#2a1206"/><circle cx="60" cy="48" r="4" fill="#2a1206"/><path d="M36 62q14 14 28 0" stroke="#2a1206" stroke-width="4" fill="none" stroke-linecap="round"/>',
        cool: '<circle cx="50" cy="54" r="30" fill="#FFD59A"/><rect x="28" y="43" width="19" height="13" rx="5" fill="#111"/><rect x="53" y="43" width="19" height="13" rx="5" fill="#111"/><path d="M47 48h6" stroke="#111" stroke-width="3"/><path d="M38 66q12 8 24 0" stroke="#2a1206" stroke-width="4" fill="none" stroke-linecap="round"/>',
        cat: '<path d="M22 44V16l20 14zM78 44V16L58 30z" fill="#F0A24B"/><circle cx="50" cy="55" r="30" fill="#F0A24B"/><circle cx="40" cy="50" r="4" fill="#2a1206"/><circle cx="60" cy="50" r="4" fill="#2a1206"/><path d="M46 60h8l-4 5z" fill="#d6577a"/><path d="M50 65q-6 8-12 4M50 65q6 8 12 4M20 56h14M20 63h14M66 56h14M66 63h14" stroke="#2a1206" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
        dog: '<ellipse cx="24" cy="48" rx="11" ry="22" fill="#7a4a21"/><ellipse cx="76" cy="48" rx="11" ry="22" fill="#7a4a21"/><circle cx="50" cy="54" r="29" fill="#D9A066"/><circle cx="40" cy="48" r="4" fill="#2a1206"/><circle cx="60" cy="48" r="4" fill="#2a1206"/><ellipse cx="50" cy="62" rx="9" ry="7" fill="#f3d3a8"/><circle cx="50" cy="60" r="4" fill="#2a1206"/>',
        bear: '<circle cx="26" cy="28" r="11" fill="#8a5a2b"/><circle cx="74" cy="28" r="11" fill="#8a5a2b"/><circle cx="50" cy="54" r="31" fill="#A9743E"/><circle cx="40" cy="48" r="4" fill="#2a1206"/><circle cx="60" cy="48" r="4" fill="#2a1206"/><ellipse cx="50" cy="63" rx="11" ry="8" fill="#e6c08f"/><circle cx="50" cy="60" r="3.5" fill="#2a1206"/>',
        panda: '<circle cx="26" cy="28" r="11" fill="#222"/><circle cx="74" cy="28" r="11" fill="#222"/><circle cx="50" cy="54" r="31" fill="#f4f4f4"/><ellipse cx="38" cy="49" rx="8" ry="10" fill="#222" transform="rotate(20 38 49)"/><ellipse cx="62" cy="49" rx="8" ry="10" fill="#222" transform="rotate(-20 62 49)"/><circle cx="39" cy="48" r="3" fill="#fff"/><circle cx="61" cy="48" r="3" fill="#fff"/><ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#222"/>',
        robot: '<path d="M50 14v10" stroke="#eee" stroke-width="4"/><circle cx="50" cy="12" r="5" fill="#ff5252"/><rect x="22" y="24" width="56" height="52" rx="12" fill="#B8C4CE"/><circle cx="38" cy="46" r="7" fill="#1b2a35"/><circle cx="62" cy="46" r="7" fill="#1b2a35"/><circle cx="38" cy="46" r="3" fill="#6fe3ff"/><circle cx="62" cy="46" r="3" fill="#6fe3ff"/><path d="M36 63h28" stroke="#1b2a35" stroke-width="4" stroke-dasharray="4 3"/>',
        alien: '<ellipse cx="50" cy="54" rx="29" ry="34" fill="#7BD66B"/><ellipse cx="37" cy="52" rx="8" ry="12" fill="#111" transform="rotate(20 37 52)"/><ellipse cx="63" cy="52" rx="8" ry="12" fill="#111" transform="rotate(-20 63 52)"/><path d="M42 74q8 5 16 0" stroke="#1d4d17" stroke-width="3" fill="none" stroke-linecap="round"/>',
        ghost: '<path d="M24 80V46a26 26 0 0 1 52 0v34l-9-7-8 7-9-7-9 7-8-7z" fill="#f6f6ff"/><circle cx="42" cy="46" r="5" fill="#222"/><circle cx="58" cy="46" r="5" fill="#222"/><ellipse cx="50" cy="60" rx="5" ry="6" fill="#222"/>',
        owl: '<path d="M24 26l14 10M76 26L62 36" stroke="#6b4423" stroke-width="7" stroke-linecap="round"/><ellipse cx="50" cy="56" rx="29" ry="32" fill="#9a6a3a"/><circle cx="38" cy="48" r="11" fill="#fff"/><circle cx="62" cy="48" r="11" fill="#fff"/><circle cx="38" cy="48" r="5" fill="#111"/><circle cx="62" cy="48" r="5" fill="#111"/><path d="M45 58h10l-5 10z" fill="#F9A825"/>',
        fox: '<path d="M18 46V14l24 18zM82 46V14L58 32z" fill="#E8661A"/><path d="M50 86L18 52q10-26 32-26t32 26z" fill="#E8661A"/><path d="M50 86L30 60q20 8 40 0z" fill="#fff"/><circle cx="39" cy="50" r="3.5" fill="#2a1206"/><circle cx="61" cy="50" r="3.5" fill="#2a1206"/><circle cx="50" cy="75" r="4" fill="#2a1206"/>',
        star: '<path d="M50 14l11 24 26 3-19 18 5 26-23-13-23 13 5-26-19-18 26-3z" fill="#FFD54F" stroke="#F9A825" stroke-width="3" stroke-linejoin="round"/><circle cx="43" cy="50" r="3" fill="#2a1206"/><circle cx="57" cy="50" r="3" fill="#2a1206"/><path d="M44 58q6 6 12 0" stroke="#2a1206" stroke-width="3" fill="none" stroke-linecap="round"/>'
    };
    var AV_KEYS = Object.keys(AV);
    function svgUri(key) { return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + AV[key] + '</svg>'); }
    function okAvatar(a) {
        if (a === '') return true;
        if (typeof a !== 'string' || a.length > AV_MAX + 4) return false;
        if (a.indexOf('b:') === 0) return Object.prototype.hasOwnProperty.call(AV, a.slice(2));
        return /^d:data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(a);
    }
    function avatarUri(a) {
        if (!okAvatar(a) || !a) return '';
        return a.indexOf('b:') === 0 ? svgUri(a.slice(2)) : a.slice(2);
    }
    // Any picture file -> a small square JPEG data URL (or null).
    function photoToAvatar(file, done) {
        var url;
        try { url = (window.URL || window.webkitURL).createObjectURL(file); } catch (e) { done(null); return; }
        var img = new Image();
        function free() { try { (window.URL || window.webkitURL).revokeObjectURL(url); } catch (e) { /* ignore */ } }
        img.onload = function () {
            var out = null;
            try {
                var size = 112, q = 0.8, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, sq = Math.min(w, h);
                for (var tries = 0; tries < 6 && sq > 0; tries++) {
                    var c = document.createElement('canvas'); c.width = size; c.height = size;
                    c.getContext('2d').drawImage(img, (w - sq) / 2, (h - sq) / 2, sq, sq, 0, 0, size, size);
                    out = c.toDataURL('image/jpeg', q);
                    if (out.length <= AV_MAX - 2) break;
                    q -= 0.12; size = Math.max(64, size - 16);
                }
            } catch (e) { out = null; }
            free();
            done(out && out.length <= AV_MAX - 2 && /^data:image\/jpeg;base64,/.test(out) ? out : null);
        };
        img.onerror = function () { free(); done(null); };
        img.src = url;
    }

    var ls, ss;
    try {
        ls = window.localStorage; ss = window.sessionStorage;
        ls.getItem('pek_probe'); ss.setItem('pek_probe', '1'); ss.removeItem('pek_probe');
    } catch (e) { window.PekProfiles = disabled; return; }   // no storage: no profiles, the app runs as before

    var P = Storage.prototype;
    var rawGet = P.getItem, rawSet = P.setItem, rawDel = P.removeItem;
    function g(k) { try { return rawGet.call(ls, k); } catch (e) { return null; } }
    function s(k, v) { try { rawSet.call(ls, k, v); return true; } catch (e) { return false; } }
    function d(k) { try { rawDel.call(ls, k); } catch (e) { /* gone anyway */ } }
    function allKeys() {
        var out = [];
        try { for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k !== null) out.push(k); } } catch (e) { /* none */ }
        return out;
    }

    // ---------------- registry ----------------
    function readReg() {
        var r = null;
        try { r = JSON.parse(g(REG_KEY) || 'null'); } catch (e) { r = null; }
        if (!r || !Array.isArray(r.list) || !r.list.length) return null;
        r.list = r.list.filter(function (p) { return p && typeof p.id === 'string' && typeof p.name === 'string'; });
        return r.list.length ? r : null;
    }
    function migrate(toId) {
        // Move today's personal data under the first profile (copy, then delete: safe to run twice).
        allKeys().forEach(function (k) {
            if (SCOPED.test(k)) {
                var v = g(k);
                if (v !== null && s('p/' + toId + '/' + k, v)) d(k);
            }
        });
    }

    // Version 1 (first release of profiles) kept the cloud sign-in inside each profile. Version 2 shares it:
    // the first profile's sign-in becomes the device's, and the other profiles start from a clean sync state.
    function adoptAccount(list) {
        var ids = list.map(function (p) { return p.id; });
        ids.sort(function (a, b) { return (a === 'p1' ? 0 : 1) - (b === 'p1' ? 0 : 1); });
        ACCOUNT_KEYS.forEach(function (k) {
            if (g(k) === null) {
                for (var i = 0; i < ids.length; i++) {
                    var v = g('p/' + ids[i] + '/' + k);
                    if (v !== null) { s(k, v); break; }
                }
            }
            ids.forEach(function (id) { d('p/' + id + '/' + k); });
        });
        ids.forEach(function (id) {
            if (id !== 'p1') SYNC_STATE_KEYS.forEach(function (k) { d('p/' + id + '/' + k); });
        });
    }

    var reg = readReg();
    if (!reg) {
        reg = { v: 3, active: 'p1', list: [{ id: 'p1', name: 'Profile 1', color: COLORS[0], updated: 0, avatar: '', pin: '' }], tombs: {}, setupDone: false };
        migrate('p1');
        s(REG_KEY, JSON.stringify(reg));
    }
    if (!reg.tombs || typeof reg.tombs !== 'object') reg.tombs = {};
    reg.list.forEach(function (p) {
        if (typeof p.updated !== 'number') p.updated = 0;
        if (!p.color) p.color = COLORS[0];
        if (!okAvatar(p.avatar)) p.avatar = '';
        if (!okPin(p.pin)) p.pin = '';
    });
    if (!reg.v || reg.v < 2) { adoptAccount(reg.list); reg.v = 2; s(REG_KEY, JSON.stringify(reg)); }
    // The mandatory first-time setup (name + picture) applies to an account whose main profile was never set up. Anyone who
    // already has several profiles, a custom name, a picture or a passcode has effectively done it.
    if (!reg.setupDone) {
        var legacy = reg.list.length > 1 || reg.list.some(function (p) { return p.avatar || p.pin || p.name !== 'Profile 1'; });
        reg.setupDone = !!legacy;
    }
    if (reg.v < 3) reg.v = 3;
    s(REG_KEY, JSON.stringify(reg));
    if (!reg.list.some(function (p) { return p.id === reg.active; })) reg.active = reg.list[0].id;
    var activeId = reg.active;
    function save() { s(REG_KEY, JSON.stringify(reg)); }

    // ---------------- the wrapper everything else goes through ----------------
    function scoped(k) { k = String(k); return SCOPED.test(k) ? 'p/' + activeId + '/' + k : k; }
    P.getItem = function (k) { return rawGet.call(this, this === ls ? scoped(k) : k); };
    P.setItem = function (k, v) { return rawSet.call(this, this === ls ? scoped(k) : k, v); };
    P.removeItem = function (k) { return rawDel.call(this, this === ls ? scoped(k) : k); };

    // ---------------- profile operations ----------------
    function clean(name) { return String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); }
    function nameTaken(name, exceptId) {
        var n = name.toLowerCase();
        return reg.list.some(function (p) { return p.id !== exceptId && p.name.toLowerCase() === n; });
    }
    function nextColor() {
        for (var i = 0; i < COLORS.length; i++) {
            if (!reg.list.some(function (p) { return p.color === COLORS[i]; })) return COLORS[i];
        }
        return COLORS[reg.list.length % COLORS.length];
    }
    function newId() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
    function addProfile(name, color, avatar, pin) {
        if (reg.list.length >= MAX) return null;
        var p = { id: newId(), name: clean(name), color: color || nextColor(), updated: Date.now(), avatar: okAvatar(avatar) ? avatar : '', pin: okPin(pin) ? pin : '' };
        reg.list.push(p); save();
        return p;
    }
    function updateProfile(id, name, color, avatar, pin) {
        reg.list.forEach(function (p) {
            if (p.id !== id) return;
            p.name = clean(name); p.color = color || p.color; p.updated = Date.now();
            if (okAvatar(avatar)) p.avatar = avatar;
            if (okPin(pin)) p.pin = pin;
        });
        save();
    }
    function removeProfile(id) {
        if (reg.list.length < 2) return false;
        var prefix = 'p/' + id + '/';
        allKeys().forEach(function (k) { if (k.indexOf(prefix) === 0) d(k); });
        reg.list = reg.list.filter(function (p) { return p.id !== id; });
        reg.tombs[id] = Date.now();   // so the removal reaches the cloud and the other devices
        if (reg.active === id) { reg.active = reg.list[0].id; activeId = reg.active; }
        save();
        return true;
    }
    function enter(id) {
        reg.active = id; save();
        try { ss.setItem(PICKED, '1'); ss.removeItem(MANAGE); } catch (e) { /* checked at start */ }
        location.reload();
    }

    // ---------------- when to show the picker ----------------
    var picked = false, manage = false;
    try { picked = ss.getItem(PICKED) === '1'; manage = ss.getItem(MANAGE) === '1'; } catch (e) { /* defaults */ }
    // Profiles are an account feature: the picker, creating, editing and switching profiles are only offered while this
    // device is signed in to a cloud account (email + password). Signed out, the app simply runs as the active profile;
    // nothing is deleted, and every profile comes back as soon as the person signs in again.
    function hasAccount() { return !!g('hesper_sync_token'); }
    // With an account every app session starts on "Who's watching?" (even with a single profile) and the app does not
    // start until a profile is picked. First time: the setup screen comes first.
    var needsSetup = hasAccount() && !reg.setupDone;
    var pending = hasAccount() && (needsSetup || manage || !picked);

    function current() {
        for (var i = 0; i < reg.list.length; i++) if (reg.list[i].id === activeId) return { id: reg.list[i].id, name: reg.list[i].name, color: reg.list[i].color, avatar: reg.list[i].avatar || '' };
        return null;
    }

    // ---- for sync.js ----
    function snapshot() {
        return { list: reg.list.map(function (p) { return { id: p.id, name: p.name, color: p.color, updated: p.updated || 0, avatar: p.avatar || '', pin: p.pin || '' }; }), tombs: JSON.parse(JSON.stringify(reg.tombs)) };
    }
    function removeLocalData(id) {
        var prefix = 'p/' + id + '/';
        allKeys().forEach(function (k) { if (k.indexOf(prefix) === 0) d(k); });
    }
    // The cloud's list of profiles (live and removed). Newest change wins per profile. A profile that is in use
    // right now is never deleted under the running app; its removal is applied once another profile is active.
    function mergeRemote(remote) {
        if (!Array.isArray(remote)) return false;
        var changed = false;
        remote.forEach(function (r) {
            if (!r || typeof r.id !== 'string') return;
            var local = null;
            for (var i = 0; i < reg.list.length; i++) if (reg.list[i].id === r.id) local = reg.list[i];
            var tomb = reg.tombs[r.id];
            if (r.deleted) {
                if (tomb !== undefined && r.updated >= tomb) { delete reg.tombs[r.id]; changed = true; }   // the cloud has our removal
                if (local && (local.updated || 0) <= r.updated && r.id !== activeId && reg.list.length > 1) {
                    reg.list = reg.list.filter(function (p) { return p.id !== r.id; });
                    removeLocalData(r.id); changed = true;
                }
                return;
            }
            if (tomb !== undefined && tomb >= r.updated) return;      // we removed it after that: our removal gets pushed
            if (!local) {
                if (reg.list.length < MAX) { reg.list.push({ id: r.id, name: clean(r.name) || 'Profile', color: r.color || nextColor(), updated: r.updated || 0, avatar: okAvatar(r.avatar) ? r.avatar : '', pin: okPin(r.pin) ? r.pin : '' }); changed = true; }
            } else if ((local.updated || 0) < (r.updated || 0)) {
                local.name = clean(r.name) || local.name; local.color = r.color || local.color; local.updated = r.updated; changed = true;
                // An older cloud service sends no avatar / passcode: then keep ours. An empty string means "none".
                if (typeof r.avatar === 'string' && okAvatar(r.avatar)) local.avatar = r.avatar;
                if (typeof r.pin === 'string' && okPin(r.pin)) local.pin = r.pin;
            }
        });
        if (changed) save();
        return changed;
    }
    // Used when this device signs in or out: forget sync progress for EVERY profile (not just the active one).
    function clearSyncState() {
        SYNC_STATE_KEYS.forEach(function (k) {
            d(k);
            reg.list.forEach(function (p) { d('p/' + p.id + '/' + k); });
        });
    }
    // The active profile was removed elsewhere but is still in use here: keep it (a newer "updated" wins in the cloud).
    function touch(id) {
        reg.list.forEach(function (p) { if (p.id === id) p.updated = Date.now(); });
        delete reg.tombs[id]; save();
    }

    window.PekProfiles = {
        enabled: true,
        hasAccount: hasAccount,
        // What happens to this device's own data when an account is signed in to:
        //  - the account was just CREATED: what is on the device (watched before the account existed) becomes the main profile.
        //    This is the only time local data is carried into an account.
        //  - any other sign-in: the device's data is cleared and the account's profiles are used instead (they download right
        //    after). Whatever was watched while signed out is never merged into an existing account.
        //  - signing back in to the same account after the session merely expired (the data on the device IS that account's): merge.
        // Returns true when the device's data was cleared and the profile list rebuilt.
        adoptCloudProfiles: function (remote, email, created) {
            var mail = String(email || '').toLowerCase();
            var same = !!mail && g(LASTMAIL) === mail;
            if (mail) s(LASTMAIL, mail);
            if (created || same) return false;
            var live = (Array.isArray(remote) ? remote : []).filter(function (r) { return r && !r.deleted && typeof r.id === 'string' && clean(r.name); }).slice(0, MAX);
            allKeys().forEach(function (k) { if (SCOPED.test(k) || k.indexOf('p/') === 0) d(k); });
            d('hesper_posters_v1');
            if (live.length) {
                reg.list = live.map(function (r) {
                    return { id: r.id, name: clean(r.name), color: /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : nextColor(), updated: r.updated || 0,
                        avatar: okAvatar(r.avatar) ? r.avatar : '', pin: okPin(r.pin) ? r.pin : '' };
                });
                reg.setupDone = true;
            } else {
                reg.list = [{ id: 'p1', name: 'Profile 1', color: COLORS[0], updated: 0, avatar: '', pin: '' }];   // an account with nothing named yet
                reg.setupDone = false;
            }
            reg.tombs = {}; reg.v = 3;
            reg.active = reg.list[0].id; activeId = reg.active;
            save();
            return true;
        },
        // Signing out of the ACCOUNT: everything that came from it (every profile's favorites, history, resume points and looks,
        // the profile list, the sign-in itself and caches) is removed from this device. The app starts again as a clean slate;
        // the cloud keeps the data. The page reloads right away so nothing of it stays on screen or gets written back.
        afterSignOut: function () {
            allKeys().forEach(function (k) {
                if (SCOPED.test(k) || k.indexOf('p/') === 0 || ACCOUNT_KEYS.indexOf(k) >= 0 || SYNC_STATE_KEYS.indexOf(k) >= 0 ||
                    k === REG_KEY || k === LASTMAIL || k === 'hesper_posters_v1' || k === 'hesper_sync_key') d(k);
            });
            try { ss.clear(); } catch (e) { /* nothing to clear */ }
            try { if (window.caches && caches.keys) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }); } catch (e) { /* none */ }
            location.reload();
        },
        // Called right after a sign-in / sign-up finished: back to "Who's watching?" (or the first-time setup).
        afterSignIn: function () {
            try { ss.removeItem(PICKED); ss.removeItem(MANAGE); } catch (e) { return; }
            location.reload();
        },
        snapshot: snapshot, mergeRemote: mergeRemote, clearSyncState: clearSyncState, touch: touch,
        pending: pending,
        max: MAX,
        list: function () { return reg.list.map(function (p) { return { id: p.id, name: p.name, color: p.color }; }); },
        current: current,
        // Back to "Who's watching?" (or its manage screen). The page reloads so nothing of this profile stays on screen.
        openPicker: function (manageMode) {
            try { ss.removeItem(PICKED); if (manageMode) ss.setItem(MANAGE, '1'); else ss.removeItem(MANAGE); } catch (e) { return; }
            location.reload();
        }
    };

    if (!pending) return;

    // ======================================================================
    // The picker screen (plain DOM: it runs before the app exists)
    // ======================================================================
    var CSS = [
        '#pek-profiles{position:fixed;inset:0;z-index:2147483000;overflow:auto;color:#fff3ea;',
        'background:radial-gradient(ellipse at 50% 18%,#3a1706 0%,#170b05 55%,#0b0603 100%);',
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent;',
        'padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0)}',
        '#pek-profiles *{box-sizing:border-box}',
        '#pek-profiles .hp-wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4vmin 3vmin;gap:4.5vmin}',
        '#pek-profiles h1{margin:0;font-size:clamp(26px,5.2vmin,52px);font-weight:600;letter-spacing:.01em;text-align:center}',
        '#pek-profiles .hp-row{display:flex;flex-wrap:wrap;justify-content:center;gap:3.2vmin;max-width:96vw}',
        '#pek-profiles .hp-tile{background:none;border:0;padding:6px;margin:0;color:inherit;font:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:1.4vmin;border-radius:14px;outline:none;transition:transform .12s ease}',
        '#pek-profiles .hp-av{position:relative;width:clamp(88px,17vmin,170px);height:clamp(88px,17vmin,170px);border-radius:16px;display:flex;align-items:center;justify-content:center;',
        'font-size:clamp(40px,8.4vmin,84px);font-weight:700;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.35);border:4px solid transparent;transition:border-color .12s ease,box-shadow .12s ease}',
        '#pek-profiles .hp-av.hp-add{background:rgba(255,255,255,.08);border:3px dashed rgba(255,243,234,.4);font-weight:300}',
        '#pek-profiles .hp-edit{position:absolute;right:-6px;bottom:-6px;width:36%;height:36%;border-radius:50%;background:#fff3ea;color:#2a1206;font-size:.4em;display:flex;align-items:center;justify-content:center;text-shadow:none}',
        '#pek-profiles .hp-name{font-size:clamp(15px,2.6vmin,26px);opacity:.85;max-width:20vmin;min-width:12vmin;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#pek-profiles .hp-tile:focus,#pek-profiles .hp-tile:hover{transform:scale(1.07)}',
        '#pek-profiles .hp-tile:focus .hp-av,#pek-profiles .hp-tile:hover .hp-av{border-color:#ff9a52;box-shadow:0 0 0 3px rgba(255,154,82,.35),0 10px 30px rgba(0,0,0,.5)}',
        '#pek-profiles .hp-tile:focus .hp-name,#pek-profiles .hp-tile:hover .hp-name{opacity:1}',
        '#pek-profiles .hp-btn{font:inherit;font-size:clamp(15px,2.5vmin,24px);color:#fff3ea;background:rgba(255,255,255,.1);border:2px solid rgba(255,243,234,.35);border-radius:999px;padding:1.3vmin 3.4vmin;cursor:pointer;outline:none}',
        '#pek-profiles .hp-btn:focus,#pek-profiles .hp-btn:hover{border-color:#ff9a52;background:rgba(255,154,82,.22);color:#fff}',
        '#pek-profiles .hp-btn.hp-primary{background:#E04A00;border-color:#E04A00}',
        '#pek-profiles .hp-btn.hp-primary:focus,#pek-profiles .hp-btn.hp-primary:hover{background:#ff6a1f;border-color:#ffd2b0}',
        '#pek-profiles .hp-btn.hp-danger{border-color:#e5484d;color:#ffb4b6}',
        '#pek-profiles .hp-btn.hp-danger.hp-armed{background:#c62828;color:#fff;border-color:#ff9a9a}',
        '#pek-profiles .hp-shade{position:fixed;inset:0;background:rgba(5,2,1,.78);display:flex;align-items:center;justify-content:center;padding:3vmin;overflow:auto}',
        '#pek-profiles .hp-panel{background:#24120a;border:1px solid rgba(255,154,82,.35);border-radius:20px;padding:4vmin;width:min(560px,94vw);display:flex;flex-direction:column;align-items:center;gap:2.6vmin}',
        '#pek-profiles .hp-panel h2{margin:0;font-size:clamp(20px,3.6vmin,34px);font-weight:600}',
        '#pek-profiles .hp-input{width:100%;font:inherit;font-size:clamp(18px,3vmin,28px);color:#fff3ea;background:rgba(255,255,255,.08);border:2px solid rgba(255,243,234,.35);border-radius:12px;padding:1.4vmin 2vmin;outline:none;text-align:center}',
        '#pek-profiles .hp-input:focus{border-color:#ff9a52;background:rgba(255,154,82,.12)}',
        '#pek-profiles .hp-colors{display:flex;flex-wrap:wrap;justify-content:center;gap:1.8vmin}',
        '#pek-profiles .hp-sw{width:clamp(34px,6vmin,56px);height:clamp(34px,6vmin,56px);border-radius:50%;border:3px solid transparent;padding:0;cursor:pointer;outline:none;color:#fff;font-size:clamp(14px,2.6vmin,24px);line-height:1}',
        '#pek-profiles .hp-sw.hp-on{border-color:#fff3ea}',
        '#pek-profiles .hp-sw:focus,#pek-profiles .hp-sw:hover{border-color:#ff9a52;transform:scale(1.15)}',
        '#pek-profiles .hp-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:1.8vmin}',
        '#pek-profiles .hp-msg{min-height:1.4em;font-size:clamp(13px,2.2vmin,20px);color:#ffcfae;text-align:center;margin:0}',
        '#pek-profiles .hp-av.hp-small{width:clamp(64px,11vmin,110px);height:clamp(64px,11vmin,110px);font-size:clamp(30px,5.6vmin,56px)}',
        '#pek-profiles .hp-av.hp-mini{width:clamp(44px,8vmin,72px);height:clamp(44px,8vmin,72px);border-radius:12px;font-size:clamp(20px,3.8vmin,34px);border-width:3px}',
        '#pek-profiles .hp-lock{position:absolute;left:-6px;bottom:-6px;width:34%;height:34%;border-radius:50%;background:#2a1206;border:2px solid #fff3ea;font-size:.34em;display:flex;align-items:center;justify-content:center;text-shadow:none}',
        '#pek-profiles .hp-sub{margin:0;max-width:34em;text-align:center;font-size:clamp(13px,2.3vmin,21px);opacity:.8;line-height:1.4}',
        '#pek-profiles .hp-label{align-self:flex-start;font-size:clamp(12px,2vmin,18px);opacity:.7;margin:0}',
        '#pek-profiles .hp-opts{display:flex;flex-wrap:wrap;justify-content:center;gap:1.4vmin;max-height:34vh;overflow:auto;padding:4px}',
        '#pek-profiles .hp-opt{background:none;border:0;padding:3px;margin:0;border-radius:14px;cursor:pointer;outline:none;color:inherit;font:inherit}',
        '#pek-profiles .hp-opt .hp-av{border-color:transparent}',
        '#pek-profiles .hp-opt.hp-on .hp-av{border-color:#fff3ea}',
        '#pek-profiles .hp-opt:focus .hp-av,#pek-profiles .hp-opt:hover .hp-av{border-color:#ff9a52;box-shadow:0 0 0 3px rgba(255,154,82,.35)}',
        '#pek-profiles .hp-dots{display:flex;gap:2.4vmin;margin:.6vmin 0}',
        '#pek-profiles .hp-dot{width:clamp(14px,2.6vmin,24px);height:clamp(14px,2.6vmin,24px);border-radius:50%;border:2px solid rgba(255,243,234,.6)}',
        '#pek-profiles .hp-dot.hp-fill{background:#ff9a52;border-color:#ff9a52}',
        '#pek-profiles .hp-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:1.4vmin;width:min(300px,80%)}',
        '#pek-profiles .hp-key{font:inherit;font-size:clamp(18px,3.2vmin,30px);color:#fff3ea;background:rgba(255,255,255,.1);border:2px solid rgba(255,243,234,.3);border-radius:14px;padding:1.3vmin 0;cursor:pointer;outline:none}',
        '#pek-profiles .hp-key:focus,#pek-profiles .hp-key:hover{border-color:#ff9a52;background:rgba(255,154,82,.22)}',
        '#pek-profiles .hp-key.hp-small{font-size:clamp(13px,2.2vmin,20px)}'
    ].join('');

    var root = null, state = { manage: manage, modal: null, setup: false, layers: [] };
    var fails = 0, lockUntil = 0;   // wrong-passcode counter (a speed bump, not real security)

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function initial(name) { var a = Array.from(String(name || '?').trim()); return (a[0] || '?').toUpperCase(); }
    function btn(label, cls, onClick) {
        var b = el('button', 'hp-btn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button'; b.setAttribute('data-f', '1');
        b.addEventListener('click', onClick);
        return b;
    }

    function scope() {
        var all = root ? root.querySelectorAll('.hp-shade') : [];
        return all.length ? all[all.length - 1] : root;
    }
    function focusables() {
        var sc = scope();
        if (!sc) return [];
        return [].slice.call(sc.querySelectorAll('[data-f]')).filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
    }
    function focusFirst(preferId) {
        var list = focusables(), t = null;
        if (preferId) t = list.filter(function (n) { return n.getAttribute('data-id') === preferId; })[0];
        if (!t) t = list[0];
        if (t) { try { t.focus({ preventScroll: false }); } catch (e) { t.focus(); } }
    }
    function moveFocus(dir) {
        var list = focusables(), cur = document.activeElement;
        if (list.indexOf(cur) < 0) { focusFirst(); return; }
        var cr = cur.getBoundingClientRect(), cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        var best = null, bestScore = Infinity;
        list.forEach(function (n) {
            if (n === cur) return;
            var r = n.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
            var ok = dir === 'left' ? dx < -4 : dir === 'right' ? dx > 4 : dir === 'up' ? dy < -4 : dy > 4;
            if (!ok) return;
            var horiz = dir === 'left' || dir === 'right';
            var score = (horiz ? Math.abs(dx) : Math.abs(dy)) + (horiz ? Math.abs(dy) : Math.abs(dx)) * 2.5;
            if (score < bestScore) { bestScore = score; best = n; }
        });
        if (best) best.focus();
    }

    // Layers: small dialogs (passcode pad, password check) that sit above the grid or the editor. Back closes the top one.
    function pushLayer(shade, extra) {
        var l = extra || {};
        l.shade = shade; l.prev = document.activeElement;
        state.layers.push(l);
        root.appendChild(shade);
        focusFirst();
        return l;
    }
    function popLayer() {
        var l = state.layers.pop();
        if (l && l.shade.parentNode) l.shade.parentNode.removeChild(l.shade);
        if (l && l.prev && l.prev.focus && document.body.contains(l.prev)) { try { l.prev.focus(); } catch (e) { focusFirst(); } } else focusFirst();
    }
    function closeAllLayers() {
        while (state.layers.length) { var l = state.layers.pop(); if (l.shade.parentNode) l.shade.parentNode.removeChild(l.shade); }
    }
    function cancelTop() {
        var l = state.layers[state.layers.length - 1];
        if (!l) return false;
        if (l.cancel) l.cancel(); else popLayer();
        return true;
    }

    function avatar(p, extra) {
        var a = el('div', 'hp-av' + (extra ? ' ' + extra : ''));
        a.style.background = p.color;
        var img = avatarUri(p.avatar);
        if (img) {
            a.style.backgroundImage = 'url("' + img + '")';
            a.style.backgroundSize = 'cover'; a.style.backgroundPosition = 'center'; a.style.backgroundRepeat = 'no-repeat';
        } else a.textContent = initial(p.name);
        if (p.pin) a.appendChild(el('span', 'hp-lock', '\uD83D\uDD12'));
        return a;
    }

    // ---------------- passcode pad ----------------
    // o: { title, sub, onComplete(pin) -> undefined (handled) | { msg } (stay open), cancel(), forgot() }
    function pinPad(o) {
        var digits = '';
        var shade = el('div', 'hp-shade'), panel = el('div', 'hp-panel');
        panel.appendChild(el('h2', '', o.title));
        if (o.sub) panel.appendChild(el('p', 'hp-sub', o.sub));
        var dots = el('div', 'hp-dots'), dotEls = [];
        for (var i = 0; i < PIN_LEN; i++) { var d = el('span', 'hp-dot'); dotEls.push(d); dots.appendChild(d); }
        panel.appendChild(dots);
        var msg = el('p', 'hp-msg', '');
        panel.appendChild(msg);
        function paint() { dotEls.forEach(function (d, j) { d.className = 'hp-dot' + (j < digits.length ? ' hp-fill' : ''); }); }
        var layer;
        function digit(k) {
            if (digits.length >= PIN_LEN) return;
            digits += k; paint();
            if (digits.length === PIN_LEN) {
                var pin = digits;
                setTimeout(function () {
                    var r = o.onComplete(pin);
                    if (r && r.msg !== undefined) { msg.textContent = r.msg; digits = ''; paint(); }
                }, 120);
            }
        }
        function back() { digits = digits.slice(0, -1); paint(); msg.textContent = ''; }
        function cancel() { popLayer(); if (o.cancel) o.cancel(); }
        var keys = el('div', 'hp-keys');
        ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (k) { keys.appendChild(btn(k, 'hp-key', function () { digit(k); })); });
        keys.appendChild(btn('Cancel', 'hp-key hp-small', cancel));
        keys.appendChild(btn('0', 'hp-key', function () { digit('0'); }));
        keys.appendChild(btn('\u232B', 'hp-key', back));
        [].forEach.call(keys.children, function (b) { b.className = b.className.replace('hp-btn ', ''); });
        panel.appendChild(keys);
        if (o.forgot) panel.appendChild(btn('Forgot passcode?', '', o.forgot));
        shade.appendChild(panel);
        layer = pushLayer(shade, { digit: digit, back: back, cancel: cancel });
        // start on the 5 key: handy with a remote
        var five = shade.querySelectorAll('.hp-key')[4]; if (five) five.focus();
        return layer;
    }

    // Asks for profile p's passcode; onOk runs once it is right (or was reset with the account password).
    function askPin(p, onOk) {
        pinPad({
            title: 'Enter passcode', sub: p.name,
            onComplete: function (pin) {
                var now = Date.now();
                if (now < lockUntil) return { msg: 'Too many tries. Wait ' + Math.ceil((lockUntil - now) / 1000) + 's.' };
                if (checkPin(p.pin, pin)) { fails = 0; closeAllLayers(); onOk(); return; }
                if (++fails >= 5) { fails = 0; lockUntil = now + 30000; return { msg: 'Too many tries. Wait 30s.' }; }
                return { msg: 'Wrong passcode.' };
            },
            forgot: function () { forgotPin(p, onOk); }
        });
    }

    // Choose a new passcode: enter it twice. cb(pin).
    function askNewPin(cb) {
        pinPad({
            title: 'Choose a passcode', sub: PIN_LEN + ' digits',
            onComplete: function (first) {
                popLayer();
                pinPad({
                    title: 'Enter it again', sub: 'to confirm',
                    onComplete: function (second) {
                        if (second !== first) { popLayer(); askNewPin(cb); return; }
                        popLayer(); cb(first);
                    }
                });
            }
        });
    }

    // The passcode is forgotten: the account password (checked by the cloud) removes it.
    function forgotPin(p, onOk) {
        var shade = el('div', 'hp-shade'), panel = el('div', 'hp-panel');
        panel.appendChild(el('h2', '', 'Forgot passcode?'));
        panel.appendChild(el('p', 'hp-sub', 'Enter your account password to remove the passcode from \u201C' + p.name + '\u201D. You can set a new one afterwards.'));
        var input = el('input', 'hp-input');
        input.type = 'password'; input.placeholder = 'Account password'; input.maxLength = 200;
        input.setAttribute('data-f', '1'); input.setAttribute('autocomplete', 'current-password');
        panel.appendChild(input);
        var msg = el('p', 'hp-msg', ''); panel.appendChild(msg);
        var busy = false;
        function go() {
            var S = window.PekSync;
            if (busy) return;
            if (!input.value) { msg.textContent = 'Enter your password.'; return; }
            if (!S || !S.confirmPassword) { msg.textContent = 'Not available right now.'; return; }
            busy = true; msg.textContent = 'Checking\u2026';
            S.confirmPassword(input.value).then(function (r) {
                busy = false;
                if (r && r.ok) {
                    p.pin = ''; p.updated = Date.now(); save();
                    closeAllLayers(); renderGrid(p.id); onOk();
                    return;
                }
                var e = r && r.error;
                msg.textContent = e === 'bad_credentials' ? 'That password is not right.' : e === 'rate_limited' ? 'Too many tries. Try again later.'
                    : e === 'offline' ? 'No connection. Try again when you are online.' : e === 'not_found' ? 'The cloud service needs an update for this.' : 'Something went wrong. Try again.';
            });
        }
        input.__submit = go;
        var actions = el('div', 'hp-actions');
        actions.appendChild(btn('Confirm', 'hp-primary', go));
        actions.appendChild(btn('Cancel', '', function () { popLayer(); }));
        panel.appendChild(actions);
        shade.appendChild(panel);
        pushLayer(shade, {});
    }

    // ---------------- grid ----------------
    function renderGrid(focusId) {
        state.modal = null; state.setup = false; closeAllLayers();
        root.textContent = '';
        var wrap = el('div', 'hp-wrap');
        wrap.appendChild(el('h1', '', state.manage ? 'Manage Profiles' : 'Who\u2019s watching?'));
        var row = el('div', 'hp-row');
        reg.list.forEach(function (p) {
            var t = el('button', 'hp-tile');
            t.type = 'button'; t.setAttribute('data-f', '1'); t.setAttribute('data-id', p.id);
            var av = avatar(p);
            if (state.manage) av.appendChild(el('span', 'hp-edit', '\u270E'));
            t.appendChild(av);
            t.appendChild(el('span', 'hp-name', p.name));
            t.addEventListener('click', function () {
                var go = function () { if (state.manage) openEditor(p.id); else enter(p.id); };
                if (p.pin) askPin(p, go); else go();
            });
            row.appendChild(t);
        });
        if (reg.list.length < MAX && hasAccount()) {
            var at = el('button', 'hp-tile');
            at.type = 'button'; at.setAttribute('data-f', '1'); at.setAttribute('data-id', '__add');
            at.appendChild(el('div', 'hp-av hp-add', '+'));
            at.appendChild(el('span', 'hp-name', 'Add Profile'));
            at.addEventListener('click', function () { openEditor(null); });
            row.appendChild(at);
        }
        wrap.appendChild(row);
        var bar = el('div', 'hp-actions');
        bar.appendChild(btn(state.manage ? 'Done' : 'Manage Profiles', state.manage ? 'hp-primary' : '', function () {
            state.manage = !state.manage; renderGrid('__mode');
        }));
        bar.lastChild.setAttribute('data-id', '__mode');
        wrap.appendChild(bar);
        root.appendChild(wrap);
        focusFirst(focusId || (state.manage ? null : activeId));
    }

    // First time with an account: a name and a picture are required. The existing local profile becomes the main one,
    // so everything watched before the account is kept.
    function renderSetup() {
        state.setup = true;
        root.textContent = '';
        var wrap = el('div', 'hp-wrap');
        wrap.appendChild(el('h1', '', 'Welcome to PEK TV'));
        wrap.appendChild(el('p', 'hp-sub', 'Set up your profile. Everything you watched before is kept in it.'));
        root.appendChild(wrap);
        openEditor(reg.list[0].id, { setup: true });
    }

    // Editor for one profile (id) or a new one (null).  o.setup: the mandatory first-time version (no cancel, no delete).
    function openEditor(id, o) {
        o = o || {};
        var existing = id ? reg.list.filter(function (p) { return p.id === id; })[0] : null;
        var draft = {
            name: existing && !o.setup ? existing.name : '',
            color: existing ? existing.color : nextColor(),
            avatar: existing ? existing.avatar || '' : '',
            pin: existing ? existing.pin || '' : ''
        };
        if (o.setup && !draft.avatar) draft.avatar = 'b:' + AV_KEYS[Math.floor(Math.random() * AV_KEYS.length)];
        var armed = false;

        var shade = el('div', 'hp-shade');
        var panel = el('div', 'hp-panel');
        panel.appendChild(el('h2', '', o.setup ? 'Create your profile' : existing ? 'Edit Profile' : 'New Profile'));
        var preview = avatar({ name: draft.name || '?', color: draft.color, avatar: draft.avatar, pin: draft.pin }, 'hp-small');
        panel.appendChild(preview);

        var input = el('input', 'hp-input');
        input.type = 'text'; input.maxLength = NAME_MAX; input.placeholder = 'Name'; input.value = draft.name;
        input.setAttribute('data-f', '1'); input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'words');
        input.addEventListener('input', function () { draft.name = input.value; refresh(); });
        panel.appendChild(input);

        panel.appendChild(el('p', 'hp-label', 'Picture'));
        var opts = el('div', 'hp-opts');
        panel.appendChild(opts);
        var fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
        panel.appendChild(fileInput);
        var msg = el('p', 'hp-msg', '');

        function option(label, value, extra) {
            var b = el('button', 'hp-opt' + (draft.avatar === value ? ' hp-on' : ''));
            b.type = 'button'; b.setAttribute('data-f', '1'); b.setAttribute('aria-label', label);
            b.appendChild(avatar({ name: draft.name || '?', color: draft.color, avatar: value }, 'hp-mini'));
            b.setAttribute('data-v', value);
            b.addEventListener('click', function () {
                draft.avatar = value; refresh();
                var again = [].slice.call(opts.children).filter(function (n) { return n.getAttribute('data-v') === value; })[0];
                if (again) again.focus();
            });
            return b;
        }
        function renderOpts() {
            opts.textContent = '';
            opts.appendChild(option('Letter', ''));
            AV_KEYS.forEach(function (k) { opts.appendChild(option(k, 'b:' + k)); });
            if (draft.avatar.indexOf('d:') === 0) opts.appendChild(option('Your photo', draft.avatar));
        }
        function refresh() {
            var np = avatar({ name: draft.name || '?', color: draft.color, avatar: draft.avatar, pin: draft.pin }, 'hp-small');
            panel.replaceChild(np, preview); preview = np;
            renderOpts(); renderPin();
        }
        var uploadBtn = btn('Upload photo', '', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            var f = fileInput.files && fileInput.files[0];
            try { fileInput.value = ''; } catch (e) { /* ignore */ }
            if (!f) return;
            msg.textContent = 'Loading picture\u2026';
            photoToAvatar(f, function (uri) {
                if (!uri) { msg.textContent = 'That picture could not be used.'; return; }
                msg.textContent = ''; draft.avatar = 'd:' + uri; refresh();
            });
        });
        panel.appendChild(uploadBtn);

        panel.appendChild(el('p', 'hp-label', 'Colour'));
        var colors = el('div', 'hp-colors');
        var swatches = [];
        COLORS.forEach(function (c) {
            var sw = el('button', 'hp-sw' + (c === draft.color ? ' hp-on' : ''), c === draft.color ? '\u2713' : '');
            sw.type = 'button'; sw.style.background = c; sw.setAttribute('data-f', '1'); sw.setAttribute('aria-label', 'Colour');
            sw.addEventListener('click', function () {
                draft.color = c;
                swatches.forEach(function (x) { var on = x.c === c; x.n.className = 'hp-sw' + (on ? ' hp-on' : ''); x.n.textContent = on ? '\u2713' : ''; });
                refresh();
            });
            swatches.push({ c: c, n: sw }); colors.appendChild(sw);
        });
        panel.appendChild(colors);

        // Passcode (optional)
        panel.appendChild(el('p', 'hp-label', 'Passcode (optional)'));
        var pinRow = el('div', 'hp-actions');
        panel.appendChild(pinRow);
        function setPin(pin) { draft.pin = makePin(pin); refresh(); if (pinRow.firstChild) pinRow.firstChild.focus(); }
        function renderPin() {
            pinRow.textContent = '';
            if (draft.pin) {
                pinRow.appendChild(btn('Change passcode', '', function () { askNewPin(setPin); }));
                pinRow.appendChild(btn('Remove passcode', '', function () { draft.pin = ''; refresh(); if (pinRow.firstChild) pinRow.firstChild.focus(); }));
            } else {
                pinRow.appendChild(btn('Set a passcode', '', function () { askNewPin(setPin); }));
            }
        }
        panel.appendChild(msg);

        var actions = el('div', 'hp-actions');
        actions.appendChild(btn(o.setup ? 'Continue' : existing ? 'Save' : 'Create', 'hp-primary', function () {
            var name = clean(draft.name);
            if (!name) { msg.textContent = 'Enter a name.'; input.focus(); return; }
            if (nameTaken(name, id)) { msg.textContent = 'Another profile already has that name.'; input.focus(); return; }
            if (existing) updateProfile(id, name, draft.color, draft.avatar, draft.pin);
            else { var np = addProfile(name, draft.color, draft.avatar, draft.pin); id = np ? np.id : null; }
            if (o.setup) { reg.setupDone = true; save(); enter(id); return; }
            closeEditor(id);
        }));
        if (!o.setup) actions.appendChild(btn('Cancel', '', function () { closeEditor(id); }));
        if (existing && !o.setup && reg.list.length > 1) {
            var del = btn('Delete', 'hp-danger', function () {
                if (!armed) {
                    armed = true; del.textContent = 'Press again to delete'; del.className += ' hp-armed';
                    msg.textContent = 'This also deletes its favorites and watch history.';
                    return;
                }
                removeProfile(id); closeEditor(null);
            });
            actions.appendChild(del);
        }
        panel.appendChild(actions);
        renderOpts(); renderPin();
        shade.appendChild(panel);
        root.appendChild(shade);
        state.modal = true;
        focusFirst();
    }
    function closeEditor(focusId) {
        state.modal = null;
        renderGrid(focusId || activeId);
    }

    // Keys: the app is not running yet, so this screen has the keyboard / remote to itself.
    function onKey(e) {
        if (!root) return;
        var k = e.key, c = e.keyCode, t = e.target, inInput = t && t.tagName === 'INPUT';
        var top = state.layers[state.layers.length - 1];
        if (top && top.digit && !inInput) {   // passcode pad: number keys and backspace
            if (/^[0-9]$/.test(k)) { e.preventDefault(); e.stopPropagation(); top.digit(k); return; }
            if (k === 'Backspace' || c === 8) { e.preventDefault(); e.stopPropagation(); top.back(); return; }
        }
        var dir = (k === 'ArrowLeft' || c === 37) ? 'left' : (k === 'ArrowRight' || c === 39) ? 'right'
            : (k === 'ArrowUp' || c === 38) ? 'up' : (k === 'ArrowDown' || c === 40) ? 'down' : null;
        if (dir) {
            e.stopPropagation();
            if (inInput && (dir === 'left' || dir === 'right')) return;   // move the text cursor
            e.preventDefault(); moveFocus(dir); return;
        }
        if (k === 'Enter' || c === 13 || k === 'Select') {
            e.stopPropagation();
            if (inInput) { if (t.__submit) { e.preventDefault(); t.__submit(); } return; }   // else let the on-screen keyboard open
            var a = document.activeElement;
            if (a && a.getAttribute && a.getAttribute('data-f')) { e.preventDefault(); a.click(); }
            return;
        }
        if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || c === 27 || c === 4) {
            if (state.layers.length) { e.preventDefault(); e.stopPropagation(); cancelTop(); return; }
            if (state.setup) return;   // first-time setup cannot be skipped
            if (state.modal) { e.preventDefault(); e.stopPropagation(); closeEditor(null); return; }
            if (state.manage) { e.preventDefault(); e.stopPropagation(); state.manage = false; renderGrid('__mode'); return; }
            return;   // top level: leave Back alone, so the Android app's own "exit?" question still works
        }
        e.stopPropagation();
    }

    function show() {
        var st = document.createElement('style');
        st.id = 'pek-profiles-css'; st.textContent = CSS;
        document.head.appendChild(st);
        root = el('div', ''); root.id = 'pek-profiles';
        document.body.appendChild(root);
        // The Android app asks the page what Back should do (MainActivity -> window.__pekBack). Handle dialogs, the editor and
        // the manage screen; at the top level (and in the first-time setup) answer false, so the app's own "exit?" question appears.
        window.__pekBack = function () {
            if (state.layers.length) { cancelTop(); return true; }
            if (state.setup) return false;
            if (state.modal) { closeEditor(null); return true; }
            if (state.manage) { state.manage = false; renderGrid('__mode'); return true; }
            return false;
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', function (e) { if (root) e.stopPropagation(); }, true);
        if (needsSetup) renderSetup(); else renderGrid();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
})();
