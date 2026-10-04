import re, sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
hp, ap = os.path.join(www, "index.html"), os.path.join(www, "app.js")
html, js = open(hp).read(), open(ap).read()

# index.html: load player.js before app.js
if "player.js" in html:
    print("index.html already patched")
else:
    pat = re.compile(r'(\s*)(<script src="app\.js[^"]*"></script>)')
    m = pat.search(html)
    assert m, "index.html: app.js script tag not found"
    html = html[:m.start()] + m.group(1) + '<script src="player.js?v=1"></script>' + m.group(1) + m.group(2) + html[m.end():]
    open(hp, "w").write(html)
    print("index.html patched")

# app.js: use the shared player when there is no native one; Back goes to it first
if "_openWebPlayer" in js:
    print("app.js already patched")
else:
    old = "        window.open(url, '_blank');\n"
    assert js.count(old) == 1, "app.js: playMedia fallback not found (is the playback patch applied?)"
    js = js.replace(old, "        if (window.HesperPlayer && window.HtmlVideoBackend) { this._openWebPlayer(url, title); return; }\n" + old, 1)

    old = "    closeDetail() { this.setState({ detail: null }); }\n"
    assert js.count(old) == 1, "app.js: closeDetail not found"
    method = '''
    // The shared player (player.js) with a <video> backend: used where there is
    // no native player, such as the web/dev build.
    _openWebPlayer(url, title) {
        if (this._player) return;
        this.setState({ detail: null });
        const player = new window.HesperPlayer({
            title: title || '',
            backend: new window.HtmlVideoBackend(),
            onClose: () => { this._player = null; }
        });
        this._player = player;
        player.open(url, 0);
    }
'''
    js = js.replace(old, old + method, 1)

    old = "    goBack() {\n        const { engine } = this.props;\n"
    assert js.count(old) == 1, "app.js: goBack not found"
    js = js.replace(old, old + "        if (this._player) { this._player.onBack(); return true; }\n", 1)
    open(ap, "w").write(js)
    print("app.js patched")
