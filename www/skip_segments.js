/* ============================================================
   Hesper: Skip Intro / Skip Recap  (fully automatic)
   Loaded before player.js. The player creates one HesperSkip.Controller per playback
   (library files AND torrent streams: both go through HesperPlayer).

   Nobody marks anything. Where the skip spans come from:
     1. Chapters inside the file (mpv reports them). A chapter called "Intro", "Opening",
        "OP", "Recap", "Previously on ..." is a skip span. Exact, and works the same for a
        torrent stream, because the chapter list sits in the file header.
     2. Times from a community database (IntroDB), looked up automatically for episodes of
        a show. The backend (/api/skip-segments) turns the show name into an IMDb id and asks
        the database for this season and episode; the answer is cached. Turn it off in the
        Skip menu ("Look up intro/recap online").
   Order of trust: chapters, then the database. Both are exact for this episode, so
   auto-skip ('hesper_skip_auto') acts on either.
   ============================================================ */
(function () {
    'use strict';

    const OLD_STORE_KEY = 'hesper_skip_v1';          // manual marks of older versions: wiped, no longer used
    const AUTO_KEY = 'hesper_skip_auto';
    const ONLINE_KEY = 'hesper_skip_online';          // '0' = never ask the database (default: on)
    const STYLE_ID = 'hesper-skip-style';
    const KINDS = ['recap', 'intro'];                 // recap first: it comes first in an episode
    const LABEL = { intro: 'Skip Intro', recap: 'Skip Recap' };
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

    // Episode identity: only used to decide whether an online lookup makes sense. Movies have none
    // (chapters still work for them).
    function isEpisodeMeta(meta) {
        if (!meta) return false;
        if (meta.kind === 'episode') return !!String(meta.showTitle || '').trim();
        return meta.kind === 'other' && !!String(meta.title || '').trim() && !!((meta.season | 0) || (meta.episode | 0));
    }

    // Drop spans people marked by hand in earlier versions.
    try { localStorage.removeItem(OLD_STORE_KEY); } catch (e) { /* ignore */ }

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
            let a = pick(o, ['start_sec', 'startSec', 'start_seconds', 'start', 'from', 'start_time', 'startTime'], false);
            let b = pick(o, ['end_sec', 'endSec', 'end_seconds', 'end', 'to', 'end_time', 'endTime'], false);
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
/* Phone: small, see-through and tucked into the corner so it stays out of the picture. Covers landscape phones too. */
.hp-skip.hp-phone { right: 12px; bottom: 14px; padding: 7px 14px; gap: 6px; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.01em;
    background-color: rgba(28, 24, 21, 0.4); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.4);
    border: 1px solid rgba(246, 242, 236, 0.22); border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.22);
    opacity: 0.8; }
