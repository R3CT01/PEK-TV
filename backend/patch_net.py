import re, sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
hp, ap = os.path.join(www, "index.html"), os.path.join(www, "app.js")
html, js = open(hp).read(), open(ap).read()

# index.html: load net.js first
if "net.js" in html:
    print("index.html already patched")
else:
    m = re.search(r'(\s*)(<script src="player\.js[^"]*"></script>)', html)
    assert m, "index.html: player.js script tag not found"
    html = html[:m.start()] + m.group(1) + '<script src="net.js?v=1"></script>' + m.group(1) + m.group(2) + html[m.end():]
    open(hp, "w").write(html)
    print("index.html patched")

# app.js
if "_watchNetwork" in js:
    print("app.js already patched")
else:
    def sub1(t, old, new, what):
        assert t.count(old) == 1, "app.js: could not find " + what
        return t.replace(old, new, 1)

    js = sub1(js, "        this._startClockTicker();\n", "        this._startClockTicker();\n        this._watchNetwork();\n", "_startClockTicker() call")
    js = sub1(js, "    _queuePosters(items) {\n",
              "    _queuePosters(items) {\n        if (window.HesperNet && !window.HesperNet.isOnline()) return;   // offline: poster art waits for the network\n",
              "_queuePosters")
    marker = "    // ---------------- Clock (built-in header widget) ----------------"
    method = '''    // ---------------- Online / offline ----------------
    // net.js draws the green/red dot and reports changes. Offline mode: the local
    // library keeps working, internet-only things wait until the network is back.
    _watchNetwork() {
        const net = window.HesperNet;
        if (!net) return;
        const { ui } = this.props.engine;
        net.onChange((online) => {
            ui.toast(online ? 'Back online' : 'Offline mode: your local library only');
            if (online) {
                // fetch the poster art that was skipped while offline
                ['movies', 'shows'].forEach(t => {
                    const d = this.state.library[t];
                    if (d && !d.error) this._queuePostersFor(t, d);
                });
            }
        });
    }

'''
    js = sub1(js, marker, method + marker, "clock section marker")
    open(ap, "w").write(js)
    print("app.js patched")
