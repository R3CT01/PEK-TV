// Tells the rest of the app when a player starts / stops, so a plugin page can stop its trailer.
function pekAnnouncePlayer(active) {
    try {
        let ev;
        if (typeof CustomEvent === 'function') ev = new CustomEvent('pek-player', { detail: { active: !!active } });
        else { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('pek-player', false, false, { active: !!active }); }
        document.dispatchEvent(ev);
    } catch (e) { /* the page just keeps its trailer */ }
}

/* ============================================================
   PEK shared player: on-screen controls + backend contract

   One set of controls (this file) is used on every platform. Each platform
   only supplies a *backend* that decodes and draws the video:

     - HtmlVideoBackend (below)   <video> element, used by the web/dev build
     - an mpv backend             to come: Android (libmpv) and desktop

   Backend contract (extend PekPlayerBackend):
     load(url, startSec)  play()  pause()  seek(sec)          seek = absolute seconds
     setAudioTrack(id)    setSubtitleTrack(id | null)         null = subtitles off
     addSubtitle(url, label)   load an extra subtitle file (SubRip text at url) and switch it on;
                          returns a Promise: false = this backend cannot (see subtitles.js)
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

    const STYLE_ID = 'pek-player-style';
    const CSS = `
.hp-root { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 20000; overflow: hidden;
    background: #000; color: #f6f2ec; color: var(--hp-fg, #f6f2ec);
    font-family: inherit; font-family: var(--sx-font, inherit);
    -webkit-user-select: none; user-select: none; }
.hp-root.hp-transparent { background: transparent; }
html.hp-mpv, html.hp-mpv body { background: transparent !important; }
html.hp-mpv body > *:not(.hp-root) { visibility: hidden !important; }
.hp-root.hp-idle { cursor: none; }
.hp-video-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.hp-video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }

/* Shared dark glass: every floating piece of the player (buttons, tip, chip, menus). */
.hp-btn, .hp-chip, .hp-seek-tip, .hp-stream, .hp-menu, .hp-confirm-card, .hp-min {
    background-color: rgba(28, 24, 21, 0.62);
    background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.58);
    -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5);
    border: 1px solid rgba(246, 242, 236, 0.16);
    border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.16);
    color: #f6f2ec; color: var(--hp-fg, #f6f2ec); }

/* top bar + bottom bar */
.hp-top, .hp-bottom { position: absolute; left: 0; right: 0; opacity: 0; pointer-events: none;
    -webkit-transition: opacity 0.28s ease, -webkit-transform 0.28s ease; transition: opacity 0.28s ease, transform 0.28s ease; }
.hp-show .hp-top, .hp-show .hp-bottom { opacity: 1; -webkit-transform: none; transform: none; }
.hp-show .hp-bottom { pointer-events: auto; }
.hp-top { top: 0; padding: 18px 22px 54px; display: flex; align-items: center; gap: 12px;
    -webkit-transform: translateY(-6px); transform: translateY(-6px);
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0));
    background: linear-gradient(to bottom, rgba(var(--hp-shade-rgb, 14, 12, 10), 0.82), rgba(var(--hp-shade-rgb, 14, 12, 10), 0)); }
.hp-bottom { bottom: 0; padding: 58px 22px 16px;
    -webkit-transform: translateY(6px); transform: translateY(6px);
    background: linear-gradient(to top, rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0));
    background: linear-gradient(to top, rgba(var(--hp-shade-rgb, 14, 12, 10), 0.9), rgba(var(--hp-shade-rgb, 14, 12, 10), 0)); }
.hp-top-title { -webkit-box-flex: 1; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 1.08rem; font-weight: 600; letter-spacing: 0.01em; text-shadow: 0 1px 10px rgba(0, 0, 0, 0.65); }

/* live torrent chip (top right, only for torrent streams) */
.hp-toast { position: absolute; left: 50%; bottom: 17%; max-width: 86%; padding: 9px 16px; border-radius: 999px;
    transform: translateX(-50%); font-size: 0.85rem; text-align: center; pointer-events: none; z-index: 5;
    background-color: rgba(28, 24, 21, 0.78); opacity: 0; transition: opacity 0.25s; }
.hp-toast.hp-on { opacity: 1; }
.hp-chip { flex: none; display: none; align-items: center; gap: 8px; padding: 7px 13px; border-radius: 999px;
    font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hp-chip.hp-on { display: flex; }
.hp-chip i { width: 7px; height: 7px; border-radius: 50%; background: #f3eee7; background: var(--hp-hi, #f3eee7);
    box-shadow: 0 0 8px rgba(243, 238, 231, 0.8); box-shadow: 0 0 8px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.8); }

/* seek bar */
.hp-seek { position: relative; height: 30px; cursor: pointer; -ms-touch-action: none; touch-action: none; }
.hp-seek-track { position: absolute; left: 0; right: 0; top: 13px; height: 4px; border-radius: 2px; overflow: hidden;
    background: rgba(255, 255, 255, 0.16); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.16);
    -webkit-transition: top 0.15s, height 0.15s; transition: top 0.15s, height 0.15s; }
.hp-seek-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 2px;
    background: #f3eee7; background: var(--hp-hi, #f3eee7); }
.hp-seek-knob { position: absolute; top: 9px; left: 0; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%;
    background: #f3eee7; background: var(--hp-hi, #f3eee7);
    box-shadow: 0 0 0 4px rgba(243, 238, 231, 0.22), 0 2px 8px rgba(0, 0, 0, 0.5);
    box-shadow: 0 0 0 4px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.22), 0 2px 8px rgba(0, 0, 0, 0.5);
    -webkit-transition: -webkit-transform 0.15s; transition: transform 0.15s; }
.hp-keys .hp-seek.hp-focused .hp-seek-track { top: 11px; height: 8px; border-radius: 4px; }
.hp-keys .hp-seek.hp-focused .hp-seek-knob { -webkit-transform: scale(1.5); transform: scale(1.5); }

/* torrent streams: the downloaded parts shown on the seek bar */
.hp-seek-have { position: absolute; left: 0; right: 0; top: 0; bottom: 0; pointer-events: none; }
.hp-seek-have i { position: absolute; top: 0; bottom: 0; background: rgba(255, 255, 255, 0.46);
    background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.46); }
.hp-seek-have i.hp-part { background: rgba(255, 255, 255, 0.24); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.24); }

/* the label that follows your finger while you drag the bar */
.hp-seek-tip { position: absolute; bottom: 38px; left: 0; padding: 7px 14px 8px; border-radius: 14px;
    border-radius: var(--hp-pr, 14px); display: none; text-align: center; white-space: nowrap; pointer-events: none;
    -webkit-transform: translateX(-50%); transform: translateX(-50%); }
.hp-seek-tip.hp-on { display: block; }
.hp-tip-time { display: block; font-size: 1.02rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.hp-tip-state { display: block; margin-top: 1px; font-size: 0.74rem; font-weight: 600; letter-spacing: 0.03em;
    color: rgba(246, 242, 236, 0.72); color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.72); }
