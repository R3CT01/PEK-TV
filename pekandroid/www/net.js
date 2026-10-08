/* ============================================================
   Hesper connectivity indicator (is_online)

   Shows a small dot in the top-right corner: green = online, red = offline.
   "Online" means the internet is really reachable, not just that the device is
   connected to Wi-Fi: it fetches a tiny page from the internet every so often
   (and right away when the system reports a change).

   Other code can use:
     HesperNet.isOnline()        true / false (true until the first check finishes)
     HesperNet.onChange(fn)      fn(online) is called whenever the state flips
     HesperNet.check()           check now

   Offline mode: the local library keeps working; anything that needs the
   internet (TMDb lookups, cross-device sync) should wait for isOnline().
   ============================================================ */
(function () {
    'use strict';

    // Tiny pages used only to see whether the internet is reachable. The first is
    // the same one Android itself uses; the second is a fallback.
    const PROBES = [
        'https://www.gstatic.com/generate_204',
        'https://cloudflare.com/cdn-cgi/trace'
    ];
    const TIMEOUT_MS = 5000;
    const POLL_ONLINE_MS = 30000;     // how often to re-check while online
    const POLL_OFFLINE_MS = 8000;     // ...and while offline, to notice recovery quickly

    const CSS = `
.hn-dot { position: fixed; top: 6px; right: 6px; width: 10px; height: 10px; border-radius: 50%;
    z-index: 9000; pointer-events: none; display: none;
    -webkit-transition: background 0.3s, box-shadow 0.3s; transition: background 0.3s, box-shadow 0.3s; }
.hn-dot.hn-show { display: block; }
.hn-dot.hn-online { background: #3fb950; box-shadow: 0 0 6px rgba(63, 185, 80, 0.85); }
.hn-dot.hn-offline { background: #f85149; box-shadow: 0 0 6px rgba(248, 81, 73, 0.9); }
`;

    let online = true;        // assumed until the first check says otherwise
    let known = false;
    let timer = null;
    let checking = false;
    const listeners = [];
    let dot = null;

    function paint() {
        if (!dot) return;
        dot.className = 'hn-dot hn-show ' + (online ? 'hn-online' : 'hn-offline');
        dot.title = online ? 'Online' : 'Offline mode: local library only';
    }

    function setOnline(v) {
        const changed = known && v !== online;
        online = v;
        known = true;
        paint();
        if (changed) {
            listeners.slice().forEach(function (fn) {
                try { fn(online); } catch (e) { console.error('[HesperNet]', e); }
            });
        }
    }

    // true if the URL answered at all (the reply is opaque; we only care that it arrived)
    function probeOne(url) {
        return new Promise(function (resolve) {
            const ctl = window.AbortController ? new AbortController() : null;
            let done = false;
            const finish = function (v) {
                if (done) return;
                done = true;
                clearTimeout(t);
                resolve(v);
            };
            const t = setTimeout(function () {
                finish(false);
                if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
            }, TIMEOUT_MS);
            const opts = { mode: 'no-cors', cache: 'no-store' };
            if (ctl) opts.signal = ctl.signal;
            fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(), opts)
                .then(function () { finish(true); }, function () { finish(false); });
        });
    }

    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(check, online ? POLL_ONLINE_MS : POLL_OFFLINE_MS);
    }

    async function check() {
        if (checking) return;
        checking = true;
        try {
            if (navigator.onLine === false) {
                setOnline(false);                 // the system says there is no network at all
            } else {
                let ok = false;
                for (let i = 0; i < PROBES.length && !ok; i++) ok = await probeOne(PROBES[i]);
                setOnline(ok);
            }
        } finally {
            checking = false;
            schedule();
        }
    }

    function start() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        dot = document.createElement('div');
        dot.className = 'hn-dot';
        document.body.appendChild(dot);

        window.addEventListener('online', check);
        window.addEventListener('offline', check);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) check();
        });
        check();
    }

    window.HesperNet = {
        isOnline: function () { return online; },
        isKnown: function () { return known; },
        onChange: function (fn) { listeners.push(fn); },
        check: check
    };

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
