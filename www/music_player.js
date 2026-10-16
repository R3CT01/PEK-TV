/* ============================================================
   PEK TV - Music player
   The audio engine behind the Music tab: one queue, one sound engine, shuffle / repeat, playlists, and the
   little "now playing" bar that stays on screen while you browse. It owns its own DOM and never asks the app to
   repaint for a progress tick, so scrolling, typing and focus are never disturbed by the music.
   Songs come from /api/music/stream/<id> (the backend reads them from local folders and network shares).
   The sound engine is libmpv on Android (MpvAudioController.kt, plays every format the library lists) and the
   browser's <audio> element everywhere else.
   Saved per profile (see profiles.js): hesper_music_state (queue + position), hesper_music_playlists.
   ============================================================ */
(function () {
    'use strict';

    var STATE_KEY = 'hesper_music_state';
    var LISTS_KEY = 'hesper_music_playlists';
    var MIME = {
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.aac': 'audio/aac',
        '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg; codecs="opus"', '.wav': 'audio/wav',
        '.aiff': 'audio/aiff', '.aif': 'audio/aiff'
    };

    // ---------------------------------------------------------------- sound engines
    // Both engines have the same small interface, so the queue code below never knows which one it is talking to:
    //   load(url, startAt, autoplay)  start a song (startAt in seconds)     play() / pause() / seek(sec)
    //   unload()                      stop and let go of the song           position() / duration() in seconds
    //   hasSource() / paused()        is a song loaded / is it not playing  canPlay(track)
    //   on(name, fn)                  names: playing, pause, time, ended, error
    var engine = (function () {
        var handlers = {};
        function fire(name) { if (handlers[name]) handlers[name](); }
        var api = { on: function (name, fn) { handlers[name] = fn; } };
        var native = window.PekAndroid;

        if (native && typeof native.musicLoad === 'function') {
            // Android: libmpv. State lives in the app, which reports it through window.__pekMusicMpv.
            var src = '', pos = 0, dur = 0, playing = false;
            window.__pekMusicMpv = function (ev, d) {
                if (!src) return;                                  // a late report from a song that was already let go
                if (ev === 'time') { pos = d.position || 0; dur = d.duration || 0; fire('time'); }
                else if (ev === 'state') {
                    var was = playing;
                    playing = !!d.playing && !!d.loaded && !d.buffering;
                    if (playing) fire('playing'); else if (was) fire('pause');
                }
                else if (ev === 'ended') { src = ''; pos = 0; dur = 0; playing = false; fire('ended'); }
                else if (ev === 'error') {
                    var failed = src;
                    fire('error');                                 // the handler may already have started the next song
                    if (src === failed) { src = ''; pos = 0; dur = 0; playing = false; }
                }
            };
            api.load = function (url, startAt, autoplay) {
                src = new URL(url, location.href).href; pos = startAt || 0; dur = 0; playing = false;
                native.musicLoad(src, startAt || 0, !!autoplay);
            };
            api.play = function () { if (src) native.musicPlay(); };
            api.pause = function () { if (src) native.musicPause(); };
            api.seek = function (sec) { if (!src) return; pos = sec; native.musicSeek(sec); };
            api.unload = function () { src = ''; pos = 0; dur = 0; playing = false; native.musicStop(); };
            api.position = function () { return pos; };
            api.duration = function () { return dur; };
            api.hasSource = function () { return !!src; };
            api.paused = function () { return !playing; };
            api.canPlay = function () { return true; };           // mpv decodes everything the scanner lists
        } else {
            // Browsers (desktop and the TV web view): the <audio> element. What it can decode decides what plays.
            var audio = new Audio();
            var pendingStart = 0;     // seconds to jump to once the song's length is known
            audio.preload = 'auto';
            audio.addEventListener('ended', function () { fire('ended'); });
            audio.addEventListener('playing', function () { fire('playing'); });
            audio.addEventListener('pause', function () { fire('pause'); });
            audio.addEventListener('loadedmetadata', function () {
                if (pendingStart > 0) { try { audio.currentTime = pendingStart; } catch (e) { /* not seekable yet */ } pendingStart = 0; }
                fire('time');
            });
            audio.addEventListener('durationchange', function () { fire('time'); });
            audio.addEventListener('timeupdate', function () { fire('time'); });
            audio.addEventListener('error', function () { fire('error'); });
            api.load = function (url, startAt, autoplay) {
                pendingStart = startAt > 0 ? startAt : 0;
                audio.src = url;
                if (autoplay) {
                    var p = audio.play();
                    if (p && p.catch) p.catch(function () { fire('pause'); });   // blocked (no tap yet): stays paused, the button still works
                }
            };
            api.play = function () { audio.play().catch(function () {}); };
            api.pause = function () { if (!audio.paused) audio.pause(); };
            api.seek = function (sec) { audio.currentTime = sec; };
            api.unload = function () {
                audio.pause();
                try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* ignore */ }
            };
            api.position = function () { return audio.currentTime || 0; };
            api.duration = function () { return audio.duration; };
            api.hasSource = function () { return !!audio.src; };
            api.paused = function () { return audio.paused; };
            api.canPlay = function (t) {
                var m = MIME[(t.ext || '').toLowerCase()];
                if (!m) return false;
                try { return audio.canPlayType(m) !== ''; } catch (e) { return true; }
            };
        }
        return api;
    })();

    var P = {};
    var queue = [];           // what plays, in order (already shuffled when shuffle is on)
    var original = null;      // the order before shuffling (to switch shuffle off again)
    var index = -1;
    var shuffle = false;
    var repeat = 'off';       // off | all | one
    var pendingSeek = 0;      // seconds to jump to once the restored song loads
    var failures = 0;
    var listeners = [];
    var lastSave = 0;
    var loadedId = '';

    // ---------------------------------------------------------------- storage
    function readJson(key, fallback) {
        try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
    }
    function writeJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
    }
    function slim(t) {
        return { id: t.id, title: t.title || '', artist: t.artist || '', album: t.album || '', albumId: t.albumId || '',
                 duration: t.duration || 0, ext: t.ext || '', art: !!t.art,
                 primary: t.primary || '', featured: t.featured || [] };
    }
    function saveState(force) {
        var now = Date.now();
        if (!force && now - lastSave < 4000) return;
        lastSave = now;
        writeJson(STATE_KEY, { queue: queue, index: index, shuffle: shuffle, repeat: repeat, original: original,
                               position: engine.position() });
    }
    function emit(kind) {
        listeners.slice().forEach(function (fn) { try { fn(kind); } catch (e) { /* a listener must not break playback */ } });
    }

    // ---------------------------------------------------------------- helpers
    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s;
    }
    function fmtLong(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
        if (h) return h + ' hr ' + m + ' min';
        return Math.max(1, m) + ' min';
    }
    function streamUrl(t) { return '/api/music/stream/' + encodeURIComponent(t.id); }
    function artUrl(t) {
        if (!t || !t.art) return '';
        return t.albumId ? '/api/music/art?album=' + encodeURIComponent(t.albumId) : '/api/music/art?track=' + encodeURIComponent(t.id);
    }
    function canPlay(t) { return engine.canPlay(t); }
    function shuffled(list) {
        var a = list.slice();
        for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var x = a[i]; a[i] = a[j]; a[j] = x; }
        return a;
    }
    function toast(msg) { if (typeof P.onToast === 'function') P.onToast(msg); }

    // ---------------------------------------------------------------- icons
    var ICONS = {
        play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
        prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9.5 12z"/></svg>',
        next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5l10.5 7L4 19z"/></svg>',
        stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3.5c2 0 3.2 1 4.3 2.6l2.4 3.8c1.1 1.6 2.3 2.6 4.3 2.6H20M4 17h3.5c2 0 3.2-1 4.3-2.6M14.2 10.6C15.3 9 16.5 8 18.5 8H20M17.5 5.5L20 8l-2.5 2.5M17.5 13.5L20 16l-2.5 2.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
        repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11V9.5C5 8 6 7 7.5 7H19M16.5 4.5L19 7l-2.5 2.5M19 13v1.5c0 1.5-1 2.5-2.5 2.5H5M7.5 19.5L5 17l2.5-2.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
        back15: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.3 4M5 4v5h5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="12" y="15" font-size="6.5" font-weight="700" text-anchor="middle" fill="currentColor">15</text></svg>',
        fwd15: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 0 6.3 4M19 4v5h-5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="12" y="15" font-size="6.5" font-weight="700" text-anchor="middle" fill="currentColor">15</text></svg>'
    };
    P.icon = function (name) { return ICONS[name] || ''; };

    // ---------------------------------------------------------------- the player
    function current() { return index >= 0 && index < queue.length ? queue[index] : null; }

    function load(i, autoplay, startAt) {
        if (i < 0 || i >= queue.length) return;
        index = i;
        var t = queue[i];
        loadedId = t.id;
        pendingSeek = startAt > 0 ? startAt : 0;
        if (!canPlay(t)) { skipUnplayable(t); return; }
        engine.load(streamUrl(t), pendingSeek, autoplay);
        pendingSeek = 0;
        setMediaSession(t);
        saveState(true);
        emit('track');
        P.sync();
    }
    function skipUnplayable(t) {
        failures++;
        toast('Can\u2019t play this kind of file here: ' + (t.title || t.ext));
        if (failures < queue.length && queue.length > 1) { setTimeout(function () { P.next(true); }, 50); }
        else { engine.pause(); failures = 0; emit('track'); P.sync(); }
    }

    P.play = function (list, startIndex, opts) {
        opts = opts || {};
        if (!list || !list.length) return;
        var items = list.map(slim);
        var startTrack = items[Math.max(0, Math.min(startIndex || 0, items.length - 1))];
        failures = 0;
        if (opts.shuffle) {
            var rest = items.filter(function (t) { return t !== startTrack; });
            original = items.slice();
            queue = [startTrack].concat(shuffled(rest));
            shuffle = true;
            index = 0;
        } else {
            original = null;
            queue = items;
            shuffle = !!opts.keepShuffle && shuffle;
            index = items.indexOf(startTrack);
            if (shuffle) { original = items.slice(); var before = queue.slice(0, index + 1), after = queue.slice(index + 1); queue = before.concat(shuffled(after)); }
        }
        load(index, true, 0);
    };
    P.playOne = function (track) { P.play([track], 0); };

    P.next = function (auto) {
        if (!queue.length) return;
        if (auto && repeat === 'one') { load(index, true, 0); return; }
        if (index + 1 < queue.length) load(index + 1, true, 0);
        else if (repeat === 'all') load(0, true, 0);
        else { engine.pause(); engine.seek(0); P.sync(); emit('state'); }
    };
    P.prev = function () {
        if (!queue.length) return;
        if (engine.position() > 3 || index <= 0) { engine.seek(0); return; }
        load(index - 1, true, 0);
    };
    P.toggle = function () {
        if (!queue.length) return;
        if (!engine.hasSource() || loadedId !== (current() || {}).id) { load(index < 0 ? 0 : index, true, pendingSeek); return; }
        if (engine.paused()) engine.play(); else engine.pause();
    };
    P.pause = function () { engine.pause(); };
    P.resume = function () { if (queue.length && !P.isPlaying()) P.toggle(); };   // play (never pauses); used by the Android notification
    P.stop = function () {                       // the X on the bar: stop and put the bar away (the queue is kept for next time)
        engine.unload();
        loadedId = '';
        saveState(true);
        P.hidden = true;
        P.sync(); emit('state');
    };
    P.seek = function (sec) { if (isFinite(sec)) engine.seek(Math.max(0, sec)); };
    P.skip = function (delta) { P.seek(engine.position() + delta); };
    P.seekFraction = function (f) { var d = duration(); if (d) P.seek(d * f); };
    P.jump = function (i) { load(i, true, 0); };

    P.toggleShuffle = function () {
        if (!queue.length) { shuffle = !shuffle; saveState(true); P.sync(); emit('state'); return; }
        var cur = current();
        if (!shuffle) {
            original = queue.slice();
            var before = queue.slice(0, index + 1), after = queue.slice(index + 1);
            queue = before.concat(shuffled(after));
            shuffle = true;
        } else {
            if (original) {
                var ids = {};
                queue.forEach(function (t) { ids[t.id] = true; });
                var restored = original.filter(function (t) { return ids[t.id]; });
                queue.forEach(function (t) { if (!restored.some(function (r) { return r.id === t.id; })) restored.push(t); });
                queue = restored;
                for (var i = 0; i < queue.length; i++) if (cur && queue[i].id === cur.id) { index = i; break; }
            }
            original = null;
            shuffle = false;
        }
        saveState(true); P.sync(); emit('track');
    };
    P.cycleRepeat = function () {
        repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
        saveState(true); P.sync(); emit('state');
    };

    P.enqueue = function (tracks) {
        var items = (tracks || []).map(slim);
        if (!items.length) return;
        if (!queue.length) { P.play(items, 0); return; }
        queue = queue.concat(items);
        if (original) original = original.concat(items);
        saveState(true); emit('track'); toast(items.length === 1 ? 'Added to the queue' : items.length + ' songs added to the queue');
    };
    P.playNext = function (tracks) {
        var items = (tracks || []).map(slim);
        if (!items.length) return;
        if (!queue.length) { P.play(items, 0); return; }
        queue = queue.slice(0, index + 1).concat(items, queue.slice(index + 1));
        if (original) original = original.concat(items);
        saveState(true); emit('track'); toast(items.length === 1 ? 'Will play next' : items.length + ' songs will play next');
    };
    P.removeAt = function (i) {
        if (i < 0 || i >= queue.length) return;
        var wasCurrent = i === index;
        var removed = queue.splice(i, 1)[0];
        if (original) original = original.filter(function (t) { return t.id !== removed.id; });
        if (i < index) index--;
        if (!queue.length) { P.clear(); return; }
        if (wasCurrent) { if (index >= queue.length) index = queue.length - 1; load(index, !engine.paused(), 0); return; }
        saveState(true); emit('track');
    };
    P.clear = function () {
        engine.unload();
        queue = []; original = null; index = -1; loadedId = ''; pendingSeek = 0;
        saveState(true); P.sync(); emit('track');
    };

    // ---------------------------------------------------------------- read-only state for the screens
    P.queue = function () { return queue.slice(); };
    P.index = function () { return index; };
    P.current = current;
    P.isPlaying = function () { return !engine.paused() && engine.hasSource(); };
    P.shuffle = function () { return shuffle; };
    P.repeat = function () { return repeat; };
    P.hasQueue = function () { return queue.length > 0; };
    P.fmt = fmt;
    P.fmtLong = fmtLong;
    P.artUrl = artUrl;
    P.on = function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; };
    function duration() {
        var d = engine.duration();
        if (isFinite(d) && d > 0) return d;
        var t = current();
        return t && t.duration ? t.duration : 0;
    }

    // ---------------------------------------------------------------- lyrics (time-synced, like Spotify)
    // The backend asks LRCLIB (/api/music/lyrics). Synced lyrics light up line by line while the song plays and
    // scroll to keep the current line in the middle; tapping a line jumps there. Songs with only plain lyrics show
    // the text without timings. Answers are kept in memory for this session (the backend keeps them on disk).
    var lyrCache = {};                                   // track id -> { lines: [{t, s}] | null, plain: '' } or { none: true }
    var lyr = { el: null, body: null, id: '', lines: null, active: -2, manualUntil: 0 };
    var clock = { pos: 0, at: 0 };                       // smooths the position between reports (libmpv reports about once a second)

    function parseLrc(text) {
        var out = [];
        String(text || '').split(/\r?\n/).forEach(function (raw) {
            var re = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g, m, times = [], last = 0;
            while ((m = re.exec(raw))) { times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'))); last = re.lastIndex; }
            if (!times.length) return;                    // [ar:..] [ti:..] and other tags
            var words = raw.slice(last).replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim();
            times.forEach(function (t) { out.push({ t: t, s: words }); });
        });
        out.sort(function (a, b) { return a.t - b.t; });
        return out;
    }
    function lyricsFor(t) {
        if (!t) return Promise.resolve({ none: true });
        if (lyrCache[t.id]) return Promise.resolve(lyrCache[t.id]);
        return fetch('/api/music/lyrics?track=' + encodeURIComponent(t.id)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
            var res = { none: true };
            if (d) {
                var lines = d.synced ? parseLrc(d.synced) : null;
                if (lines && lines.length) res = { lines: lines, plain: d.plain || '' };
                else if (d.plain) res = { lines: null, plain: d.plain };
            }
            lyrCache[t.id] = res;
            return res;
        }).catch(function () { return { none: true, failed: true }; });      // a network error is not remembered
    }
    function lyrMessage(text) {
        if (!lyr.body) return;
        lyr.body.innerHTML = '';
        var d = document.createElement('div'); d.className = 'pm-lyrics-msg'; d.textContent = text;
        lyr.body.appendChild(d);
    }
    function paintLyrics(res) {
        if (!lyr.body) return;
        lyr.body.innerHTML = '';
        lyr.active = -2;
        lyr.lines = res.lines || null;
        if (res.none) { lyrMessage(res.failed ? 'Couldn\u2019t load lyrics.' : 'No lyrics found for this song.'); return; }
        if (!res.lines) {                                  // plain text only
            var pre = document.createElement('div'); pre.className = 'pm-lyrics-plain'; pre.textContent = res.plain;
            lyr.body.appendChild(pre);
            return;
        }
        var pad = document.createElement('div'); pad.className = 'pm-lyric-pad'; lyr.body.appendChild(pad);
        res.lines.forEach(function (ln, i) {
            var d = document.createElement('div');
            d.className = 'pm-lyric' + (ln.s ? '' : ' pm-lyric-gap');
            d.textContent = ln.s || '\u266A';
            d.setAttribute('data-i', i);
            d.addEventListener('click', function () { P.seek(Math.max(0, ln.t)); lyr.manualUntil = 0; lyricsTick(true); });
            lyr.body.appendChild(d);
        });
        var pad2 = document.createElement('div'); pad2.className = 'pm-lyric-pad'; lyr.body.appendChild(pad2);
        lyricsTick(true);
    }
    // The panel for the Now Playing screen. Build it into the screen; it loads and follows the current song by itself.
    P.lyricsPanel = function () {
        var t = current();
        var el = document.createElement('div'); el.className = 'pm-lyrics';
        var head = document.createElement('div'); head.className = 'pm-lyrics-head'; head.textContent = 'Lyrics';
        var body = document.createElement('div'); body.className = 'pm-lyrics-body';
        ['wheel', 'touchmove', 'pointerdown'].forEach(function (ev) {
            body.addEventListener(ev, function () { lyr.manualUntil = Date.now() + 4000; }, { passive: true });   // let the reader look around
        });
        el.appendChild(head); el.appendChild(body);
        lyr.el = el; lyr.body = body; lyr.id = t ? t.id : ''; lyr.lines = null; lyr.active = -2;
        if (!t) { lyrMessage(''); return el; }
        if (lyrCache[t.id]) paintLyrics(lyrCache[t.id]);
        else {
            lyrMessage('Looking for lyrics\u2026');
            var id = t.id;
            lyricsFor(t).then(function (res) { if (lyr.id === id && lyr.body === body) paintLyrics(res); });
        }
        return el;
    };
    function lyricsTick(force) {
        if (!lyr.el || !lyr.lines || !lyr.el.isConnected) return;
        var pos = engine.position(), now = Date.now();
        if (pos !== clock.pos) { clock.pos = pos; clock.at = now; }
        else if (!engine.paused()) pos += Math.min(1.5, (now - clock.at) / 1000);
        pos += 0.25;                                       // show a line a moment early, the way Spotify does
        var lines = lyr.lines, lo = 0, hi = lines.length - 1, a = -1;
        while (lo <= hi) { var mid = (lo + hi) >> 1; if (lines[mid].t <= pos) { a = mid; lo = mid + 1; } else hi = mid - 1; }
        if (a === lyr.active && !force) return;
        var nodes = lyr.body.querySelectorAll('.pm-lyric');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].classList.toggle('pm-lyric-on', i === a);
            nodes[i].classList.toggle('pm-lyric-past', i < a);
        }
        lyr.active = a;
        if (a >= 0 && nodes[a] && (force || Date.now() > lyr.manualUntil)) {
            var n = nodes[a], box = lyr.body;
            box.scrollTo({ top: Math.max(0, n.offsetTop - box.clientHeight / 2 + n.clientHeight / 2), behavior: force ? 'auto' : 'smooth' });
        }
    }
    setInterval(function () { if (lyr.el) lyricsTick(false); }, 200);

    // ---------------------------------------------------------------- buttons shared by the bar and the Now Playing screen
    var ACTIONS = {
        toggle: function () { P.toggle(); }, next: function () { P.next(false); }, prev: function () { P.prev(); },
        stop: function () { P.stop(); }, shuffle: function () { P.toggleShuffle(); }, repeat: function () { P.cycleRepeat(); },
        back15: function () { P.skip(-15); }, fwd15: function () { P.skip(15); }
    };
    var LABELS = { toggle: 'Play or pause', next: 'Next song', prev: 'Previous song', stop: 'Close player', shuffle: 'Shuffle',
                   repeat: 'Repeat', back15: 'Back 15 seconds', fwd15: 'Forward 15 seconds' };
    // name: toggle | next | prev | stop | shuffle | repeat | back15 | fwd15
    P.button = function (name, className) {
        var b = document.createElement('button');
        b.className = 'pm-btn focusable ' + (className || '') + ' pm-btn-' + name;
        b.type = 'button';
        b.setAttribute('data-pm', name);
        b.setAttribute('aria-label', LABELS[name] || name);
        b.title = LABELS[name] || name;
        b.innerHTML = name === 'toggle' ? ICONS.play : (ICONS[name] || '');
        b.addEventListener('click', function (e) { e.stopPropagation(); ACTIONS[name](); });
        return b;
    };
    // Brings every control and readout on screen in line with the player (cheap; called on any change).
    P.sync = function () {
        var playing = P.isPlaying();
        var nodes = document.querySelectorAll('[data-pm]');
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i], name = n.getAttribute('data-pm');
            if (name === 'toggle') { var want = playing ? 'pause' : 'play'; if (n.getAttribute('data-state') !== want) { n.setAttribute('data-state', want); n.innerHTML = ICONS[want]; } }
            else if (name === 'shuffle') n.classList.toggle('on', shuffle);
            else if (name === 'repeat') { n.classList.toggle('on', repeat !== 'off'); n.setAttribute('data-mode', repeat); }
        }
        updateBar();
        P.tick();
    };
    P.tick = function () {
        var d = duration(), pos = engine.position(), frac = d ? Math.min(1, pos / d) : 0;
        var fills = document.querySelectorAll('[data-pm-fill]');
        for (var i = 0; i < fills.length; i++) fills[i].style.width = (frac * 100) + '%';
        var ranges = document.querySelectorAll('[data-pm-range]');
        for (var r = 0; r < ranges.length; r++) if (ranges[r].getAttribute('data-drag') !== '1') ranges[r].value = Math.round(frac * 1000);
        var times = document.querySelectorAll('[data-pm-time]');
        for (var k = 0; k < times.length; k++) times[k].textContent = fmt(pos);
        var totals = document.querySelectorAll('[data-pm-total]');
        for (var q = 0; q < totals.length; q++) totals[q].textContent = d ? fmt(d) : '--:--';
    };

    // ---------------------------------------------------------------- the bar
    var barEl = null, barArt = null, barTitle = null, barSub = null;
    function ensureBar() {
        if (barEl) return barEl;
        barEl = document.createElement('div');
        barEl.className = 'pm-bar';
        barEl.hidden = true;
        var prog = document.createElement('div'); prog.className = 'pm-bar-progress';
        var fill = document.createElement('div'); fill.className = 'pm-bar-fill'; fill.setAttribute('data-pm-fill', '');
        prog.appendChild(fill);
        var row = document.createElement('div'); row.className = 'pm-bar-row';
        var info = document.createElement('button'); info.type = 'button'; info.className = 'pm-bar-info focusable'; info.title = 'Open Now Playing';
        barArt = document.createElement('div'); barArt.className = 'pm-art pm-bar-art';
        var note = document.createElement('span'); note.className = 'pm-art-note'; note.textContent = '\u266A'; barArt.appendChild(note);
        var txt = document.createElement('div'); txt.className = 'pm-bar-text';
        barTitle = document.createElement('div'); barTitle.className = 'pm-bar-title';
        barSub = document.createElement('div'); barSub.className = 'pm-bar-sub';
        txt.appendChild(barTitle); txt.appendChild(barSub);
        info.appendChild(barArt); info.appendChild(txt);
        info.addEventListener('click', function () { if (typeof P.onOpenNowPlaying === 'function') P.onOpenNowPlaying(); });
        row.appendChild(info);
        row.appendChild(P.button('prev'));
        row.appendChild(P.button('toggle', 'pm-btn-main'));
        row.appendChild(P.button('next'));
        row.appendChild(P.button('stop'));
        barEl.appendChild(prog); barEl.appendChild(row);
        return barEl;
    }
    var shownId = '';
    function updateBar() {
        if (!barEl) return;
        var t = current();
        barEl.hidden = !t || P.hidden === true;
        document.documentElement.classList.toggle('pm-has-bar', !barEl.hidden);
        if (!t) { shownId = ''; return; }
        if (shownId !== t.id) {
            shownId = t.id;
            barTitle.textContent = t.title || 'Unknown song';
            barSub.textContent = t.artist || '';
            var old = barArt.querySelector('img'); if (old) old.remove();
            var url = artUrl(t);
            if (url) {
                var img = document.createElement('img'); img.alt = ''; img.decoding = 'async';
                img.addEventListener('error', function () { img.remove(); });
                img.src = url; barArt.appendChild(img);
            }
        }
    }
    // The one persistent node; the app puts it into each repaint of the screen.
    P.bar = function () { ensureBar(); updateBar(); return barEl; };
    P.show = function () { P.hidden = false; updateBar(); };

    // ---------------------------------------------------------------- system media controls (lock screen, headset, TV remote)
    // Android app: the notification and lock screen are native, so tell the app what is playing.
    function setNativeMeta(t) {
        var n = window.PekAndroid;
        if (!n || typeof n.musicMeta !== 'function') return;
        try { var a = artUrl(t); n.musicMeta(t.title || '', t.artist || '', t.album || '', a ? location.origin + a : ''); } catch (e) { /* ignore */ }
    }
    function setMediaSession(t) {
        setNativeMeta(t);
        if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
        try {
            var art = artUrl(t);
            navigator.mediaSession.metadata = new MediaMetadata({
                title: t.title || '', artist: t.artist || '', album: t.album || '',
                artwork: art ? [{ src: location.origin + art, sizes: '512x512' }] : []
            });
        } catch (e) { /* not supported here */ }
    }
    if ('mediaSession' in navigator) {
        var set = function (a, fn) { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* unsupported action */ } };
        set('play', function () { P.toggle(); });
        set('pause', function () { P.pause(); });
        set('previoustrack', function () { P.prev(); });
        set('nexttrack', function () { P.next(false); });
        set('seekto', function (d) { if (d && isFinite(d.seekTime)) P.seek(d.seekTime); });
    }
    window.addEventListener('keydown', function (e) {
        if (!queue.length) return;
        var k = e.key;
        if (k === 'MediaPlayPause') { P.toggle(); e.preventDefault(); }
        else if (k === 'MediaTrackNext') { P.next(false); e.preventDefault(); }
        else if (k === 'MediaTrackPrevious') { P.prev(); e.preventDefault(); }
        else if (k === 'MediaStop') { P.pause(); e.preventDefault(); }
    }, true);

    // ---------------------------------------------------------------- sound engine events
    engine.on('ended', function () { P.next(true); });
    engine.on('playing', function () { failures = 0; P.hidden = false; P.sync(); emit('state'); });
    engine.on('pause', function () { P.sync(); emit('state'); saveState(true); });
    engine.on('time', function () { P.tick(); saveState(false); });
    engine.on('error', function () {
        var t = current();
        if (!t || !engine.hasSource()) return;
        failures++;
        toast('Couldn\u2019t play \u201C' + (t.title || 'this song') + '\u201D');
        if (failures < queue.length && queue.length > 1) P.next(true);
        else { failures = 0; P.sync(); emit('state'); }
    });
    window.addEventListener('pagehide', function () { saveState(true); });

    // ---------------------------------------------------------------- playlists (kept on this device, per profile)
    function lists() { var l = readJson(LISTS_KEY, []); return Array.isArray(l) ? l : []; }
    function saveLists(l) { writeJson(LISTS_KEY, l); emit('playlists'); }
    P.playlists = lists;
    P.playlist = function (id) { return lists().filter(function (p) { return p.id === id; })[0] || null; };
    P.createPlaylist = function (name, tracks) {
        var l = lists();
        var p = { id: 'pl' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), name: (name || 'New playlist').trim() || 'New playlist', tracks: (tracks || []).map(slim) };
        l.push(p); saveLists(l);
        return p;
    };
    P.renamePlaylist = function (id, name) {
        var l = lists(); l.forEach(function (p) { if (p.id === id && name && name.trim()) p.name = name.trim(); }); saveLists(l);
    };
    P.deletePlaylist = function (id) { saveLists(lists().filter(function (p) { return p.id !== id; })); };
    // returns how many songs were really added (songs already in the playlist are skipped)
    P.addToPlaylist = function (id, tracks) {
        var l = lists(), added = 0;
        l.forEach(function (p) {
            if (p.id !== id) return;
            var have = {}; p.tracks.forEach(function (t) { have[t.id] = true; });
            (tracks || []).forEach(function (t) { if (!have[t.id]) { have[t.id] = true; p.tracks.push(slim(t)); added++; } });
        });
        saveLists(l);
        return added;
    };
    P.removeFromPlaylist = function (id, i) {
        var l = lists(); l.forEach(function (p) { if (p.id === id && i >= 0 && i < p.tracks.length) p.tracks.splice(i, 1); }); saveLists(l);
    };

    // ---------------------------------------------------------------- restore last session (paused)
    (function restore() {
        var s = readJson(STATE_KEY, null);
        if (!s || !Array.isArray(s.queue) || !s.queue.length) return;
        queue = s.queue.filter(function (t) { return t && t.id; }).map(slim);
        original = Array.isArray(s.original) ? s.original.map(slim) : null;
        index = Math.max(0, Math.min(s.index | 0, queue.length - 1));
        shuffle = !!s.shuffle;
        repeat = s.repeat === 'all' || s.repeat === 'one' ? s.repeat : 'off';
        pendingSeek = s.position > 1 ? s.position : 0;
        P.hidden = false;
    })();

    window.PekMusic = P;
})();
