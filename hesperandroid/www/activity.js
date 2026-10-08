/* PEK background activity  (window.HesperActivity)
 *
 * A small, quiet status line in the corner that says what PEK is doing behind the scenes
 * ("Scanning your media folders...", "Fetching poster art (12 left)", "Syncing watch history...").
 *
 * It never gets in the way: it is not focusable (the D-pad skips it), ignores taps and clicks, stays
 * small and half see-through, sits above the phone's tab bar, and is hidden while a video is playing.
 * Settings -> Background activity: Off / Basic / Detailed (Detailed adds plugin network requests etc.).
 *
 * API (used by PEK's own code):
 *   begin(id, text, detail)   something started (counted: every begin needs an end)
 *   update(id, text)          change the text of a running item
 *   end(id, doneText)         finished; doneText (optional) stays a moment as "done"
 *   note(text, detail)        a one-off message
 *   `detail` = true means only shown at the Detailed level.
 */
(function () {
    'use strict';
    var KEY = 'hesper-activity';
    var LEVELS = ['off', 'basic', 'detailed'];
    var level = 'basic';
    try { var v = localStorage.getItem(KEY); if (LEVELS.indexOf(v) >= 0) level = v; } catch (e) { /* default */ }

    var items = {};          // id -> { text, detail, count, done, order }
    var seq = 0, el = null, timer = null, hidden = false;
    var MAX_LINES = 3;

    function css() {
        var st = document.createElement('style');
        st.textContent =
            '#hesper-activity{position:fixed;right:10px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:2900;' +
            'max-width:min(70vw,420px);pointer-events:none;user-select:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px;' +
            'font:12px/1.3 system-ui,sans-serif;opacity:.85}' +
            '#hesper-activity .ha-line{display:flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;' +
            'background:rgba(15,18,26,.72);color:#e8edf5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}' +
            '#hesper-activity .ha-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--sx-accent,#58a6ff);animation:ha-pulse 1s ease-in-out infinite}' +
            '#hesper-activity .ha-done .ha-dot{animation:none;background:#4cc38a}' +
            '#hesper-activity .ha-txt{overflow:hidden;text-overflow:ellipsis}' +
            '@keyframes ha-pulse{0%,100%{opacity:.35}50%{opacity:1}}' +
            '@media (max-width:720px){#hesper-activity{bottom:calc(66px + env(safe-area-inset-bottom,0px));right:8px;font-size:11px}}' +
            'html.hp-typing #hesper-activity{display:none}' +
            'html.hp-mini-on #hesper-activity{bottom:calc(var(--hp-mini-h,68px) + 8px)}' +
            '@media (prefers-reduced-motion:reduce){#hesper-activity .ha-dot{animation:none}}';
        document.head.appendChild(st);
    }

    function mount() {
        if (el || !document.body) return;
        css();
        el = document.createElement('div');
        el.id = 'hesper-activity';
        el.setAttribute('aria-hidden', 'true');           // decoration only: not read out, not focusable
        document.body.appendChild(el);
        draw();
    }

    function visible(it) { return level === 'detailed' || (level === 'basic' && !it.detail); }

    function draw() {
        timer = null;
        if (!el) return;
        var list = Object.keys(items).map(function (k) { return items[k]; })
            .filter(function (it) { return visible(it) && (it.done || Date.now() - it.t < 90000); })   // a stuck item fades out
            .sort(function (a, b) { return a.order - b.order; }).slice(-MAX_LINES);
        el.style.display = (hidden || level === 'off' || !list.length) ? 'none' : 'flex';
        el.textContent = '';
        list.forEach(function (it) {
            var line = document.createElement('div');
            line.className = 'ha-line' + (it.done ? ' ha-done' : '');
            var dot = document.createElement('span'); dot.className = 'ha-dot';
            var t = document.createElement('span'); t.className = 'ha-txt'; t.textContent = it.text;
            line.appendChild(dot); line.appendChild(t);
            el.appendChild(line);
        });
    }

    function redraw() { if (!timer) timer = setTimeout(draw, 120); }      // batch bursts of updates

    function expire(id, ms) {
        setTimeout(function () { if (items[id] && items[id].done) { delete items[id]; redraw(); } }, ms);
    }

    var A = {
        begin: function (id, text, detail) {
            if (level === 'off') return;
            var it = items[id];
            if (it && !it.done) { it.count++; if (text) it.text = String(text).slice(0, 120); it.t = Date.now(); }
            else items[id] = { t: Date.now(), text: String(text || id).slice(0, 120), detail: !!detail, count: 1, done: false, order: ++seq };
            redraw();
        },
        update: function (id, text) {
            if (level === 'off') return;
            var it = items[id];
            if (!it || it.done) return A.begin(id, text, false);
            it.text = String(text).slice(0, 120); it.t = Date.now();
            redraw();
        },
        end: function (id, doneText) {
            var it = items[id];
            if (!it || it.done) return;
            if (--it.count > 0) return;                    // another request of the same kind is still running
            if (doneText && level !== 'off') { it.text = String(doneText).slice(0, 120); it.done = true; redraw(); expire(id, 2500); }
            else { it.done = true; redraw(); expire(id, 600); }
        },
        note: function (text, detail) {
            if (level === 'off') return;
            var id = 'note:' + (++seq);
            items[id] = { t: Date.now(), text: String(text).slice(0, 120), detail: !!detail, count: 0, done: true, order: seq };
            redraw(); expire(id, 3000);
        },
        levels: LEVELS.slice(),
        get: function () { return level; },
        set: function (l) {
            if (LEVELS.indexOf(l) < 0) return;
            level = l;
            try { localStorage.setItem(KEY, l); } catch (e) { /* not saved */ }
            if (l === 'off') items = {};
            else A.note('Background activity: ' + (l === 'basic' ? 'Basic' : 'Detailed'));
            redraw();
        }
    };
    window.HesperActivity = A;

    // Watching a video: no text over the picture.
    document.addEventListener('hesper-player', function (e) { hidden = !!(e && e.detail && e.detail.active); redraw(); });

    function start() {
        mount();
        // Things that happen in files loaded before or after this one are hooked here, once everything exists.
        var S = window.HesperSync, T = window.HesperTorrent, N = window.HesperNet;
        if (S && S.sync) {
            var sync = S.sync;
            S.sync = function () {
                A.begin('sync', 'Syncing watch history\u2026');
                var p = sync.apply(S, arguments);
                Promise.resolve(p).then(function (r) { A.end('sync', r && r.ok === false ? 'Sync failed' : 'Sync complete'); },
                    function () { A.end('sync', 'Sync failed'); });
                return p;
            };
        }
        if (T && T.search) {
            var search = T.search;
            T.search = function (q) {
                var name = q && q.title ? String(q.title).slice(0, 40) : '';
                A.begin('search', 'Searching releases' + (name ? ': ' + name : '') + '\u2026');
                var p = search.apply(T, arguments);
                Promise.resolve(p).then(function (r) { A.end('search', (r && r.length ? r.length + ' releases found' : 'No releases found')); },
                    function () { A.end('search', 'Release search failed'); });
                return p;
            };
        }
        if (T && T.open) {
            var open = T.open;
            T.open = function (o) {
                A.note('Starting stream' + (o && o.title ? ': ' + String(o.title).slice(0, 40) : '') + '\u2026');
                return open.apply(T, arguments);
            };
        }
        if (N && N.onChange) {
            N.onChange(function (online) { A.note(online ? 'Back online' : 'You are offline'); });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
