/* PEK TV mode (window.PekTV): the "10-foot" look.
 * - Adds/removes html.pek-tv (bigger text that scales with the screen, TV-safe margins, bold focus ring; see style.css).
 * - Mode: 'auto' (on for the Android app on a TV box, off on a phone), 'on', 'off'. Also ?tv=1 / ?tv=0 in the address.
 * - Safe margin: percent of the screen kept clear at the edges (0, 2, 4 or 6) for TVs that crop the picture.
 * - Hides the mouse pointer after a few idle seconds (TV mode only).
 * - Game controllers (browser / desktop only: Android already turns a controller into D-pad keys):
 *   D-pad / left stick = arrows, A = OK, B = Back, Y = menu (long-press), through the same key handling as a remote.
 */
(function () {
    var MODE_KEY = 'hesper-tv-mode', SAFE_KEY = 'hesper-tv-safe';
    var root = document.documentElement;
    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* lasts until restart */ } }

    var q = /[?&]tv=([01])/.exec(location.search);
    if (q) put(MODE_KEY, q[1] === '1' ? 'on' : 'off');

    function isTvDevice() {
        try { var A = window.PekAndroid; return !!(A && (typeof A.isPhone !== 'function' || !A.isPhone())); } catch (e) { return false; }
    }
    function mode() { var m = get(MODE_KEY); return m === 'on' || m === 'off' ? m : 'auto'; }
    function safe() { var s = parseInt(get(SAFE_KEY), 10); return [0, 2, 4, 6].indexOf(s) >= 0 ? s : 2; }
    function isOn() { var m = mode(); return m === 'on' || (m === 'auto' && isTvDevice()); }

    function apply() {
        root.classList.toggle('pek-tv', isOn());
        var s = safe();
        root.style.setProperty('--tv-safe-x', s + 'vw');
        root.style.setProperty('--tv-safe-y', s + 'vh');
    }

    // ---- hide the pointer when idle ----
    var idleT = 0;
    function wake() {
        root.classList.remove('pek-idle');
        clearTimeout(idleT);
        if (isOn()) idleT = setTimeout(function () { root.classList.add('pek-idle'); }, 3000);
    }
    ['mousemove', 'mousedown', 'touchstart'].forEach(function (n) { window.addEventListener(n, wake, { passive: true }); });

    // ---- game controller -> key events (not on Android) ----
    var padRaf = 0, held = {}, nextAt = {};
    var MAP = { 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight', 0: 'Enter', 1: 'Escape', 3: 'ContextMenu' };
    function fire(type, key, repeat) {
        var t = document.activeElement || document.body;
        try { t.dispatchEvent(new KeyboardEvent(type, { key: key, bubbles: true, cancelable: true, repeat: !!repeat })); } catch (e) { /* ignore */ }
    }
    function pollPad() {
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        var down = {};
        for (var i = 0; i < pads.length; i++) {
            var p = pads[i];
            if (!p) continue;
            Object.keys(MAP).forEach(function (b) { if (p.buttons[b] && p.buttons[b].pressed) down[MAP[b]] = true; });
            var x = p.axes[0] || 0, y = p.axes[1] || 0;
            if (x < -0.6) down.ArrowLeft = true; else if (x > 0.6) down.ArrowRight = true;
            if (y < -0.6) down.ArrowUp = true; else if (y > 0.6) down.ArrowDown = true;
        }
        var now = Date.now();
        Object.keys(down).forEach(function (k) {
            var arrow = k.indexOf('Arrow') === 0;
            if (!held[k]) { held[k] = true; nextAt[k] = now + 400; fire('keydown', k, false); }
            else if (arrow && now >= nextAt[k]) { nextAt[k] = now + 100; fire('keydown', k, true); }
        });
        Object.keys(held).forEach(function (k) {
            if (!down[k]) { delete held[k]; fire('keyup', k, false); }
        });
        padRaf = requestAnimationFrame(pollPad);
    }
    if (!window.PekAndroid && navigator.getGamepads) {
        window.addEventListener('gamepadconnected', function () { if (!padRaf) padRaf = requestAnimationFrame(pollPad); });
        window.addEventListener('gamepaddisconnected', function () {
            var any = false, ps = navigator.getGamepads();
            for (var i = 0; i < ps.length; i++) if (ps[i]) any = true;
            if (!any && padRaf) { cancelAnimationFrame(padRaf); padRaf = 0; held = {}; }
        });
    }

    window.PekTV = {
        mode: mode, safe: safe, isOn: isOn,
        setMode: function (m) { put(MODE_KEY, m === 'on' || m === 'off' ? m : 'auto'); apply(); wake(); },
        setSafe: function (pct) { put(SAFE_KEY, String(pct)); apply(); }
    };
    apply();
    wake();
})();
