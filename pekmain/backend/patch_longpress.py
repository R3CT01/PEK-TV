import re, sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
fp, ap, cp = (os.path.join(www, n) for n in ("hesperframework.js", "app.js", "style.css"))
fw, js, css = open(fp).read(), open(ap).read(), open(cp).read()

# ================= hesperframework.js =================
if "_longPress(" in fw:
    print("hesperframework.js already patched")
else:
    def sub1(text, old, new, what):
        assert text.count(old) == 1, "hesperframework.js: could not find " + what
        return text.replace(old, new, 1)

    # card()
    fw = sub1(fw, "    card(title, subtitle, onClick) {\n        return this.engine.createElement('div', {\n            className: 'empty-state focusable sx-card',",
                  "    card(title, subtitle, onClick, opts = {}) {\n        const el = this.engine.createElement('div', {\n            className: 'empty-state focusable sx-card',", "card()")
    fw = sub1(fw, "            subtitle ? this.engine.createElement('p', {}, subtitle) : null\n        );\n    }\n\n    /** A poster-art tile.",
                  "            subtitle ? this.engine.createElement('p', {}, subtitle) : null\n        );\n        return this._longPress(el, opts.onLongPress);\n    }\n\n    /** A poster-art tile.", "end of card()")

    # posterCard()
    fw = sub1(fw, "posterCard(title, subtitle, posterUrl, onClick) {", "posterCard(title, subtitle, posterUrl, onClick, opts = {}) {", "posterCard signature")
    fw = sub1(fw, "if (!posterUrl) return this.card(title, subtitle, onClick);", "if (!posterUrl) return this.card(title, subtitle, onClick, opts);", "posterCard fallback")
    fw = sub1(fw, "const plain = this.card(title, subtitle, onClick);", "const plain = this.card(title, subtitle, onClick, opts);", "posterCard error fallback")
    fw = sub1(fw, "        wrap.appendChild(img);\n        return wrap;", "        wrap.appendChild(img);\n        return this._longPress(wrap, opts.onLongPress);", "posterCard return")

    # listRow()
    fw = sub1(fw, "        return this.engine.createElement('div', {\n            className: 'plugin-row focusable sx-list-row',",
                  "        const el = this.engine.createElement('div', {\n            className: 'plugin-row focusable sx-list-row',", "listRow()")
    fw = sub1(fw, "            opts.statusDot ? this.engine.createElement('div', { className: 'plugin-status-dot' }) : null\n        );",
                  "            opts.statusDot ? this.engine.createElement('div', { className: 'plugin-status-dot' }) : null\n        );\n        return this._longPress(el, opts.onLongPress);", "end of listRow()")

    # new helpers: _longPress + toast
    helpers = '''    /** Adds a press-and-hold action to an element (touch/mouse hold, or hold OK on a
     *  remote - the engine's key handler looks at el._hesperLongPress). */
    _longPress(el, handler) {
        if (!handler) return el;
        el.classList.add('sx-longpress');
        el._hesperLongPress = handler;
        if (!HesperUIKit._lpInstalled) {
            HesperUIKit._lpInstalled = true;
            // After a long press fires, swallow the click that follows the release.
            document.addEventListener('click', (ev) => {
                const t = ev.target && ev.target.closest ? ev.target.closest('.sx-longpress') : null;
                if (t && t._lpSuppress) { t._lpSuppress = false; ev.stopPropagation(); ev.preventDefault(); }
            }, true);
        }
        let timer = null;
        const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
        el.addEventListener('pointerdown', () => {
            cancel();
            timer = setTimeout(() => { timer = null; el._lpSuppress = true; handler(); }, 550);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => el.addEventListener(n, () => {
            cancel();
            if (el._lpSuppress) setTimeout(() => { el._lpSuppress = false; }, 350);
        }));
        el.addEventListener('contextmenu', (ev) => ev.preventDefault());
        return el;
    }

    /** A small themed message at the bottom of the screen that fades away. */
    toast(text, ms = 3500) {
        const old = document.querySelector('.sx-toast');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        const el = this.engine.createElement('div', { className: 'sx-toast' }, text);
        document.body.appendChild(el);
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
    }

'''
    marker = "    /** A horizontal row of children, e.g. a set of cards. */"
    fw = sub1(fw, marker, helpers + marker, "row() marker")

    # engine: hold OK on a remote
    fw = sub1(fw, "                    else active.click();\n",
"""                    else if (active._hesperLongPress) {
                        // Hold OK for the long-press action; a short press clicks on release.
                        if (!e.repeat && !this._lpTimer && !this._lpFiredByKey) {
                            this._lpTarget = active;
                            this._lpTimer = setTimeout(() => {
                                this._lpTimer = null; this._lpTarget = null;
                                this._lpFiredByKey = true;
                                active._hesperLongPress();
                            }, 550);
                        }
                    } else active.click();
""", "Enter handling")
    fw = sub1(fw, "        });\n    }\n\n    _applyFocus() {",
"""        });

        window.addEventListener('keyup', (e) => {
            if (e.key !== 'Enter') return;
            this._lpFiredByKey = false;
            if (this._lpTimer) {
                clearTimeout(this._lpTimer);
                this._lpTimer = null;
                const t = this._lpTarget; this._lpTarget = null;
                if (t && t.isConnected) t.click();
            }
        });
    }

    _applyFocus() {""", "end of _initGlobalListener")
    open(fp, "w").write(fw)
    print("hesperframework.js patched")

# ================= app.js =================
if "ui.toast(" in js:
    print("app.js already patched")
else:
    old = "ui.listRow(`Episode ${e.episode}`, e.filename, () => this.openEpisodeDetail(show.showTitle, e))"
    assert js.count(old) == 1, "app.js: episode row not found"
    js = js.replace(old, "ui.listRow(`Episode ${e.episode}`, null, () => this.openEpisodeDetail(show.showTitle, e), { onLongPress: () => ui.toast(e.filename) })", 1)
    old = "ui.posterCard(m.title, m.year ? String(m.year) : m.filename, this.state.posters['m:' + m.id], () => this.openMovieDetail(m))"
    assert js.count(old) == 1, "app.js: movie card not found"
    js = js.replace(old, "ui.posterCard(m.title, m.year ? String(m.year) : '', this.state.posters['m:' + m.id], () => this.openMovieDetail(m), { onLongPress: () => ui.toast(m.filename) })", 1)
    open(ap, "w").write(js)
    print("app.js patched")

# ================= style.css =================
if "sx-toast" in css:
    print("style.css already patched")
else:
    css += '''

/* ============================================================
   Long-press support + toast
   ============================================================ */
.sx-longpress {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
}

.sx-toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    max-width: 90%;
    padding: 10px 18px;
    border-radius: 14px;
    font-size: 0.9rem;
    line-height: 1.4;
    word-break: break-all;
    text-align: center;
    color: #f0f6fc;
    color: var(--sx-text, #f0f6fc);
    background: rgba(13, 18, 30, 0.92);
    border: 1px solid rgba(88, 166, 255, 0.45);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    -webkit-transform: translateX(-50%);
    transform: translateX(-50%);
    z-index: 10000;
    pointer-events: none;
    animation: sxToastIn 0.2s ease-out;
}

@keyframes sxToastIn {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
}
'''
    open(cp, "w").write(css)
    print("style.css patched")
