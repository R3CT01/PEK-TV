/* ============================================================
   Hesper: Skip Intro / Skip Recap
   Loaded before player.js. The player creates one HesperSkip.Controller per playback
   (library files AND torrent streams: both go through HesperPlayer).

   Where the skip spans come from
     1. Chapters inside the file (mpv reports them). A chapter called "Intro", "Opening",
        "OP", "Recap", "Previously on ..." is a skip span. Exact, and works the same for a
        torrent stream, because the chapter list sits in the file header.
     2. Times from a community database (IntroDB), looked up automatically for episodes of
        a show: nobody has to mark anything. The backend (/api/skip-segments) turns the show
        name into an IMDb id and asks the database for this season and episode; the answer is
        cached. Library files and torrent streams are treated the same. Turn it off in the
        Skip menu ("Look up intro/recap online").
     3. Spans you mark once per show (player menu > Skip). They are saved per show (and per
        season) and offered on every other episode of that show, library or torrent alike.
        Episodes start the intro at slightly different times (cold opens), so a saved span
        shows its button a little early and stays until the saved end.

   Saved spans live in localStorage 'hesper_skip_v1'. Auto-skip ('hesper_skip_auto') acts on
   chapter spans and database spans (both are exact for this episode): a span you marked on
   another episode is a good guess, not a fact, so it is never skipped without a tap.
   Order of trust: chapters, then the database, then your own marks.
   ============================================================ */
