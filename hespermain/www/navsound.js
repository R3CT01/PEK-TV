/* Hesper navigation sound  (window.HesperNavSound)
 * A soft, short "tick" when the D-pad / arrow keys move the highlight, like a streaming box.
 * Synthesised with Web Audio (no sound file). Off / Low / Medium / High is saved in Settings.
 */
(function () {
    'use strict';
    var KEY = 'hesper-navsound';
    var LEVELS = { off: 0, low: 0.035, med: 0.07, high: 0.13 };
    var ctx = null, last = 0, level = 'med';
    try { var v = localStorage.getItem(KEY); if (v && LEVELS.hasOwnProperty(v)) level = v; } catch (e) { /* default */ }

    function tick() {
        var gainLevel = LEVELS[level];
        if (!gainLevel) return;
        var now = Date.now();
        if (now - last < 45) return;            // holding a key: keep it a soft patter, not a buzz
        last = now;
        try {
            if (!ctx) {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                ctx = new AC();
            }
            if (ctx.state === 'suspended') ctx.resume();
            var t = ctx.currentTime;
            var osc = ctx.createOscillator(), g = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1850, t);
            osc.frequency.exponentialRampToValueAtTime(1250, t + 0.04);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(gainLevel, t + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
            osc.connect(g); g.connect(ctx.destination);
            osc.start(t); osc.stop(t + 0.07);
        } catch (e) { /* no audio: stay silent */ }
    }

    window.HesperNavSound = {
        tick: tick,
        levels: ['off', 'low', 'med', 'high'],
        get: function () { return level; },
        set: function (l) {
            if (!LEVELS.hasOwnProperty(l)) return;
            level = l;
            try { localStorage.setItem(KEY, l); } catch (e) { /* not saved */ }
            last = 0; tick();                    // preview
        }
    };
})();
