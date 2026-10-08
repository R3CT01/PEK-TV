import re, sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
js_path, css_path = os.path.join(www, "app.js"), os.path.join(www, "style.css")
js, css = open(js_path).read(), open(css_path).read()

if "_renderShowHero" in js:
    print("app.js already patched")
else:
    # 1) new hero method, placed right before _renderShows
    method = '''    // Glass "hero" card for a show: blurred poster backdrop, poster, title,
    // meta line and synopsis. Falls back to a plain heading until the bio loads.
    _renderShowHero(show, meta) {
        const { createElement } = this.props.engine;
        const info = this.state.showInfo[show.showTitle];
        const ready = info && !info.loading && !info.error && info.overview;
        if (!ready) {
            return createElement('div', {},
                createElement('h2', { className: 'sub-heading' }, show.showTitle),
                info && info.loading ? createElement('p', { className: 'sub' }, 'Loading synopsis\\u2026') : null
            );
        }
        return createElement('div', { className: 'hero' },
            info.poster ? createElement('div', { className: 'hero-backdrop', style: { backgroundImage: 'url("' + info.poster + '")' } }) : null,
            createElement('div', { className: 'hero-glass' },
                info.poster ? createElement('img', { className: 'hero-poster', src: info.poster, alt: '' }) : null,
                createElement('div', { className: 'hero-text' },
                    createElement('h2', { className: 'hero-title' }, show.showTitle),
                    createElement('div', { className: 'hero-meta' }, meta),
                    createElement('div', { className: 'hero-rule' }),
                    createElement('p', { className: 'hero-overview' }, info.overview)
                )
            )
        );
    }

'''
    marker = "    _renderShows(data) {"
    assert marker in js, "could not find _renderShows"
    js = js.replace(marker, method + marker, 1)

    # 2) use it on the seasons screen
    pat = re.compile(r"createElement\('h2', \{ className: 'sub-heading' \}, show\.showTitle\),\s*\n\s*this\._renderShowBio\(show\.showTitle\),")
    new = "this._renderShowHero(show, `${plural(show.seasons.length, 'season')} \\u00b7 ${plural(show.episodeCount, 'episode')}`),"
    js, n = pat.subn(lambda m: new, js, count=1)
    assert n == 1, "could not find the seasons-screen heading/bio lines"

    # 3) modal: glass synopsis panel + nicer image
    old_img = "createElement('img', { src: d.image, alt: '', style: { maxWidth: '100%', borderRadius: '8px', margin: '8px 0' } })"
    assert old_img in js, "could not find modal image"
    js = js.replace(old_img, "createElement('img', { className: 'detail-image', src: d.image, alt: '' })", 1)
    old_p = "            createElement('p', {}, text)\n        );\n        return ui.modal("
    assert old_p in js, "could not find modal text"
    js = js.replace(old_p, "            createElement('div', { className: 'glass-panel' }, createElement('p', {}, text))\n        );\n        return ui.modal(", 1)
    open(js_path, "w").write(js)
    print("app.js patched")

if "Detail hero (glass)" in css:
    print("style.css already patched")
else:
    css += '''

/* ============================================================
   Detail hero (glass)
   Literal fallbacks come first so old WebViews still render.
   ============================================================ */
.hero {
    position: relative;
    margin: 8px 0 24px;
    border-radius: 20px;
    overflow: hidden;
    background: #0d121e;
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    animation: fadeIn 0.35s ease-out;
}

.hero-backdrop {
    position: absolute;
    top: -30px; right: -30px; bottom: -30px; left: -30px;
    background-size: cover;
    background-position: center;
    -webkit-filter: blur(34px) saturate(1.3);
    filter: blur(34px) saturate(1.3);
    opacity: 0.55;
}

.hero-glass {
    position: relative;
    display: flex;
    gap: 20px;
    padding: 22px;
    background: rgba(10, 14, 24, 0.55);
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.02)), rgba(10, 14, 24, 0.45);
    -webkit-backdrop-filter: blur(18px);
    backdrop-filter: blur(18px);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.hero-poster {
    width: 140px;
    flex-shrink: 0;
    align-self: flex-start;
    border-radius: 12px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.10);
}

.hero-text { min-width: 0; }

.hero-title {
    margin: 0 0 6px 0;
    font-size: 1.9rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
    color: #f0f6fc;
    color: var(--sx-text, #f0f6fc);
}

.hero-meta {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #8b949e;
    color: var(--sx-text-muted, #8b949e);
}

.hero-rule {
    width: 44px;
    height: 3px;
    margin: 12px 0 14px;
    border-radius: 2px;
    background: #58a6ff;
    background: var(--sx-accent, #58a6ff);
    box-shadow: 0 0 12px rgba(88, 166, 255, 0.5);
}

.hero-overview {
    margin: 0;
    font-size: 1rem;
    line-height: 1.65;
    color: rgba(240, 246, 252, 0.88);
}

@media (max-width: 520px) {
    .hero-glass { padding: 16px; gap: 14px; }
    .hero-poster { width: 96px; }
    .hero-title { font-size: 1.5rem; }
}

/* Glass panel used for synopsis text inside the detail modal */
.glass-panel {
    margin: 10px 0 4px;
    padding: 14px 16px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.10);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    line-height: 1.6;
}
.glass-panel p { margin: 0; }

.detail-image {
    max-width: 100%;
    margin: 8px 0;
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
'''
    open(css_path, "w").write(css)
    print("style.css patched")
