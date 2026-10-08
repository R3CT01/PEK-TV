// Tells the rest of the app when a player starts / stops, so a plugin page can stop its trailer.
function hesperAnnouncePlayer(active) {
    try {
        let ev;
        if (typeof CustomEvent === 'function') ev = new CustomEvent('hesper-player', { detail: { active: !!active } });
        else { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('hesper-player', false, false, { active: !!active }); }
        document.dispatchEvent(ev);
    } catch (e) { /* the page just keeps its trailer */ }
}

/* ============================================================
   Hesper shared player: on-screen controls + backend contract

   One set of controls (this file) is used on every platform. Each platform
   only supplies a *backend* that decodes and draws the video:

     - HtmlVideoBackend (below)   <video> element, used by the web/dev build
     - an mpv backend             to come: Android (libmpv) and desktop

   Backend contract (extend HesperPlayerBackend):
     load(url, startSec)  play()  pause()  seek(sec)          seek = absolute seconds
     setAudioTrack(id)    setSubtitleTrack(id | null)         null = subtitles off
     destroy()
     drawsBehindPage      getter, true when the video is a native surface behind
                          the page (the page then stays transparent)
     supportsMini         getter, true when the backend can shrink its picture into
                          a docked mini player (Android phones only, never TV)
     setMiniRect(rect)    rect = {left, top, width, height} in CSS px: move the native
                          picture there. null = back to full screen
   The backend reports back with this.emit(...):
     'time'   { position, duration }          seconds
     'state'  { playing, buffering }
     'tracks' { audio: [{id,label,selected}], subtitles: [{id,label,selected}] }
     'ended'
     'error'  { message }

   Styling uses the same --sx-* theme tokens as the rest of the app, so skins
   apply. The CSS is injected from here to keep this file self-contained.
   ============================================================ */
