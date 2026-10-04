import re, sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
fp, ap, cp = (os.path.join(www, n) for n in ("hesperframework.js", "app.js", "style.css"))
fw, js, css = open(fp).read(), open(ap).read(), open(cp).read()

# framework: grid() accepts an extra className
if "opts.className" in fw:
    print("hesperframework.js already patched")
else:
    old = "            className: 'sx-grid',"
    assert old in fw, "hesperframework.js: grid className not found"
    fw = fw.replace(old, "            className: 'sx-grid' + (opts.className ? ' ' + opts.className : ''),", 1)
    open(fp, "w").write(fw)
    print("hesperframework.js patched")

# app.js: mark the show and movie poster grids
if "sx-poster-grid" in js:
    print("app.js already patched")
else:
    total = 0
    for anchor in (r"this\.openShow\(s\.showTitle\)\)\),", r"this\.openMovieDetail\(m\)\)\),"):
        pat = re.compile("(" + anchor + r"\s*\n\s*)\{ minColWidth: '200px' \}")
        js, n = pat.subn(lambda m: m.group(1) + "{ minColWidth: '200px', className: 'sx-poster-grid' }", js, count=1)
        total += n
    assert total == 2, "app.js: expected to patch 2 poster grids, patched %d" % total
    open(ap, "w").write(js)
    print("app.js patched")

# CSS: smaller posters on small screens (phones, phone landscape)
if "Compact poster grids" in css:
    print("style.css already patched")
else:
    css += '''

/* ============================================================
   Compact poster grids on small screens (phones, either rotation).
   TVs and tablets keep the large layout.
   !important is needed because the grid sets its column size inline.
   ============================================================ */
@media (max-width: 700px), (max-height: 500px) {
    .sx-poster-grid {
        --sx-grid-min: 110px !important;
        gap: 0.6rem;
    }
    .sx-poster-grid .sx-poster-card { border-radius: 10px; }
    /* plain (no poster) cards sitting in the same grid */
    .sx-poster-grid .sx-card { padding: 0.75rem; }
    .sx-poster-grid .sx-card h3 { font-size: 0.95rem; }
    .sx-poster-grid .sx-card p { font-size: 0.8rem; }
    .sx-poster-grid .sx-poster-card { padding: 150% 0 0 0; }
}
'''
    open(cp, "w").write(css)
    print("style.css patched")
