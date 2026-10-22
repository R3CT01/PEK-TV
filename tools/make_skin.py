#!/usr/bin/env python3
"""make_skin.py - make PEK TV skins from code.

Builds skin.json for the Flutter UI, runs the same safety checks as backend/skin_install.h, and packs an
installable .zip:

    my-skin.zip
    └── my-skin/
        └── skin.json

The Flutter UI draws skins from their colours and corner size only, so skin.css is not accepted any more: not when
making a skin, and not when checking one (`validate` refuses a zip that has a skin.css).

The colour maths is the same as `SkinJson.derive` in flutter_ui/lib/src/skins.dart, so a skin made here looks the same
as one made in the app's Skin maker.

Examples
    # four colours, the rest is worked out
    make_skin.py new --name Sunset --bg '#1a0f14' --surface '#2a1820' --text '#fff1e8' --accent '#ffb347' --radius 14

    # one accent colour is enough (dark by default; --light for a light skin)
    make_skin.py new --name Ocean --accent '#38bdf8'

    # only a hue (0-360)
    make_skin.py new --name Moss --hue 140 --glow

    # many skins from one JSON file (a list of the same fields as the flags, see --help for spec)
    make_skin.py batch skins.json --out dist/

    # check a .zip or a skin folder with the rules the server and the apps use
    make_skin.py validate dist/sunset.zip

    # print the skin.json instead of writing files
    make_skin.py new --name Test --accent '#ff00aa' --print

Spec file (batch): [{"name": "Sunset", "accent": "#ffb347", "bg": "...", "surface": "...", "text": "...", "radius": 14,
                     "mode": "dark", "hue": 30, "glow": true, "tokens": {"textMuted": "#aaa"}}]
"""
import argparse, colorsys, json, math, os, re, sys, zipfile

# ---------------------------------------------------------------- limits (backend/skin_install.h, plugin_install.h)
MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_MANIFEST = 60, 2 * 1024 * 1024, 6 * 1024 * 1024, 16 * 1024
MAX_PATH, MAX_DEPTH = 120, 6
RESERVED_IDS = {"default", "green", "neon", "ember", "minimal", "light", "netflix"}   # web + Flutter built-ins
ALLOWED_EXT = {"json", "md", "txt", "png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "ttf", "otf"}


NO_CSS = "skins can't contain CSS (skin.css): a skin is colours and a corner size only. Remove the .css file and try again."


class SkinError(Exception):
    pass


# ---------------------------------------------------------------- colours
def parse_color(text):
    """#rgb, #rrggbb, #rrggbbaa, rgb(), rgba() -> (r, g, b, a) with a in 0..255, or None."""
    t = str(text).strip().lower()
    if t.startswith("#"):
        h = t[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if not re.fullmatch(r"[0-9a-f]+", h or "x") or len(h) not in (6, 8):
            return None
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return (r, g, b, int(h[6:8], 16) if len(h) == 8 else 255)
    m = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)", t)
    if not m:
        return None
    ch = lambda i: max(0, min(255, int(m.group(i))))
    a = 1.0 if m.group(4) is None else max(0.0, min(1.0, float(m.group(4))))
    return (ch(1), ch(2), ch(3), _round(a * 255))


def _round(x):          # Dart's round() (half away from zero), not Python's banker's rounding
    return int(math.floor(x + 0.5))


def luminance(c):       # Flutter's Color.computeLuminance
    def lin(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])


def lerp(a, b, t):      # Flutter's Color.lerp on opaque colours
    return tuple(_round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def hex_(c, alpha=False):
    base = "#%02x%02x%02x" % c[:3]
    return base + ("%02x" % c[3] if alpha or c[3] != 255 else "")


def rgba(c):
    return "rgba(%d, %d, %d, %.2f)" % (c[0], c[1], c[2], c[3] / 255.0)


def with_alpha(c, a):
    return (c[0], c[1], c[2], a)


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l, s)
    return (_round(r * 255), _round(g * 255), _round(b * 255), 255)


def hue_of(c):
    return colorsys.rgb_to_hls(c[0] / 255.0, c[1] / 255.0, c[2] / 255.0)[0] * 360


# ---------------------------------------------------------------- palette + tokens
def auto_palette(accent=None, hue=None, dark=True):
    """bg, surface, text and accent worked out from one accent colour (or a hue)."""
    if accent is None and hue is None:
        raise SkinError("give --accent, --hue, or all of --bg --surface --text --accent")
    if accent is None:
        accent = hsl(hue, 0.85, 0.60 if dark else 0.42)
    h = hue_of(accent) if hue is None else hue
    if dark:
        return dict(bg=hsl(h, 0.40, 0.06), surface=hsl(h, 0.32, 0.12), text=hsl(h, 0.60, 0.95), accent=accent)
    return dict(bg=hsl(h, 0.25, 0.90), surface=hsl(h, 0.30, 0.96), text=hsl(h, 0.30, 0.14), accent=accent)


