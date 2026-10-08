import re, sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
paths = {n: os.path.join(www, n) for n in ("app.js", "hesperframework.js", "style.css")}
src = {n: open(p).read() for n, p in paths.items()}

app, fw, css = src["app.js"], src["hesperframework.js"], src["style.css"]

# ---------------- hesperframework.js: ui.posterCard ----------------
if "posterCard(" in fw:
    print("hesperframework.js already patched")
else:
    marker = "    /** A horizontal row of children, e.g. a set of cards. */"
    assert marker in fw, "hesperframework.js: row() marker not found"
    method = '''    /** A poster-art tile. Falls back to the plain titled card when there is
     *  no poster, or if the image fails to load. */
    posterCard(title, subtitle, posterUrl, onClick) {
        if (!posterUrl) return this.card(title, subtitle, onClick);
        const wrap = this.engine.createElement('div', {
            className: 'focusable sx-card sx-poster-card',
            title: title,
            onClick: onClick || (() => {})
        });
        const img = this.engine.createElement('img', { className: 'sx-poster-img', src: posterUrl, alt: title });
        img.addEventListener('error', () => {
            const plain = this.card(title, subtitle, onClick);
            if (wrap.parentNode) {
                wrap.parentNode.replaceChild(plain, wrap);
                this.engine.refreshFocusList();
            }
        });
        wrap.appendChild(img);
        return wrap;
    }

'''
    fw = fw.replace(marker, method + marker, 1)
    open(paths["hesperframework.js"], "w").write(fw)
    print("hesperframework.js patched")

# ---------------- app.js ----------------
if "_queuePosters" in app:
    print("app.js already patched")
else:
    # state
    old = "            weatherText: this._readWeather()"
    assert old in app, "app.js: state marker not found"
    app = app.replace(old, "            posters: this._readPosters(),   // 'm:<id>' / 's:<title>' -> poster url ('' = none found)\n" + old, 1)

    # methods
    marker = "    // ---------------- Details (TMDb via the backend) ----------------"
    assert marker in app, "app.js: details marker not found"
    methods = '''    // ---------------- Poster art for cards ----------------
    _readPosters() {
        try { return JSON.parse(localStorage.getItem('hesper_posters_v1') || '{}') || {}; }
        catch (e) { return {}; }
    }

    _queuePostersFor(tab, data) {
        if (tab === 'movies') {
            this._queuePosters((data.movies || []).map(m => ({
                key: 'm:' + m.id, url: '/api/movie-details?id=' + encodeURIComponent(m.id)
            })));
        } else if (tab === 'shows') {
            this._queuePosters((data.shows || []).map(s => ({
                key: 's:' + s.showTitle, url: '/api/show-details?title=' + encodeURIComponent(s.showTitle)
            })));
        }
    }

    // Fetches posters we don't have yet, 3 at a time, and publishes results in
    // batches so the grid is not rebuilt for every single image.
    _queuePosters(items) {
        if (!this._posterQueue) {
            this._posterQueue = []; this._posterActive = 0; this._posterPending = {}; this._posterSeen = {}; this._posterTimer = null;
        }
        items.forEach(it => {
            if (this.state.posters[it.key] !== undefined || this._posterSeen[it.key]) return;
            this._posterSeen[it.key] = true;
            this._posterQueue.push(it);
        });
        this._pumpPosters();
    }

    _pumpPosters() {
        while (this._posterActive < 3 && this._posterQueue.length) {
            const it = this._posterQueue.shift();
            this._posterActive++;
            this._fetchJson(it.url).then(d => d.poster || '', () => '').then(poster => {
                this._posterPending[it.key] = poster;
                this._posterActive--;
                if (!this._posterTimer) {
                    this._posterTimer = setTimeout(() => { this._posterTimer = null; this._flushPosters(); }, 600);
                }
                this._pumpPosters();
            });
        }
    }

    _flushPosters() {
        const pending = this._posterPending;
        this._posterPending = {};
        const keys = Object.keys(pending);
        if (!keys.length) return;
        const posters = { ...this.state.posters };
        keys.forEach(k => { posters[k] = pending[k]; });
        this.setState({ posters });
        try {
            const keep = {};
            Object.keys(posters).forEach(k => { if (posters[k]) keep[k] = posters[k]; });
            localStorage.setItem('hesper_posters_v1', JSON.stringify(keep));
        } catch (e) { /* storage unavailable: posters just reload next time */ }
    }

'''
    app = app.replace(marker, methods + marker, 1)

    # queue after the library loads
    old = "            this.setState({ library: { ...this.state.library, [tab]: data } });"
    assert app.count(old) == 1, "app.js: loadLibrary marker not found exactly once"
    app = app.replace(old, old + "\n            this._queuePostersFor(tab, data);", 1)

    # movie cards
    old = "ui.card(m.title, m.year ? String(m.year) : m.filename, () => this.openMovieDetail(m))"
    assert old in app, "app.js: movie card not found"
    app = app.replace(old, "ui.posterCard(m.title, m.year ? String(m.year) : m.filename, this.state.posters['m:' + m.id], () => this.openMovieDetail(m))", 1)

    # show cards
    pat = re.compile(r"shows\.map\(s => ui\.card\(\s*s\.showTitle,(.*?),\s*\(\) => this\.openShow\(s\.showTitle\)\s*\)\)", re.S)
    app, n = pat.subn(lambda m: "shows.map(s => ui.posterCard(s.showTitle," + m.group(1) + ", this.state.posters['s:' + s.showTitle], () => this.openShow(s.showTitle)))", app, count=1)
    assert n == 1, "app.js: show card not found"
    open(paths["app.js"], "w").write(app)
    print("app.js patched")

# ---------------- style.css ----------------
if "Poster cards" in css:
    print("style.css already patched")
else:
    css += '''

/* ============================================================
   Poster cards (movie / show tiles)
   padding-top % keeps a 2:3 ratio on old WebViews (no aspect-ratio).
   ============================================================ */
.sx-poster-card {
    position: relative;
    padding: 150% 0 0 0;
    overflow: hidden;
    background: #161b22;
    background: var(--sx-surface, #161b22);
    -webkit-transition: -webkit-transform 0.18s ease, box-shadow 0.18s ease;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
}

.sx-poster-img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
}

.sx-poster-card.focused {
    z-index: 2;
    -webkit-transform: scale(1.04);
    transform: scale(1.04);
}
'''
    open(paths["style.css"], "w").write(css)
    print("style.css patched")