(function () {
    'use strict';

    const STORE_KEY = 'hesper_skip_v1';
    const AUTO_KEY = 'hesper_skip_auto';
    const ONLINE_KEY = 'hesper_skip_online';          // '0' = never ask the database (default: on)
    const STYLE_ID = 'hesper-skip-style';
    const MAX_SHOWS = 200;
    const KINDS = ['recap', 'intro'];                 // recap first: it comes first in an episode
    const LABEL = { intro: 'Skip Intro', recap: 'Skip Recap' };
    const SAVED_LEAD = 12;                            // seconds: a saved span's button appears this early
    const CHAPTER_LEAD = 1.5;
    const END_MARGIN = 2;                             // no button in the last 2 s of a span

    const RE = {
        recap: /\b(re-?cap|previously(\s+on)?|last\s+time|story\s+so\s+far)\b/i,
        intro: /\b(intro|opening(\s+(credits|theme|titles?|sequence))?|op\s?\d*|title\s+sequence|main\s+titles?)\b/i
    };

    // Phone / tablet with a touchscreen = native says so; everything else (Android TV, desktop) gets the TV dialog.
    function isTv() {
        try { const a = window.HesperAndroid; return !(a && typeof a.isPhone === 'function' && a.isPhone()); }
        catch (e) { return true; }
    }

    function fmt(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        const m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // ---------------- storage ----------------
    function load() {
        try { const o = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; }
        catch (e) { return {}; }
    }
    function save(o) {
        try {
            const keys = Object.keys(o);
            if (keys.length > MAX_SHOWS) {                        // keep the most recently used
                keys.sort((a, b) => ((o[a] && o[a].u) || 0) - ((o[b] && o[b].u) || 0));
                keys.slice(0, keys.length - MAX_SHOWS).forEach(k => { delete o[k]; });
            }
            localStorage.setItem(STORE_KEY, JSON.stringify(o));
        } catch (e) { /* storage unavailable: lasts until restart only */ }
    }

    // One key per show, one per show+season. Movies have none (chapters still work for them).
    function keysFor(meta) {
        if (!meta) return null;
        let name = '';
        if (meta.kind === 'episode') name = meta.showTitle;
        else if (meta.kind === 'other' && ((meta.season | 0) || (meta.episode | 0))) name = meta.title;
        name = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!name) return null;
        const season = meta.season | 0;
        return { show: name, season: season > 0 ? name + '|s' + season : null };
    }

    function get(meta, kind) {
        const k = keysFor(meta);
        if (!k) return null;
        const db = load();
        const a = k.season && db[k.season] && db[k.season][kind];
        const b = db[k.show] && db[k.show][kind];
        const r = a || b;
        return r && r.e > r.s ? { start: r.s, end: r.e } : null;
    }

    function set(meta, kind, start, end) {
        const k = keysFor(meta);
        if (!k || !(end - start >= 3) || end - start > 600) return false;
        const db = load(), now = Date.now();
        [k.show, k.season].forEach(key => {
            if (!key) return;
            const rec = db[key] || {};
            rec[kind] = { s: Math.round(start * 10) / 10, e: Math.round(end * 10) / 10 };
            rec.u = now;
            db[key] = rec;
        });
        save(db);
        return true;
    }

    function clear(meta) {
        const k = keysFor(meta);
        if (!k) return;
        const db = load();
        Object.keys(db).forEach(key => { if (key === k.show || key.indexOf(k.show + '|s') === 0) delete db[key]; });
        save(db);
    }

    function hasAny(meta) { return !!(get(meta, 'intro') || get(meta, 'recap')); }

    function autoOn() { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { return false; } }
    function onlineOn() { try { return localStorage.getItem(ONLINE_KEY) !== '0'; } catch (e) { return true; } }
    function setOnline(on) { try { localStorage.setItem(ONLINE_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ } }
    function setAuto(on) { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ } }

    // ---------------- chapters -> spans ----------------
    // chapters: [{ title, time }] in seconds, in order.
    function chapterSpans(chapters, duration) {
        const out = [];
        (chapters || []).forEach((c, i) => {
            const title = String((c && c.title) || '');
            const start = +c.time;
            if (!title || !isFinite(start)) return;
            const next = chapters[i + 1];
            const end = next && isFinite(+next.time) ? +next.time : (duration > 0 ? duration : 0);
            const len = end - start;
            if (!(len >= 8 && len <= 400)) return;                 // too short / too long to be an intro or recap
            let kind = '';
            if (RE.recap.test(title)) kind = 'recap';
            else if (RE.intro.test(title) && len <= 300) kind = 'intro';
            if (kind) out.push({ id: 'c' + i, kind: kind, start: start, end: end, src: 'chapter' });
        });
        return out;
    }

    // ---------------- database answer -> spans ----------------
    // The exact shape of the database answer is not relied on: walk it and take every object
    // that has a type ("intro" / "recap") and a start and end time, in seconds or milliseconds.
    function num(v) {
        if (typeof v === 'number') return isFinite(v) ? v : NaN;
        if (typeof v !== 'string' || !v) return NaN;
        const parts = v.trim().split(':');                        // "mm:ss" / "hh:mm:ss" / "12.5"
        if (parts.length > 3 || parts.some(p => p === '' || isNaN(+p))) return NaN;
        return parts.reduce((t, p) => t * 60 + (+p), 0);
    }
    function pick(o, names, ms) {
        for (let i = 0; i < names.length; i++) {
            if (o[names[i]] != null) { const n = num(o[names[i]]); if (!isNaN(n)) return ms ? n / 1000 : n; }
        }
        return NaN;
    }
    function remoteSpans(data, duration) {
        const out = [], seen = {};
        function add(kind, o) {
            if (!o || typeof o !== 'object') return;
            let a = pick(o, ['start_sec', 'startSec', 'start_seconds', 'start', 'from'], false);
            let b = pick(o, ['end_sec', 'endSec', 'end_seconds', 'end', 'to'], false);
            if (isNaN(a)) a = pick(o, ['start_ms', 'startMs', 'start_time_ms'], true);
            if (isNaN(b)) b = pick(o, ['end_ms', 'endMs', 'end_time_ms'], true);
            if (isNaN(a) || isNaN(b)) return;
            if (b - a > 600 && (b - a) / 1000 >= 5 && (b - a) / 1000 <= 600) { a /= 1000; b /= 1000; }   // it was milliseconds
            if (!(b - a >= 5 && b - a <= 600) || a < 0) return;       // not a plausible intro / recap
            if (duration > 0 && a >= duration - 5) return;
            if (seen[kind]) return;                                   // first (best-ranked) one per kind
            seen[kind] = true;
            out.push({ id: 'r' + kind, kind: kind, start: a, end: duration > 0 ? Math.min(b, duration) : b, src: 'remote' });
        }
        function kindOf(t) {
            t = String(t || '').toLowerCase();
            if (/recap|previously/.test(t)) return 'recap';
            if (/intro|opening/.test(t)) return 'intro';
            return '';
        }
        (function walk(v, key, depth) {
            if (!v || typeof v !== 'object' || depth > 5) return;
            if (Array.isArray(v)) { v.forEach(x => walk(x, key, depth + 1)); return; }
            const t = kindOf(v.segment_type || v.segmentType || v.type || v.kind || v.label || '');
            if (t) add(t, v);
            Object.keys(v).forEach(k => {
                const kk = kindOf(k);
                if (kk && v[k] && typeof v[k] === 'object') {
                    if (Array.isArray(v[k])) v[k].forEach(x => add(kk, x)); else add(kk, v[k]);
                }
                if (v[k] && typeof v[k] === 'object') walk(v[k], k, depth + 1);
            });
        })(data, '', 0);
        return out;
    }

    // ---------------- the button ----------------
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = `
.hp-skip { position: absolute; right: 22px; bottom: 28px; z-index: 3; display: none; align-items: center; gap: 8px;
    padding: 12px 22px; border-radius: 999px; font: inherit; font-size: 0.95rem; font-weight: 700; letter-spacing: 0.02em;
    cursor: pointer; white-space: nowrap;
    background-color: rgba(28, 24, 21, 0.78); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.8);
    border: 1px solid rgba(246, 242, 236, 0.32); border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.32);
    color: #f6f2ec; color: var(--hp-fg, #f6f2ec);
    -webkit-transition: bottom 0.28s ease, opacity 0.25s ease, -webkit-transform 0.15s; transition: bottom 0.28s ease, opacity 0.25s ease, transform 0.15s; }
.hp-skip.hp-on { display: flex; }
.hp-menu.hp-open ~ .hp-skip, .hp-confirm.hp-open ~ .hp-skip { display: none !important; }
.hp-skip.hp-quiet { opacity: 0.55; }
.hp-skip svg { width: 18px; height: 18px; }
.hp-show .hp-skip { bottom: 150px; }
.hp-skip.hp-focused, .hp-skip:active { background-color: #f3eee7; background-color: var(--hp-hi, #f3eee7); color: #1c1815; border-color: transparent;
    -webkit-transform: scale(1.05); transform: scale(1.05); }
/* TV / remote: a small dialog in the bottom-right corner, Prime-style. Already highlighted, so OK skips. */
.hp-skip.hp-tv { right: 56px; bottom: 64px; padding: 14px 30px; border-radius: 6px; font-size: 1.2rem; gap: 12px;
    background-color: #f3eee7; background-color: var(--hp-hi, #f3eee7); color: #1c1815; color: var(--hp-ink, #1c1815);
    border: 2px solid transparent; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    -webkit-animation: hp-skip-in 0.28s ease-out; animation: hp-skip-in 0.28s ease-out; }
.hp-skip.hp-tv.hp-quiet { opacity: 1; }
.hp-skip.hp-tv .hp-skip-key { font-size: 0.75rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; border: 1.5px solid currentColor; opacity: 0.7; }
.hp-show .hp-skip.hp-tv { bottom: 170px; }
@-webkit-keyframes hp-skip-in { from { opacity: 0; -webkit-transform: translateX(24px); } to { opacity: 1; -webkit-transform: none; } }
@keyframes hp-skip-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
@media (max-width: 700px) { .hp-skip { right: 14px; padding: 10px 16px; font-size: 0.85rem; } .hp-show .hp-skip { bottom: 128px; } }
`;
        document.head.appendChild(s);
    }

    // ---------------- per-playback controller ----------------
    class Controller {
        constructor(player, meta) {
            this.player = player;
            this.meta = meta || null;
            this.spans = [];          // from chapters
            this.remote = [];         // from the database (see fetchRemote)
            this._remoteTried = false;
            this.cur = null;          // the span the button offers right now
            this.autoDone = {};       // span id -> already auto-skipped / skipped once
            this.pending = {};        // kind -> start time marked, waiting for the end mark
            this.el = null;
            this._shownAt = 0;
        }

        // The pill. Lives inside the player's root so it is above the native video surface.
        mount(root) {
            injectStyle();
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hp-skip';
            b.setAttribute('aria-label', 'Skip');
            if (isTv()) b.className += ' hp-tv';
            b.addEventListener('click', (ev) => { ev.stopPropagation(); this.skip(); });
            b.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); });   // do not toggle the controls
            root.appendChild(b);
            this.el = b;
            this.fetchRemote();
        }

        // Ask the backend for this episode's intro / recap times. Fire and forget: if it is
        // offline, slow or has nothing, the player simply carries on with chapters and saved marks.
        fetchRemote() {
            const m = this.meta;
            if (this._remoteTried || !m || !onlineOn() || typeof fetch !== 'function') return;
            const show = m.kind === 'episode' ? m.showTitle : ((m.kind === 'other' && m.title) ? m.title : '');
            const season = m.season | 0, episode = m.episode | 0;
            if (!show || episode <= 0) return;                     // movies / unparsed names: nothing to look up
            this._remoteTried = true;
            const url = '/api/skip-segments?show=' + encodeURIComponent(show) + '&season=' + season + '&episode=' + episode;
            fetch(url).then(r => r.json()).then(j => {
                if (!this.el || !j || !j.found || !j.data) return;
                this.remote = remoteSpans(j.data, this.player.state.duration);
                if (this.remote.length) this.player._updateButtons();   // the Skip menu entry may now apply
            }).catch(() => { /* offline: ignore */ });
        }

        destroy() { this.cur = null; if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); this.el = null; }

        setChapters(list) {
            this.spans = chapterSpans(list, this.player.state.duration);
            this.autoDone = {};
        }

        // Is there anything for the Skip menu / button to do for this video?
        available() { return !!keysFor(this.meta) || this.spans.length > 0 || this.remote.length > 0; }

        _saved() {
            const out = [];
            KINDS.forEach(kind => {
                const r = get(this.meta, kind);
                if (r) out.push({ id: 's' + kind, kind: kind, start: r.start, end: r.end, src: 'saved' });
            });
            return out;
        }

        _find(pos) {
            const all = this.spans.concat(this.remote, this._saved());   // chapters, then the database, then your marks
            for (let i = 0; i < all.length; i++) {
                const s = all[i];
                const lead = s.src === 'saved' ? SAVED_LEAD : CHAPTER_LEAD;
                if (pos >= s.start - lead && pos < s.end - END_MARGIN) return s;
            }
            return null;
        }

        // Called with every time update.
        tick(pos, dur) {
            const p = this.player;
            if (!this.el) return;
            const seg = (p.mini || p._closed) ? null : this._find(pos);
            if (!seg) { if (this.cur) this._setCur(null); return; }
            if (!this.cur || this.cur.id !== seg.id) this._setCur(seg);
            // fade the pill after a few seconds; it stays tappable
            this.el.classList.toggle('hp-quiet', Date.now() - this._shownAt > 9000 && !p.mode.match(/controls/));
            if (seg.src !== 'saved' && autoOn() && !this.autoDone[seg.id] && pos >= seg.start - 0.3 && !p._pendingSeek) {
                this.autoDone[seg.id] = true;
                this.skip();
            }
        }

        _setCur(seg) {
            const had = !!this.cur;
            this.cur = seg;
            if (!this.el) return;
            if (seg) {
                this._shownAt = Date.now();
                this.el.textContent = '';
                this.el.appendChild(document.createTextNode(LABEL[seg.kind]));
                this.el.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 5.5v13l8-6.5-8-6.5zm9 0v13l8-6.5-8-6.5z"/></svg>');
                if (isTv()) this.el.insertAdjacentHTML('beforeend', '<span class="hp-skip-key">OK</span>');
                this.el.setAttribute('aria-label', LABEL[seg.kind]);
                this.el.classList.add('hp-on');
                this.el.classList.remove('hp-quiet');
            } else {
                this.el.classList.remove('hp-on', 'hp-quiet', 'hp-focused');
            }
            if (had !== !!seg) this.player._updateButtons();       // the remote's focus order includes the pill while it shows
        }

        // Jump to the end of the offered span. The player's own seek does the work, so a torrent
        // stream gets the same "waiting for the download to reach that point" handling as any seek.
        skip() {
            const seg = this.cur, p = this.player;
            if (!seg) return false;
            this.autoDone[seg.id] = true;
            const d = p.state.duration;
            const target = d > 0 ? Math.min(seg.end, d - 1) : seg.end;
            this._setCur(null);
            p._seekBy(target - p.state.position);
            return true;
        }

        // ---- the "Skip" menu (player menu kind 'skip') ----
        _markItem(kind) {
            const p = this.player, now = p.state.position, word = kind;
            const saved = get(this.meta, kind);
            const pend = this.pending[kind];
            if (pend == null) {
                return {
                    label: 'Mark ' + word + ' start here (' + fmt(now) + ')' + (saved ? '   \u00b7   saved ' + fmt(saved.start) + '\u2013' + fmt(saved.end) : ''),
                    action: () => { this.pending[kind] = now; }
                };
            }
            return {
                label: 'Mark ' + word + ' end here (' + fmt(now) + ')   \u00b7   started ' + fmt(pend),
                action: () => {
                    if (now - pend >= 3) set(this.meta, kind, pend, now);
                    delete this.pending[kind];
                }
            };
        }

        menuItems() {
            const items = [];
            if (keysFor(this.meta)) {
                KINDS.slice().reverse().forEach(kind => items.push(this._markItem(kind)));
                if (hasAny(this.meta)) items.push({ label: 'Forget saved skips for this show', action: () => { clear(this.meta); this.pending = {}; } });
            }
            items.push({
                label: 'Look up intro/recap online: ' + (onlineOn() ? 'On' : 'Off'),
                selected: onlineOn(),
                action: () => { setOnline(!onlineOn()); this._remoteTried = false; if (onlineOn()) this.fetchRemote(); else this.remote = []; }
            });
            items.push({
                label: 'Auto-skip when the time is known: ' + (autoOn() ? 'On' : 'Off'),
                selected: autoOn(),
                action: () => setAuto(!autoOn())
            });
            return items;
        }
    }

    window.HesperSkip = {
        Controller: Controller,
        chapterSpans: chapterSpans,
        remoteSpans: remoteSpans,
        keysFor: keysFor,
        get: get,
        set: set,
        clear: clear
    };
})();
