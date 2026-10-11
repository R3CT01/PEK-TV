/* PEK TV profiles  (window.HesperProfiles)
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
    var PICKED = 'hesper_profile_picked';       // sessionStorage: a profile was chosen in this app session
    var MANAGE = 'hesper_profiles_manage';      // sessionStorage: open the picker in "manage" mode
    var MAX = 5;
    var NAME_MAX = 20;
    var COLORS = ['#E04A00', '#C2185B', '#7B1FA2', '#3949AB', '#0277BD', '#00897B', '#689F38', '#F9A825'];

    // Personal data: stored per profile.
    var SCOPED = /^(hesper_(favorites|progress|history|skip)|hesper_sync_(cursor|last|seen|pending)|hesper-(theme|skin|layout|poster-size|view|ember-seen|dashboard))/;
    // Device level (shared by all profiles): the cloud sign-in and the plugin backup, which belongs to the account.
    var ACCOUNT_KEYS = ['hesper_sync_token', 'hesper_sync_email', 'hesper_plugin_backup_on', 'hesper_plugin_backup_seen_v1', 'hesper_plugin_backup_pending_v1', 'hesper_plugin_backup_skip_v1'];
    var SYNC_STATE_KEYS = ['hesper_sync_cursor_v1', 'hesper_sync_last_v1', 'hesper_sync_seen_v1', 'hesper_sync_pending_v1'];

    var disabled = { enabled: false, pending: false, max: MAX, list: function () { return []; }, current: function () { return null; }, openPicker: function () {},
        snapshot: function () { return { list: [], tombs: {} }; }, mergeRemote: function () { return false; }, clearSyncState: function () {}, touch: function () {} };

    var ls, ss;
    try {
        ls = window.localStorage; ss = window.sessionStorage;
        ls.getItem('hesper_probe'); ss.setItem('hesper_probe', '1'); ss.removeItem('hesper_probe');
    } catch (e) { window.HesperProfiles = disabled; return; }   // no storage: no profiles, the app runs as before

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
        reg = { v: 2, active: 'p1', list: [{ id: 'p1', name: 'Profile 1', color: COLORS[0], updated: 0 }], tombs: {} };
        migrate('p1');
        s(REG_KEY, JSON.stringify(reg));
    }
    if (!reg.tombs || typeof reg.tombs !== 'object') reg.tombs = {};
    reg.list.forEach(function (p) { if (typeof p.updated !== 'number') p.updated = 0; if (!p.color) p.color = COLORS[0]; });
    if (!reg.v || reg.v < 2) { adoptAccount(reg.list); reg.v = 2; s(REG_KEY, JSON.stringify(reg)); }
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
    function addProfile(name, color) {
        if (reg.list.length >= MAX) return null;
        var p = { id: newId(), name: clean(name), color: color || nextColor(), updated: Date.now() };
        reg.list.push(p); save();
        return p;
    }
    function updateProfile(id, name, color) {
        reg.list.forEach(function (p) { if (p.id === id) { p.name = clean(name); p.color = color || p.color; p.updated = Date.now(); } });
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
    var pending = manage || (reg.list.length > 1 && !picked);

    function current() {
        for (var i = 0; i < reg.list.length; i++) if (reg.list[i].id === activeId) return { id: reg.list[i].id, name: reg.list[i].name, color: reg.list[i].color };
        return null;
    }

    // ---- for sync.js ----
    function snapshot() {
        return { list: reg.list.map(function (p) { return { id: p.id, name: p.name, color: p.color, updated: p.updated || 0 }; }), tombs: JSON.parse(JSON.stringify(reg.tombs)) };
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
                if (reg.list.length < MAX) { reg.list.push({ id: r.id, name: clean(r.name) || 'Profile', color: r.color || nextColor(), updated: r.updated || 0 }); changed = true; }
            } else if ((local.updated || 0) < (r.updated || 0)) {
                local.name = clean(r.name) || local.name; local.color = r.color || local.color; local.updated = r.updated; changed = true;
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

    window.HesperProfiles = {
        enabled: true,
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
        '#hesper-profiles{position:fixed;inset:0;z-index:2147483000;overflow:auto;color:#fff3ea;',
        'background:radial-gradient(ellipse at 50% 18%,#3a1706 0%,#170b05 55%,#0b0603 100%);',
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-tap-highlight-color:transparent;',
        'padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,0) env(safe-area-inset-left,0)}',
        '#hesper-profiles *{box-sizing:border-box}',
        '#hesper-profiles .hp-wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4vmin 3vmin;gap:4.5vmin}',
        '#hesper-profiles h1{margin:0;font-size:clamp(26px,5.2vmin,52px);font-weight:600;letter-spacing:.01em;text-align:center}',
        '#hesper-profiles .hp-row{display:flex;flex-wrap:wrap;justify-content:center;gap:3.2vmin;max-width:96vw}',
        '#hesper-profiles .hp-tile{background:none;border:0;padding:6px;margin:0;color:inherit;font:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:1.4vmin;border-radius:14px;outline:none;transition:transform .12s ease}',
        '#hesper-profiles .hp-av{position:relative;width:clamp(88px,17vmin,170px);height:clamp(88px,17vmin,170px);border-radius:16px;display:flex;align-items:center;justify-content:center;',
        'font-size:clamp(40px,8.4vmin,84px);font-weight:700;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.35);border:4px solid transparent;transition:border-color .12s ease,box-shadow .12s ease}',
        '#hesper-profiles .hp-av.hp-add{background:rgba(255,255,255,.08);border:3px dashed rgba(255,243,234,.4);font-weight:300}',
        '#hesper-profiles .hp-edit{position:absolute;right:-6px;bottom:-6px;width:36%;height:36%;border-radius:50%;background:#fff3ea;color:#2a1206;font-size:.4em;display:flex;align-items:center;justify-content:center;text-shadow:none}',
        '#hesper-profiles .hp-name{font-size:clamp(15px,2.6vmin,26px);opacity:.85;max-width:20vmin;min-width:12vmin;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#hesper-profiles .hp-tile:focus,#hesper-profiles .hp-tile:hover{transform:scale(1.07)}',
        '#hesper-profiles .hp-tile:focus .hp-av,#hesper-profiles .hp-tile:hover .hp-av{border-color:#ff9a52;box-shadow:0 0 0 3px rgba(255,154,82,.35),0 10px 30px rgba(0,0,0,.5)}',
        '#hesper-profiles .hp-tile:focus .hp-name,#hesper-profiles .hp-tile:hover .hp-name{opacity:1}',
        '#hesper-profiles .hp-btn{font:inherit;font-size:clamp(15px,2.5vmin,24px);color:#fff3ea;background:rgba(255,255,255,.1);border:2px solid rgba(255,243,234,.35);border-radius:999px;padding:1.3vmin 3.4vmin;cursor:pointer;outline:none}',
        '#hesper-profiles .hp-btn:focus,#hesper-profiles .hp-btn:hover{border-color:#ff9a52;background:rgba(255,154,82,.22);color:#fff}',
        '#hesper-profiles .hp-btn.hp-primary{background:#E04A00;border-color:#E04A00}',
        '#hesper-profiles .hp-btn.hp-primary:focus,#hesper-profiles .hp-btn.hp-primary:hover{background:#ff6a1f;border-color:#ffd2b0}',
        '#hesper-profiles .hp-btn.hp-danger{border-color:#e5484d;color:#ffb4b6}',
        '#hesper-profiles .hp-btn.hp-danger.hp-armed{background:#c62828;color:#fff;border-color:#ff9a9a}',
        '#hesper-profiles .hp-shade{position:fixed;inset:0;background:rgba(5,2,1,.78);display:flex;align-items:center;justify-content:center;padding:3vmin;overflow:auto}',
        '#hesper-profiles .hp-panel{background:#24120a;border:1px solid rgba(255,154,82,.35);border-radius:20px;padding:4vmin;width:min(560px,94vw);display:flex;flex-direction:column;align-items:center;gap:2.6vmin}',
        '#hesper-profiles .hp-panel h2{margin:0;font-size:clamp(20px,3.6vmin,34px);font-weight:600}',
        '#hesper-profiles .hp-input{width:100%;font:inherit;font-size:clamp(18px,3vmin,28px);color:#fff3ea;background:rgba(255,255,255,.08);border:2px solid rgba(255,243,234,.35);border-radius:12px;padding:1.4vmin 2vmin;outline:none;text-align:center}',
        '#hesper-profiles .hp-input:focus{border-color:#ff9a52;background:rgba(255,154,82,.12)}',
        '#hesper-profiles .hp-colors{display:flex;flex-wrap:wrap;justify-content:center;gap:1.8vmin}',
        '#hesper-profiles .hp-sw{width:clamp(34px,6vmin,56px);height:clamp(34px,6vmin,56px);border-radius:50%;border:3px solid transparent;padding:0;cursor:pointer;outline:none;color:#fff;font-size:clamp(14px,2.6vmin,24px);line-height:1}',
        '#hesper-profiles .hp-sw.hp-on{border-color:#fff3ea}',
        '#hesper-profiles .hp-sw:focus,#hesper-profiles .hp-sw:hover{border-color:#ff9a52;transform:scale(1.15)}',
        '#hesper-profiles .hp-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:1.8vmin}',
        '#hesper-profiles .hp-msg{min-height:1.4em;font-size:clamp(13px,2.2vmin,20px);color:#ffcfae;text-align:center;margin:0}',
        '#hesper-profiles .hp-av.hp-small{width:clamp(64px,11vmin,110px);height:clamp(64px,11vmin,110px);font-size:clamp(30px,5.6vmin,56px)}'
    ].join('');

    var root = null, state = { manage: manage, modal: null };

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

    function scope() { return (root && root.querySelector('.hp-shade')) || root; }
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

    function avatar(p, extra) {
        var a = el('div', 'hp-av' + (extra ? ' ' + extra : ''), initial(p.name));
        a.style.background = p.color;
        return a;
    }

    function renderGrid(focusId) {
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
            t.addEventListener('click', function () { if (state.manage) openEditor(p.id); else enter(p.id); });
            row.appendChild(t);
        });
        if (reg.list.length < MAX) {
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

    // Editor for one profile (id) or a new one (null).
    function openEditor(id) {
        var existing = id ? reg.list.filter(function (p) { return p.id === id; })[0] : null;
        var draft = { name: existing ? existing.name : '', color: existing ? existing.color : nextColor() };
        var armed = false;

        var shade = el('div', 'hp-shade');
        var panel = el('div', 'hp-panel');
        panel.appendChild(el('h2', '', existing ? 'Edit Profile' : 'New Profile'));
        var preview = avatar({ name: draft.name || '?', color: draft.color }, 'hp-small');
        panel.appendChild(preview);

        var input = el('input', 'hp-input');
        input.type = 'text'; input.maxLength = NAME_MAX; input.placeholder = 'Name'; input.value = draft.name;
        input.setAttribute('data-f', '1'); input.setAttribute('autocomplete', 'off'); input.setAttribute('autocapitalize', 'words');
        input.addEventListener('input', function () { draft.name = input.value; preview.textContent = initial(input.value || '?'); });
        panel.appendChild(input);

        var colors = el('div', 'hp-colors');
        var swatches = [];
        COLORS.forEach(function (c) {
            var sw = el('button', 'hp-sw' + (c === draft.color ? ' hp-on' : ''), c === draft.color ? '\u2713' : '');
            sw.type = 'button'; sw.style.background = c; sw.setAttribute('data-f', '1'); sw.setAttribute('aria-label', 'Colour');
            sw.addEventListener('click', function () {
                draft.color = c; preview.style.background = c;
                swatches.forEach(function (o) { var on = o.c === c; o.n.className = 'hp-sw' + (on ? ' hp-on' : ''); o.n.textContent = on ? '\u2713' : ''; });
            });
            swatches.push({ c: c, n: sw }); colors.appendChild(sw);
        });
        panel.appendChild(colors);

        var msg = el('p', 'hp-msg', '');
        panel.appendChild(msg);

        var actions = el('div', 'hp-actions');
        actions.appendChild(btn(existing ? 'Save' : 'Create', 'hp-primary', function () {
            var name = clean(draft.name);
            if (!name) { msg.textContent = 'Enter a name.'; input.focus(); return; }
            if (nameTaken(name, id)) { msg.textContent = 'Another profile already has that name.'; input.focus(); return; }
            if (existing) updateProfile(id, name, draft.color); else { var np = addProfile(name, draft.color); id = np ? np.id : null; }
            closeEditor(id);
        }));
        actions.appendChild(btn('Cancel', '', function () { closeEditor(id); }));
        if (existing && reg.list.length > 1) {
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
        var dir = (k === 'ArrowLeft' || c === 37) ? 'left' : (k === 'ArrowRight' || c === 39) ? 'right'
            : (k === 'ArrowUp' || c === 38) ? 'up' : (k === 'ArrowDown' || c === 40) ? 'down' : null;
        if (dir) {
            e.stopPropagation();
            if (inInput && (dir === 'left' || dir === 'right')) return;   // move the text cursor
            e.preventDefault(); moveFocus(dir); return;
        }
        if (k === 'Enter' || c === 13 || k === 'Select') {
            e.stopPropagation();
            if (inInput) return;                                          // let the on-screen keyboard open
            var a = document.activeElement;
            if (a && a.getAttribute && a.getAttribute('data-f')) { e.preventDefault(); a.click(); }
            return;
        }
        if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || c === 27 || c === 4) {
            if (state.modal) { e.preventDefault(); e.stopPropagation(); closeEditor(null); return; }
            if (state.manage) { e.preventDefault(); e.stopPropagation(); state.manage = false; renderGrid('__mode'); return; }
            return;   // top level: leave Back alone, so the Android app's own "exit?" question still works
        }
        e.stopPropagation();
    }

    function show() {
        var st = document.createElement('style');
        st.id = 'hesper-profiles-css'; st.textContent = CSS;
        document.head.appendChild(st);
        root = el('div', ''); root.id = 'hesper-profiles';
        document.body.appendChild(root);
        // The Android app asks the page what Back should do (MainActivity -> window.__hesperBack). Handle the editor and
        // the manage screen; at the top level answer false, so the app's own "exit?" question appears.
        window.__hesperBack = function () {
            if (state.modal) { closeEditor(null); return true; }
            if (state.manage) { state.manage = false; renderGrid('__mode'); return true; }
            return false;
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', function (e) { if (root) e.stopPropagation(); }, true);
        renderGrid();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
})();
