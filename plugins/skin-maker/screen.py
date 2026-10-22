"""Skin Maker for the Flutter UI (PEK's official, bundled plugin).

It used to be a hard-coded screen in the app. Now it is a plugin like any other: this file only *describes* the screen
(pek_ui) and asks PEK TV to save, use or delete a skin. PEK TV draws the colour window, the slider and the live preview,
and checks every skin again before it stores it.

What it keeps from the old maker: the four main colours (accent, background, cards, text) work out the rest, a colour set
by hand is left alone afterwards, text that would be hard to read is refused, starting from any skin or from one accent
colour or hue, and copy / paste of a skin.json (the same file the web build installs from a .zip).
"""
import json
import math
import time

import pek_ui as ui

# (key, label, hint)
MAIN = [
    ("accent", "Accent", "Buttons, the focus ring and highlights"),
    ("bg", "Background", "Behind everything"),
    ("surface", "Cards and rows", "Posters, list rows, buttons"),
    ("text", "Text", "Titles and body text"),
]
# (key, label, hint, see-through)
MORE = [
    ("bgElevated", "Bars and sidebar", "The menu strip and bottom bar", False),
    ("surfaceFocused", "Highlight", "The row or tile that is selected", True),
    ("border", "Lines", "Thin outlines and dividers", True),
    ("borderFocus", "Focus ring", "The outline around the selected item", False),
    ("textMuted", "Muted text", "Small print and descriptions", False),
    ("accentGlow", "Accent glow", "Soft light around the accent", True),
    ("overlay", "Dim behind dialogs", "The veil over the page when a window is open", True),
    ("shadow", "Shadow", "Under cards and windows", True),
    ("glassStrong", "Windows and panels", "Dialogs and the music browse panel", True),
]
MAIN_KEYS = [m[0] for m in MAIN]
COLOR_KEYS = ["bg", "bgElevated", "surface", "surfaceFocused", "border", "borderFocus", "text", "textMuted", "accent",
              "accentGlow", "overlay", "shadow", "glassStrong"]

S = {
    "view": "list",        # list | edit | paste | accent
    "id": "",              # id of the skin being edited ("" = a new one)
    "name": "My skin",
    "desc": "",
    "t": {},               # the draft: colour keys -> "#rrggbb" / "#rrggbbaa"
    "radius": 16,
    "touched": [],         # colours set by hand: a main colour no longer rewrites them
    "more": False,
    "dirty": False,
    "confirm": "",         # id of a skin waiting for "Delete?"
    "paste": "",
    "paste_error": "",
    "accent_text": "#38bdf8",
    "light": False,
}


# ---------------------------------------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------------------------------------

def _parse(text):
    """'#rgb', '#rrggbb', '#rrggbbaa' (CSS order) or 'rgb(a)(r, g, b, a)' -> (r, g, b, a 0-255), or None."""
    t = str(text or "").strip().lower()
    if t.startswith("#"):
        d = t[1:]
        if len(d) == 3:
            d = "".join(c + c for c in d)
        if len(d) not in (6, 8) or any(c not in "0123456789abcdef" for c in d):
            return None
        v = [int(d[i:i + 2], 16) for i in range(0, len(d), 2)]
        return (v[0], v[1], v[2], v[3] if len(v) == 4 else 255)
    if t.startswith("rgb") and t.endswith(")") and "(" in t:
        parts = [p.strip() for p in t[t.index("(") + 1:-1].split(",")]
        if len(parts) not in (3, 4):
            return None
        try:
            rgb = [max(0, min(255, int(float(p)))) for p in parts[:3]]
            a = float(parts[3]) if len(parts) == 4 else 1.0
        except ValueError:
            return None
        return (rgb[0], rgb[1], rgb[2], int(round(max(0.0, min(1.0, a)) * 255)))
    return None


def _hex(c, alpha=False):
    base = "#%02x%02x%02x" % (c[0], c[1], c[2])
    return base + ("%02x" % c[3]) if (alpha or c[3] != 255) else base


def _lin(v):
    v = v / 255.0
    return v / 12.92 if v <= 0.03928 else math.pow((v + 0.055) / 1.055, 2.4)


def _lum(c):
    return 0.2126 * _lin(c[0]) + 0.7152 * _lin(c[1]) + 0.0722 * _lin(c[2])