(function () {
    'use strict';

    const STYLE_ID = 'hesper-player-style';
    const CSS = `
.hp-root { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 20000; overflow: hidden;
    background: #000; color: #f0f6fc; color: var(--sx-text, #f0f6fc); font-family: inherit; }
.hp-root.hp-transparent { background: transparent; }
html.hp-mpv, html.hp-mpv body { background: transparent !important; }
html.hp-mpv body > *:not(.hp-root) { visibility: hidden !important; }
.hp-root.hp-idle { cursor: none; }
.hp-video-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.hp-video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }

.hp-top, .hp-bottom { position: absolute; left: 0; right: 0; opacity: 0; pointer-events: none;
    -webkit-transition: opacity 0.25s; transition: opacity 0.25s; }
.hp-show .hp-top, .hp-show .hp-bottom { opacity: 1; }
.hp-show .hp-bottom { pointer-events: auto; }
.hp-top { top: 0; padding: 20px 24px 44px; font-size: 1.15rem; font-weight: 600;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0)); }
.hp-bottom { bottom: 0; padding: 46px 24px 20px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.88), rgba(0, 0, 0, 0)); }

.hp-seek { position: relative; height: 28px; cursor: pointer; -ms-touch-action: none; touch-action: none; }
.hp-seek-track { position: absolute; left: 0; right: 0; top: 11px; height: 6px; border-radius: 3px;
    background: rgba(255, 255, 255, 0.25); }
.hp-seek-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 3px;
    background: #58a6ff; background: var(--sx-accent, #58a6ff); }
.hp-seek-knob { position: absolute; top: 6px; left: 0; width: 16px; height: 16px; margin-left: -8px;
    border-radius: 50%; background: #58a6ff; background: var(--sx-accent, #58a6ff);
    box-shadow: 0 0 10px rgba(88, 166, 255, 0.7); }
.hp-seek.hp-focused .hp-seek-track { top: 9px; height: 10px; border-radius: 5px; }
.hp-seek.hp-focused .hp-seek-knob { top: 4px; width: 20px; height: 20px; margin-left: -10px; }

.hp-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.hp-spacer { -webkit-box-flex: 1; flex: 1; }
.hp-time { font-size: 1.05rem; font-weight: 600; min-width: 3.4rem; color: #e6edf3; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8); }
/* Glass buttons: big, frosted, with a bright rim so they stay readable on any picture. */
.hp-btn { min-width: 64px; min-height: 52px; padding: 12px 22px; border-radius: 16px; font: inherit;
    font-size: 1.15rem; font-weight: 600; letter-spacing: 0.01em; cursor: pointer;
    color: #ffffff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
    background-color: rgba(26, 34, 52, 0.72);
    background-image: -webkit-linear-gradient(top, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.10));
    background-image: linear-gradient(to bottom, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.10));
    -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
    border: 1.5px solid rgba(255, 255, 255, 0.60);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.45); }
.hp-btn.hp-main { min-width: 140px; font-size: 1.3rem; }
.hp-btn.hp-focused, .hp-btn:hover, .hp-menu-item.hp-focused, .hp-confirm-btn.hp-focused {
    border-color: #58a6ff; border-color: var(--sx-accent, #58a6ff);
    background-color: rgba(60, 120, 200, 0.62);
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.9), 0 0 22px rgba(88, 166, 255, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.5); }
.hp-btn.hp-focused { -webkit-transform: scale(1.06); transform: scale(1.06); }

/* torrent streams: downloaded parts on the seek bar, scrub label, and the loading box */
.hp-seek-have { position: absolute; left: 0; right: 0; top: 0; bottom: 0; pointer-events: none; }
.hp-seek-have i { position: absolute; top: 0; bottom: 0; background: rgba(255, 255, 255, 0.55); }
.hp-seek-have i.hp-part { background: rgba(255, 255, 255, 0.28); }
.hp-seek-tip { position: absolute; bottom: 34px; left: 0; padding: 5px 12px; border-radius: 12px; display: none;
    font-size: 0.95rem; font-weight: 600; white-space: nowrap; pointer-events: none; color: #fff;
    -webkit-transform: translateX(-50%); transform: translateX(-50%);
    background: rgba(16, 22, 34, 0.86); border: 1px solid rgba(255, 255, 255, 0.55); }
.hp-seek-tip.hp-on { display: block; }
.hp-stream { position: absolute; left: 50%; top: 50%; margin-top: 44px; width: 360px; max-width: 86%; padding: 14px 18px;
    -webkit-transform: translateX(-50%); transform: translateX(-50%); border-radius: 18px; text-align: center; display: none;
    background: rgba(14, 19, 30, 0.78); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border: 1.5px solid rgba(255, 255, 255, 0.5); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55); }
.hp-stream.hp-on { display: block; }
.hp-stream-title { font-size: 1.1rem; font-weight: 700; }
.hp-stream-sub { margin-top: 3px; font-size: 0.95rem; color: #dbe4ee; }
.hp-stream-bar { height: 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.22); overflow: hidden; margin: 10px 0 8px; }
.hp-stream-fill { height: 100%; width: 3%; border-radius: 4px; background: #58a6ff; background: var(--sx-accent, #58a6ff);
    -webkit-transition: width 0.4s; transition: width 0.4s; }
.hp-stream-foot { font-size: 0.85rem; color: #b8c4d2; }

.hp-spinner { position: absolute; top: 50%; left: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px;
    border-radius: 50%; border: 4px solid rgba(255, 255, 255, 0.2); border-top-color: #58a6ff;
    border-top-color: var(--sx-accent, #58a6ff); display: none;
    -webkit-animation: hp-spin 0.9s linear infinite; animation: hp-spin 0.9s linear infinite; }
.hp-spinner.hp-on { display: block; }
@-webkit-keyframes hp-spin { to { -webkit-transform: rotate(360deg); } }
@keyframes hp-spin { to { transform: rotate(360deg); } }

.hp-error { position: absolute; top: 50%; left: 10%; right: 10%; margin-top: -1.5em; text-align: center;
    font-size: 1.2rem; display: none; }

.hp-menu { position: absolute; right: 24px; bottom: 120px; min-width: 220px; max-width: 80%; max-height: 50%;
    overflow-y: auto; padding: 10px; border-radius: 14px; display: none;
    background: #0d121e; background: var(--sx-bg-elevated, #0d121e);
    border: 1px solid #58a6ff; border: 1px solid var(--sx-accent, #58a6ff);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6); }
.hp-menu.hp-open { display: block; }
.hp-menu-title { font-weight: 700; margin: 2px 8px 8px; }
.hp-menu-item { padding: 9px 12px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; white-space: pre; }

.hp-confirm { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: none;
    -webkit-box-align: center; align-items: center; -webkit-box-pack: center; justify-content: center;
    background: rgba(5, 8, 15, 0.7); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.hp-confirm.hp-open { display: -webkit-box; display: flex; }
.hp-confirm-card { width: 420px; max-width: 90%; padding: 22px 24px 18px; border-radius: 16px;
    background: #0d121e; background: var(--sx-bg-elevated, #0d121e);
    border: 1px solid #58a6ff; border: 1px solid var(--sx-accent, #58a6ff);
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6), 0 0 30px rgba(88, 166, 255, 0.35); }
.hp-confirm-title { font-size: 1.4rem; font-weight: 700; }
.hp-confirm-msg { margin-top: 6px; color: #8b949e; color: var(--sx-text-muted, #8b949e); }
.hp-confirm-row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
.hp-confirm-btn { padding: 10px 20px; border-radius: 12px; font: inherit; font-size: 1rem; cursor: pointer;
    color: #f0f6fc; color: var(--sx-text, #f0f6fc); background: #161b22; background: var(--sx-surface, #161b22);
    border: 1px solid #30363d; border: 1px solid var(--sx-border, #30363d); }

/* minimize button (top-left of the full-screen player; phones only) */
.hp-top { display: flex; align-items: center; gap: 12px; }
.hp-top-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-min { flex: none; width: 52px; height: 52px; padding: 0; border-radius: 50%; cursor: pointer;
    display: flex; align-items: center; justify-content: center; pointer-events: none;
    color: #ffffff; background-color: rgba(26, 34, 52, 0.72);
    background-image: linear-gradient(to bottom, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.10));
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border: 1.5px solid rgba(255, 255, 255, 0.60); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); }
.hp-show .hp-min { pointer-events: auto; }
.hp-min svg { width: 28px; height: 28px; }

/* mini player: a bar docked at the bottom. The thumbnail cell is deliberately
   see-through: the native video surface is moved right under it. Nothing else
   in this bar may paint behind that cell. */
:root { --hp-mini-h: 68px; }
.hp-mini { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9500; display: flex; flex-direction: column;
    color: #f0f6fc; color: var(--sx-text, #f0f6fc); font-family: inherit; }
.hp-mini-progress { position: relative; height: 4px; background: #30363d; background: var(--sx-border, #30363d);
    border-top: 1px solid #30363d; border-top: 1px solid var(--sx-border, #30363d); }
.hp-mini-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
    background: #58a6ff; background: var(--sx-accent, #58a6ff); }
.hp-mini-row { display: flex; align-items: stretch; height: 64px; }
.hp-mini-thumb { flex: none; width: 114px; height: 64px; background: transparent; cursor: pointer; }
.hp-mini-rest { flex: 1; min-width: 0; display: flex; align-items: center;
    background: #0d121e; background: var(--sx-bg-elevated, #0d121e); }
.hp-mini-info { flex: 1; min-width: 0; padding: 0 10px; cursor: pointer; }
.hp-mini-title { font-size: 0.95rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-mini-sub { margin-top: 2px; font-size: 0.8rem; white-space: nowrap;
    color: #8b949e; color: var(--sx-text-muted, #8b949e); }
.hp-mini-btn { flex: none; width: 48px; height: 48px; padding: 0; border: 0; background: transparent; cursor: pointer;
    font: inherit; font-size: 1.15rem; color: inherit; border-radius: 50%; }
.hp-mini-btn:active { background: rgba(88, 166, 255, 0.25); }
html.hp-mini-on, html.hp-mini-on body { background: transparent !important; }
html.hp-mini-on body { height: calc(100vh - var(--hp-mini-h)); height: calc(100dvh - var(--hp-mini-h)); }
html.hp-mini-on .hesper-shell { height: calc(100vh - var(--hp-mini-h)); height: calc(100dvh - var(--hp-mini-h)); }
html.hp-mini-on::before { content: ''; position: fixed; left: 0; right: 0; top: 0; bottom: var(--hp-mini-h);
    background: #090d16; background: var(--sx-bg, #090d16); z-index: -1; }
html.hp-mini-on .theme-panel-overlay, html.hp-mini-on .plugin-window { bottom: var(--hp-mini-h); }

@media (max-width: 700px) {
    .hp-top { padding: 14px 16px 36px; font-size: 1rem; }
    .hp-bottom { padding: 36px 14px 14px; }
    .hp-btn { min-width: 56px; min-height: 48px; padding: 10px 16px; font-size: 1.05rem; }
    .hp-btn.hp-main { min-width: 116px; font-size: 1.15rem; }
    .hp-row { gap: 10px; }
    .hp-menu { right: 12px; bottom: 110px; }
}
`;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const pad = n => (n < 10 ? '0' : '') + n;
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }

    // Maps the many key names TV remotes and browsers send to a small set.
    function normKey(e) {
        const k = e.key, c = e.keyCode;
        if (k === 'ArrowLeft' || c === 37) return 'left';
        if (k === 'ArrowRight' || c === 39) return 'right';
        if (k === 'ArrowUp' || c === 38) return 'up';
        if (k === 'ArrowDown' || c === 40) return 'down';
        if (k === 'Enter' || k === ' ' || k === 'Spacebar' || c === 13 || c === 32 || c === 23) return 'ok';
        if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack' || k === 'XF86Back' ||
            c === 27 || c === 8 || c === 4) return 'back';
        if (k === 'MediaPlayPause' || c === 85 || c === 179) return 'playpause';
        if (k === 'MediaFastForward' || c === 417) return 'ff';
        if (k === 'MediaRewind' || c === 412) return 'rew';
        return '';
    }

    // ---------------- backends ----------------

    class HesperPlayerBackend {
        constructor() { this._handlers = {}; }
        on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; }
        emit(ev, data) {
            const list = this._handlers[ev];
            if (!list) return;
            list.slice().forEach(fn => { try { fn(data); } catch (e) { console.error('[HesperPlayer]', e); } });
        }
        get drawsBehindPage() { return false; }
        get supportsMini() { return false; }
        setMiniRect(rect) {}
        load(url, startSec) {}
        play() {}
        pause() {}
        seek(sec) {}
        setAudioTrack(id) {}
        setSubtitleTrack(id) {}
        destroy() {}
    }

    // Plays through a <video> element: the web/dev build, and a stand-in for testing.
    class HtmlVideoBackend extends HesperPlayerBackend {
        constructor() {
            super();
            const v = document.createElement('video');
            v.className = 'hp-video';
            v.setAttribute('playsinline', '');
            this.video = v;
            const time = () => this.emit('time', { position: v.currentTime, duration: v.duration });
            v.addEventListener('timeupdate', time);
            v.addEventListener('durationchange', time);
            v.addEventListener('play', () => this.emit('state', { playing: true, buffering: false }));
            v.addEventListener('playing', () => this.emit('state', { playing: true, buffering: false }));
            v.addEventListener('pause', () => this.emit('state', { playing: false, buffering: false }));
            v.addEventListener('waiting', () => this.emit('state', { playing: !v.paused, buffering: true }));
            v.addEventListener('ended', () => this.emit('ended'));
            v.addEventListener('loadedmetadata', () => this.emit('tracks', { audio: [], subtitles: [] }));
            v.addEventListener('error', () => {
                const err = v.error;
                this.emit('error', { message: (err && err.message) || 'This file could not be played here.' });
            });
        }
        attach(container) { container.appendChild(this.video); }
        load(url, startSec) {
            const v = this.video;
            v.src = url;
            if (startSec > 0) {
                v.addEventListener('loadedmetadata', function once() {
                    v.removeEventListener('loadedmetadata', once);
                    v.currentTime = startSec;
                });
            }
            this.play();
        }
        play() { const p = this.video.play(); if (p && p.catch) p.catch(function () {}); }
        pause() { this.video.pause(); }
        seek(sec) {
            const d = this.video.duration;
            sec = Math.max(0, sec);
            if (isFinite(d)) sec = Math.min(sec, d);
            this.video.currentTime = sec;
        }
        destroy() {
            const v = this.video;
            v.pause();
            v.removeAttribute('src');
            if (v.load) v.load();
            if (v.parentNode) v.parentNode.removeChild(v);
        }
    }

    // Android: libmpv draws on a native surface behind the page (see MpvController.kt).
    // This class only forwards the controls above to the app's HesperAndroid bridge and
    // turns the native events back into the contract events.
    class MpvBackend extends HesperPlayerBackend {
        constructor(opts) {
            super();
            opts = opts || {};
            this.title = opts.title || '';
            this.theme = opts.theme || '';
            this._cb = (ev, data) => this.emit(ev, data);
            window.__hesperMpv = this._cb;
        }
        // Phone = not a TV / leanback box and has a touchscreen (decided natively).
        static isPhone() {
            try { return !!(window.HesperAndroid && typeof window.HesperAndroid.isPhone === 'function' && window.HesperAndroid.isPhone()); }
            catch (e) { return false; }
        }
        static available() {
            return !!(window.HesperAndroid && typeof window.HesperAndroid.mpvLoad === 'function');
        }
        get drawsBehindPage() { return true; }
        get supportsMini() { return MpvBackend.isPhone() && typeof window.HesperAndroid.mpvSetRect === 'function'; }
        setMiniRect(r) {
            if (r) window.HesperAndroid.mpvSetRect(r.left, r.top, r.width, r.height);
            else window.HesperAndroid.mpvFullscreen();
        }
        attach() { document.documentElement.classList.add('hp-mpv'); }
        load(url, startSec) { window.HesperAndroid.mpvLoad(url, startSec || 0, this.title, this.theme); }
        play() { window.HesperAndroid.mpvPlay(); }
        pause() { window.HesperAndroid.mpvPause(); }
        seek(sec) { window.HesperAndroid.mpvSeek(sec); }
        setAudioTrack(id) { window.HesperAndroid.mpvSetAudio(id); }
        setSubtitleTrack(id) { window.HesperAndroid.mpvSetSubtitle(id === null || id === undefined ? -1 : id); }
        destroy() {
            try { window.HesperAndroid.mpvDestroy(); } catch (e) { /* ignore */ }
            // only clear the hook if it is still ours (a newer player may already own it)
            if (window.__hesperMpv === this._cb) window.__hesperMpv = null;
            document.documentElement.classList.remove('hp-mpv');
        }
    }

    // ---------------- the controls ----------------

    class HesperPlayer {
        constructor(opts) {
            this.title = opts.title || '';
            this.backend = opts.backend;
            this.onClose = opts.onClose || function () {};
            this.onProgress = opts.onProgress || null;   // (position, duration) every ~10s and on close
            this._lastProgress = 0;
            this.state = { playing: false, buffering: true, position: 0, duration: 0, audio: [], subtitles: [] };
            this.mode = 'hidden';          // hidden | controls | menu | confirm
            this.focus = 'play';
            this.menu = null;
            this.confirmIndex = 0;         // 0 = keep watching, 1 = exit
            this._wasPlaying = false;
            this._hideTimer = null;
            this._dragging = false;
            this._closed = false;
            this.mini = false;             // true while shrunk into the docked mini player
            this.miniSupported = opts.allowMini !== false && !!this.backend.supportsMini;
        }

        open(url, startSec) {
            hesperAnnouncePlayer(true);
            injectStyle();
            this._build();
            document.body.appendChild(this.root);
            this._startStreamWatch(url);
            if (this.backend.attach) this.backend.attach(this.videoLayer);

            this._onKey = (e) => this._handleKey(e);
            this._onKeyUp = (e) => {
                if (normKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
            };
            window.addEventListener('keydown', this._onKey, true);
            window.addEventListener('keyup', this._onKeyUp, true);

            const b = this.backend;
            b.on('time', (d) => {
                this.state.duration = d.duration > 0 && isFinite(d.duration) ? d.duration : 0;
                if (!this._dragging) this.state.position = d.position || 0;
                this._updateTime();
                this._reportProgress(false);
            });
            b.on('state', (d) => {
                this.state.playing = !!d.playing;
                this.state.buffering = !!d.buffering;
                this._updateButtons();
                if (this.state.playing) this._scheduleHide();
            });
            b.on('tracks', (d) => {
                this.state.audio = d.audio || [];
                this.state.subtitles = d.subtitles || [];
                this._updateButtons();
            });
            b.on('ended', () => this.close());
            b.on('error', (d) => {
                this.errorBox.textContent = (d && d.message) || 'Playback failed.';
                this.errorBox.style.display = 'block';
                this.state.buffering = false;
                this._updateButtons();
                this._show();
            });

            b.load(url, startSec || 0);
            this._show();
            this._updateButtons();
            this._updateTime();
        }

        close() {
            if (this._closed) return;
            this._closed = true;
            clearTimeout(this._hideTimer);
            clearTimeout(this._streamTimer);
            this._reportProgress(true);
            window.removeEventListener('keydown', this._onKey, true);
            window.removeEventListener('keyup', this._onKeyUp, true);
            this._leaveMiniLayout();
            try { this.backend.destroy(); } catch (e) { /* ignore */ }
            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
            hesperAnnouncePlayer(false);
            this.onClose();
        }

        // ---- mini player (phones only) ----
        // Full screen -> a bar docked at the bottom of the app. The page below stays usable.
        minimize() {
            if (!this.miniSupported || this.mini || this._closed) return;
            this.confirmEl.classList.remove('hp-open');
            this._closeMenu(true);
            clearTimeout(this._hideTimer);
            this.mode = 'hidden';
            this.root.classList.remove('hp-show');
            this.mini = true;
            // the remote / keyboard belong to the app again while minimized
            window.removeEventListener('keydown', this._onKey, true);
            window.removeEventListener('keyup', this._onKeyUp, true);
            this.root.style.display = 'none';
            const html = document.documentElement;
            html.classList.remove('hp-mpv');
            html.classList.add('hp-mini-on');
            if (!this.miniEl) this._buildMini();
            document.body.appendChild(this.miniEl);
            html.style.setProperty('--hp-mini-h', this.miniEl.offsetHeight + 'px');
            this._updateMini();
            this._onResize = () => this._sendMiniRect();
            window.addEventListener('resize', this._onResize);
            // wait for the page to re-flow around the bar, then park the picture in its thumbnail cell
            const raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
            raf(() => raf(() => { if (this.mini) this._sendMiniRect(); }));
        }

        // Mini bar -> full screen again.
        expand() {
            if (!this.mini || this._closed) return;
            this._leaveMiniLayout();
            if (this.backend.drawsBehindPage) document.documentElement.classList.add('hp-mpv');
            this.backend.setMiniRect(null);
            this.root.style.display = '';
            window.addEventListener('keydown', this._onKey, true);
            window.addEventListener('keyup', this._onKeyUp, true);
            this.mode = 'hidden';
            this._show();
        }

        _leaveMiniLayout() {
            if (!this.mini) return;
            this.mini = false;
            if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
            if (this.miniEl && this.miniEl.parentNode) this.miniEl.parentNode.removeChild(this.miniEl);
            const html = document.documentElement;
            html.classList.remove('hp-mini-on');
            html.style.removeProperty('--hp-mini-h');
        }

        _sendMiniRect() {
            if (!this.mini || !this.miniThumb) return;
            const r = this.miniThumb.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                this.backend.setMiniRect({ left: r.left, top: r.top, width: r.width, height: r.height });
            }
        }

        _buildMini() {
            const bar = el('div', 'hp-mini');
            const prog = el('div', 'hp-mini-progress');
            this.miniFill = el('div', 'hp-mini-fill');
            prog.appendChild(this.miniFill);

            const row = el('div', 'hp-mini-row');
            this.miniThumb = el('div', 'hp-mini-thumb');          // see-through: the video shows here
            this.miniThumb.addEventListener('click', () => this.expand());
            const rest = el('div', 'hp-mini-rest');
            const info = el('div', 'hp-mini-info');
            this.miniTitle = el('div', 'hp-mini-title', this.title);
            this.miniSub = el('div', 'hp-mini-sub', '');
            info.appendChild(this.miniTitle);
            info.appendChild(this.miniSub);
            info.addEventListener('click', () => this.expand());
            this.miniPlay = el('button', 'hp-mini-btn', '\u275a\u275a');
            this.miniPlay.setAttribute('aria-label', 'Play or pause');
            this.miniPlay.addEventListener('click', (ev) => { ev.stopPropagation(); this._toggle(); });
            const closeBtn = el('button', 'hp-mini-btn', '\u2715');
            closeBtn.setAttribute('aria-label', 'Close player');
            closeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); this.close(); });
            rest.appendChild(info);
            rest.appendChild(this.miniPlay);
            rest.appendChild(closeBtn);
            row.appendChild(this.miniThumb);
            row.appendChild(rest);
            bar.appendChild(prog);
            bar.appendChild(row);
            this.miniEl = bar;
        }

        _updateMini() {
            if (!this.mini || !this.miniEl) return;
            const d = this.state.duration, p = this.state.position;
            this.miniFill.style.width = (d > 0 ? Math.min(100, Math.max(0, (p / d) * 100)) : 0) + '%';
            this.miniSub.textContent = fmtTime(p) + (d > 0 ? ' / ' + fmtTime(d) : '');
            this.miniPlay.textContent = this.state.playing ? '\u275a\u275a' : '\u25b6';
        }

        // Tells the app where we are, at most every 10 seconds (and always on close),
        // so it can offer "Resume" next time.
        _reportProgress(force) {
            if (!this.onProgress) return;
            const now = Date.now();
            if (!force && now - this._lastProgress < 10000) return;
            if (!force && !(this.state.position > 0)) return;
            this._lastProgress = now;
            try { this.onProgress(this.state.position, this.state.duration); }
            catch (e) { console.error('[HesperPlayer] onProgress', e); }
        }

        // The app's Back handler calls this while the player is open.
        onBack() {
            if (this.mode === 'confirm') this._keepWatching();
            else if (this.mode === 'menu') this._closeMenu();
            else this._askExit();
        }

        // ---- building the screen ----
        _build() {
            const root = el('div', 'hp-root' + (this.backend.drawsBehindPage ? ' hp-transparent' : ''));
            this.root = root;
            this.videoLayer = el('div', 'hp-video-layer');
            this.spinner = el('div', 'hp-spinner hp-on');
            this.errorBox = el('div', 'hp-error');

            const top = el('div', 'hp-top');
            if (this.miniSupported) {
                const mb = el('button', 'hp-min');
                mb.setAttribute('aria-label', 'Minimize player');
                const NS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(NS, 'svg');
                svg.setAttribute('viewBox', '0 0 24 24');
                const path = document.createElementNS(NS, 'path');
                path.setAttribute('d', 'M6 9l6 6 6-6');
                path.setAttribute('fill', 'none');
                path.setAttribute('stroke', 'currentColor');
                path.setAttribute('stroke-width', '2.4');
                path.setAttribute('stroke-linecap', 'round');
                path.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(path);
                mb.appendChild(svg);
                mb.addEventListener('click', (ev) => { ev.stopPropagation(); this.minimize(); });
                top.appendChild(mb);
            }
            top.appendChild(el('div', 'hp-top-title', this.title));
            const bottom = el('div', 'hp-bottom');

            // seek bar
            this.seek = el('div', 'hp-seek');
            const track = el('div', 'hp-seek-track');
            this.seekFill = el('div', 'hp-seek-fill');
            this.seekKnob = el('div', 'hp-seek-knob');
            this.seekHave = el('div', 'hp-seek-have');
            track.appendChild(this.seekHave);
            track.appendChild(this.seekFill);
            this.seek.appendChild(track);
            this.seek.appendChild(this.seekKnob);
            this.seekTip = el('div', 'hp-seek-tip');
            this.seek.appendChild(this.seekTip);
            this._wireSeek();

            // buttons
            this.btns = {};
            const mk = (id, label, fn) => {
                const b = el('button', 'hp-btn', label);
                b.addEventListener('click', (ev) => { ev.stopPropagation(); this.focus = id; this._scheduleHide(); fn(); this._updateFocus(); });
                this.btns[id] = b;
                return b;
            };
            this.timeLeft = el('span', 'hp-time', '0:00');
            this.timeRight = el('span', 'hp-time', '0:00');
            const row = el('div', 'hp-row');
            row.appendChild(this.timeLeft);
            row.appendChild(mk('rew', '\u221210s', () => this._seekBy(-10)));
            row.appendChild(mk('play', '\u25b6  Play', () => this._toggle()));
            this.btns.play.classList.add('hp-main');
            row.appendChild(mk('fwd', '+10s', () => this._seekBy(10)));
            row.appendChild(this.timeRight);
            row.appendChild(el('span', 'hp-spacer'));
            row.appendChild(mk('audio', 'Audio', () => this._openMenu('audio')));
            row.appendChild(mk('subs', 'Subtitles', () => this._openMenu('subs')));
            row.appendChild(mk('exit', 'Exit', () => this._askExit()));
            bottom.appendChild(this.seek);
            bottom.appendChild(row);

            this.menuEl = el('div', 'hp-menu');
            this._buildConfirm();

            root.appendChild(this.videoLayer);
            root.appendChild(this.spinner);
            this.streamBox = el('div', 'hp-stream');
            this.streamTitle = el('div', 'hp-stream-title', 'Loading from the torrent');
            this.streamSub = el('div', 'hp-stream-sub');
            const sbar = el('div', 'hp-stream-bar');
            this.streamFill = el('div', 'hp-stream-fill');
            sbar.appendChild(this.streamFill);
            this.streamFoot = el('div', 'hp-stream-foot');
            this.streamBox.appendChild(this.streamTitle);
            this.streamBox.appendChild(this.streamSub);
            this.streamBox.appendChild(sbar);
            this.streamBox.appendChild(this.streamFoot);
            root.appendChild(this.streamBox);
            root.appendChild(this.errorBox);
            root.appendChild(top);
            root.appendChild(bottom);
            root.appendChild(this.menuEl);
            root.appendChild(this.confirmEl);

            // tap the picture to show / hide the controls
            root.addEventListener('pointerdown', (ev) => {
                if (this.mode === 'confirm' || this.mode === 'menu') return;
                if (ev.target === root || ev.target === this.videoLayer || ev.target === this.backend.video) {
                    if (this.mode === 'hidden') this._show(); else this._hide();
                } else {
                    this._scheduleHide();
                }
            });
        }

        _buildConfirm() {
            this.confirmEl = el('div', 'hp-confirm');
            const card = el('div', 'hp-confirm-card');
            card.appendChild(el('div', 'hp-confirm-title', 'Stop watching?'));
            card.appendChild(el('div', 'hp-confirm-msg', 'Do you want to exit the video?'));
            const row = el('div', 'hp-confirm-row');
            this.keepBtn = el('button', 'hp-confirm-btn', 'Keep watching');
            this.exitBtn = el('button', 'hp-confirm-btn', 'Exit');
            this.keepBtn.addEventListener('click', () => this._keepWatching());
            this.exitBtn.addEventListener('click', () => this.close());
            row.appendChild(this.keepBtn);
            row.appendChild(this.exitBtn);
            card.appendChild(row);
            this.confirmEl.appendChild(card);
        }

        _wireSeek() {
            let lastSent = 0;
            const at = (ev, send) => {
                if (!(this.state.duration > 0)) return;
                const r = this.seek.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1)));
                this.state.position = ratio * this.state.duration;
                this._updateTime();
                const now = Date.now();
                if (send || now - lastSent > 250) { lastSent = now; this.backend.seek(this.state.position); }
            };
            this.seek.addEventListener('pointerdown', (ev) => {
                ev.stopPropagation();
                this._dragging = true;
                try { this.seek.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
                this.focus = 'seek';
                this._updateFocus();
                at(ev, false);
            });
            this.seek.addEventListener('pointermove', (ev) => { if (this._dragging) at(ev, false); });
            const end = (ev) => {
                if (!this._dragging) return;
                at(ev, true);
                this._dragging = false;
                this._updateSeekTip();
                this._scheduleHide();
            };
            this.seek.addEventListener('pointerup', end);
            this.seek.addEventListener('pointercancel', () => { this._dragging = false; this._updateSeekTip(); });
        }

        // ---- showing and hiding ----
        _show() {
            this.root.classList.add('hp-show');
            this.root.classList.remove('hp-idle');
            if (this.mode === 'hidden') this.mode = 'controls';
            this._updateFocus();
            this._scheduleHide();
        }

        _hide() {
            if (this.mode !== 'controls') return;
            this.root.classList.remove('hp-show');
            this.root.classList.add('hp-idle');
            this.mode = 'hidden';
        }

        _scheduleHide() {
            clearTimeout(this._hideTimer);
            if (!this.state.playing) return;     // stay visible while paused
            this._hideTimer = setTimeout(() => {
                if (this.mode === 'controls' && this.state.playing && !this._dragging) this._hide();
            }, 4000);
        }

        // ---- updating the screen ----
        _updateTime() {
            const d = this.state.duration, p = this.state.position;
            const pct = d > 0 ? Math.min(100, Math.max(0, (p / d) * 100)) : 0;
            this.seekFill.style.width = pct + '%';
            this.seekKnob.style.left = pct + '%';
            this.timeLeft.textContent = fmtTime(p);
            this.timeRight.textContent = d > 0 ? fmtTime(d) : '--:--';
            this._updateSeekTip();
            this._updateMini();
        }

        // ---- torrent streams: what is downloaded, and how far a scrub target is ----
        // The stream URL is /api/torrent/<hash>/stream; its status (with the downloaded map) is next to it.
        _startStreamWatch(url) {
            const m = /^(.*\/api\/torrent\/[0-9a-fA-F]+)\/stream(?:[?#].*)?$/.exec(String(url || ''));
            if (!m) return;
            this._streamUrl = m[1] + '/status?map=1';
            this.stream = null;
            const tick = () => {
                if (this._closed || !this._streamUrl) return;
                const waiting = !!(this.state && this.state.buffering);
                fetch(this._streamUrl).then(r => r.json()).then(s => {
                    if (this._closed || !s || s.error) return;
                    this.stream = { peers: s.peers | 0, kbps: s.downKBps | 0, done: s.fileProgress || 0, have: s.have || null };
                    this._renderStream();
                }).catch(() => { /* try again next time */ }).then(() => {
                    if (!this._closed) this._streamTimer = setTimeout(tick, (this.state && this.state.buffering) || waiting ? 500 : 2000);
                });
            };
            tick();
        }

        // Percent (0..100) of the part of the file at `ratio` (0..1) that is downloaded: the slice there
        // and the two after it, which is what playback needs next.
        _haveAt(ratio) {
            const have = this.stream && this.stream.have;
            if (!have || !have.length) return null;
            const b = Math.min(have.length - 1, Math.max(0, Math.floor(ratio * have.length)));
            let sum = 0, n = 0;
            for (let i = b; i < Math.min(have.length, b + 3); i++) { sum += have[i]; n++; }
            return Math.round(sum / n);
        }

        _renderStream() {
            const s = this.stream;
            const waiting = !!this.state.buffering && this.errorBox.style.display === 'none';
            if (!s) {                                  // first status not here yet
                if (this._streamUrl) {
                    this.streamBox.classList.toggle('hp-on', waiting);
                    this.streamSub.textContent = 'Connecting to the torrent\u2026';
                    this.streamFoot.textContent = '';
                }
                return;
            }
            const have = s.have;
            const sig = have ? have.join(',') : '';
            if (sig !== this._haveSig) {
                this._haveSig = sig;
                this.seekHave.innerHTML = '';
                if (have) {
                    const cls = v => (v >= 90 ? 2 : (v > 0 ? 1 : 0));
                    let start = 0;
                    for (let i = 1; i <= have.length; i++) {
                        if (i === have.length || cls(have[i]) !== cls(have[start])) {
                            const c = cls(have[start]);
                            if (c > 0) {
                                const bar = document.createElement('i');
                                if (c === 1) bar.className = 'hp-part';
                                bar.style.left = (start / have.length * 100) + '%';
                                bar.style.width = ((i - start) / have.length * 100) + '%';
                                this.seekHave.appendChild(bar);
                            }
                            start = i;
                        }
                    }
                }
            }
            this.streamBox.classList.toggle('hp-on', waiting);
            if (!waiting) return;
            const d = this.state.duration, p = this.state.position;
            const pct = this._haveAt(d > 0 ? p / d : 0);
            const speed = s.kbps >= 1024 ? (s.kbps / 1024).toFixed(1) + ' MB/s' : s.kbps + ' KB/s';
            this.streamSub.textContent = (p > 0 ? 'At ' + fmtTime(p) + ' \u00b7 ' : '') +
                (pct === null ? 'getting started\u2026' : pct + '% of this part is ready');
            this.streamFill.style.width = Math.max(3, pct === null ? 3 : pct) + '%';
            this.streamFoot.textContent = s.peers + ' peers \u00b7 ' + speed + ' \u00b7 ' +
                Math.round(s.done * 100) + '% of the file downloaded';
        }

        // While dragging the bar: the time under the finger, and whether that part is downloaded yet.
        _updateSeekTip() {
            if (!this.seekTip) return;
            if (!this._dragging) { this.seekTip.classList.remove('hp-on'); return; }
            const d = this.state.duration, p = this.state.position;
            const pct = d > 0 ? Math.min(100, Math.max(0, p / d * 100)) : 0;
            let text = fmtTime(p);
            const h = this._haveAt(d > 0 ? p / d : 0);
            if (h !== null) text += h >= 90 ? ' \u00b7 ready' : (h > 0 ? ' \u00b7 ' + h + '% loaded' : ' \u00b7 not downloaded yet');
            this.seekTip.textContent = text;
            this.seekTip.style.left = Math.min(88, Math.max(12, pct)) + '%';
            this.seekTip.classList.add('hp-on');
        }

        _focusOrder() {
            const order = ['seek', 'rew', 'play', 'fwd'];
            if (this.state.audio.length > 1) order.push('audio');
            if (this.state.subtitles.length > 0) order.push('subs');
            order.push('exit');
            return order;
        }

        _updateButtons() {
            this.btns.play.textContent = this.state.playing ? '\u275a\u275a  Pause' : '\u25b6  Play';
            this.btns.audio.style.display = this.state.audio.length > 1 ? '' : 'none';
            this.btns.subs.style.display = this.state.subtitles.length > 0 ? '' : 'none';
            const waiting = this.state.buffering && this.errorBox.style.display === 'none';
            this.spinner.classList.toggle('hp-on', waiting);
            if (this._streamUrl) this._renderStream();
            if (this._focusOrder().indexOf(this.focus) < 0) this.focus = 'play';
            this._updateFocus();
            this._updateMini();
        }

        _updateFocus() {
            const show = this.mode === 'controls';
            this.seek.classList.toggle('hp-focused', show && this.focus === 'seek');
            Object.keys(this.btns).forEach(id => {
                this.btns[id].classList.toggle('hp-focused', show && this.focus === id);
            });
        }

        // ---- actions ----
        _toggle() {
            if (this.state.playing) this.backend.pause(); else this.backend.play();
        }

        _seekBy(delta) {
            const d = this.state.duration;
            let t = this.state.position + delta;
            t = Math.max(0, d > 0 ? Math.min(t, d) : t);
            this.state.position = t;
            this._updateTime();
            this.backend.seek(t);
        }

        _askExit() {
            this._wasPlaying = this.state.playing;
            this.backend.pause();
            this._closeMenu(true);
            this.mode = 'confirm';
            this.confirmIndex = 0;
            this.confirmEl.classList.add('hp-open');
            this._renderConfirm();
            this._updateFocus();
        }

        _keepWatching() {
            this.confirmEl.classList.remove('hp-open');
            this.mode = 'controls';
            this._show();
            if (this._wasPlaying) this.backend.play();
        }

        _renderConfirm() {
            this.keepBtn.classList.toggle('hp-focused', this.confirmIndex === 0);
            this.exitBtn.classList.toggle('hp-focused', this.confirmIndex === 1);
        }

        _openMenu(kind) {
            const tracks = kind === 'audio' ? this.state.audio : this.state.subtitles;
            const items = kind === 'subs'
                ? [{ id: null, label: 'Off', selected: !tracks.some(t => t.selected) }].concat(tracks)
                : tracks.slice();
            if (!items.length) return;
            let index = 0;
            items.forEach((it, i) => { if (it.selected) index = i; });
            this.menu = { kind: kind, items: items, index: index };
            this.mode = 'menu';
            this._renderMenu();
        }

        _renderMenu() {
            const m = this.menu;
            this.menuEl.textContent = '';
            this.menuEl.appendChild(el('div', 'hp-menu-title', m.kind === 'audio' ? 'Audio' : 'Subtitles'));
            m.items.forEach((it, i) => {
                const row = el('div', 'hp-menu-item' + (i === m.index ? ' hp-focused' : ''),
                    (it.selected ? '\u2713  ' : '     ') + it.label);
                row.addEventListener('click', (ev) => { ev.stopPropagation(); m.index = i; this._chooseMenu(); });
                this.menuEl.appendChild(row);
            });
            this.menuEl.classList.add('hp-open');
        }

        _chooseMenu() {
            const m = this.menu;
            if (!m) return;
            const item = m.items[m.index];
            const list = m.kind === 'audio' ? this.state.audio : this.state.subtitles;
            if (m.kind === 'audio') this.backend.setAudioTrack(item.id);
            else this.backend.setSubtitleTrack(item.id);
            list.forEach(t => { t.selected = (t.id === item.id); });
            this._closeMenu();
        }

        _closeMenu(silent) {
            this.menu = null;
            this.menuEl.classList.remove('hp-open');
            if (!silent && this.mode === 'menu') { this.mode = 'controls'; this._show(); }
        }

        // ---- keys ----
        _handleKey(e) {
            const key = normKey(e);
            if (!key) return;                       // leave other keys (F5, F12...) alone
            e.preventDefault();
            e.stopImmediatePropagation();

            if (this.mode === 'confirm') {
                if (key === 'left' || key === 'right' || key === 'up' || key === 'down') {
                    this.confirmIndex = this.confirmIndex === 0 ? 1 : 0;
                    this._renderConfirm();
                } else if (key === 'ok') {
                    if (this.confirmIndex === 1) this.close(); else this._keepWatching();
                } else if (key === 'back') {
                    this._keepWatching();
                }
                return;
            }

            if (this.mode === 'menu') {
                const m = this.menu;
                if (key === 'up') m.index = Math.max(0, m.index - 1);
                else if (key === 'down') m.index = Math.min(m.items.length - 1, m.index + 1);
                else if (key === 'ok') { this._chooseMenu(); return; }
                else if (key === 'back' || key === 'left') { this._closeMenu(); return; }
                this._renderMenu();
                return;
            }

            if (key === 'back') { this._askExit(); return; }
            if (key === 'playpause') { this._toggle(); this._show(); return; }
            if (key === 'ff') { this._seekBy(30); this._show(); return; }
            if (key === 'rew') { this._seekBy(-10); this._show(); return; }

            if (this.mode === 'hidden') {
                // controls are hidden: arrows skip, OK pauses
                if (key === 'left') this._seekBy(-10);
                else if (key === 'right') this._seekBy(10);
                else if (key === 'ok') this._toggle();
                this._show();
                return;
            }

            // controls are showing
            this._scheduleHide();
            const order = this._focusOrder();
            const i = order.indexOf(this.focus);
            if (key === 'left' || key === 'right') {
                if (this.focus === 'seek') this._seekBy(key === 'left' ? -10 : 10);
                else this.focus = order[Math.max(1, Math.min(order.length - 1, i + (key === 'left' ? -1 : 1)))];
            } else if (key === 'up') {
                this.focus = 'seek';
            } else if (key === 'down') {
                if (this.focus === 'seek') this.focus = 'play'; else this._hide();
            } else if (key === 'ok') {
                const btn = this.btns[this.focus];
                if (this.focus === 'seek') this._toggle();
                else if (btn) btn.click();
            }
            this._updateFocus();
        }
    }

    window.HesperPlayerBackend = HesperPlayerBackend;
    window.HtmlVideoBackend = HtmlVideoBackend;
    window.MpvBackend = MpvBackend;
    window.HesperPlayer = HesperPlayer;
    window.HesperPlayerUtil = { fmtTime: fmtTime, normKey: normKey };
})();
