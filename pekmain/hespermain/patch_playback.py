import re, sys, os
root = sys.argv[1] if len(sys.argv) > 1 else "."
sp = os.path.join(root, "backend", "server.cpp")
ap = os.path.join(root, "www", "app.js")
sv, js = open(sp).read(), open(ap).read()

# ---- server.cpp: include + register routes ----
if "registerPlaybackRoutes" in sv:
    print("server.cpp already patched")
else:
    assert '#include "server.h"' in sv, "server.cpp: include marker not found"
    sv = sv.replace('#include "server.h"', '#include "server.h"\n#include "playback.h"', 1)
    m = re.search(r"^(\s*)httplib::Server svr;\s*$", sv, re.M)
    assert m, "server.cpp: 'httplib::Server svr;' not found"
    sv = sv[:m.end()] + "\n" + m.group(1) + "registerPlaybackRoutes(svr, scanner);   // /api/stream/<id>" + sv[m.end():]
    open(sp, "w").write(sv)
    print("server.cpp patched")

# ---- app.js: Play button + playMedia ----
if "playMedia(" in js:
    print("app.js already patched")
else:
    # playMedia method right after closeDetail()
    marker = "    closeDetail() { this.setState({ detail: null }); }"
    assert marker in js, "app.js: closeDetail marker not found"
    method = '''

    // Hands a library file to the native player on Android (HesperAndroid is
    // injected by the app). Elsewhere it just opens the stream URL.
    playMedia(id, title) {
        const url = window.location.origin + '/api/stream/' + encodeURIComponent(id);
        try {
            if (window.HesperAndroid && typeof window.HesperAndroid.play === 'function') {
                window.HesperAndroid.play(url, title || '');
                return;
            }
        } catch (e) { console.warn('[PEK] native play failed, falling back', e); }
        window.open(url, '_blank');
    }'''
    js = js.replace(marker, marker + method, 1)

    # ids on the detail objects
    old = "const base = { title: m.title, subtitle:"
    assert old in js, "app.js: movie base not found"
    js = js.replace(old, "const base = { playId: m.id, title: m.title, subtitle:", 1)
    old = "const base = { title: label, subtitle:"
    assert old in js, "app.js: episode base not found"
    js = js.replace(old, "const base = { playId: ep.id, title: label, subtitle:", 1)

    # Play button in the detail modal body
    play_btn = ",\n            d.playId ? createElement('div', { style: { margin: '14px 0 6px' } }, ui.button('\\u25b6  Play', () => this.playMedia(d.playId, d.title), { variant: 'primary' })) : null"
    a = "createElement('div', { className: 'glass-panel' }, createElement('p', {}, text))"
    b = "createElement('p', {}, text)\n        );\n        return ui.modal("
    if a in js:
        js = js.replace(a, a + play_btn, 1)
    elif b in js:
        js = js.replace("createElement('p', {}, text)\n        );\n        return ui.modal(", "createElement('p', {}, text)" + play_btn + "\n        );\n        return ui.modal(", 1)
    else:
        raise AssertionError("app.js: modal body not found")
    open(ap, "w").write(js)
    print("app.js patched")