def _contrast(a, b):
    la, lb = _lum(a), _lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def _lerp(a, b, k):
    return tuple(int(round(a[i] + (b[i] - a[i]) * k)) for i in range(4))


def _alpha(c, a):
    return (c[0], c[1], c[2], a)


def _unreadable(t):
    """The web theme's guard: text must keep a contrast of 2 on the background, the cards and the bars."""
    text, bg, surface, bar = _parse(t["text"]), _parse(t["bg"]), _parse(t["surface"]), _parse(t["bgElevated"])
    return _contrast(text, bg) < 2 or _contrast(text, surface) < 2 or _contrast(text, bar) < 2


def _derive(bg, surface, text, accent):
    """The colours a skin needs besides its four main ones, worked out from them (same rules as the app's own skins)."""
    dark = _lum(bg) < 0.5
    overlay = (10, 5, 3, 191) if dark else (60, 48, 38, 89)
    shadow = (0, 0, 0, 140) if dark else (70, 52, 36, 56)
    return {
        "bg": _hex(bg),
        "bgElevated": _hex(_lerp(bg, surface, 0.5)),
        "surface": _hex(surface),
        "surfaceFocused": _hex(_alpha(accent, 0x2A)),
        "border": _hex(_lerp(bg, text, 0.14)),
        "borderFocus": _hex(accent),
        "text": _hex(text),
        "textMuted": _hex(_lerp(text, bg, 0.42)),
        "accent": _hex(accent),
        "accentGlow": _hex(_alpha(accent, 0x66)),
        "overlay": _hex(overlay, True),
        "shadow": _hex(shadow, True),
        "glassStrong": _hex(_alpha(_lerp(bg, surface, 0.6), 0xF0)),
    }


def _hsl(hue, s, l):
    hue = (hue % 360) / 360.0
    if s == 0:
        v = int(round(l * 255))
        return (v, v, v, 255)
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q

    def chan(t):
        t = t % 1.0
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p

    return (int(round(chan(hue + 1 / 3) * 255)), int(round(chan(hue) * 255)), int(round(chan(hue - 1 / 3) * 255)), 255)


def _hue_of(c):
    r, g, b = c[0] / 255.0, c[1] / 255.0, c[2] / 255.0
    hi, lo = max(r, g, b), min(r, g, b)
    if hi == lo:
        return 0.0
    d = hi - lo
    if hi == r:
        h6 = ((g - b) / d) % 6
    elif hi == g:
        h6 = (b - r) / d + 2
    else:
        h6 = (r - g) / d + 4
    return h6 * 60.0


def _from_accent(accent, hue, dark):
    """One accent (or just a hue) is enough: the background, cards and text follow its hue."""
    if accent is None:
        accent = _hsl(hue, 0.85, 0.60 if dark else 0.42)
    bg = _hsl(hue, 0.40, 0.06) if dark else _hsl(hue, 0.25, 0.90)
    surface = _hsl(hue, 0.32, 0.12) if dark else _hsl(hue, 0.30, 0.96)
    text = _hsl(hue, 0.60, 0.95) if dark else _hsl(hue, 0.30, 0.14)
    return _derive(bg, surface, text, accent)


# ---------------------------------------------------------------------------------------------------------
# The draft
# ---------------------------------------------------------------------------------------------------------

def _tokens_with_radius():
    t = dict(S["t"])
    t["radius"] = "%dpx" % int(S["radius"])
    return t


def _radius_of(tokens):
    try:
        return max(0, min(40, int(round(float(str(tokens.get("radius", "16")).replace("px", "").strip())))))
    except ValueError:
        return 16


def _load(skin, keep_id, name=None):
    t = skin.get("tokens") or {}
    S["t"] = {k: t[k] for k in COLOR_KEYS if k in t}
    for k in COLOR_KEYS:                       # a draft always has every colour
        if k not in S["t"]:
            S["t"][k] = "#000000"
    S["radius"] = _radius_of(t)
    S["id"] = skin["id"] if keep_id else ""
    S["name"] = name if name is not None else (skin["name"] if keep_id else skin["name"] + " copy")
    S["desc"] = skin.get("description", "") if (keep_id or skin.get("custom")) else ""
    S["touched"] = [m[0] for m in MORE]        # every colour is already chosen: the main colours must not rewrite them
    S["dirty"] = False
    S["view"] = "edit"
    S["more"] = False