def derive(bg, surface, text, accent, radius):
    """Same as SkinJson.derive in skins.dart: the other colours follow the four main ones."""
    dark = luminance(bg) < 0.5
    overlay = (10, 5, 3, _round(0.75 * 255)) if dark else (60, 48, 38, _round(0.35 * 255))
    shadow = (0, 0, 0, _round(0.55 * 255)) if dark else (70, 52, 36, _round(0.22 * 255))
    return dict(
        bg=bg, bgElevated=lerp(bg, surface, 0.5), surface=surface, surfaceFocused=with_alpha(accent, 0x2A),
        border=lerp(bg, text, 0.14), borderFocus=accent, text=text, textMuted=lerp(text, bg, 0.42),
        accent=accent, accentGlow=with_alpha(accent, 0x66), overlay=overlay, shadow=shadow,
        glassStrong=with_alpha(lerp(bg, surface, 0.6), 0xF0), radius=radius, dark=dark)


def tokens_to_json(t):
    """Same shape as SkinJson.tokensTo: what the web UI and the Flutter UI both read."""
    dark = t["dark"]
    return {
        "bg": hex_(t["bg"]), "bgElevated": hex_(t["bgElevated"]), "surface": hex_(t["surface"]),
        "surfaceFocused": hex_(t["surfaceFocused"]), "border": hex_(t["border"]), "borderFocus": hex_(t["borderFocus"]),
        "text": hex_(t["text"]), "textMuted": hex_(t["textMuted"]), "accent": hex_(t["accent"]),
        "accentGlow": rgba(t["accentGlow"]), "radius": "%dpx" % _round(t["radius"]),
        "overlay": rgba(t["overlay"]), "shadow": rgba(t["shadow"]),
        "glass": "rgba(10, 14, 24, 0.45)" if dark else "rgba(255, 255, 255, 0.50)",
        "glassStrong": rgba(t["glassStrong"]),
        "glassFill": "rgba(255, 255, 255, 0.05)" if dark else "rgba(255, 255, 255, 0.55)",
        "glassEdge": "rgba(255, 255, 255, 0.10)" if dark else "rgba(60, 48, 38, 0.14)",
    }


def glow_gradient(accent, bg):
    """A soft radial glow behind the app, like the default Ember look (web only; the Flutter UI ignores bgImage)."""
    a = "%d, %d, %d" % accent[:3]
    b = "%d, %d, %d" % bg[:3]
    return (f"radial-gradient(ellipse at 50% -10%, rgba({a}, 0.30) 0%, rgba({a}, 0.12) 38%, rgba({b}, 0) 72%), "
            f"radial-gradient(ellipse at 50% 115%, rgba({a}, 0.18) 0%, rgba({b}, 0) 60%)")


# ---------------------------------------------------------------- the skin
def slug(text):
    s = re.sub(r"\.zip$", "", str(text or "").lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40]
    return s.rstrip("-")


