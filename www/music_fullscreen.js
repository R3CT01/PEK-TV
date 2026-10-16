/* ============================================================
   PEK TV - Full-screen music player
   A Spotify-style landscape screen for the Music tab: the song's cover (album, single or artist art) fills the
   background, the big cover + title sit on the left, time-synced lyrics (toggle) on the right, and a Browse button
   in the top-right corner opens a side window to pick another song, album, artist or playlist without leaving.

   Works with touch, mouse and a TV remote (arrows move, OK presses, Back closes the browse window, then the screen).
   On Android it asks the app to rotate to landscape and hide the system bars (PekAndroid.musicFullscreen); in a
   browser it uses the Fullscreen API and the orientation lock where they exist.

   Opens with PekMusicFS.open(). It owns its own DOM (a layer on <body>), so it never disturbs the app's repaints.
   ============================================================ */
(function () {
    'use strict';
    var P = window.PekMusic;
    if (!P) return;

    var LYR_KEY = 'hesper_music_fs_lyrics';
    var FS = { isOpen: false };
    window.PekMusicFS = FS;

    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsPut(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* kept until restart */ } }

    // ---------------------------------------------------------------- tiny helpers
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function focusable(n) { n.setAttribute('data-f', ''); return n; }
    function btn(cls, label, html) {
        var b = el('button', cls);
        b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
        if (html) b.innerHTML = html;
        return focusable(b);
    }
    var IC = {
        down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
        lyrics: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="18" cy="17" r="2.6" fill="currentColor"/></svg>',
        browse: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M17 13V6l4 1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="15.5" cy="16" r="2.4" fill="currentColor"/></svg>',
        note: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7" cy="18" r="2.4" fill="currentColor"/><circle cx="17" cy="16" r="2.4" fill="currentColor"/></svg>'
    };

    // ---------------------------------------------------------------- styles
    var CSS = [
        '.pmfs { position: fixed; inset: 0; z-index: 9000; background: #07070a; color: #fff; overflow: hidden; display: none; font-family: inherit; -webkit-user-select: none; user-select: none; }',
        '.pmfs.open { display: block; animation: pmfs-in .28s ease both; }',
        '@keyframes pmfs-in { from { opacity: 0; transform: translateY(2.5vh); } to { opacity: 1; transform: none; } }',
        /* backdrop */
        '.pmfs-bg { position: absolute; inset: -6%; background: radial-gradient(120% 90% at 20% 10%, #3a2a20 0%, #0d0b0b 70%); transition: filter .6s ease; }',
        '.pmfs-bgl { position: absolute; inset: 0; background-size: cover; background-position: center; opacity: 0; transition: opacity .8s ease; }',
        '.pmfs-bgl.on { opacity: 1; }',
        '.pmfs .pmfs-bg { filter: brightness(.62) saturate(1.1); }',
        '.pmfs.lyr .pmfs-bg { filter: blur(46px) brightness(.46) saturate(1.25); }',
        'html.pek-lite .pmfs.lyr .pmfs-bg { filter: brightness(.3); }',   /* weak devices: darken instead of blur */
        '.pmfs-scrim { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 52%, rgba(0,0,0,.82) 100%); }',
        '.pmfs.lyr .pmfs-scrim { background: linear-gradient(180deg, rgba(0,0,0,.35) 0%, rgba(0,0,0,.1) 30%, rgba(0,0,0,.7) 100%); }',
        /* layout */
        '.pmfs-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; box-sizing: border-box;',
        '  padding: calc(2.4vh + var(--tv-safe-y, 0vh)) calc(3vw + var(--tv-safe-x, 0vw)) calc(2.6vh + var(--tv-safe-y, 0vh)); padding-top: max(calc(2.4vh + var(--tv-safe-y, 0vh)), env(safe-area-inset-top, 0px)); padding-bottom: max(calc(2.6vh + var(--tv-safe-y, 0vh)), env(safe-area-inset-bottom, 0px)); }',
        '.pmfs-top { display: flex; align-items: center; gap: 1.2vw; flex: none; }',
        '.pmfs-from { flex: 1; min-width: 0; text-align: center; line-height: 1.25; }',
        '.pmfs-from small { display: block; font-size: max(.62rem, 1.5vh); letter-spacing: .16em; text-transform: uppercase; opacity: .65; }',
        '.pmfs-from b { display: block; font-size: max(.9rem, 2.3vh); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.pmfs-right { display: flex; gap: .6vw; align-items: center; }',
        '.pmfs-ib { height: max(2.6rem, 6.4vh); min-width: max(2.6rem, 6.4vh); padding: 0 1.1vh; border-radius: 999px; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .5em;',
        '  color: #fff; background: rgba(255,255,255,.12); font: inherit; font-weight: 700; font-size: max(.8rem, 2vh); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); transition: background .15s, transform .15s; }',
        'html.pek-lite .pmfs-ib { -webkit-backdrop-filter: none; backdrop-filter: none; background: rgba(40,40,44,.8); }',
        '.pmfs-ib svg { width: max(1.2rem, 3vh); height: max(1.2rem, 3vh); flex: none; }',
        '.pmfs-ib:hover { background: rgba(255,255,255,.22); }',
        '.pmfs-ib.on { background: #fff; color: #111; }',
        '.pmfs-main { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 5vw; }',
        '.pmfs-left { display: flex; align-items: center; gap: 3.2vw; min-width: 0; max-width: 100%; transition: all .3s ease; }',
        '.pmfs-cover { width: min(58vh, 34vw); height: min(58vh, 34vw); flex: none; border-radius: 1.2vh; background: #1b1b1f center/cover no-repeat; box-shadow: 0 2.4vh 6vh rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.35); overflow: hidden; }',
        '.pmfs-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }',
        '.pmfs-cover svg { width: 38%; height: 38%; }',
        '.pmfs-meta { min-width: 0; max-width: 34vw; }',
        '.pmfs-title { font-size: max(1.4rem, 5.6vh); font-weight: 800; line-height: 1.1; margin: 0 0 1.2vh; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }',
        '.pmfs-artist { font-size: max(1rem, 3vh); font-weight: 600; opacity: .92; line-height: 1.3; overflow-wrap: anywhere; }',
        '.pmfs-artist .feat { opacity: .7; font-weight: 500; }',
        '.pmfs-album { font-size: max(.85rem, 2.2vh); opacity: .6; margin-top: .8vh; overflow-wrap: anywhere; }',
        /* lyrics layout: cover shrinks to the left column, lyrics take the right */
        '.pmfs-lyr { display: none; flex: 1.35; min-width: 0; height: 100%; }',
        '.pmfs.lyr .pmfs-lyr { display: block; }',
        '.pmfs.lyr .pmfs-main { justify-content: flex-start; gap: 4vw; }',
        '.pmfs.lyr .pmfs-left { flex-direction: column; align-items: flex-start; gap: 2.2vh; flex: 0 0 auto; width: min(36vh, 24vw); }',
        '.pmfs.lyr .pmfs-cover { width: min(36vh, 24vw); height: min(36vh, 24vw); }',
        '.pmfs.lyr .pmfs-meta { max-width: min(36vh, 24vw); }',
        '.pmfs.lyr .pmfs-title { font-size: max(1.15rem, 3.6vh); }',
        '.pmfs.lyr .pmfs-artist { font-size: max(.9rem, 2.4vh); }',
        '.pmfs-lyr .pm-lyrics { height: 100%; }',
        '.pmfs-lyr .pm-lyrics-head { display: none; }',
        '.pmfs-lyr .pm-lyrics-body { height: 100%; padding: 0 1vw; -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 14%, #000 86%, transparent 100%); mask-image: linear-gradient(180deg, transparent 0, #000 14%, #000 86%, transparent 100%); }',
        '.pmfs-lyr .pm-lyric { font-size: max(1.25rem, 4.4vh); line-height: 1.28; padding: .9vh 0; color: #fff; opacity: .38; transform-origin: left center; transition: opacity .3s, transform .3s; }',
        '.pmfs-lyr .pm-lyric-past { opacity: .5; }',
        '.pmfs-lyr .pm-lyric-on { opacity: 1; transform: scale(1.04); color: #fff; }',
        '.pmfs-lyr .pm-lyrics-msg, .pmfs-lyr .pm-lyrics-plain { color: #fff; font-size: max(1.05rem, 3vh); opacity: .85; padding: 4vh 0; white-space: pre-wrap; }',
        '.pmfs-lyr .pm-lyrics-body:has(.pm-lyrics-plain) { -webkit-mask-image: none; mask-image: none; }',
        /* bottom: seek + controls */
        '.pmfs-bottom { flex: none; display: flex; flex-direction: column; gap: 1.2vh; }',
        '.pmfs-seek { display: flex; align-items: center; gap: 1.2vw; }',
        '.pmfs-seek .pm-time { color: rgba(255,255,255,.75); font-size: max(.75rem, 1.9vh); min-width: 3em; }',
        '.pmfs-range { -webkit-appearance: none; appearance: none; flex: 1; min-width: 0; height: max(1.6rem, 4vh); background: transparent; cursor: pointer; margin: 0; --p: 0%; }',
        '.pmfs-range::-webkit-slider-runnable-track { height: .5vh; min-height: 4px; border-radius: 4px; background: linear-gradient(90deg, #fff var(--p), rgba(255,255,255,.28) var(--p)); }',
        '.pmfs-range::-webkit-slider-thumb { -webkit-appearance: none; width: max(14px, 2.2vh); height: max(14px, 2.2vh); border-radius: 50%; background: #fff; margin-top: calc((max(4px, .5vh) - max(14px, 2.2vh)) / 2); box-shadow: 0 0 6px rgba(0,0,0,.5); }',
        '.pmfs-range::-moz-range-track { height: 4px; border-radius: 4px; background: rgba(255,255,255,.28); }',
        '.pmfs-range::-moz-range-progress { height: 4px; border-radius: 4px; background: #fff; }',
        '.pmfs-range::-moz-range-thumb { width: 14px; height: 14px; border: none; border-radius: 50%; background: #fff; }',
        '.pmfs-ctl { display: flex; align-items: center; justify-content: center; gap: 2.2vw; }',
        '.pmfs .pmfs-ctl .pm-btn { width: max(2.8rem, 7.4vh); height: max(2.8rem, 7.4vh); color: #fff; background: transparent; }',
        '.pmfs .pmfs-ctl .pm-btn svg { width: max(1.5rem, 3.8vh); height: max(1.5rem, 3.8vh); }',
        '.pmfs .pmfs-ctl .pm-btn.on { color: var(--sx-accent, #ff8a3d); background: rgba(255,255,255,.1); }',
        '.pmfs .pmfs-ctl .pm-btn-main { width: max(3.6rem, 10vh); height: max(3.6rem, 10vh); background: #fff; color: #111; }',
        '.pmfs .pmfs-ctl .pm-btn-main svg { width: max(1.9rem, 5vh); height: max(1.9rem, 5vh); }',
        '.pmfs .pmfs-ctl .pm-btn-main:hover { transform: scale(1.06); }',
        /* TV / keyboard focus ring (only shown while using keys, never after a tap) */
        '.pmfs [data-f]:focus { outline: none; }',
        '.pmfs.kbd [data-f]:focus { outline: max(3px, .5vh) solid #fff; outline-offset: max(2px, .4vh); }',
        '.pmfs.kbd .pmfs-row:focus { outline-offset: -3px; }',
        /* browse window */
        '.pmfs-shade { position: absolute; inset: 0; background: rgba(0,0,0,.45); opacity: 0; pointer-events: none; transition: opacity .25s; }',
        '.pmfs-panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(30rem, 88vw, 46vw); min-width: min(88vw, 22rem); display: flex; flex-direction: column; background: rgba(18,18,22,.94); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px);',
        '  transform: translateX(104%); transition: transform .28s cubic-bezier(.2,.8,.2,1); box-shadow: -2vh 0 6vh rgba(0,0,0,.5); padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }',
        'html.pek-lite .pmfs-panel { -webkit-backdrop-filter: none; backdrop-filter: none; background: #131316; }',
        '.pmfs.panel .pmfs-panel { transform: none; }',
        '.pmfs.panel .pmfs-shade { opacity: 1; pointer-events: auto; }',
        '.pmfs-ph { flex: none; display: flex; align-items: center; gap: .6rem; padding: 1rem 1rem .5rem; }',
        '.pmfs-ph h3 { flex: 1; margin: 0; font-size: 1.15rem; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.pmfs-ph .pmfs-ib { height: 2.4rem; min-width: 2.4rem; }',
        '.pmfs-tabs { flex: none; display: flex; gap: .45rem; padding: .3rem 1rem .8rem; overflow-x: auto; scrollbar-width: none; }',
        '.pmfs-tabs::-webkit-scrollbar { display: none; }',
        '.pmfs-tab { flex: none; border: none; cursor: pointer; font: inherit; font-weight: 700; font-size: .88rem; padding: .5rem .95rem; border-radius: 999px; background: rgba(255,255,255,.1); color: #fff; }',
        '.pmfs-tab.on { background: #fff; color: #111; }',
        '.pmfs-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 .55rem 1.2rem; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }',
        '.pmfs-row { width: 100%; display: flex; align-items: center; gap: .8rem; text-align: left; border: none; background: transparent; color: #fff; font: inherit; padding: .5rem .55rem; border-radius: .7rem; cursor: pointer; }',
        '.pmfs-row:hover { background: rgba(255,255,255,.08); }',
        '.pmfs-row.cur { background: rgba(255,255,255,.12); }',
        '.pmfs-row.cur .pmfs-rt { color: var(--sx-accent, #ff8a3d); }',
        '.pmfs-rimg { width: 3.1rem; height: 3.1rem; flex: none; border-radius: .45rem; background: rgba(255,255,255,.08); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.4); overflow: hidden; }',
        '.pmfs-rimg.round { border-radius: 50%; }',
        '.pmfs-rimg img { width: 100%; height: 100%; object-fit: cover; display: block; }',
        '.pmfs-rimg svg { width: 55%; height: 55%; }',
        '.pmfs-rn { width: 1.6rem; flex: none; text-align: center; opacity: .55; font-size: .85rem; font-variant-numeric: tabular-nums; }',
        '.pmfs-rm { flex: 1; min-width: 0; }',
        '.pmfs-rt { font-weight: 700; font-size: .98rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.pmfs-rs { font-size: .8rem; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: .1rem; }',
        '.pmfs-acts { display: flex; gap: .5rem; padding: .3rem .55rem .8rem; }',
        '.pmfs-acts .pmfs-ib { height: 2.5rem; padding: 0 1.2rem; font-size: .9rem; }',
        '.pmfs-acts .pmfs-ib.pri { background: #fff; color: #111; }',
        '.pmfs-msg { padding: 2rem 1rem; opacity: .65; text-align: center; font-size: .95rem; }',
        /* portrait / small fallback: stack everything */
        '@media (orientation: portrait) {',
        '  .pmfs-main { flex-direction: column; gap: 2vh; justify-content: center; }',
        '  .pmfs-left { flex-direction: column; text-align: center; gap: 2.4vh; }',
        '  .pmfs-cover { width: min(70vw, 38vh); height: min(70vw, 38vh); }',
        '  .pmfs-meta { max-width: 88vw; }',
        '  .pmfs.lyr .pmfs-main { justify-content: flex-start; }',
        '  .pmfs.lyr .pmfs-left { flex-direction: row; width: 100%; align-items: center; text-align: left; }',
        '  .pmfs.lyr .pmfs-cover { width: 16vh; height: 16vh; } .pmfs.lyr .pmfs-meta { max-width: none; }',
        '  .pmfs-lyr { width: 100%; flex: 1; }',
        '  .pmfs-panel { width: 100vw; min-width: 0; }',
        '  .pmfs-lyr .pm-lyric { font-size: max(1.2rem, 3vh); }',
        '}',
        '@media (max-height: 430px) { .pmfs-from small { display: none; } .pmfs-ib span { display: none; } }'
    ].join('\n');

    // ---------------------------------------------------------------- DOM (built once, on first open)
    var root, bgBox, shownBg = '', bgToken = 0;
    var coverEl, titleEl, artistEl, albumEl, fromEl, lyrHost, lyrBtn, browseBtn, shadeEl;
    var panelEl, panelHead, panelTabs, panelBody;
    var lyricsOn = lsGet(LYR_KEY) === '1';
    var shownId = '';
    var usedFullscreen = false;

    function build() {
        if (root) return;
        var st = el('style'); st.id = 'pek-music-fs-css'; st.textContent = CSS; document.head.appendChild(st);

        root = el('div', 'pmfs'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Full screen player');
        bgBox = el('div', 'pmfs-bg');
        var scrim = el('div', 'pmfs-scrim');

        var wrap = el('div', 'pmfs-wrap');
        // top bar
        var closeB = btn('pmfs-ib', 'Close full screen', IC.down);
        closeB.addEventListener('click', function () { FS.close(); });
        fromEl = el('div', 'pmfs-from');
        lyrBtn = btn('pmfs-ib', 'Lyrics on or off', IC.lyrics + '<span>Lyrics</span>');
        lyrBtn.addEventListener('click', function () { setLyrics(!lyricsOn); });
        browseBtn = btn('pmfs-ib', 'Browse music and playlists', IC.browse + '<span>Browse</span>');
        browseBtn.addEventListener('click', function () { togglePanel(); });
        var right = el('div', 'pmfs-right'); right.appendChild(lyrBtn); right.appendChild(browseBtn);
        var top = el('div', 'pmfs-top'); top.appendChild(closeB); top.appendChild(fromEl); top.appendChild(right);

        // centre: cover + words (+ lyrics)
        coverEl = el('div', 'pmfs-cover');
        titleEl = el('h1', 'pmfs-title'); artistEl = el('div', 'pmfs-artist'); albumEl = el('div', 'pmfs-album');
        var meta = el('div', 'pmfs-meta'); meta.appendChild(titleEl); meta.appendChild(artistEl); meta.appendChild(albumEl);
        var left = el('div', 'pmfs-left'); left.appendChild(coverEl); left.appendChild(meta);
        lyrHost = el('div', 'pmfs-lyr');
        var main = el('div', 'pmfs-main'); main.appendChild(left); main.appendChild(lyrHost);

        // bottom: seek + controls
        var range = el('input', 'pmfs-range'); range.type = 'range'; range.min = '0'; range.max = '1000'; range.value = '0';
        range.setAttribute('data-pm-range', ''); range.setAttribute('aria-label', 'Position'); focusable(range);
        range.addEventListener('input', function () { range.setAttribute('data-drag', '1'); range.style.setProperty('--p', (range.value / 10) + '%'); });
        range.addEventListener('change', function () { range.removeAttribute('data-drag'); P.seekFraction(Number(range.value) / 1000); });
        var t0 = el('span', 'pm-time', '0:00'); t0.setAttribute('data-pm-time', '');
        var t1 = el('span', 'pm-time', '--:--'); t1.setAttribute('data-pm-total', '');
        var seek = el('div', 'pmfs-seek'); seek.appendChild(t0); seek.appendChild(range); seek.appendChild(t1);
        var ctl = el('div', 'pmfs-ctl');
        ['shuffle', 'prev', 'toggle', 'next', 'repeat'].forEach(function (n) {
            var b = P.button(n, n === 'toggle' ? 'pm-btn-main' : ''); focusable(b); ctl.appendChild(b);
        });
        var bottom = el('div', 'pmfs-bottom'); bottom.appendChild(seek); bottom.appendChild(ctl);

        wrap.appendChild(top); wrap.appendChild(main); wrap.appendChild(bottom);

        // browse window
        shadeEl = el('div', 'pmfs-shade');
        shadeEl.addEventListener('click', function () { togglePanel(false); });
        panelEl = el('div', 'pmfs-panel'); panelEl.setAttribute('role', 'dialog'); panelEl.setAttribute('aria-label', 'Browse music');
        panelHead = el('div', 'pmfs-ph'); panelTabs = el('div', 'pmfs-tabs'); panelBody = el('div', 'pmfs-body');
        panelEl.appendChild(panelHead); panelEl.appendChild(panelTabs); panelEl.appendChild(panelBody);

        root.appendChild(bgBox); root.appendChild(scrim); root.appendChild(wrap); root.appendChild(shadeEl); root.appendChild(panelEl);
        document.body.appendChild(root);

        // the seek bar's filled part follows playback (the range itself is updated by PekMusic.tick)
        setInterval(function () {
            if (!FS.isOpen || range.getAttribute('data-drag') === '1') return;
            range.style.setProperty('--p', (range.value / 10) + '%');
        }, 400);
        root.addEventListener('pointerdown', function () { root.classList.remove('kbd'); }, true);
    }

    // ---------------------------------------------------------------- the song on screen
    function artLine(t) {
        artistEl.textContent = '';
        artistEl.appendChild(document.createTextNode(t.primary || t.artist || ''));
        if (t.featured && t.featured.length) {
            var f = el('span', 'feat', ' feat. ' + t.featured.join(', '));
            artistEl.appendChild(f);
        }
    }
    function setBackdrop(t) {
        var url = P.artUrl(t);
        if (url === shownBg) return;
        shownBg = url;
        var token = ++bgToken;
        if (!url) { Array.prototype.forEach.call(bgBox.querySelectorAll('.pmfs-bgl'), function (n) { n.classList.remove('on'); setTimeout(function () { n.remove(); }, 900); }); return; }
        var img = new Image();
        img.onload = function () {
            if (token !== bgToken) return;
            var layer = el('div', 'pmfs-bgl'); layer.style.backgroundImage = 'url("' + url + '")';
            bgBox.appendChild(layer);
            requestAnimationFrame(function () { requestAnimationFrame(function () { layer.classList.add('on'); }); });
            setTimeout(function () {
                var layers = bgBox.querySelectorAll('.pmfs-bgl');
                for (var i = 0; i < layers.length - 1; i++) layers[i].remove();
            }, 1000);
        };
        img.onerror = function () { if (token === bgToken) shownBg = ''; };
        img.src = url;
    }
    function setCover(t) {
        coverEl.innerHTML = '';
        var url = P.artUrl(t);
        if (url) {
            var img = el('img'); img.alt = ''; img.decoding = 'async';
            img.onerror = function () { img.remove(); coverEl.innerHTML = IC.note; };
            img.src = url; coverEl.appendChild(img);
        } else coverEl.innerHTML = IC.note;
    }
    function mountLyrics() {
        lyrHost.innerHTML = '';
        if (!lyricsOn) return;
        lyrHost.appendChild(P.lyricsPanel());
    }
    function update(force) {
        var t = P.current();
        if (!t) { FS.close(); return; }
        if (!force && t.id === shownId) return;
        shownId = t.id;
        titleEl.textContent = t.title || 'Unknown song';
        artLine(t);
        albumEl.textContent = t.album || '';
        fromEl.innerHTML = '';
        if (t.album) { fromEl.appendChild(el('small', '', 'Playing from')); fromEl.appendChild(el('b', '', t.album)); }
        setCover(t);
        setBackdrop(t);
        if (lyricsOn) mountLyrics();
        P.sync();
    }
    function setLyrics(on) {
        lyricsOn = !!on;
        lsPut(LYR_KEY, lyricsOn ? '1' : '0');
        root.classList.toggle('lyr', lyricsOn);
        lyrBtn.classList.toggle('on', lyricsOn);
        lyrBtn.setAttribute('aria-pressed', lyricsOn ? 'true' : 'false');
        mountLyrics();
    }

    // ---------------------------------------------------------------- browse window
    var panel = { open: false, tab: 'queue', stack: [], token: 0 };
    var cache = { albums: null, artists: null, songs: null };
    var TABS = [['queue', 'Queue'], ['playlists', 'Playlists'], ['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs']];

    function getJson(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); }); }
    function enc(s) { return encodeURIComponent(s); }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

    function row(o) {
        var b = el('button', 'pmfs-row' + (o.cur ? ' cur' : '')); b.type = 'button'; focusable(b);
        if (o.id) b.setAttribute('data-id', o.id);
        if (o.num != null) b.appendChild(el('span', 'pmfs-rn', String(o.num)));
        if (o.img !== undefined) {
            var im = el('div', 'pmfs-rimg' + (o.round ? ' round' : ''));
            im.innerHTML = IC.note;
            if (o.img) {
                var i = el('img'); i.alt = ''; i.loading = 'lazy'; i.decoding = 'async';
                i.onload = function () { im.innerHTML = ''; im.appendChild(i); };
                i.src = o.img;
            }
            b.appendChild(im);
        }
        var m = el('div', 'pmfs-rm'); m.appendChild(el('div', 'pmfs-rt', o.title));
        if (o.sub) m.appendChild(el('div', 'pmfs-rs', o.sub));
        b.appendChild(m);
        b.addEventListener('click', o.onClick);
        return b;
    }
    function msg(text) { return el('div', 'pmfs-msg', text); }
    function trackSub(t) { return (t.primary || t.artist || '') + (t.featured && t.featured.length ? ' feat. ' + t.featured.join(', ') : ''); }
    function isCur(t) { var c = P.current(); return !!c && c.id === t.id; }

    // a list of songs: tapping one plays the whole list from there
    function trackRows(tracks, o) {
        o = o || {};
        var frag = document.createDocumentFragment();
        tracks.forEach(function (t, i) {
            frag.appendChild(row({
                id: t.id, cur: isCur(t), num: o.numbers ? (t.track || i + 1) : undefined,
                img: o.numbers ? undefined : (t.art ? P.artUrl(t) : ''), title: t.title || 'Unknown song', sub: trackSub(t),
                onClick: function () { o.onPlay ? o.onPlay(i) : P.play(tracks, i); }
            }));
        });
        return frag;
    }
    function actions(getTracks) {
        var a = el('div', 'pmfs-acts');
        var play = btn('pmfs-ib pri', 'Play', '<span style="display:inline">Play</span>');
        var shuf = btn('pmfs-ib', 'Shuffle', '<span style="display:inline">Shuffle</span>');
        play.addEventListener('click', function () { Promise.resolve(getTracks()).then(function (tr) { if (tr.length) P.play(tr, 0); }); });
        shuf.addEventListener('click', function () { Promise.resolve(getTracks()).then(function (tr) { if (tr.length) P.play(tr, Math.floor(Math.random() * tr.length), { shuffle: true }); }); });
        a.appendChild(play); a.appendChild(shuf);
        return a;
    }
    function albumTracks(d) {
        return (d.list || []).map(function (t) { return Object.assign({}, t, d.singles ? { album: d.title, albumId: '', art: d.art } : { album: d.title, albumId: d.id, art: d.art }); });
    }

    function pushView(title, render) { panel.stack.push({ title: title, render: render }); renderPanel(true); }

    function openAlbum(a) {
        pushView(a.title, function (box, token) {
            box.appendChild(msg('Loading\u2026'));
            getJson('/api/music/album?id=' + enc(a.id)).then(function (d) {
                if (token !== panel.token) return;
                var tracks = albumTracks(d);
                box.innerHTML = '';
                box.appendChild(actions(function () { return tracks; }));
                box.appendChild(trackRows(tracks, { numbers: true }));
                focusFirst(box);
            }).catch(function () { if (token === panel.token) { box.innerHTML = ''; box.appendChild(msg('Couldn\u2019t open that album.')); } });
        });
    }
    function openArtist(a) {
        pushView(a.name, function (box, token) {
            box.appendChild(msg('Loading\u2026'));
            getJson('/api/music/artist?id=' + enc(a.id)).then(function (d) {
                if (token !== panel.token) return;
                box.innerHTML = '';
                box.appendChild(actions(function () {
                    return Promise.all(d.albums.map(function (al) { return getJson('/api/music/album?id=' + enc(al.id)).then(albumTracks); })).then(function (ls) { return [].concat.apply([], ls); });
                }));
                if (!d.albums.length) box.appendChild(msg('No albums.'));
                d.albums.forEach(function (al) { box.appendChild(albumRow(al)); });
                focusFirst(box);
            }).catch(function () { if (token === panel.token) { box.innerHTML = ''; box.appendChild(msg('Couldn\u2019t open that artist.')); } });
        });
    }
    function openPlaylist(p) {
        pushView(p.name, function (box) {
            var live = P.playlist(p.id) || p, tracks = live.tracks || [];
            if (!tracks.length) { box.appendChild(msg('This playlist is empty.')); return; }
            box.appendChild(actions(function () { return tracks; }));
            box.appendChild(trackRows(tracks, {}));
        });
    }
    function albumRow(a) {
        var sub = a.artist + (a.year ? ' \u00B7 ' + a.year : '') + ' \u00B7 ' + plural(a.tracks, 'song', 'songs');
        return row({ id: 'al' + a.id, img: a.art ? '/api/music/art?album=' + enc(a.id) : '', title: a.title, sub: sub, onClick: function () { openAlbum(a); } });
    }

    // tab bodies
    var TAB_RENDER = {
        queue: function (box) {
            var q = P.queue();
            if (!q.length) { box.appendChild(msg('The queue is empty.')); return; }
            box.appendChild(trackRows(q, { onPlay: function (i) { P.jump(i); } }));
            var cur = box.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'center' });
        },
        playlists: function (box) {
            var ls = P.playlists();
            if (!ls.length) { box.appendChild(msg('No playlists yet. Add songs to a playlist from the Music tab.')); return; }
            ls.forEach(function (p) {
                var first = (p.tracks || []).filter(function (t) { return t.art; })[0];
                box.appendChild(row({ id: 'pl' + p.id, img: first ? P.artUrl(first) : '', title: p.name, sub: plural((p.tracks || []).length, 'song', 'songs'), onClick: function () { openPlaylist(p); } }));
            });
        },
        albums: function (box, token) {
            var go = function (list) { if (token !== panel.token) return; box.innerHTML = ''; if (!list.length) box.appendChild(msg('No albums found.')); list.forEach(function (a) { box.appendChild(albumRow(a)); }); };
            if (cache.albums) return go(cache.albums);
            box.appendChild(msg('Loading\u2026'));
            getJson('/api/music/albums').then(function (d) { cache.albums = d.albums || []; go(cache.albums); }).catch(function () { if (token === panel.token) { box.innerHTML = ''; box.appendChild(msg('Couldn\u2019t load albums.')); } });
        },
        artists: function (box, token) {
            var go = function (list) {
                if (token !== panel.token) return; box.innerHTML = '';
                if (!list.length) box.appendChild(msg('No artists found.'));
                list.forEach(function (a) {
                    box.appendChild(row({ id: 'ar' + a.id, round: true, img: (a.photo || a.art) ? '/api/music/art?artist=' + enc(a.id) : '', title: a.name, sub: plural(a.albums, 'album', 'albums') + ' \u00B7 ' + plural(a.tracks, 'song', 'songs'), onClick: function () { openArtist(a); } }));
                });
            };
            if (cache.artists) return go(cache.artists);
            box.appendChild(msg('Loading\u2026'));
            getJson('/api/music/artists').then(function (d) { cache.artists = d.artists || []; go(cache.artists); }).catch(function () { if (token === panel.token) { box.innerHTML = ''; box.appendChild(msg('Couldn\u2019t load artists.')); } });
        },
        songs: function (box, token) {
            var load = function (offset) {
                getJson('/api/music/songs?offset=' + offset + '&limit=200').then(function (d) {
                    if (token !== panel.token) return;
                    var s = cache.songs || (cache.songs = { items: [], total: 0 });
                    if (offset === 0) s.items = [];
                    s.items = s.items.concat(d.songs || []); s.total = d.total || 0;
                    draw();
                }).catch(function () { if (token === panel.token) { box.innerHTML = ''; box.appendChild(msg('Couldn\u2019t load songs.')); } });
            };
            var draw = function () {
                if (token !== panel.token) return;
                var s = cache.songs; box.innerHTML = '';
                if (!s.items.length) { box.appendChild(msg('No songs found.')); return; }
                box.appendChild(trackRows(s.items, {}));
                if (s.items.length < s.total) {
                    var more = row({ title: 'Show more (' + (s.total - s.items.length) + ' left)', onClick: function () { more.remove(); load(s.items.length); } });
                    box.appendChild(more);
                }
            };
            if (cache.songs && cache.songs.items.length) return draw();
            box.appendChild(msg('Loading\u2026'));
            load(0);
        }
    };

    function renderPanel(focus) {
        var token = ++panel.token, keep = panelBody.scrollTop;
        var top = panel.stack[panel.stack.length - 1];
        panelHead.innerHTML = ''; panelTabs.innerHTML = ''; panelBody.innerHTML = '';
        if (top) {
            var back = btn('pmfs-ib', 'Back', IC.back); back.addEventListener('click', function () { panelBack(); });
            panelHead.appendChild(back);
            panelHead.appendChild(el('h3', '', top.title));
        } else {
            panelHead.appendChild(el('h3', '', 'Browse'));
            TABS.forEach(function (t) {
                var b = el('button', 'pmfs-tab' + (panel.tab === t[0] ? ' on' : ''), t[1]); b.type = 'button'; focusable(b);
                b.addEventListener('click', function () { panel.tab = t[0]; renderPanel(true); });
                panelTabs.appendChild(b);
            });
        }
        var closeB = btn('pmfs-ib', 'Close browse window', IC.close); closeB.addEventListener('click', function () { togglePanel(false); });
        panelHead.appendChild(closeB);
        panelTabs.style.display = top ? 'none' : '';
        var content = panelBody;
        if (top) top.render(content, token); else TAB_RENDER[panel.tab](content, token);
        if (!focus) panelBody.scrollTop = keep;
        if (focus && root.classList.contains('kbd')) {
            if (!top) { var on = panelTabs.querySelector('.on'); if (on) on.focus({ preventScroll: true }); }
            else focusFirst(content);
        }
    }
    function focusFirst(box) {
        if (!root.classList.contains('kbd')) return;
        var a = document.activeElement;
        if (a && panelBody.contains(a)) return;
        var f = box.querySelector('[data-f]'); if (f) f.focus({ preventScroll: true });
    }
    function panelBack() {
        if (panel.stack.length) { panel.stack.pop(); renderPanel(true); return true; }
        return false;
    }
    function togglePanel(on) {
        panel.open = on == null ? !panel.open : !!on;
        root.classList.toggle('panel', panel.open);
        browseBtn.classList.toggle('on', panel.open);
        if (panel.open) {
            cache.albums = cache.artists = cache.songs = null;       // look at the library afresh each time it is opened
            panel.stack = []; panel.tab = P.queue().length > 1 ? 'queue' : 'albums';
            renderPanel(true);
        } else if (root.classList.contains('kbd')) browseBtn.focus({ preventScroll: true });
    }
    function markCurrent() {
        var c = P.current();
        Array.prototype.forEach.call(panelBody.querySelectorAll('.pmfs-row[data-id]'), function (r) {
            r.classList.toggle('cur', !!c && r.getAttribute('data-id') === c.id);
        });
    }

    // ---------------------------------------------------------------- TV remote / keyboard
    function scopeEls() {
        var scope = panel.open ? panelEl : root;
        var list = Array.prototype.slice.call(scope.querySelectorAll('[data-f]'));
        return list.filter(function (n) {
            if (!panel.open && panelEl.contains(n)) return false;
            var r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
    }
    function moveFocus(dir) {
        var els = scopeEls(); if (!els.length) return;
        var cur = document.activeElement;
        if (!cur || els.indexOf(cur) < 0) {
            var pref = panel.open ? (panelBody.querySelector('.cur') || panelBody.querySelector('[data-f]') || els[0]) : (root.querySelector('.pm-btn-main') || els[0]);
            pref.focus({ preventScroll: true }); return;
        }
        var cr = cur.getBoundingClientRect(), cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        var best = null, bestScore = Infinity;
        els.forEach(function (n) {
            if (n === cur) return;
            var r = n.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, dx = x - cx, dy = y - cy, main, cross;
            if (dir === 'right') { if (dx <= 2) return; main = dx; cross = Math.abs(dy); }
            else if (dir === 'left') { if (dx >= -2) return; main = -dx; cross = Math.abs(dy); }
            else if (dir === 'down') { if (dy <= 2) return; main = dy; cross = Math.abs(dx); }
            else { if (dy >= -2) return; main = -dy; cross = Math.abs(dx); }
            var s = main + cross * 2.5;
            if (s < bestScore) { bestScore = s; best = n; }
        });
        if (best) { best.focus({ preventScroll: true }); if (panel.open) best.scrollIntoView({ block: 'nearest' }); }
    }
    function onKey(e) {
        if (!FS.isOpen) return;
        var k = e.key, handled = true;
        var back = k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || k === 'XF86Back' || e.keyCode === 4 || (k === 'Backspace' && !(e.target && /^(input|textarea)$/i.test(e.target.tagName)));
        if (back) { FS.back(); }
        else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
            root.classList.add('kbd');
            var cur = document.activeElement, dir = k.slice(5).toLowerCase();
            if (cur && cur.classList.contains('pmfs-range') && (dir === 'left' || dir === 'right')) P.skip(dir === 'left' ? -10 : 10);
            else moveFocus(dir);
        }
        else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
            root.classList.add('kbd');
            var a = document.activeElement;
            if (a && a !== document.body && root.contains(a) && a.hasAttribute('data-f') && a.tagName !== 'INPUT') a.click();
            else if (a && a.classList && a.classList.contains('pmfs-range')) { /* nothing */ }
            else P.toggle();
        }
        else if (k === 'l' || k === 'L') setLyrics(!lyricsOn);
        else handled = false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', function (e) { if (FS.isOpen && (e.key === 'Enter' || e.key.indexOf('Arrow') === 0)) e.stopImmediatePropagation(); }, true);

    // ---------------------------------------------------------------- phone / TV: landscape + no system bars
    function setNative(on) {
        try {
            var A = window.PekAndroid;
            if (A && typeof A.musicFullscreen === 'function') { A.musicFullscreen(!!on); return; }
        } catch (e) { /* fall through to the browser way */ }
        try {
            if (on) {
                var de = document.documentElement;
                if (de.requestFullscreen && !document.fullscreenElement) { usedFullscreen = true; de.requestFullscreen().catch(function () { usedFullscreen = false; }); }
                if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () { /* not allowed here */ });
            } else {
                if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { });
                if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
                usedFullscreen = false;
            }
        } catch (e) { /* a browser that will not rotate still shows the screen */ }
    }
    document.addEventListener('fullscreenchange', function () {
        if (FS.isOpen && usedFullscreen && !document.fullscreenElement) { usedFullscreen = false; FS.close(); }   // left with the browser's own exit
    });

    // ---------------------------------------------------------------- public
    FS.open = function () {
        if (!P.current()) return;
        build();
        if (FS.isOpen) return;
        FS.isOpen = true;
        root.classList.add('open');
        root.classList.toggle('lyr', lyricsOn);
        lyrBtn.classList.toggle('on', lyricsOn);
        lyrBtn.setAttribute('aria-pressed', lyricsOn ? 'true' : 'false');
        root.classList.toggle('kbd', document.documentElement.classList.contains('pek-tv'));
        panel.open = false; root.classList.remove('panel'); browseBtn.classList.remove('on');
        shownId = ''; shownBg = '';
        update(true);
        P.sync();
        setNative(true);
        if (root.classList.contains('kbd')) setTimeout(function () { var m = root.querySelector('.pm-btn-main'); if (m) m.focus({ preventScroll: true }); }, 60);
    };
    FS.close = function () {
        if (!FS.isOpen) return;
        FS.isOpen = false;
        if (panel.open) togglePanel(false);
        root.classList.remove('open', 'panel');
        lyrHost.innerHTML = '';
        bgToken++;
        setNative(false);
        P.sync();
    };
    // Back: first the sub-folder of the browse window, then the window, then the screen. Returns true when it did something.
    FS.back = function () {
        if (!FS.isOpen) return false;
        if (panel.open) { if (!panelBack()) togglePanel(false); return true; }
        FS.close();
        return true;
    };

    P.on(function (kind) {
        if (!FS.isOpen) return;
        if (kind === 'track') { update(false); if (panel.open) { if (panel.tab === 'queue' && !panel.stack.length) renderPanel(false); else markCurrent(); } }
        else if (kind === 'queue' && panel.open && panel.tab === 'queue' && !panel.stack.length) renderPanel(false);
        else if (kind === 'playlists' && panel.open && panel.tab === 'playlists' && !panel.stack.length) renderPanel(false);
    });

    // The Android Back button asks the page first (window.__pekBack, set by other scripts later): answer for this screen first.
    (function () {
        var inner = window.__pekBack;
        try {
            Object.defineProperty(window, '__pekBack', {
                configurable: true,
                get: function () { return function () { if (FS.isOpen) { FS.back(); return true; } return inner ? inner.apply(this, arguments) : null; }; },
                set: function (f) { inner = f; }
            });
        } catch (e) { /* the key handler above still covers keyboards and remotes */ }
    })();
})();