def _new():
    cur = None
    for s in ui.skins():
        if s["current"]:
            cur = s
    if cur is None:
        for s in ui.skins():
            cur = s
            break
    S["name"], S["desc"], S["id"], S["touched"], S["dirty"], S["more"] = "My skin", "", "", [], False, False
    if cur is not None:
        S["t"] = {k: cur["tokens"].get(k, "#000000") for k in COLOR_KEYS}
        S["radius"] = _radius_of(cur["tokens"])
    S["view"] = "edit"


def _start_from(skin):
    S["t"] = {k: skin["tokens"].get(k, "#000000") for k in COLOR_KEYS}
    S["radius"] = _radius_of(skin["tokens"])
    S["touched"] = []
    S["dirty"] = True


def _set_color(key, value):
    c = _parse(value)
    if c is None:
        ui.toast("That is not a colour.")
        return
    new = dict(S["t"])
    new[key] = _hex(c)
    if key in MAIN_KEYS:
        d = _derive(_parse(new["bg"]), _parse(new["surface"]), _parse(new["text"]), _parse(new["accent"]))
        for m in MORE:
            if m[0] not in S["touched"]:
                new[m[0]] = d[m[0]]
    if _unreadable(new):
        ui.toast("The text would be hard to read on that. Pick a colour with more difference.")
        return
    S["t"] = new
    if key not in MAIN_KEYS and key not in S["touched"]:
        S["touched"] = S["touched"] + [key]
    S["dirty"] = True


def _set_radius(v):
    S["radius"] = max(0, min(32, int(v)))
    S["dirty"] = True


def _set_name(v):
    S["name"] = v
    S["dirty"] = True


def _set_desc(v):
    S["desc"] = v
    S["dirty"] = True


def _accent_go():
    c = _parse(S["accent_text"] if S["accent_text"].startswith("#") else "#" + S["accent_text"])
    if c is None:
        ui.toast("Type a colour like #38bdf8.")
        return
    d = _from_accent(c, _hue_of(c), not S["light"])
    if _unreadable(d):
        ui.toast("That accent gives text that is hard to read. Try another.")
        return
    S["t"] = d
    S["touched"] = []
    S["dirty"] = True
    S["view"] = "edit"


def _hue_go(hue):
    d = _from_accent(None, float(hue), not S["light"])
    S["t"] = d
    S["touched"] = []
    S["dirty"] = True
    S["view"] = "edit"


# ---------------------------------------------------------------------------------------------------------
# skin.json
# ---------------------------------------------------------------------------------------------------------

def _json_text(name, desc, author, tokens):
    dark = _lum(_parse(tokens["bg"])) < 0.5

    def rgba(hx):
        c = _parse(hx)
        return "rgba(%d, %d, %d, %.2f)" % (c[0], c[1], c[2], c[3] / 255.0)

    out = {}
    for k in COLOR_KEYS:
        out[k] = rgba(tokens[k]) if k in ("accentGlow", "overlay", "shadow", "glassStrong") else tokens[k][:7]
    out["radius"] = tokens["radius"]
    out["glass"] = "rgba(10, 14, 24, 0.45)" if dark else "rgba(255, 255, 255, 0.50)"
    out["glassFill"] = "rgba(255, 255, 255, 0.05)" if dark else "rgba(255, 255, 255, 0.55)"
    out["glassEdge"] = "rgba(255, 255, 255, 0.10)" if dark else "rgba(60, 48, 38, 0.14)"
    return json.dumps({"name": name, "author": author or "PEK TV", "version": "1.0.0", "description": desc, "pek_api": 1,
                       "tokens": out}, indent=2)


