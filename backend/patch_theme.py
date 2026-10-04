import sys, os
path = os.path.join(sys.argv[1] if len(sys.argv) > 1 else "www", "app.js")
js = open(path).read()
if "_themeForNative" in js:
    print("already patched"); sys.exit(0)

old = "window.HesperAndroid.play(url, title || '');"
assert old in js, "playMedia call not found (is the playback patch applied?)"
js = js.replace(old, "window.HesperAndroid.play(url, title || '', this._themeForNative());", 1)

marker = "    // Hands a library file to the native player"
assert marker in js, "playMedia comment marker not found"
method = '''    // Reads the active theme's colors (so skins work) and returns them as JSON
    // with #AARRGGBB values for the native player's dialogs.
    _themeForNative() {
        const names = {
            bg: '--sx-bg-elevated', surface: '--sx-surface', border: '--sx-border',
            accent: '--sx-accent', text: '--sx-text', muted: '--sx-text-muted',
            glow: '--sx-accent-glow'
        };
        const out = {};
        try {
            const probe = document.createElement('span');
            probe.style.display = 'none';
            document.body.appendChild(probe);
            const hex = n => ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
            Object.keys(names).forEach(k => {
                probe.style.color = '';
                probe.style.color = 'var(' + names[k] + ')';
                const m = getComputedStyle(probe).color.match(/[\\d.]+/g);   // r g b [a]
                if (!m || m.length < 3) return;
                const a = m.length > 3 ? parseFloat(m[3]) * 255 : 255;
                out[k] = '#' + hex(a) + hex(parseFloat(m[0])) + hex(parseFloat(m[1])) + hex(parseFloat(m[2]));
            });
            document.body.removeChild(probe);
            const r = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sx-radius'), 10);
            if (r) out.radius = r;
        } catch (e) { /* native side falls back to the default colors */ }
        return JSON.stringify(out);
    }

'''
js = js.replace(marker, method + marker, 1)
open(path, "w").write(js)
print("app.js patched")