.hp-skip.hp-phone svg { width: 14px; height: 14px; }
.hp-skip.hp-phone.hp-quiet { opacity: 0.35; }
.hp-show .hp-skip.hp-phone { bottom: 96px; }
.hp-skip.hp-phone.hp-focused, .hp-skip.hp-phone:active { opacity: 1; -webkit-transform: none; transform: none; }
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
            this._dbg = 'not asked yet';
            this._chapInfo = 'chapters not read yet';
            this.cur = null;          // the span the button offers right now
            this.autoDone = {};       // span id -> already auto-skipped / skipped once
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
            b.className += isTv() ? ' hp-tv' : ' hp-phone';
            b.addEventListener('click', (ev) => { ev.stopPropagation(); this.skip(); });
            b.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); });   // do not toggle the controls
            root.appendChild(b);
            this.el = b;
            this.fetchRemote();
        }

        // Ask the backend for this episode's intro / recap times. Fire and forget: if it is
        // offline, slow or has nothing, the player simply carries on with chapters alone.
        fetchRemote() {
            const m = this.meta;
            if (this._remoteTried || typeof fetch !== 'function') return;
            if (!onlineOn()) { this._dbg = 'online lookup is Off'; return; }
            if (!m) { this._dbg = 'no show info passed to the player (meta missing)'; return; }
            const show = m.kind === 'episode' ? m.showTitle : ((m.kind === 'other' && m.title) ? m.title : '');
            const season = m.season | 0, episode = m.episode | 0;
            if (!show || episode <= 0) { this._dbg = 'no lookup: needs show + episode number (got "' + (show || '') + '" S' + season + 'E' + episode + ')'; return; }
            this._remoteTried = true;
            this._dbg = 'asking for "' + show + '" S' + season + 'E' + episode + '...';
            const url = '/api/skip-segments?show=' + encodeURIComponent(show) + '&season=' + season + '&episode=' + episode;
            fetch(url).then(r => { this._http = r.status; return r.json(); }).then(j => {
                if (!this.el) return;
                if (!j) { this._dbg = 'empty answer from the app server'; return; }
                if (j.error) { this._dbg = 'app server error: ' + j.error; return; }
                if (!j.found || !j.data) {
                    this._dbg = j.imdb ? 'show found (' + j.imdb + ') but the database has no times for this episode'
                                       : 'could not look up the show (TMDb/network problem on the app server)';
                    return;
                }
                this.remote = remoteSpans(j.data, this.player.state.duration);
                if (this.remote.length) {
                    this._dbg = 'ok: ' + this.remote.map(x => x.kind + ' ' + fmt(x.start) + '-' + fmt(x.end)).join(', ');
                    this.player._updateButtons();
                } else {
                    let raw = ''; try { raw = JSON.stringify(j.data).slice(0, 120); } catch (e) { /* ignore */ }
                    this._dbg = 'database answered but no usable times in it: ' + raw;
                }
            }).catch((e) => { this._dbg = 'lookup failed: ' + ((e && e.message) || e) + (this._http ? ' (HTTP ' + this._http + ')' : ''); });
        }

        destroy() { this.cur = null; if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); this.el = null; }

        setChapters(list) {
            this.spans = chapterSpans(list, this.player.state.duration);
            this._chapInfo = (list && list.length ? list.length + ' in file (' + list.slice(0, 3).map(c => (c && c.title) || '?').join(', ') + (list.length > 3 ? ', ...' : '') + ')' : 'none in file') + ', ' + this.spans.length + ' look like intro/recap';
            this.autoDone = {};
        }

        // Is there anything for the Skip menu / button to do for this video?
        available() { return isEpisodeMeta(this.meta) || this.spans.length > 0 || this.remote.length > 0; }

        _find(pos) {
            const all = this.spans.concat(this.remote);   // chapters, then the database
            for (let i = 0; i < all.length; i++) {
                const s = all[i];
                if (pos >= s.start - CHAPTER_LEAD && pos < s.end - END_MARGIN) return s;
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
            this.el.classList.toggle('hp-quiet', Date.now() - this._shownAt > (isTv() ? 9000 : 4000) && !p.mode.match(/controls/));
            if (autoOn() && !this.autoDone[seg.id] && pos >= seg.start - 0.3 && !p._pendingSeek) {
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
        menuItems() {
            const items = [];
            items.push({ label: 'Why no skip? Chapters: ' + this._chapInfo + '. Online: ' + this._dbg + '.', action: () => {} });
            items.push({
                label: 'Look up intro/recap online: ' + (onlineOn() ? 'On' : 'Off'),
                selected: onlineOn(),
                action: () => { setOnline(!onlineOn()); this._remoteTried = false; if (onlineOn()) this.fetchRemote(); else this.remote = []; }
            });
            items.push({
                label: 'Auto-skip intro/recap: ' + (autoOn() ? 'On' : 'Off'),
                selected: autoOn(),
                action: () => setAuto(!autoOn())
            });
            return items;
        }
    }

    window.HesperSkip = {
        Controller: Controller,
        chapterSpans: chapterSpans,
        remoteSpans: remoteSpans
    };
})();