def _import():
    """Pasted skin.json text -> the draft. Only the name, description and colours are used (skin.css is web-only)."""
    try:
        j = json.loads(S["paste"])
    except ValueError:
        j = None
    toks = j.get("tokens") if isinstance(j, dict) else None
    if not isinstance(toks, dict):
        S["paste_error"] = "That is not a skin.json with colours in it."
        return
    got = {}
    for k in COLOR_KEYS:
        c = _parse(toks.get(k)) if isinstance(toks.get(k), str) else None
        if c is not None:
            got[k] = _hex(c)
    if not got and toks.get("radius") is None:
        S["paste_error"] = "That is not a skin.json with colours in it."
        return
    bg = _parse(got.get("bg", "#130a06"))
    base = None
    for s in ui.skins():
        if s["id"] == ("ember" if _lum(bg) < 0.5 else "light"):
            base = s
    t = {k: (base["tokens"].get(k, "#000000") if base else "#000000") for k in COLOR_KEYS}
    t.update(got)
    S["t"] = t
    S["radius"] = _radius_of(toks)
    name = str(j.get("name") or "").strip()
    S["name"] = name or "Imported skin"
    S["desc"] = str(j.get("description") or "")
    S["id"] = ""
    S["touched"] = [m[0] for m in MORE]
    S["dirty"] = True
    S["paste_error"] = ""
    S["paste"] = ""
    S["view"] = "edit"
    if _unreadable(S["t"]):
        ui.toast("Heads up: the text is hard to read on these colours. Saving is refused until you change them.")


# ---------------------------------------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------------------------------------

def _refresh_later():
    """PEK TV applies a save / delete after this call returns; look at the skins again a moment later."""
    def work():
        time.sleep(0.8)
        return True

    ui.background(work, lambda r: None, lambda m: None)


def _save(use):
    t = _tokens_with_radius()
    if _unreadable(S["t"]):
        ui.toast("The text would be hard to read on these colours.")
        return
    name = S["name"].strip() or "My skin"
    ui.skin_save(S["id"] if S["id"].startswith("custom-") else "", name, S["desc"].strip(), t, use=use)
    S["view"] = "list"
    S["dirty"] = False
    _refresh_later()


def _copy_draft():
    ui.copy_skin_json(_json_text(S["name"].strip() or "My skin", S["desc"].strip(), "", _tokens_with_radius()))


def _copy_skin(skin):
    t = dict(skin["tokens"])
    ui.copy_skin_json(_json_text(skin["name"], skin["description"], skin["author"], {**{k: "#000000" for k in COLOR_KEYS}, **t}))


def _use(skin):
    ui.skin_use(skin["id"])
    _refresh_later()


def _delete(skin):
    ui.skin_delete(skin["id"])
    S["confirm"] = ""
    _refresh_later()


def _go(view):
    S["view"] = view
    S["confirm"] = ""
    S["paste_error"] = ""
    ui.scroll_top()


def _leave_edit():
    S["view"] = "list"
    S["dirty"] = False
    ui.scroll_top()


# ---------------------------------------------------------------------------------------------------------
# Screens
# ---------------------------------------------------------------------------------------------------------

def _list_view():
    skins = ui.skins()
    mine = [s for s in skins if s["custom"]]
    rows = [
        ui.heading("Skin maker"),
        ui.text("Make your own look for PEK TV. A skin you make shows up in Settings > Appearance next to the built-in ones, "
                "and every profile can pick it."),
        ui.row(
            ui.button("New skin", _new, primary=True, autofocus="new"),
            ui.button("From one accent colour", lambda: _go("accent")),
            ui.button("Paste skin.json", lambda: _go("paste")),
        ),
        ui.heading("Your skins"),
    ]
    if not mine:
        rows.append(ui.text("You have not made a skin yet."))
    for s in mine:
        rows.append(ui.list_row(s["name"] + ("  (in use)" if s["current"] else ""), s["description"] or "Made by you",
                                lambda s=s: _load(s, True)))
        if S["confirm"] == s["id"]:
            rows.append(ui.row(ui.text("Delete \u201c%s\u201d? Profiles that use it go back to PEK Ember." % s["name"]),
                               ui.button("Delete", lambda s=s: _delete(s), primary=True),
                               ui.button("Cancel", lambda: S.update({"confirm": ""}), autofocus="cancel")))
        else:
            rows.append(ui.row(
                ui.button("Use", lambda s=s: _use(s), selected=s["current"]),
                ui.button("Edit", lambda s=s: _load(s, True)),
                ui.button("Copy skin.json", lambda s=s: _copy_skin(s)),
                ui.button("Delete", lambda s=s: S.update({"confirm": s["id"]})),
            ))
    rows.append(ui.heading("Start from any skin"))
    rows.append(ui.text("Opens a copy in the maker. The original is never changed."))
    rows.append(ui.row([ui.button(s["name"], lambda s=s: _load(s, False)) for s in skins]))
    ui.set_back(None)
    return ui.column(rows)


