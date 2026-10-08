import sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
fp, cp = os.path.join(www, "hesperframework.js"), os.path.join(www, "style.css")
fw, css = open(fp).read(), open(cp).read()

if "sx-poster-caption" in fw:
    print("hesperframework.js already patched")
else:
    old = "        wrap.appendChild(img);\n"
    assert fw.count(old) == 1, "hesperframework.js: poster card image line not found"
    fw = fw.replace(old, old + "        wrap.appendChild(this.engine.createElement('div', { className: 'sx-poster-caption' }, title));\n", 1)
    open(fp, "w").write(fw)
    print("hesperframework.js patched")

if "sx-poster-caption" in css:
    print("style.css already patched")
else:
    css += '''

/* Title strip along the bottom of poster cards */
.sx-poster-caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 30px 10px 10px;
    background: linear-gradient(to top, rgba(5, 8, 14, 0.92), rgba(5, 8, 14, 0));
    color: #f0f6fc;
    color: var(--sx-text, #f0f6fc);
    font-size: 0.9rem;
    font-weight: 600;
    line-height: 1.25;
    text-align: left;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    pointer-events: none;
}

@media (max-width: 700px), (max-height: 500px) {
    .sx-poster-caption {
        padding: 20px 7px 7px;
        font-size: 0.78rem;
    }
}
'''
    open(cp, "w").write(css)
    print("style.css patched")