def build(spec):
    """spec -> (id, {path: bytes}). Raises SkinError with a plain message."""
    name = str(spec.get("name", "")).strip()
    if not name:
        raise SkinError('a skin needs a "name"')
    sid = slug(spec.get("id") or name)
    if not sid or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", sid):
        raise SkinError("could not make an id from the name; pass --id (1-40 lowercase letters, digits, - or _)")
    if sid in RESERVED_IDS:
        raise SkinError('"%s" is the id of a skin that ships with PEK TV; pick another name or --id' % sid)

    def col(key):
        if spec.get(key) is None:
            return None
        c = parse_color(spec[key])
        if c is None:
            raise SkinError("%s is not a colour: %s (use #rrggbb)" % (key, spec[key]))
        return c

    mode = str(spec.get("mode", "dark")).lower()
    if mode not in ("dark", "light"):
        raise SkinError('"mode" is "dark" or "light"')
    main = {k: col(k) for k in ("bg", "surface", "text", "accent")}
    if all(main.values()):
        pal = main
    else:
        auto = auto_palette(main["accent"], spec.get("hue"), mode == "dark")
        pal = {k: main[k] or auto[k] for k in auto}
    radius = float(str(spec.get("radius", 16)).replace("px", "").strip())
    if not 0 <= radius <= 40:
        raise SkinError("radius is 0 to 40")
    t = derive(pal["bg"], pal["surface"], pal["text"], pal["accent"], radius)
    tokens = tokens_to_json(t)

    for k, v in (spec.get("tokens") or {}).items():          # hand-set overrides
        if k == "bgImage":
            tokens[k] = str(v)
        elif k == "radius":
            tokens[k] = str(v) if str(v).endswith("px") else "%spx" % v
        else:
            if parse_color(v) is None:
                raise SkinError("tokens.%s is not a colour: %s" % (k, v))
            tokens[k] = str(v)
            if k in t and k != "radius":
                t[k] = parse_color(v)
    if spec.get("glow") and "bgImage" not in tokens:
        tokens["bgImage"] = glow_gradient(t["accent"], t["bg"])

    bad = [n for n, o in (("the background", t["bg"]), ("the cards", t["surface"]), ("the bars", t["bgElevated"]))
           if contrast(t["text"], o) < 2]
    if bad and not spec.get("force"):
        raise SkinError("the text would be hard to read on %s (contrast under 2). Pick a lighter text or a darker "
                        "background, or pass --force." % ", ".join(bad))

    manifest = {"name": name[:60], "author": str(spec.get("author") or "")[:80] or "PEK TV",
                "version": str(spec.get("version") or "1.0.0")[:20],
                "description": str(spec.get("description") or "")[:200], "pek_api": 1, "tokens": tokens}
    files = {"skin.json": (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")}

    if spec.get("css"):
        raise SkinError(NO_CSS)
    for extra in spec.get("files") or []:                      # extra images / fonts: paths on disk
        files[os.path.basename(extra)] = open(extra, "rb").read()
    check_files(files)
    return sid, files


# ---------------------------------------------------------------- checks (port of backend/skin_install.h)
def check_path(p):
    if not p: return "a file has an empty name"
    if len(p) > MAX_PATH: return "a file path is too long: " + p[:40] + "..."
    if p[0] == "/": return "absolute paths are not allowed: " + p
    depth = 0
    for part in p.split("/"):
        if not part: return "bad path (empty folder name): " + p
        if part in (".", ".."): return "bad path (. or ..): " + p
        if part[0] == ".": return "hidden files are not allowed: " + p
        if len(part) > 64: return "a file or folder name is too long in: " + p
        if part[-1] in ". ": return "bad file name: " + p
        if any(ord(c) < 0x20 or ord(c) == 0x7f or c in '\\:*?"<>|' for c in part): return "bad character in file name: " + p
        depth += 1
        if depth > MAX_DEPTH: return "folders are nested too deeply: " + p
    return ""


def check_files(files):
    """files: {path: bytes}. Raises SkinError with the server's wording."""
    if not files: raise SkinError("the skin has no files")
    if len(files) > MAX_FILES: raise SkinError("too many files (limit %d)" % MAX_FILES)
    seen, total, has_manifest = set(), 0, False
    for path, data in files.items():
        why = check_path(path)
        if why: raise SkinError(why)
        if path.lower() in seen: raise SkinError("the same file appears twice: " + path)
        seen.add(path.lower())
        if len(data) > MAX_FILE_BYTES: raise SkinError(path + " is too large (limit 2 MB per file)")
        total += len(data)
        if total > MAX_TOTAL_BYTES: raise SkinError("the skin is too large (limit 6 MB in total)")
        if path in ("plugin.json", "ui.js", "backend.py"):
            raise SkinError("this is a plugin, not a skin. Install it from Settings -> Plugins.")
        ext = path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
        if ext == "css": raise SkinError(NO_CSS)
        if ext in ("js", "py"): raise SkinError("skins can't contain code: " + path)
        if ext not in ALLOWED_EXT: raise SkinError("file type not allowed in skins: " + path)
        if path == "skin.json":
            has_manifest = True
            if len(data) > MAX_MANIFEST: raise SkinError("skin.json is too large")
            text = data.decode("utf-8", "replace").lstrip("\ufeff").lstrip()
            if not text.startswith("{"): raise SkinError("skin.json is not a JSON object")
            if '"name"' not in text: raise SkinError('skin.json needs a "name"')
            if "url(" in text.lower():
                raise SkinError("skin.json can't use url(). Use a plain gradient for bgImage.")
            try:
                json.loads(text)
            except ValueError:
                raise SkinError("skin.json is not valid JSON")
    if not has_manifest: raise SkinError("skin.json is missing")


def read_skin(path):
    """A .zip or a folder -> (id, files), the way the apps unpack it (one optional top folder, junk skipped)."""
    entries = {}
    if os.path.isdir(path):
        for root, dirs, names in os.walk(path):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for n in names:
                full = os.path.join(root, n)
                entries[os.path.relpath(full, path).replace(os.sep, "/")] = open(full, "rb").read()
        base = os.path.basename(os.path.abspath(path))
    else:
        with zipfile.ZipFile(path) as z:
            for i in z.infolist():
                if not i.is_dir():
                    entries[i.filename.replace("\\", "/")] = z.read(i)
        base = os.path.basename(path)
    entries = {p: d for p, d in entries.items() if not any(s.startswith(".") or s.lower() == "__macosx" for s in p.split("/"))}
    if not entries: raise SkinError("the zip is empty")
    tops = {p.split("/")[0] for p in entries}
    prefix = ""
    if "skin.json" not in entries and len(tops) == 1 and all(p.startswith(next(iter(tops)) + "/") for p in entries) \
            and next(iter(tops)) + "/skin.json" in entries:
        prefix = next(iter(tops)) + "/"
    if prefix + "plugin.json" in entries:
        raise SkinError("this is a plugin, not a skin. Install it from Settings -> Plugins.")
    if prefix + "skin.json" not in entries:
        raise SkinError("skin.json was not found. It must be at the top of the zip, or inside one folder.")
    files = {p[len(prefix):]: d for p, d in entries.items()}
    try:
        name = json.loads(files["skin.json"].decode("utf-8").lstrip("\ufeff")).get("name", "")
    except Exception:
        name = ""
    return slug(prefix.rstrip("/")) or slug(name) or slug(base) or "skin", files


# ---------------------------------------------------------------- packing
def pack(sid, files, out_zip):
    os.makedirs(os.path.dirname(os.path.abspath(out_zip)), exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(files):
            info = zipfile.ZipInfo("%s/%s" % (sid, path), date_time=(2026, 1, 1, 0, 0, 0))   # same bytes every run
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, files[path])


# ---------------------------------------------------------------- command line
def spec_from_args(a):
    spec = {k: getattr(a, k) for k in ("name", "id", "author", "version", "description", "bg", "surface", "text", "accent",
                                       "radius", "hue") if getattr(a, k, None) is not None}
    spec["mode"] = "light" if a.light else "dark"
    spec["glow"], spec["force"] = a.glow, a.force
    spec["files"] = a.file or []
    return spec


def main(argv=None):
    ap = argparse.ArgumentParser(description="Make PEK TV skins from code.", formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("Examples", 1)[1] if "Examples" in __doc__ else "")
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="make one skin")
    n.add_argument("--name", required=True)
    for f in ("id", "author", "version", "description", "bg", "surface", "text", "accent"):
        n.add_argument("--" + f)
    n.add_argument("--radius", type=float, help="corner size in px, 0-40 (default 16)")
    n.add_argument("--hue", type=float, help="0-360; makes the accent and the surfaces when you give nothing else")
    n.add_argument("--light", action="store_true", help="a light skin (default dark) when the colours are worked out")
    n.add_argument("--glow", action="store_true", help="add a soft accent glow behind the app (web UI only)")
    n.add_argument("--force", action="store_true", help="allow low-contrast text")
    n.add_argument("--file", action="append", help="extra image or font to include (repeatable)")
    n.add_argument("--out", default=".", help="folder for the .zip (default: here)")
    n.add_argument("--folder", action="store_true", help="write a skin folder instead of a .zip")
    n.add_argument("--print", action="store_true", help="print skin.json and write nothing")
    b = sub.add_parser("batch", help="make many skins from a JSON list")
    b.add_argument("spec")
    b.add_argument("--out", default="dist")
    v = sub.add_parser("validate", help="check a .zip or skin folder")
    v.add_argument("path")
    a = ap.parse_args(argv)

    try:
        if a.cmd == "validate":
            sid, files = read_skin(a.path)
            check_files(files)
            if sid in RESERVED_IDS: raise SkinError('"%s" is the id of a skin that ships with PEK TV' % sid)
            m = json.loads(files["skin.json"].decode("utf-8").lstrip("\ufeff"))
            print("OK  id=%s  name=%s  files=%d  tokens=%d" % (sid, m.get("name"), len(files), len(m.get("tokens") or {})))
            return 0
        specs = json.load(open(a.spec, encoding="utf-8")) if a.cmd == "batch" else [spec_from_args(a)]
        if isinstance(specs, dict): specs = [specs]
        failed = 0
        for spec in specs:
            try:
                sid, files = build(spec)
            except SkinError as e:
                failed += 1
                print("FAILED %s: %s" % (spec.get("name", "?"), e), file=sys.stderr)
                continue
            if a.cmd == "new" and a.print:
                sys.stdout.write(files["skin.json"].decode("utf-8"))
                continue
            if a.cmd == "new" and a.folder:
                d = os.path.join(a.out, sid)
                os.makedirs(d, exist_ok=True)
                for p, data in files.items():
                    open(os.path.join(d, p), "wb").write(data)
                print("wrote", d)
            else:
                out = os.path.join(a.out, sid + ".zip")
                pack(sid, files, out)
                print("wrote", out)
        return 1 if failed else 0
    except SkinError as e:
        print("error:", e, file=sys.stderr)
        return 1
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        print("error:", e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