def _edit_view():
    t = S["t"]
    tok = _tokens_with_radius()
    skins = ui.skins()
    rows = [
        ui.heading("Edit skin" if S["id"] else "Skin maker"),
        ui.skin_preview(tok),
        ui.heading("Start from"),
        ui.text("Load a look, then change what you like."),
        ui.row([ui.button(s["name"], lambda s=s: _start_from(s)) for s in skins]),
        ui.heading("Name"),
        ui.text_input("Skin name", S["name"], _set_name, key="skin-name"),
        ui.text_input("Description (optional)", S["desc"], _set_desc, key="skin-desc"),
        ui.heading("Colours"),
        ui.text("Tap a colour to change it. The other colours follow.")
    ]
    for key, label, hint in MAIN:
        rows.append(ui.color_row(label, hint, t[key], lambda v, key=key: _set_color(key, v)))
    rows.append(ui.heading("Corners"))
    rows.append(ui.slider("Corner size", S["radius"], 0, 32, _set_radius, unit=" px"))
    rows.append(ui.toggle("More colours (lines, focus ring, muted text, dialogs and the rest)", S["more"],
                          lambda v: S.update({"more": bool(v)})))
    if S["more"]:
        for key, label, hint, alpha in MORE:
            rows.append(ui.color_row(label, hint, t[key], lambda v, key=key: _set_color(key, v), alpha=alpha))
    rows.append(ui.row(
        ui.button("Save and use", lambda: _save(True), primary=True),
        ui.button("Save", lambda: _save(False)),
        ui.button("Copy skin.json", _copy_draft),
    ))
    ui.set_back(_leave_edit)
    return ui.column(rows)


def _paste_view():
    ui.set_back(lambda: _go("list"))
    rows = [
        ui.heading("Paste a skin.json"),
        ui.text("Only the name, description and colours are used. A skin\u2019s own styling (skin.css) only works in the web build."),
        ui.text_input("skin.json", S["paste"], lambda v: S.update({"paste": v}), placeholder='{ "name": "My skin", "tokens": { ... } }',
                      key="skin-paste", on_submit=lambda v: (S.update({"paste": v}), _import())),
    ]
    if S["paste_error"]:
        rows.append(ui.text(S["paste_error"]))
    rows.append(ui.row(ui.button("Import", _import, primary=True), ui.button("Cancel", lambda: _go("list"))))
    return ui.column(rows)


def _accent_view():
    ui.set_back(lambda: _go("list"))
    hues = [("Red", 0), ("Orange", 25), ("Yellow", 50), ("Green", 140), ("Teal", 175), ("Blue", 210), ("Purple", 270), ("Pink", 320)]
    return ui.column(
        ui.heading("From one accent colour"),
        ui.text("Give one accent colour (or pick a hue) and the background, cards and text follow it."),
        ui.tabs([("dark", "Dark"), ("light", "Light")], "light" if S["light"] else "dark", lambda v: S.update({"light": v == "light"})),
        ui.text_input("Accent colour", S["accent_text"], lambda v: S.update({"accent_text": v}), placeholder="#38bdf8",
                      key="skin-accent", on_submit=lambda v: (S.update({"accent_text": v}), _accent_go())),
        ui.row(ui.button("Make the skin", _accent_go, primary=True), ui.button("Cancel", lambda: _go("list"))),
        ui.text("Or pick a hue:"),
        ui.row([ui.button(label, lambda hue=hue: _hue_go(hue)) for label, hue in hues]),
    )


def render():
    v = S["view"]
    if v == "edit":
        return _edit_view()
    if v == "paste":
        return _paste_view()
    if v == "accent":
        return _accent_view()
    return _list_view()


def on_launch(intent):
    """The app opened the maker on a skin: mode 'edit' (change one made earlier), 'from' (a copy of any skin), or 'paste'."""
    mode = str(intent.get("mode") or "")
    if mode == "paste":
        S["view"] = "paste"
        return
    for s in ui.skins():
        if s["id"] == intent.get("id"):
            if mode == "edit" and s["custom"]:
                _load(s, True)
            else:
                _load(s, False)
            return