.hp-tip-state.hp-ok { color: #f3eee7; color: var(--hp-hi, #f3eee7); }
.hp-tip-state.hp-no { color: #f2b84b; }

/* control row: time on the left, transport in the middle, tracks + exit on the right */
.hp-row { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
.hp-grp { display: flex; align-items: center; gap: 10px; -webkit-box-flex: 1; flex: 1 1 0; min-width: 0; }
.hp-grp-mid { -webkit-box-flex: 0; flex: 0 0 auto; gap: 16px; -webkit-box-pack: center; justify-content: center; }
.hp-grp-end { -webkit-box-pack: end; justify-content: flex-end; }
.hp-times { white-space: nowrap; font-size: 0.95rem; font-weight: 600; font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7); }
.hp-time { display: inline; }
.hp-sep { margin: 0 0.4em; opacity: 0.45; }
.hp-times .hp-time + .hp-sep + .hp-time { opacity: 0.7; }

/* buttons: round glass, one clean icon each. The play button is solid in the theme's highlight colour. */
.hp-btn { position: relative; width: 48px; height: 48px; padding: 0; display: -webkit-box; display: flex;
    -webkit-box-align: center; align-items: center; -webkit-box-pack: center; justify-content: center;
    border-radius: 999px; border-radius: var(--hp-r, 999px); cursor: pointer; font: inherit;
    -webkit-tap-highlight-color: transparent;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    -webkit-transition: -webkit-transform 0.15s, background-color 0.15s, color 0.15s, box-shadow 0.15s, border-color 0.15s;
    transition: transform 0.15s, background-color 0.15s, color 0.15s, box-shadow 0.15s, border-color 0.15s; }
.hp-btn svg { width: 26px; height: 26px; display: block; pointer-events: none; }
.hp-btn.hp-sm { width: 42px; height: 42px; }
.hp-btn.hp-sm svg { width: 22px; height: 22px; }
.hp-btn.hp-main { width: 62px; height: 62px; border-color: transparent;
    background-color: #f3eee7; background-color: var(--hp-hi, #f3eee7);
    color: #2b2622; color: var(--hp-ink, #2b2622); box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45); }
.hp-btn.hp-main svg { width: 32px; height: 32px; }
.hp-btn:active { -webkit-transform: scale(0.94); transform: scale(0.94); }
.hp-keys .hp-btn.hp-focused { -webkit-transform: scale(1.1); transform: scale(1.1); border-color: transparent;
    background-color: #f3eee7; background-color: var(--hp-hi, #f3eee7);
    color: #2b2622; color: var(--hp-ink, #2b2622);
    box-shadow: 0 0 0 3px rgba(243, 238, 231, 0.38), 0 10px 28px rgba(0, 0, 0, 0.5);
    box-shadow: 0 0 0 3px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.38), 0 10px 28px rgba(0, 0, 0, 0.5); }
.hp-keys .hp-btn.hp-main.hp-focused { box-shadow: 0 0 0 4px rgba(243, 238, 231, 0.42), 0 0 30px rgba(243, 238, 231, 0.5);
    box-shadow: 0 0 0 4px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.42), 0 0 30px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.5); }
@media (hover: hover) {
    .hp-btn:hover:not(.hp-main) { background-color: rgba(255, 255, 255, 0.18);
        background-color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.18); }
    .hp-btn.hp-main:hover { -webkit-transform: scale(1.06); transform: scale(1.06); }
}

/* thin progress line that stays at the bottom edge while the controls are hidden */
.hp-line { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; pointer-events: none;
    background: rgba(255, 255, 255, 0.12); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.12);
    -webkit-transition: opacity 0.25s; transition: opacity 0.25s; }
.hp-line-fill { height: 100%; width: 0; background: #f3eee7; background: var(--hp-hi, #f3eee7); }
.hp-show .hp-line { opacity: 0; }

/* torrent loading card: shown while the picture is waiting for the download */
.hp-stream { position: absolute; left: 50%; top: 50%; width: 320px; max-width: 86%;
    padding: 16px 18px 14px; border-radius: 16px; border-radius: var(--hp-pr, 16px); display: none;
    -webkit-transform: translate(-50%, -50%); transform: translate(-50%, -50%);
    background-color: rgba(28, 24, 21, 0.82); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.8);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55); }
.hp-stream.hp-on { display: block; -webkit-animation: hp-pop 0.22s ease-out; animation: hp-pop 0.22s ease-out; }
.hp-stream-eyebrow { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
    color: rgba(246, 242, 236, 0.62); color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.62); }
.hp-stream-title { margin-top: 2px; font-size: 1.55rem; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
.hp-stream-bar { height: 6px; border-radius: 3px; overflow: hidden; margin: 13px 0 9px;
    background: rgba(255, 255, 255, 0.16); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.16); }
.hp-stream-fill { height: 100%; width: 3%; border-radius: 3px; background: #f3eee7; background: var(--hp-hi, #f3eee7);
    -webkit-transition: width 0.45s ease; transition: width 0.45s ease; }
.hp-stream-line { display: flex; -webkit-box-pack: justify; justify-content: space-between; gap: 12px;
    font-size: 0.86rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.hp-stream-eta { color: rgba(246, 242, 236, 0.7); color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.7); text-align: right; }
.hp-stream-foot { margin-top: 10px; padding-top: 9px; font-size: 0.78rem; letter-spacing: 0.02em;
    border-top: 1px solid rgba(255, 255, 255, 0.12); border-top: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.12);
    color: rgba(246, 242, 236, 0.62); color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.62); }
@-webkit-keyframes hp-pop { from { opacity: 0; -webkit-transform: translate(-50%, -46%); } to { opacity: 1; -webkit-transform: translate(-50%, -50%); } }
@keyframes hp-pop { from { opacity: 0; transform: translate(-50%, -46%); } to { opacity: 1; transform: translate(-50%, -50%); } }
.hp-stream-ring { position: absolute; top: 16px; right: 18px; width: 16px; height: 16px; border-radius: 50%;
    border: 2.5px solid rgba(255, 255, 255, 0.18); border-top-color: #f3eee7;
    border: 2.5px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.18); border-top-color: var(--hp-hi, #f3eee7);
    -webkit-animation: hp-spin 0.9s linear infinite; animation: hp-spin 0.9s linear infinite; }

.hp-spinner { position: absolute; top: 50%; left: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px;
    border-radius: 50%; border: 3px solid rgba(255, 255, 255, 0.18); border-top-color: #f3eee7;
    border: 3px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.18); border-top-color: var(--hp-hi, #f3eee7);
    display: none; -webkit-animation: hp-spin 0.9s linear infinite; animation: hp-spin 0.9s linear infinite; }
.hp-spinner.hp-on { display: block; }
@-webkit-keyframes hp-spin { to { -webkit-transform: rotate(360deg); } }
@keyframes hp-spin { to { transform: rotate(360deg); } }

.hp-error { position: absolute; top: 50%; left: 10%; right: 10%; margin-top: -1.5em; text-align: center;
    font-size: 1.15rem; display: none; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7); }

/* audio / subtitle menu */
.hp-menu { position: absolute; right: 22px; bottom: 118px; min-width: 230px; max-width: 80%; max-height: 50%;
    overflow-y: auto; padding: 8px; border-radius: 16px; border-radius: var(--hp-pr, 16px); display: none;
    background-color: rgba(28, 24, 21, 0.92); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.9);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6); }
.hp-menu.hp-open { display: block; }
.hp-menu-title { margin: 6px 10px 6px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
    color: rgba(246, 242, 236, 0.6); color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.6); }
.hp-menu-item { padding: 10px 12px; border-radius: 10px; border-radius: var(--hp-ir, 10px); cursor: pointer;
    border: 1px solid transparent; white-space: pre; font-weight: 500; }
