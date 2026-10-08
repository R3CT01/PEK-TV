/* PEK navigation sound  (window.HesperNavSound)
 * tick():   a soft, short "tick" when the D-pad / arrow keys move the highlight.
 * select(): a different, slightly longer two-note "pop" when OK is pressed.
 * Synthesised with Web Audio (no sound file). Off / Low / Medium / High is saved in Settings.
 *
 * Latency: the sounds are pre-rendered into buffers, the AudioContext is created early with
 * the lowest latency hint and unlocked on the first touch/key, and a near-silent loop keeps the
 * audio output awake. Without that, Android lets the audio hardware sleep and the first sound
 * after a pause comes out about a second late.
 */
(function () {
    'use strict';
    var KEY = 'hesper-navsound';
    var LEVELS = { off: 0, low: 0.035, med: 0.07, high: 0.13 };
    var ctx = null, tickBuf = null, selectBuf = null, keep = null;
    var last = 0, level = 'med';
    // On the Android app the sounds are played natively (low-latency AudioTrack, see NavSound.kt):
    // Web Audio inside a WebView sits behind a large buffer and the busy page thread, so on a TV box it
    // trailed the highlight. Web Audio below is the fallback for browsers / older builds.
    var nativeOk = false;
    function native() {
        if (nativeOk) return true;
        try {
            var a = window.HesperAndroid;
            if (a && typeof a.navSound === 'function' && typeof a.navSoundReady === 'function' && a.navSoundReady()) nativeOk = true;
        } catch (e) { /* use Web Audio */ }
        return nativeOk;
    }
    try { var v = localStorage.getItem(KEY); if (v && LEVELS.hasOwnProperty(v)) level = v; } catch (e) { /* default */ }

    // Render a short enveloped sine sweep(s) into an AudioBuffer.
    // notes: [{ f0, f1, start, dur }]  (seconds, Hz)
    function render(notes, total) {
        var sr = ctx.sampleRate, n = Math.ceil(sr * total);
        var buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
        notes.forEach(function (nt) {
            var s0 = Math.floor(nt.start * sr), len = Math.floor(nt.dur * sr), ph = 0;
            for (var i = 0; i < len && s0 + i < n; i++) {
                var p = i / len;
                var f = nt.f0 * Math.pow(nt.f1 / nt.f0, p);          // exponential sweep
                ph += 2 * Math.PI * f / sr;
                var env = Math.min(1, i / (sr * 0.004)) * Math.pow(1 - p, 2);   // 4ms attack, smooth decay
                d[s0 + i] += Math.sin(ph) * env;
            }
        });
        return buf;
    }

    function setup() {
        if (ctx) return true;
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
            tickBuf = render([{ f0: 1850, f1: 1250, start: 0, dur: 0.055 }], 0.07);
            selectBuf = render([
                { f0: 880, f1: 880, start: 0, dur: 0.07 },
                { f0: 1320, f1: 1320, start: 0.055, dur: 0.11 }
            ], 0.19);
            startKeepAlive();
            return true;
        } catch (e) { ctx = null; return false; }
    }

    // A looping, practically inaudible signal so the output device never goes to sleep.
    function startKeepAlive() {
        if (keep || !ctx) return;
        try {
            var n = Math.floor(ctx.sampleRate * 0.5);
            var b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
            for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.0004;
            keep = ctx.createBufferSource();
            keep.buffer = b; keep.loop = true;
            keep.connect(ctx.destination);
            keep.start();
        } catch (e) { keep = null; }
    }

    function unlock() {
        if (!LEVELS[level]) return;
        if (native()) return;
        if (!setup()) return;
        if (ctx.state !== 'running') { try { ctx.resume(); } catch (e) { /* ignore */ } }
    }
    ['pointerdown', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) {
        window.addEventListener(ev, unlock, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', function () {
        if (!ctx) return;
        try { if (document.hidden) ctx.suspend(); else ctx.resume(); } catch (e) { /* ignore */ }
    });

    function play(buf, gain, gap, kind) {
        var g = LEVELS[level];
        if (!g) return;
        var now = Date.now();
        if (gap && now - last < gap) return;
        last = now;
        if (native()) {
            try { window.HesperAndroid.navSound(kind, g * gain); return; } catch (e) { nativeOk = false; /* fall back */ }
        }
        try {
            if (!setup()) return;
            if (ctx.state !== 'running') ctx.resume();
            var src = ctx.createBufferSource(), gn = ctx.createGain();
            src.buffer = buf;
            gn.gain.value = g * gain;
            src.connect(gn); gn.connect(ctx.destination);
            src.start();
        } catch (e) { /* no audio: stay silent */ }
    }

    function tick()   { play(tickBuf || (!native() && setup() && tickBuf), 1, 45, 0); }          // holding a key: soft patter, not a buzz
    function select() { play(selectBuf || (!native() && setup() && selectBuf), 1.6, 0, 1); }

    // Build the buffers as soon as the page is up so the first press is instant.
    if (LEVELS[level]) { var early = function () { if (!native()) setup(); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', early); else early(); }

    window.HesperNavSound = {
        tick: tick,
        select: select,
        levels: ['off', 'low', 'med', 'high'],
        get: function () { return level; },
        set: function (l) {
            if (!LEVELS.hasOwnProperty(l)) return;
            level = l;
            try { localStorage.setItem(KEY, l); } catch (e) { /* not saved */ }
            last = 0; unlock(); tick();          // preview
        }
    };
})();
