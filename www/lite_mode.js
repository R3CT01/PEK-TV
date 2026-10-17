/* PEK performance mode (window.PekLite)
 * One switch for "go easy on a weak device". It adds html.pek-lite, which style.css uses to drop the costly paint
 * effects (live blur, soft wide shadows, full-screen fades), and the app uses it to skip the repaint fade,
 * and (low-spec only) the billboard trailer video.
 *
 * Mode: 'auto' (default), 'on', 'off'. Also ?lite=1 / ?lite=0 in the address.
 *   auto  -> light paint on TV boxes (html.pek-tv) and on devices that report little memory / few cores.
 *   on    -> everything above, plus no trailer video behind the billboard.
 *   off   -> never.
 * PekLite.on()      light paint applies (class is set)
 * PekLite.noVideo() the billboard trailer should not play: forced on, or auto-detected as a low-spec device.
 *                   A TV box alone does not stop trailers; turn the mode On for that.
 */
(function () {
    var KEY = 'pek-lite-mode';
    var root = document.documentElement;
    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* lasts until restart */ } }

    var q = /[?&]lite=([01])/.exec(location.search);
    if (q) put(KEY, q[1] === '1' ? 'on' : 'off');

    function mode() { var m = get(KEY); return m === 'on' || m === 'off' ? m : 'auto'; }
    function lowSpec() {
        try {
            var mem = navigator.deviceMemory, cores = navigator.hardwareConcurrency;
            return !!((mem && mem <= 2) || (cores && cores <= 2));
        } catch (e) { return false; }
    }
    function isTv() { return root.classList.contains('pek-tv'); }
    function on() { var m = mode(); return m === 'on' || (m === 'auto' && (isTv() || lowSpec())); }
    // Trailers are skipped only when performance mode is switched On by hand. A TV box that reports 2 GB / 2 cores used to be
    // auto-detected as low-spec and lost its billboard trailer (it still played on the detail page, which is why it seemed random).
    function noVideo() { return mode() === 'on'; }
    function apply() { root.classList.toggle('pek-lite', on()); }

    window.PekLite = {
        mode: mode, on: on, noVideo: noVideo, refresh: apply,
        setMode: function (m) { put(KEY, m === 'on' || m === 'off' ? m : 'auto'); apply(); }
    };
    apply();
})();