.hp-menu-item.hp-focused { background: #f3eee7; background: var(--hp-hi, #f3eee7); color: #2b2622; color: var(--hp-ink, #2b2622); }

/* "Stop watching?" */
.hp-confirm { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: none;
    -webkit-box-align: center; align-items: center; -webkit-box-pack: center; justify-content: center;
    background: rgba(5, 8, 15, 0.66); background: rgba(var(--hp-shade-rgb, 14, 12, 10), 0.66);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.hp-confirm.hp-open { display: -webkit-box; display: flex; }
.hp-confirm-card { width: 400px; max-width: 90%; padding: 22px 24px 18px; border-radius: 16px; border-radius: var(--hp-pr, 16px);
    background-color: rgba(28, 24, 21, 0.94); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.92);
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6); }
.hp-confirm-title { font-size: 1.3rem; font-weight: 700; }
.hp-confirm-msg { margin-top: 6px; color: rgba(246, 242, 236, 0.68); color: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.68); }
.hp-confirm-row { display: flex; -webkit-box-pack: end; justify-content: flex-end; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
.hp-confirm-btn { padding: 11px 22px; border-radius: 12px; border-radius: var(--hp-ir, 12px); font: inherit; font-size: 1rem; font-weight: 600; cursor: pointer;
    color: #f6f2ec; color: var(--hp-fg, #f6f2ec);
    background: rgba(255, 255, 255, 0.1); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16); border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.16);
    -webkit-transition: background-color 0.15s, color 0.15s; transition: background-color 0.15s, color 0.15s; }
.hp-confirm-btn.hp-focused { background: #f3eee7; background: var(--hp-hi, #f3eee7); color: #2b2622; color: var(--hp-ink, #2b2622);
    border-color: transparent;
    box-shadow: 0 0 0 3px rgba(243, 238, 231, 0.32); box-shadow: 0 0 0 3px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.32); }

/* minimize button (top-left of the full-screen player; phones only) */
.hp-min { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; cursor: pointer;
    display: flex; align-items: center; justify-content: center; pointer-events: none;
    -webkit-tap-highlight-color: transparent; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35); }
.hp-show .hp-min { pointer-events: auto; }
.hp-min:active { -webkit-transform: scale(0.94); transform: scale(0.94); }
.hp-min svg { width: 26px; height: 26px; }

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
.hp-mini-btn:active { background: rgba(127, 127, 127, 0.25); background: var(--sx-surface-focused, rgba(127, 127, 127, 0.25)); }
html.hp-mini-on, html.hp-mini-on body { background: transparent !important; }
html.hp-mini-on body { height: calc(100vh - var(--hp-mini-h)); height: calc(100dvh - var(--hp-mini-h)); }
html.hp-mini-on .pek-shell { height: calc(100vh - var(--hp-mini-h)); height: calc(100dvh - var(--hp-mini-h)); }
html.hp-mini-on::before { content: ''; position: fixed; left: 0; right: 0; top: 0; bottom: var(--hp-mini-h);
    background: #090d16; background: var(--sx-bg, #090d16); z-index: -1; }
html.hp-mini-on .theme-panel-overlay, html.hp-mini-on .plugin-window { bottom: var(--hp-mini-h); }

/* Going to / coming from the mini player: the picture glides (see _glide), the page and the bar fade. */
@-webkit-keyframes hp-mini-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes hp-mini-fade-in { from { opacity: 0; } to { opacity: 1; } }
@-webkit-keyframes hp-mini-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes hp-mini-fade-out { from { opacity: 1; } to { opacity: 0; } }
@-webkit-keyframes hp-mini-rise { from { opacity: 0; -webkit-transform: translateY(14px); } to { opacity: 1; -webkit-transform: none; } }
@keyframes hp-mini-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
html.hp-mini-in .pek-shell, html.hp-mini-in::before {
    -webkit-animation: hp-mini-fade-in 0.32s ease-out both; animation: hp-mini-fade-in 0.32s ease-out both; }
html.hp-mini-in .hp-mini-rest, html.hp-mini-in .hp-mini-progress {
    -webkit-animation: hp-mini-rise 0.34s cubic-bezier(0.2, 0.8, 0.2, 1) both; animation: hp-mini-rise 0.34s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
html.hp-mini-out .pek-shell, html.hp-mini-out::before, html.hp-mini-out .hp-mini {
    -webkit-animation: hp-mini-fade-out 0.26s ease-in both; animation: hp-mini-fade-out 0.26s ease-in both; }

@media (max-width: 640px) {
    .hp-top { padding: 14px 14px 46px; }
    .hp-bottom { padding: 46px 14px 12px; }
    .hp-row { flex-wrap: wrap; row-gap: 10px; }
    .hp-grp-mid { -webkit-box-ordinal-group: 0; order: -1; -webkit-box-flex: 1; flex: 1 1 100%; }
    .hp-menu { right: 12px; bottom: 130px; }
    .hp-chip { padding: 6px 10px; font-size: 0.72rem; }
}
@media (max-height: 420px) {
    .hp-bottom { padding-top: 36px; }
    .hp-stream { padding: 12px 16px 11px; }
    .hp-stream-title { font-size: 1.3rem; }
}
/* TV / set-top box ("lite") mode. Blur filters, big soft shadows and animated shadows are what make a
   TV GPU drop frames, and over the native video surface the blur has nothing to blur anyway. So the
   same glass look is kept with a denser translucent fill, and only opacity / transform are animated
   (both run on the compositor, no repaint). Phones and desktop keep the full glass. */
.hp-lite .hp-btn, .hp-lite .hp-chip, .hp-lite .hp-seek-tip, .hp-lite .hp-stream, .hp-lite .hp-menu,
.hp-lite .hp-confirm-card, .hp-lite .hp-min {
    -webkit-backdrop-filter: none; backdrop-filter: none;
    background-color: rgba(28, 24, 21, 0.8);
    background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.8);
    box-shadow: none; }
.hp-lite .hp-stream, .hp-lite .hp-menu, .hp-lite .hp-confirm-card {
    background-color: rgba(28, 24, 21, 0.94); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.94); }
.hp-lite .hp-confirm { -webkit-backdrop-filter: none; backdrop-filter: none;
    background: rgba(5, 8, 15, 0.78); background: rgba(var(--hp-shade-rgb, 14, 12, 10), 0.78); }
.hp-lite .hp-btn { -webkit-transition: -webkit-transform 0.12s; transition: transform 0.12s; }
.hp-lite .hp-btn.hp-main { box-shadow: none; }
.hp-keys.hp-lite .hp-btn.hp-focused {
    -webkit-transform: scale(1.08); transform: scale(1.08);
    box-shadow: 0 0 0 3px rgba(243, 238, 231, 0.45); box-shadow: 0 0 0 3px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.45); }
.hp-keys.hp-lite .hp-btn.hp-main.hp-focused { box-shadow: 0 0 0 4px rgba(243, 238, 231, 0.5);
    box-shadow: 0 0 0 4px rgba(var(--hp-hi-rgb, 243, 238, 231), 0.5); }
.hp-lite .hp-seek-track, .hp-lite .hp-seek-knob { -webkit-transition: none; transition: none; }
.hp-lite .hp-seek-knob { box-shadow: none; }
.hp-lite .hp-times, .hp-lite .hp-top-title, .hp-lite .hp-error { text-shadow: none; }
.hp-lite .hp-top, .hp-lite .hp-bottom { will-change: opacity, transform;
    -webkit-transition: opacity 0.2s ease, -webkit-transform 0.2s ease, visibility 0s linear 0.2s;
    transition: opacity 0.2s ease, transform 0.2s ease, visibility 0s linear 0.2s; visibility: hidden; }
.hp-lite.hp-show .hp-top, .hp-lite.hp-show .hp-bottom { visibility: visible;
    -webkit-transition-delay: 0s; transition-delay: 0s; }
.hp-lite .hp-stream.hp-on { -webkit-animation: none; animation: none; }
.hp-lite .hp-stream-fill { -webkit-transition: none; transition: none; }
.hp-lite .hp-menu-item, .hp-lite .hp-confirm-btn { -webkit-transition: none; transition: none; }
`;

    // TV / box = running inside the Android app but not on a phone. Used to switch to the lighter look.
    function isLiteDevice() {
        try {
            const a = window.PekAndroid;
            if (!a) return false;
            if (typeof a.isPhone === 'function') return !a.isPhone();
            return typeof a.mpvLoad === 'function';
        } catch (e) { return false; }
    }

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


    function fmtSpeed(kbps) {
        kbps = kbps > 0 ? kbps : 0;
        return kbps >= 1024 ? (kbps / 1024).toFixed(1) + ' MB/s' : kbps + ' KB/s';
    }

    function fmtWait(sec) {
        if (!isFinite(sec) || sec < 0) return '';
        sec = Math.max(1, Math.round(sec));
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        return 'over an hour';
    }

    // ---- icons: one clean glyph per button (drawn with currentColor, so the theme colours them) ----
    const ICONS = {
        guide: '<path fill="currentColor" d="M4 5h16v3H4zM4 10.5h9v3H4zM15 10.5h5v3h-5zM4 16h5v3H4zM11 16h9v3h-9z"/>',
        list: '<path fill="currentColor" d="M4 6h3v3H4zM9.5 6.5H20v2H9.5zM4 10.5h3v3H4zM9.5 11H20v2H9.5zM4 15h3v3H4zM9.5 15.5H20v2H9.5z"/>',
        play: '<path fill="currentColor" d="M8.2 5.3v13.4c0 .8.9 1.3 1.6.9l10.4-6.7c.6-.4.6-1.3 0-1.7L9.8 4.4c-.7-.4-1.6.1-1.6.9z"/>',
        pause: '<rect x="6.2" y="5" width="4" height="14" rx="1.3" fill="currentColor"/><rect x="13.8" y="5" width="4" height="14" rx="1.3" fill="currentColor"/>',
        rew: '<path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>' +
             '<text x="12" y="16.4" text-anchor="middle" font-size="7.4" font-weight="700" fill="currentColor" font-family="system-ui,sans-serif">10</text>',
        fwd: '<path fill="currentColor" d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>' +
             '<text x="12" y="16.4" text-anchor="middle" font-size="7.4" font-weight="700" fill="currentColor" font-family="system-ui,sans-serif">10</text>',
        audio: '<path fill="currentColor" d="M4 9.6v4.8h3.4l4.6 3.9V5.7L7.4 9.6H4z"/>' +
               '<path d="M15.4 9.2a4.2 4.2 0 0 1 0 5.6M17.9 6.7a7.6 7.6 0 0 1 0 10.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
        subs: '<rect x="3" y="5.2" width="18" height="13.6" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.9"/>' +
              '<path d="M7 10.8h3.2M12.6 10.8H17M7 14.6h5.2M14.6 14.6H17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
        close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
        skip: '<path fill="currentColor" d="M4.5 6v12l8-6-8-6zm8.5 0v12l8-6-8-6z"/>'
    };

    function setIcon(btn, name) {
        if (btn._icon === name) return;
        btn._icon = name;
        btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    }

    // ---- theme: derive the player's colours from the active skin's --sx-* tokens ----
    // The player sits on top of a picture, so it always uses dark glass with light text. The skin
    // decides the tint of the glass, the highlight colour (play button, seek bar, focus) and the
    // roundness. "PEK Cream" gets a warm cream highlight; Green / Neon get their accent colour.
    function parseColor(str) {
        str = String(str || '').trim();
        let m = /^#([0-9a-f]{3,8})$/i.exec(str);
        if (m) {
            let h = m[1];
            if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
            if (h.length < 6) return null;
            return { r: parseInt(h.substr(0, 2), 16), g: parseInt(h.substr(2, 2), 16), b: parseInt(h.substr(4, 2), 16) };
        }
        m = /^rgba?\(([^)]+)\)/i.exec(str);
        if (m) {
            const a = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
            if (a.length >= 3 && isFinite(a[0]) && isFinite(a[1]) && isFinite(a[2])) return { r: a[0], g: a[1], b: a[2] };
        }
        return null;
    }
    function lum(c) {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }
    const rgbText = (c, k) => Math.round(c.r * (k || 1)) + ', ' + Math.round(c.g * (k || 1)) + ', ' + Math.round(c.b * (k || 1));
    const hexText = c => 'rgb(' + rgbText(c) + ')';

    function applyPlayerTheme(root) {
        try {
            const cs = getComputedStyle(document.documentElement);
            const tok = n => parseColor(cs.getPropertyValue('--sx-' + n));
            const pick = (names, darkest) => {
                const list = names.map(tok).filter(Boolean).sort((a, b) => lum(a) - lum(b));
                return list.length ? (darkest ? list[0] : list[list.length - 1]) : null;
            };
            const dark = pick(['bg', 'bg-elevated', 'text', 'accent'], true);
            const text = tok('text'), accent = tok('accent');
            const lightest = pick(['bg-elevated', 'surface', 'text', 'bg'], false);
            if (!dark || !lightest) return;               // no tokens: the CSS fallbacks (warm cream) apply
            const fg = text && lum(text) > 0.6 ? text : lightest;
            const hi = accent && lum(accent) >= 0.22 ? accent : lightest;
            const set = (k, v) => root.style.setProperty(k, v);
            set('--hp-fg', hexText(fg));           set('--hp-fg-rgb', rgbText(fg));
            set('--hp-hi', hexText(hi));           set('--hp-hi-rgb', rgbText(hi));
            set('--hp-ink', hexText(dark));
            set('--hp-base-rgb', rgbText(dark, 0.7));
            set('--hp-shade-rgb', rgbText(dark, 0.45));
            const r = parseInt(cs.getPropertyValue('--sx-radius'), 10);
            const rad = isFinite(r) ? r : 16;
            set('--hp-r', rad >= 20 ? '999px' : Math.max(rad, 2) + 'px');
            const pr = Math.min(Math.max(rad, 4), 20);
            set('--hp-pr', pr + 'px');
            set('--hp-ir', Math.max(3, Math.round(pr * 0.65)) + 'px');
        } catch (e) { /* keep the fallbacks */ }
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

    class PekPlayerBackend {
        constructor() { this._handlers = {}; }
        on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; }
        emit(ev, data) {
            const list = this._handlers[ev];
            if (!list) return;
            list.slice().forEach(fn => { try { fn(data); } catch (e) { console.error('[PekPlayer]', e); } });
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
        addSubtitle(url, label) { return Promise.resolve(false); }
        destroy() {}
    }

    // Plays through a <video> element: the web/dev build, and a stand-in for testing.
    class HtmlVideoBackend extends PekPlayerBackend {
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
            // jumping ahead in a stream that is still downloading: say so, so the player can show the loading card
            v.addEventListener('seeking', () => this.emit('state', { playing: !v.paused, buffering: true }));
            v.addEventListener('seeked', () => this.emit('state', { playing: !v.paused, buffering: v.readyState < 3 }));
            v.addEventListener('canplay', () => this.emit('state', { playing: !v.paused, buffering: false }));
            v.addEventListener('ended', () => this.emit('ended'));
            this._ext = [];   // subtitles added with addSubtitle(): { id, label, el, url, on }
            v.addEventListener('loadedmetadata', () => this._emitTracks());
            v.addEventListener('error', () => {
                const err = v.error;
                this.emit('error', { message: (err && err.message) || 'This file could not be played here.' });
            });
        }
        attach(container) { container.appendChild(this.video); }
        _emitTracks() {
            this.emit('tracks', { audio: [], subtitles: this._ext.map(e => ({ id: e.id, label: e.label, selected: e.on })) });
        }
        setSubtitleTrack(id) {
            this._ext.forEach(e => { e.on = (e.id === id); try { e.el.track.mode = e.on ? 'showing' : 'disabled'; } catch (x) { /* ignore */ } });
        }
        async addSubtitle(url, label) {
            const r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) throw new Error('Could not load that subtitle.');
            let text = await r.text();
            if (window.PekSubs && window.PekSubs.toVtt) text = window.PekSubs.toVtt(text);
            const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
            const t = document.createElement('track');
            t.kind = 'subtitles';
            t.label = label || 'Subtitles';
            t.src = blobUrl;
            this.video.appendChild(t);
            const id = 'x' + (this._ext.length + 1);
            this._ext.push({ id: id, label: label || 'Subtitles', el: t, url: blobUrl, on: false });
            this.setSubtitleTrack(id);
            this._emitTracks();
            return true;
        }
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
            (this._ext || []).forEach(e => { try { URL.revokeObjectURL(e.url); } catch (x) { /* ignore */ } });
            v.removeAttribute('src');
            if (v.load) v.load();
            if (v.parentNode) v.parentNode.removeChild(v);
        }
    }

    // Android: libmpv draws on a native surface behind the page (see MpvController.kt).
    // This class only forwards the controls above to the app's PekAndroid bridge and
    // turns the native events back into the contract events.
    class MpvBackend extends PekPlayerBackend {
        constructor(opts) {
            super();
            opts = opts || {};
            this.title = opts.title || '';
            this.theme = opts.theme || '';
            this._cb = (ev, data) => this.emit(ev, data);
            window.__pekMpv = this._cb;
        }
        // Phone = not a TV / leanback box and has a touchscreen (decided natively).
        static isPhone() {
            try { return !!(window.PekAndroid && typeof window.PekAndroid.isPhone === 'function' && window.PekAndroid.isPhone()); }
            catch (e) { return false; }
        }
        static available() {
            return !!(window.PekAndroid && typeof window.PekAndroid.mpvLoad === 'function');
        }
        get drawsBehindPage() { return true; }
        get supportsMini() { return MpvBackend.isPhone() && typeof window.PekAndroid.mpvSetRect === 'function'; }
        setMiniRect(r) {
            if (r) window.PekAndroid.mpvSetRect(r.left, r.top, r.width, r.height);
            else window.PekAndroid.mpvFullscreen();
        }
        attach() { document.documentElement.classList.add('hp-mpv'); }
        load(url, startSec) { window.PekAndroid.mpvLoad(url, startSec || 0, this.title, this.theme); }
        play() { window.PekAndroid.mpvPlay(); }
        pause() { window.PekAndroid.mpvPause(); }
        seek(sec) { window.PekAndroid.mpvSeek(sec); }
        setAudioTrack(id) { window.PekAndroid.mpvSetAudio(id); }
        setSubtitleTrack(id) { window.PekAndroid.mpvSetSubtitle(id === null || id === undefined ? -1 : id); }
        addSubtitle(url, label) {
            // an older app build has no mpvAddSubtitle: the caller then says the player can't do it
            if (typeof window.PekAndroid.mpvAddSubtitle !== 'function') return Promise.resolve(false);
            window.PekAndroid.mpvAddSubtitle(url, label || 'Subtitles');
            return Promise.resolve(true);
        }
        destroy() {
            try { window.PekAndroid.mpvDestroy(); } catch (e) { /* ignore */ }
            // only clear the hook if it is still ours (a newer player may already own it)
            if (window.__pekMpv === this._cb) window.__pekMpv = null;
            document.documentElement.classList.remove('hp-mpv');
        }
    }

    // ---------------- the controls ----------------

    class PekPlayer {
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
            this._seekTo = null;           // where the user last jumped to, until playback has caught up
            this._seekAt = 0;
            this._seekSawWait = false;
            this._pendingSeek = false;     // a jump on a torrent is held back for a moment (see _seekBy)
            this._waitSince = 0;
            this._waitTimer = null;
            this._streamTick = null;
            this._streamFlight = false;
            this.mini = false;             // true while shrunk into the docked mini player
            // Skip intro / recap (skip_segments.js). opts.skipMeta = what is playing ({kind, showTitle, season, ...}).
            this.skip = window.PekSkip ? new window.PekSkip.Controller(this, opts.skipMeta || null) : null;
            // Automatic subtitles (subtitles.js): looks them up when the file has none; opts.skipMeta is what is playing.
            this.subs = window.PekSubs ? new window.PekSubs.Controller(this, opts.skipMeta || null) : null;
            // Up next (next_episode.js): opts.next = { resolve, start } from the app, or none.
            this.next = window.PekNext && opts.next ? new window.PekNext.Controller(this, opts.next) : null;
            // Live channel overlay (live_overlay.js): opts.live = { channel, query, check } from a plugin's live session.
            this.live = window.PekLive && opts.live ? new window.PekLive.Controller(this, opts.live) : null;
            this.miniSupported = opts.allowMini !== false && !!this.backend.supportsMini;
        }

        open(url, startSec) {
            pekAnnouncePlayer(true);
            injectStyle();
            this._build();
            applyPlayerTheme(this.root);
            document.body.appendChild(this.root);
            this._startStreamWatch(url);
            if (this.backend.attach) this.backend.attach(this.videoLayer);
            if (this.live) this.live.attach();

            this._onKey = (e) => this._handleKey(e);
            this._onKeyUp = (e) => {
                if (normKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
            };
            window.addEventListener('keydown', this._onKey, true);
            window.addEventListener('keyup', this._onKeyUp, true);

            const b = this.backend;
            b.on('time', (d) => {
                this.state.duration = d.duration > 0 && isFinite(d.duration) ? d.duration : 0;
                if (!this._dragging && !this._pendingSeek) this.state.position = d.position || 0;
                this._settleSeek();
                this._updateTime();
                if (this.skip) this.skip.tick(this.state.position, this.state.duration);
                if (this.next) this.next.tick(this.state.position, this.state.duration);
                this._reportProgress(false);
            });
            b.on('state', (d) => {
                this.state.playing = !!d.playing;
                this.state.buffering = !!d.buffering;
                if (this.state.buffering) this._seekSawWait = true;
                this._settleSeek();
                this._updateButtons();
                if (this.state.playing) this._scheduleHide();
            });
            b.on('tracks', (d) => {
                this.state.audio = d.audio || [];
                this.state.subtitles = d.subtitles || [];
                if (this.skip && d.chapters) this.skip.setChapters(d.chapters);
                this._updateButtons();
                if (this.subs) this.subs.onTracks();
            });
            b.on('ended', () => { if (this.next && this.next.onEnded()) return; this.close(); });
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
            clearTimeout(this._waitTimer);
            clearTimeout(this._seekDebounce);
            this._reportProgress(true);
            if (this.skip) this.skip.destroy();
            if (this.next) this.next.destroy();
            if (this.live) this.live.destroy();
            if (this.subs) this.subs.destroy();
            clearTimeout(this._toastTimer);
            window.removeEventListener('keydown', this._onKey, true);
            window.removeEventListener('keyup', this._onKeyUp, true);
            this._leaveMiniLayout();
            try { this.backend.destroy(); } catch (e) { /* ignore */ }
            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
            pekAnnouncePlayer(false);
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
            this.root.classList.remove('hp-show');       // the controls fade out (CSS transition)
            this.mini = true;
            // the remote / keyboard belong to the app again while minimized
            window.removeEventListener('keydown', this._onKey, true);
            window.removeEventListener('keyup', this._onKeyUp, true);
            // Hide the control layer only once its fade is over (and let touches through meanwhile).
            this.root.style.pointerEvents = 'none';
            clearTimeout(this._miniHideT);
            this._miniHideT = setTimeout(() => { if (this.mini) this.root.style.display = 'none'; }, 240);
            const html = document.documentElement;
            html.classList.remove('hp-mpv');
            html.classList.remove('hp-mini-out');
            html.classList.add('hp-mini-on', 'hp-mini-in');   // -in: the page and the bar fade in
            if (!this.miniEl) this._buildMini();
            document.body.appendChild(this.miniEl);
            html.style.setProperty('--hp-mini-h', this.miniEl.offsetHeight + 'px');
            this._updateMini();
            this._onResize = () => { if (!this._gliding) this._sendMiniRect(); };
            window.addEventListener('resize', this._onResize);
            // Wait for the page to re-flow around the bar, then let the picture glide from full screen into its
            // thumbnail cell (a lite / weak device just jumps there).
            const raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
            raf(() => raf(() => {
                if (!this.mini) return;
                const to = this._miniThumbRect();
                const done = () => { html.classList.remove('hp-mini-in'); this._sendMiniRect(); };
                if (!to) { done(); return; }
                this._glide({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, to, 320, done);
            }));
        }

        // Where the picture belongs while minimized (the see-through cell of the bar), or null if not measurable.
        _miniThumbRect() {
            if (!this.miniThumb) return null;
            const r = this.miniThumb.getBoundingClientRect();
            return (r.width > 0 && r.height > 0) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
        }

        // Moves the native picture from one rectangle to another over `ms`, one step per screen refresh.
        // done() runs at the end, or at once when there is nothing to animate. A newer glide (or leaving the
        // mini layout) cancels this one.
        _glide(from, to, ms, done) {
            const id = this._glideId = (this._glideId || 0) + 1;
            const raf = window.requestAnimationFrame || function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
            const now = () => (window.performance && performance.now) ? performance.now() : Date.now();
            if (!ms || isLiteDevice()) { this._gliding = false; this.backend.setMiniRect(to); if (done) done(); return; }
            this._gliding = true;
            const t0 = now();
            const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;      // easeInOutCubic
            const mix = (a, b, k) => a + (b - a) * k;
            const step = () => {
                if (id !== this._glideId || this._closed) return;
                const t = Math.min(1, (now() - t0) / ms), k = ease(t);
                this.backend.setMiniRect({ left: mix(from.left, to.left, k), top: mix(from.top, to.top, k),
                                           width: mix(from.width, to.width, k), height: mix(from.height, to.height, k) });
                if (t < 1) raf(step);
                else { this._gliding = false; if (done) done(); }
            };
            this.backend.setMiniRect(from);
            raf(step);
        }

        // Mini bar -> full screen again.
        expand() {
            if (!this.mini || this._closed || this._expanding) return;
            const html = document.documentElement;
            const finish = () => {
                this._expanding = false;
                this._leaveMiniLayout();
                html.classList.remove('hp-mini-out');
                if (this.backend.drawsBehindPage) html.classList.add('hp-mpv');
                this.backend.setMiniRect(null);
                this.root.style.display = '';
                this.root.style.pointerEvents = '';
                window.addEventListener('keydown', this._onKey, true);
                window.addEventListener('keyup', this._onKeyUp, true);
                this.mode = 'hidden';
                this._show();
            };
            const from = this._miniThumbRect();
            if (!from) { finish(); return; }
            // The picture grows back to full screen while the page and the bar fade away, then the controls return.
            this._expanding = true;
            clearTimeout(this._miniHideT);
            html.classList.remove('hp-mini-in');
            html.classList.add('hp-mini-out');
            this._glide(from, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, 300, finish);
        }

        _leaveMiniLayout() {
            if (!this.mini) return;
            this.mini = false;
            this._glideId = (this._glideId || 0) + 1;      // cancels a glide that is still running
            this._gliding = false; this._expanding = false;
            clearTimeout(this._miniHideT);
            document.documentElement.classList.remove('hp-mini-in', 'hp-mini-out');
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
            catch (e) { console.error('[PekPlayer] onProgress', e); }
        }

        // The app's Back handler calls this while the player is open.
        onBack() {
            if (this.live && this.live.onBack()) return;
            if (this.mode === 'confirm') this._keepWatching();
            else if (this.mode === 'menu') this._closeMenu();
            else this._askExit();
        }

        // ---- building the screen ----
        _build() {
            const root = el('div', 'hp-root' + (this.backend.drawsBehindPage ? ' hp-transparent' : '') + (isLiteDevice() ? ' hp-lite' : ''));
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
            this.topTitle = el('div', 'hp-top-title', this.title);
            top.appendChild(this.topTitle);
            this.chip = el('div', 'hp-chip');
            this.chip.appendChild(el('i'));
            this.chipText = el('span');
            this.chip.appendChild(this.chipText);
            top.appendChild(this.chip);
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
            this.tipTime = el('span', 'hp-tip-time');
            this.tipState = el('span', 'hp-tip-state');
            this.seekTip.appendChild(this.tipTime);
            this.seekTip.appendChild(this.tipState);
            this.seek.appendChild(this.seekTip);
            this._wireSeek();

            // buttons: round glass with one icon each; Play is the solid one
            this.btns = {};
            const mk = (id, label, icon, fn, cls) => {
                const b = el('button', 'hp-btn' + (cls ? ' ' + cls : ''));
                b.setAttribute('type', 'button');
                b.setAttribute('aria-label', label);
                b.title = label;
                setIcon(b, icon);
                b.addEventListener('click', (ev) => { ev.stopPropagation(); this.focus = id; this._scheduleHide(); fn(); this._updateFocus(); });
                this.btns[id] = b;
                return b;
            };
            this.timeLeft = el('span', 'hp-time', '0:00');
            this.timeRight = el('span', 'hp-time', '0:00');
            const times = el('div', 'hp-times');
            times.appendChild(this.timeLeft);
            times.appendChild(el('span', 'hp-sep', '/'));
            times.appendChild(this.timeRight);
            const left = el('div', 'hp-grp');
            left.appendChild(times);
            const mid = el('div', 'hp-grp hp-grp-mid');
            mid.appendChild(mk('rew', 'Back 10 seconds', 'rew', () => this._seekBy(-10)));
            mid.appendChild(mk('play', 'Play', 'play', () => this._toggle(), 'hp-main'));
            mid.appendChild(mk('fwd', 'Forward 10 seconds', 'fwd', () => this._seekBy(10)));
            const end = el('div', 'hp-grp hp-grp-end');
            end.appendChild(mk('audio', 'Audio', 'audio', () => this._openMenu('audio'), 'hp-sm'));
            end.appendChild(mk('subs', 'Subtitles', 'subs', () => this._openMenu('subs'), 'hp-sm'));
            end.appendChild(mk('skip', 'Skip intro / recap', 'skip', () => this._openMenu('skip'), 'hp-sm'));
            if (this.live) {      // channel guide + channel list (shown once the plugin has answered)
                end.appendChild(mk('lguide', 'Guide', 'guide', () => this.live.open('guide'), 'hp-sm'));
                end.appendChild(mk('lchan', 'Channels', 'list', () => this.live.open('channels'), 'hp-sm'));
                this.btns.lguide.style.display = 'none';
                this.btns.lchan.style.display = 'none';
            }
            end.appendChild(mk('exit', 'Exit', 'close', () => this._askExit(), 'hp-sm'));
            const row = el('div', 'hp-row');
            row.appendChild(left);
            row.appendChild(mid);
            row.appendChild(end);
            bottom.appendChild(this.seek);
            bottom.appendChild(row);

            this.menuEl = el('div', 'hp-menu');
            this._buildConfirm();

            root.appendChild(this.videoLayer);
            root.appendChild(this.spinner);
            this.streamBox = el('div', 'hp-stream');
            this.streamBox.appendChild(el('div', 'hp-stream-ring'));
            this.streamEyebrow = el('div', 'hp-stream-eyebrow', 'Starting the stream');
            this.streamTitle = el('div', 'hp-stream-title', 'Just a moment');
            const sbar = el('div', 'hp-stream-bar');
            this.streamFill = el('div', 'hp-stream-fill');
            sbar.appendChild(this.streamFill);
            const sline = el('div', 'hp-stream-line');
            this.streamSub = el('span', 'hp-stream-sub');
            this.streamEta = el('span', 'hp-stream-eta');
            sline.appendChild(this.streamSub);
            sline.appendChild(this.streamEta);
            this.streamFoot = el('div', 'hp-stream-foot');
            this.streamBox.appendChild(this.streamEyebrow);
            this.streamBox.appendChild(this.streamTitle);
            this.streamBox.appendChild(sbar);
            this.streamBox.appendChild(sline);
            this.streamBox.appendChild(this.streamFoot);
            this.line = el('div', 'hp-line');
            this.lineFill = el('div', 'hp-line-fill');
            this.line.appendChild(this.lineFill);
            root.appendChild(this.streamBox);
            root.appendChild(this.line);
            root.appendChild(this.errorBox);
            root.appendChild(top);
            root.appendChild(bottom);
            root.appendChild(this.menuEl);
            root.appendChild(this.confirmEl);
            if (this.skip) { this.skip.mount(root); this.btns.skipnow = this.skip.el; }
            if (this.next) {
                this.next.mount(root);
                if (this.next.playBtn) this.btns.nextnow = this.next.playBtn;
                if (this.next.noBtn) this.btns.nextno = this.next.noBtn;      // "Not now" / "Cancel": reachable with the D-pad
            }   // the "Skip Intro" pill takes focus like a button

            // tap the picture to show / hide the controls
            root.addEventListener('pointerdown', (ev) => {
                root.classList.remove('hp-keys');
                if (this.mode === 'live') { if (this.live) this.live.close(); return; }
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
                // A torrent stream is only asked to jump once, when the finger lifts: every jump re-aims the download.
                if (send || (!this._streamUrl && now - lastSent > 250)) {
                    lastSent = now;
                    this.backend.seek(this.state.position);
                    if (send) this._noteSeek(this.state.position);
                }
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
            if (this.live) this.live.onShown();
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
            if (this.live) this.live.onHidden();
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
            if (this.lineFill) this.lineFill.style.width = pct + '%';
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
            this._streamTick = () => {
                clearTimeout(this._streamTimer);
                if (this._closed || !this._streamUrl || this._streamFlight) return;
                this._streamFlight = true;
                fetch(this._streamUrl, { cache: 'no-store' }).then(r => r.json()).then(s => {
                    if (this._closed || !s || s.error) return;
                    this.stream = { peers: s.peers | 0, kbps: s.downKBps | 0, done: s.fileProgress || 0, have: s.have || null, size: s.fileSize || 0 };
                    this._renderStream();
                }).catch(() => { /* try again next time */ }).then(() => {
                    this._streamFlight = false;
                    if (this._closed) return;
                    const busy = (this.state && this.state.buffering) || this._dragging || this._seekTo !== null;
                    this._streamTimer = setTimeout(this._streamTick, busy ? 500 : 2500);
                });
            };
            this._streamTick();
        }

        // Ask for fresh numbers right now (after a jump), instead of waiting for the next poll.
        _pollStreamNow() { if (this._streamTick && !this._closed) this._streamTick(); }

        // The user jumped to `t` seconds. For a torrent the part there may not be downloaded yet, so
        // remember the target: the loading card shows it, with how much of that part has arrived.
        _noteSeek(t) {
            this._pendingSeek = false;
            this._seekTo = t;
            this._seekAt = Date.now();
            this._seekSawWait = !!this.state.buffering;
            if (this._streamUrl) { this._pollStreamNow(); this._renderStream(); }
        }

        // Forget the jump target once playback has caught up with it.
        _settleSeek() {
            if (this._seekTo === null) return;
            const age = Date.now() - this._seekAt;
            if (!this.state.buffering && (this._seekSawWait || age > 2500)) this._seekTo = null;
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

        // Draws the downloaded parts on the seek bar (only when they changed).
        _drawHave(have) {
            const sig = have ? have.join(',') : '';
            if (sig === this._haveSig) return;
            this._haveSig = sig;
            this.seekHave.innerHTML = '';
            if (!have) return;
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

        _renderStream() {
            if (this._closed || !this._streamUrl) return;
            const s = this.stream;
            const now = Date.now();
            const waiting = !!this.state.buffering && this.errorBox.style.display !== 'block';

            if (s) {                                   // live numbers in the corner + the map on the seek bar
                // A swarm often shows 0 for a second or two while connections are swapped. Keep the last real
                // number for 12 s so the chip does not flicker; after that say what is going on.
                if (s.peers > 0) { this._peersSeen = s.peers; this._peersAt = now; }
                const shown = (s.peers === 0 && this._peersSeen && now - this._peersAt < 12000) ? this._peersSeen : s.peers;
                this.chipText.textContent = shown > 0 ? shown + ' peers \u00b7 ' + fmtSpeed(s.kbps) : 'Finding peers\u2026 \u00b7 ' + fmtSpeed(s.kbps);
                this.chip.classList.add('hp-on');
                this._drawHave(s.have);
            }

            // Only show the card when the wait is a real one (a jump inside what is already loaded takes no time).
            if (waiting) {
                if (!this._waitSince) {
                    this._waitSince = now;
                    clearTimeout(this._waitTimer);
                    this._waitTimer = setTimeout(() => this._renderStream(), 340);
                }
            } else {
                this._waitSince = 0;
            }
            const show = waiting && now - this._waitSince >= 300;
            this.streamBox.classList.toggle('hp-on', show);
            this.spinner.classList.toggle('hp-on', waiting && !show);
            if (!show) return;

            const d = this.state.duration;
            const p = this._seekTo !== null ? this._seekTo : this.state.position;
            if (this._seekTo !== null) { this.streamEyebrow.textContent = 'Skipping to'; this.streamTitle.textContent = fmtTime(p); }
            else if (p > 0) { this.streamEyebrow.textContent = 'Buffering at'; this.streamTitle.textContent = fmtTime(p); }
            else { this.streamEyebrow.textContent = 'Starting the stream'; this.streamTitle.textContent = 'Just a moment'; }

            if (!s) {                                  // first status not here yet
                this.streamFill.style.width = '3%';
                this.streamSub.textContent = 'Connecting to the torrent\u2026';
                this.streamEta.textContent = '';
                this.streamFoot.textContent = '';
                return;
            }
            const pct = this._haveAt(d > 0 ? p / d : 0);
            this.streamFill.style.width = Math.max(3, pct === null ? 3 : pct) + '%';
            this.streamSub.textContent = pct === null ? 'Checking the download\u2026'
                : (pct >= 90 ? 'Almost ready' : pct + '% ready');
            // Time left: what is still missing of the part playback needs next, at the current speed.
            let eta = '';
            if (pct !== null && pct < 90 && s.have && s.size) {
                const missing = (s.size / s.have.length) * 3 * (100 - pct) / 100;
                eta = s.kbps > 0 ? '~' + fmtWait(missing / (s.kbps * 1024)) + ' left' : 'waiting for peers';
            }
            this.streamEta.textContent = eta;
            this.streamFoot.textContent = s.peers + ' peers \u00b7 ' + fmtSpeed(s.kbps) + ' \u00b7 ' +
                Math.round(s.done * 100) + '% of file';
        }

        // While dragging the bar: the time under the finger, and whether that part is downloaded yet.
        _updateSeekTip() {
            if (!this.seekTip) return;
            if (!this._dragging) { this.seekTip.classList.remove('hp-on'); return; }
            const d = this.state.duration, p = this.state.position;
            const pct = d > 0 ? Math.min(100, Math.max(0, p / d * 100)) : 0;
            this.tipTime.textContent = fmtTime(p);
            const h = this._haveAt(d > 0 ? p / d : 0);
            let t = '', c = 'hp-tip-state';
            if (h !== null) {
                if (h >= 90) { t = 'Ready to play'; c += ' hp-ok'; }
                else if (h > 0) t = h + '% loaded';
                else { t = 'Not downloaded yet'; c += ' hp-no'; }
            }
            this.tipState.textContent = t;
            this.tipState.className = c;
            this.tipState.style.display = t ? '' : 'none';
            this.seekTip.style.left = Math.min(88, Math.max(12, pct)) + '%';
            this.seekTip.classList.add('hp-on');
        }

        _focusOrder() {
            const order = ['seek', 'rew', 'play', 'fwd'];
            if (this.skip && this.skip.cur) order.push('skipnow');
            if (this.next && this.next.visible()) { order.push('nextnow'); order.push('nextno'); }
            if (this.state.audio.length > 1) order.push('audio');
            if (this._subsButton()) order.push('subs');
            if (this.skip && this.skip.available()) order.push('skip');
            if (this.live) {
                const ls = this.live.buttonsShown();
                if (ls.guide) order.push('lguide');
                if (ls.channels) order.push('lchan');
            }
            order.push('exit');
            return order;
        }

        _updateButtons() {
            setIcon(this.btns.play, this.state.playing ? 'pause' : 'play');
            this.btns.play.setAttribute('aria-label', this.state.playing ? 'Pause' : 'Play');
            this.btns.play.title = this.state.playing ? 'Pause' : 'Play';
            this.btns.audio.style.display = this.state.audio.length > 1 ? '' : 'none';
            this.btns.subs.style.display = this._subsButton() ? '' : 'none';
            this.btns.skip.style.display = this.skip && this.skip.available() ? '' : 'none';
            const waiting = this.state.buffering && this.errorBox.style.display !== 'block';
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
            if (this._streamUrl) {
                // torrent: a run of taps becomes one jump, so the download is re-aimed once, not on every tap
                this._pendingSeek = true;
                clearTimeout(this._seekDebounce);
                this._seekDebounce = setTimeout(() => {
                    if (this._closed) return;
                    this.backend.seek(this.state.position);
                    this._noteSeek(this.state.position);
                }, 350);
                return;
            }
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

        // The subtitle button shows when the file has tracks, or when online look-up is set up.
        _subsButton() { return this.state.subtitles.length > 0 || !!(this.subs && this.subs.available()); }

        // A short message over the picture ("Subtitles on: EN"). Shows even while the controls are hidden.
        _toast(text) {
            if (this._closed || !this.root) return;
            if (!this.toastEl) { this.toastEl = el('div', 'hp-toast'); this.root.appendChild(this.toastEl); }
            this.toastEl.textContent = text;
            this.toastEl.classList.add('hp-on');
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => { if (this.toastEl) this.toastEl.classList.remove('hp-on'); }, 3800);
        }

        // The online search finished (or changed): redraw the "Find subtitles" list if it is open.
        _refreshSubMenu() {
            const m = this.menu;
            if (!m || m.kind !== 'subfind' || !this.subs) return;
            m.items = this.subs.menuItems();
            m.index = Math.max(0, Math.min(m.index, m.items.length - 1));
            this._renderMenu();
        }

        _openMenu(kind) {
            if (kind === 'skip') {
                if (!this.skip) return;
                this.menu = { kind: 'skip', items: this.skip.menuItems(), index: 0 };
                this.mode = 'menu';
                this._renderMenu();
                return;
            }
            if (kind === 'subfind') {
                if (!this.subs) return;
                this.subs.openList();
                this.menu = { kind: 'subfind', items: this.subs.menuItems(), index: 0 };
                this.mode = 'menu';
                this._renderMenu();
                return;
            }
            const tracks = kind === 'audio' ? this.state.audio : this.state.subtitles;
            let items = kind === 'subs'
                ? [{ id: null, label: 'Off', selected: !tracks.some(t => t.selected) }].concat(tracks)
                : tracks.slice();
            if (kind === 'subs' && this.subs && this.subs.available()) items.push({ id: '__find', find: true, label: 'Find subtitles online\u2026' });
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
            this.menuEl.appendChild(el('div', 'hp-menu-title', m.kind === 'audio' ? 'Audio' : (m.kind === 'skip' ? 'Skip intro & recap' : (m.kind === 'subfind' ? 'Find subtitles' : 'Subtitles'))));
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
            if (m.kind === 'skip') {                 // an action: do it, then show the menu again with the new state
                try { item.action(); } catch (e) { console.error('[PekPlayer]', e); }
                m.items = this.skip.menuItems();
                m.index = Math.min(m.index, m.items.length - 1);
                this._renderMenu();
                return;
            }
            if (m.kind === 'subfind') {               // an online result: load it (or, for a status row, stay)
                try { item.action(); } catch (e) { console.error('[PekPlayer]', e); }
                if (item.keep) { this._refreshSubMenu(); return; }
                this._closeMenu();
                return;
            }
            if (m.kind === 'subs' && item.find) { this._openMenu('subfind'); return; }
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
            this.root.classList.add('hp-keys');
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

            if (this.live && this.live.handleKey(key)) return;
            if (key === 'back') { this._askExit(); return; }
            if (key === 'playpause') { this._toggle(); this._show(); return; }
            if (key === 'ff') { this._seekBy(30); this._show(); return; }
            if (key === 'rew') { this._seekBy(-10); this._show(); return; }

            if (this.mode === 'hidden') {
                // controls are hidden: arrows skip, OK pauses. Down goes to the Up next card when it is showing.
                if (key === 'down' && this.next && this.next.visible()) { this.focus = 'nextnow'; this._show(); return; }
                if (key === 'left') this._seekBy(-10);
                else if (key === 'right') this._seekBy(10);
                else if (key === 'ok') {
                    if (this.skip && this.skip.cur) { this.skip.skip(); return; }
                    if (this.next && this.next.visible()) { this.next.activate(); return; }   // pill on screen: OK skips
                    this._toggle();
                }
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
                if (this.focus === 'seek') this.focus = 'play';
                else if (this.next && this.next.visible() && this.focus !== 'nextnow' && this.focus !== 'nextno') this.focus = 'nextnow';
                else this._hide();
            } else if (key === 'ok') {
                const btn = this.btns[this.focus];
                if (this.focus === 'seek') this._toggle();
                else if (btn) btn.click();
            }
            this._updateFocus();
        }
    }

    window.PekPlayerBackend = PekPlayerBackend;
    window.HtmlVideoBackend = HtmlVideoBackend;
    window.MpvBackend = MpvBackend;
    window.PekPlayer = PekPlayer;
    window.PekPlayerUtil = { fmtTime: fmtTime, normKey: normKey };
})();
