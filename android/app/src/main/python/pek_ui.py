"""pek_ui: the UI toolkit for a plugin's Python screen (screen.py), drawn by the Flutter UI.

A plugin imports it like this:

    import pek_ui as ui
    import pek_host as h

and defines these functions in screen.py (all optional except render):

    def start():            # runs once when the screen is first opened
    def render():           # returns a tree built with ui.column(...), like pek.render(ui => tree)
    def on_launch(intent):  # PEK TV opened the plugin on a title: {"type", "id", "title", "year"}

Like the JS closures, the callbacks you pass to ui.button(...) etc. are plain Python functions. After a tap PEK
runs the function and calls render() again. Work that has to wait for the network goes through ui.background(),
which is the Python version of "start a fetch, then call pek.requestRender() when it lands".

This module is host code (trusted). A plugin only gets the names below, and every name that reaches outside the
plugin (favorites, links) is checked against plugin.json here, not in the plugin.
"""
import re
import threading
import urllib.parse

import pek_providers

# The session the current call belongs to. pek_flutter sets it for every call into plugin code.
_tl = threading.local()

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_REGION = re.compile(r"^[A-Za-z]{2}$")
YOUTUBE_HOST = "www.youtube-nocookie.com"


def _sess():
    s = getattr(_tl, "session", None)
    if s is None:
        raise RuntimeError("pek_ui can only be used while a screen is drawing or handling a tap")
    return s


def _kids(items):
    """Flattens lists and drops None / False, so `ui.column(a, None, [b, c])` works."""
    out = []
    for k in items:
        if k is None or k is False:
            continue
        if isinstance(k, (list, tuple)):
            out.extend(_kids(k))
        else:
            out.append(k)
    return out


def _s(v, limit=2000):
    return str(v if v is not None else "")[:limit]


# ---------------------------------------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------------------------------------

def column(*kids):
    return {"t": "column", "c": _kids(kids)}


def row(*kids):
    """Items side by side; they wrap onto the next line when the screen is too narrow."""
    return {"t": "row", "c": _kids(kids)}


def grid(kids, min_col=150, scroll=False):
    """Responsive poster grid. scroll=True makes one sideways-scrolling row."""
    return {"t": "grid", "c": _kids([kids]), "min": int(min_col), "scroll": bool(scroll)}


def text(s):
    return {"t": "text", "s": _s(s, 4000)}


def heading(s):
    return {"t": "heading", "s": _s(s, 300)}


def spinner(label="", big=False):
    return {"t": "spinner", "s": _s(label, 200), "big": bool(big)}


# ---------------------------------------------------------------------------------------------------------
# Things you can press
# ---------------------------------------------------------------------------------------------------------

def button(label, on=None, primary=False, selected=False, autofocus=""):
    return {"t": "button", "s": _s(label, 200), "primary": bool(primary), "sel": bool(selected),
            "af": _s(autofocus, 100), "on": _sess().register(on, 0)}


def card(title, sub="", on=None, autofocus=""):
    return {"t": "card", "s": _s(title, 200), "sub": _s(sub, 300), "af": _s(autofocus, 100),
            "on": _sess().register(on, 0)}


def list_row(title, sub="", on=None, autofocus=""):
    return {"t": "listrow", "s": _s(title, 200), "sub": _s(sub, 500), "af": _s(autofocus, 100),
            "on": _sess().register(on, 0)}


def poster_card(title, sub="", poster="", on=None, badge="", autofocus="", year=0, kind="movie"):
    """A poster tile. The picture only loads from a host listed under permissions.network in plugin.json.

    Watched marks need nothing from the plugin: PEK TV puts a tick on a movie poster that is in Watch History and lets the
    person press and hold it to mark / un-mark it. Pass year= (and kind="show" for TV so it is never ticked as a movie)
    for an exact match; without a year PEK TV looks for one in the title or the sub line, then (Settings > Plugin posters)
    matches by title alone. No "watched" permission is needed, and the plugin is never told the answer."""
    try:
        yr = int(year or 0)
    except (TypeError, ValueError):
        yr = 0
    return {"t": "poster", "s": _s(title, 200), "sub": _s(sub, 300), "img": _s(poster, 600),
            "badge": _s(badge, 40), "af": _s(autofocus, 100), "yr": yr if 1880 <= yr <= 2200 else 0,
            "k": "movie" if kind == "movie" else "other", "on": _sess().register(on, 0)}


def episode_row(title, meta="", text="", image="", dim=False, on=None, autofocus=""):
    """One episode: its picture on the left, then the title, a line of facts and a short description. The Python twin of
    ui.episodeRow in the web UI. dim=True greys it out (not aired yet). The picture only loads from a host listed under
    permissions.network (TMDb stills come from image.tmdb.org)."""
    return {"t": "episode", "s": _s(title, 200), "meta": _s(meta, 200), "text": _s(text, 600), "img": _s(image, 600),
            "dim": bool(dim), "af": _s(autofocus, 100), "on": _sess().register(on, 0)}


def tabs(items, active, on):
    """items: [(id, label), ...] or [{"id", "label"}, ...]. on(id) runs when one is chosen."""
    out = []
    for it in items:
        if isinstance(it, dict):
            out.append({"id": _s(it.get("id"), 60), "label": _s(it.get("label"), 80)})
        else:
            out.append({"id": _s(it[0], 60), "label": _s(it[1], 80)})
    return {"t": "tabs", "items": out, "active": _s(active, 60), "on": _sess().register(on, 1)}


def text_input(label, value="", on_change=None, placeholder="", secret=False, on_submit=None, key=""):
    """A text box. on_change(text) runs before the next tap's own callback (not on every keystroke);
    on_submit(text) runs when the person presses Enter / Search on the keyboard."""
    k = _s(key, 80) or (_s(label, 60) + "|" + _s(placeholder, 60))
    s = _sess()
    s.register_input(k, value, on_change)
    return {"t": "input", "s": _s(label, 120), "value": _s(value, 2000), "ph": _s(placeholder, 120),
            "secret": bool(secret), "key": k, "submit": s.register(on_submit, 1)}


def toggle(label, checked, on):
    """On/off switch. on(True or False)."""
    return {"t": "toggle", "s": _s(label, 200), "on_": bool(checked), "on": _sess().register(on, 1)}


def provider_button(name, logo="", title="", kind="movie", tmdb_id=0, region="US"):
    """A "Watch on <service>" button. Needs "providers": true in plugin.json. A service PEK knows opens its Android
    app (on the title's page when the app supports it, else the app, else its website); any other service opens the
    title's TMDb "where to watch" page. The plugin never supplies an address or an app name: PEK builds both."""
    s = _sess()
    s.need("providers")
    plan = _provider_plan(name, title, kind, tmdb_id, region)

    def go():
        if plan["pkgs"]:
            s.effect("open_app", packages=",".join(plan["pkgs"]), url=plan["url"])
        elif plan["url"]:
            s.effect("open_url", url=plan["url"])

    return {"t": "provider", "s": _s(name, 80), "logo": _s(logo, 600), "on": s.register(go, 0)}


def _norm_service(name):
    t = str(name or "").lower().replace("+", " plus ").replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def _provider_plan(name, title, kind, tmdb_id, region):
    """What one press opens (see tools/providers.json)."""
    title = _s(title, 200)
    n = _norm_service(name)
    for pattern, _display, pkgs, home, search in pek_providers.TABLE:
        if re.match(pattern, n):
            url = search.replace("{q}", urllib.parse.quote(title, safe="")) if (search and title) else home
            return {"pkgs": list(pkgs), "url": url}
    try:
        url = _watch_url(kind, tmdb_id, region)
    except ValueError:
        url = "https://www.themoviedb.org/"
    return {"pkgs": [], "url": url}


def _watch_url(kind, tmdb_id, region):
    if kind not in ("movie", "tv"):
        raise ValueError("kind must be movie or tv")
    n = int(tmdb_id)
    if n <= 0:
        raise ValueError("bad id")
    r = str(region or "US")
    if not _REGION.match(r):
        r = "US"
    return "https://www.themoviedb.org/%s/%d/watch?locale=%s" % (kind, n, r.upper())


# ---------------------------------------------------------------------------------------------------------
# Talking to PEK TV (the `pek.*` calls of the web sandbox)
# ---------------------------------------------------------------------------------------------------------

def ctx():
    """What PEK TV tells the screen on every call: {"lang": "en-US", "region": "US", "tv": bool,
    "favorites": ["movie:603", ...], "streamers": [...], "watched": [...]}. A fresh dict each call; changing it does
    nothing. Prefer streamers() / is_watched(), which also check the plugin's permissions."""
    d = dict(_sess().ctx)
    d.pop("skins", None)          # only skins() hands these out, and it needs the official "skins" permission
    return d


def background(work, done, fail=None):
    """Runs work() on another thread (so it may wait for the network), then done(result) back on the screen's
    own thread, and the screen is drawn again. fail(message) runs if work() raised. This is the Python version
    of fetch(...).then(done, fail).then(requestRender)."""
    _sess().background(work, done, fail)


def set_back(fn):
    """Make Back call fn() first (step out of your own screens). Pass None when there is nothing to step out of;
    Back then closes the plugin. Call it from render(), like pek.setBack in the web UI."""
    _sess().set_back(fn)


def scroll_top():
    """Scroll the plugin screen back to the top (after changing page, say)."""
    _sess().scroll_top()


def favorite_add(kind, tmdb_id, title, year=0, poster_path=""):
    """Add a title to PEK TV's Favorites. Needs "favorites": true. kind is 'movie' or 'tv'."""
    s = _sess()
    s.need("favorites")
    if kind not in ("movie", "tv"):
        raise ValueError("kind must be movie or tv")
    s.effect("favorite.add", type=kind, id=int(tmdb_id), title=_s(title, 200), year=int(year or 0),
             posterPath=_s(poster_path, 200))


def favorite_remove(key):
    """Remove 'movie:603' / 'tv:1396' from Favorites. Needs "favorites": true."""
    s = _sess()
    s.need("favorites")
    k = _s(key, 40)
    if not re.match(r"^(movie|tv):\d+$", k):
        raise ValueError("favorite keys look like movie:603")
    s.effect("favorite.remove", key=k)


def open_trailer(video_id):
    """Open a YouTube trailer (11-character video id). Needs www.youtube-nocookie.com under permissions.network,
    the same rule as ui.video in the web UI. It opens in the YouTube app or the browser."""
    s = _sess()
    if not s.host_listed(YOUTUBE_HOST):
        raise PermissionError("plugin.json does not list %s under permissions.network" % YOUTUBE_HOST)
    v = _s(video_id, 40)
    if not _VIDEO_ID.match(v):
        raise ValueError("a YouTube video id is 11 letters, digits, - or _")
    s.effect("open_url", url="https://www.youtube.com/watch?v=" + urllib.parse.quote(v, safe=""))


def video(video_id, autoplay=True, muted=False, title=""):
    """An inline YouTube trailer (11-character video id), pinned to the top of the screen and not restarted when the
    screen is redrawn. One per screen. Needs www.youtube-nocookie.com under permissions.network, like ui.video in the
    web UI. Plays in a locked-down web view that can only show that host."""
    s = _sess()
    if not s.host_listed(YOUTUBE_HOST):
        raise PermissionError("plugin.json does not list %s under permissions.network" % YOUTUBE_HOST)
    v = _s(video_id, 40)
    if not _VIDEO_ID.match(v):
        raise ValueError("a YouTube video id is 11 letters, digits, - or _")
    return {"t": "video", "id": v, "autoplay": bool(autoplay), "muted": bool(muted), "s": _s(title, 200)}


def streamers():
    """The other installed plugins that can play a title: [{"id", "name"}] (their plugin.json has
    "provides": {"stream": true} and a Flutter screen). Needs "plugins": true."""
    s = _sess()
    s.need("plugins")
    out = []
    for e in s.ctx.get("streamers") or []:
        if isinstance(e, dict) and e.get("id") and e.get("id") != s.id:
            out.append({"id": _s(e.get("id"), 40), "name": _s(e.get("name") or e.get("id"), 80)})
    return out


def open_plugin(plugin_id, kind, tmdb_id, title="", year=0):
    """Open another plugin (one from streamers()) on a title. Needs "plugins": true. Call it from a tap handler."""
    s = _sess()
    s.need("plugins")
    if kind not in ("movie", "tv"):
        raise ValueError("kind must be movie or tv")
    known = [e["id"] for e in streamers()]
    if plugin_id not in known:
        raise PermissionError("%r is not an installed plugin that can play titles" % plugin_id)
    s.effect("open_plugin", id=_s(plugin_id, 40), intent={"type": kind, "id": int(tmdb_id), "title": _s(title, 200),
                                                       "year": int(year or 0)})


def play_torrent(source, label, season=0, episode=0, kind="movie", name="", year=0, image=""):
    """Start a stream in PEK's own player (loading box, buffering, Resume Watching). Needs "torrent": true.
    source is a magnet link, or an https .torrent link on a host listed under permissions.network. PEK shows the
    loading screen itself, so the plugin never touches the download. kind is 'movie' or 'episode'."""
    s = _sess()
    s.need("torrent")
    src = _s(source, 8000).strip()
    low = src.lower()
    if low.startswith("magnet:?xt=urn:btih:"):
        pass
    elif low.startswith("https://"):
        host = urllib.parse.urlsplit(src).hostname or ""
        if not s.host_listed(host):
            raise PermissionError("plugin.json does not list %s under permissions.network" % host)
    else:
        raise ValueError("a release link is a magnet link or an https link")
    if kind not in ("movie", "episode"):
        raise ValueError("kind must be movie or episode")
    s.effect("torrent.play", source=src, title=_s(label, 200), season=int(season or 0), episode=int(episode or 0),
             kind=kind, name=_s(name, 200), year=int(year or 0), image=_s(image, 200))


_WATCHED_MAX = 300      # items per is_watched_many() / set_watched_many() call (the web pek.watched.check limit)


def _norm(v):
    return " ".join(str(v or "").lower().split())


def _watched_key(kind, title, year=0, season=0, episode=0):
    # The same text as Store.keyFor in the Flutter app (and histKey() in sync.js), so history and the cloud agree:
    #   movie    m|title|year
    #   episode  e|show title|season|episode      (for an episode, "title" is the SHOW's title)
    t = _norm(title)
    if not t:
        raise ValueError("a movie or show title is needed")
    if kind == "movie":
        return "m|%s|%d" % (t, int(year or 0))
    if kind == "episode":
        return "e|%s|%d|%d" % (t, int(season or 0), int(episode or 0))
    raise ValueError("kind must be 'movie' or 'episode'")


def is_watched(kind, title, year=0, season=0, episode=0):
    """Is this movie / episode in PEK TV's Watch History? Needs "watched": true.
    Movie: is_watched("movie", title, year). Episode: is_watched("episode", show_title, season=1, episode=3)."""
    s = _sess()
    s.need("watched")
    try:
        key = _watched_key(kind, title, year, season, episode)
    except ValueError:
        return False
    return key in (s.ctx.get("watched") or [])


def is_watched_many(items):
    """is_watched() for a list of {"kind", "title", "year", "season", "episode"} dicts (max 300): returns [True, False, ...],
    one per item (the web pek.watched.check). Needs "watched": true."""
    s = _sess()
    s.need("watched")
    have = set(s.ctx.get("watched") or [])
    out = []
    for it in list(items or [])[:_WATCHED_MAX]:
        try:
            key = _watched_key(it.get("kind"), it.get("title"), it.get("year", 0), it.get("season", 0), it.get("episode", 0))
        except (ValueError, AttributeError):
            out.append(False)
            continue
        out.append(key in have)
    return out


def set_watched(kind, title, year=0, value=True, season=0, episode=0):
    """Mark a movie / episode watched / unwatched in PEK TV's Watch History (the history the person sees; it syncs to PEK
    Cloud). Needs "watched": true. For an episode, "title" is the show's title and season / episode are the numbers.
    The screen's own is_watched() answers with the new value on the next call."""
    s = _sess()
    s.need("watched")
    _watched_key(kind, title, year, season, episode)       # validates
    s.effect("watched.set", kind=kind, title=_s(title, 200), year=int(year or 0), season=int(season or 0),
             episode=int(episode or 0), value=bool(value))


def set_watched_many(items, value=True):
    """set_watched() for a whole season or list in one go: items are {"kind", "title", "year", "season", "episode"} dicts
    (max 300, anything invalid is skipped). Needs "watched": true."""
    s = _sess()
    s.need("watched")
    clean = []
    for it in list(items or [])[:_WATCHED_MAX]:
        try:
            _watched_key(it.get("kind"), it.get("title"), it.get("year", 0), it.get("season", 0), it.get("episode", 0))
        except (ValueError, AttributeError):
            continue
        clean.append({"kind": it.get("kind"), "title": _s(it.get("title"), 200), "year": int(it.get("year") or 0),
                      "season": int(it.get("season") or 0), "episode": int(it.get("episode") or 0)})
    if clean:
        s.effect("watched.set_many", items=clean, value=bool(value))


# ---------------------------------------------------------------------------------------------------------
# Skins (the official Skin maker only: plugin.json "skins": true, refused for any other plugin)
# ---------------------------------------------------------------------------------------------------------

_HEX = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
_SKIN_ID = re.compile(r"^(custom|pkg)-[a-z0-9_-]{1,60}$")
_SKIN_TOKENS = ("bg", "bgElevated", "surface", "surfaceFocused", "border", "borderFocus", "text", "textMuted", "accent",
                "accentGlow", "overlay", "shadow", "glassStrong")


def _clean_tokens(tokens):
    """Only known colour tokens (#rrggbb / #rrggbbaa) and a radius of 0-40, as text. Anything else is dropped."""
    out = {}
    if not isinstance(tokens, dict):
        return out
    for k in _SKIN_TOKENS:
        v = tokens.get(k)
        if isinstance(v, str) and _HEX.match(v.strip()):
            out[k] = v.strip().lower()
    r = tokens.get("radius")
    try:
        r = float(str(r).replace("px", "").strip())
        out["radius"] = "%dpx" % max(0, min(40, round(r)))
    except (TypeError, ValueError):
        pass
    return out


def skins():
    """The skins on this device: [{"id", "name", "description", "author", "custom", "current", "tokens"}]. "custom" is true
    for ones made on this device (they can be edited and deleted). Needs "skins": true."""
    s = _sess()
    s.need("skins")
    out = []
    for e in s.ctx.get("skins") or []:
        if isinstance(e, dict) and e.get("id"):
            out.append({"id": _s(e.get("id"), 80), "name": _s(e.get("name"), 80), "description": _s(e.get("description"), 300),
                        "author": _s(e.get("author"), 80), "custom": bool(e.get("custom")), "current": bool(e.get("current")),
                        "tokens": _clean_tokens(e.get("tokens"))})
    return out


def color_row(label, hint, hex_value, on=None, alpha=False, autofocus=""):
    """A row with a colour swatch. Tapping it opens PEK's colour window; on(\"#rrggbb\") runs with the chosen colour
    (\"#rrggbbaa\" when alpha=True). Needs "skins": true."""
    s = _sess()
    s.need("skins")
    v = _s(hex_value, 12)
    return {"t": "color", "s": _s(label, 100), "sub": _s(hint, 200), "hex": v if _HEX.match(v) else "#000000",
            "alpha": bool(alpha), "af": _s(autofocus, 100), "on": s.register(on, 1)}


def slider(label, value, minimum, maximum, on=None, unit=""):
    """A number slider. on(number) runs once when the finger lifts. Needs "skins": true."""
    s = _sess()
    s.need("skins")
    return {"t": "slider", "s": _s(label, 60), "v": float(value), "min": float(minimum), "max": float(maximum),
            "unit": _s(unit, 6), "on": s.register(on, 1)}


def skin_preview(tokens):
    """A small copy of the app drawn with these skin tokens. Needs "skins": true."""
    _sess().need("skins")
    return {"t": "skinpreview", "tokens": _clean_tokens(tokens)}


def skin_save(skin_id, name, description, tokens, use=False, author=""):
    """Save a skin on this device (Settings > Appearance). skin_id is the id of a skin made here to replace, or \"\" for a
    new one. PEK TV checks it again (readable text, ids) before it stores anything. Needs "skins": true."""
    s = _sess()
    s.need("skins")
    sid = _s(skin_id, 80)
    if sid and not _SKIN_ID.match(sid):
        raise ValueError("bad skin id")
    t = _clean_tokens(tokens)
    if not t:
        raise ValueError("a skin needs colours")
    s.effect("skin.save", id=sid, name=_s(name, 60), description=_s(description, 300), author=_s(author, 80),
             tokens=t, use=bool(use))


def skin_use(skin_id):
    """Switch the app to a skin. Needs "skins": true."""
    s = _sess()
    s.need("skins")
    s.effect("skin.use", id=_s(skin_id, 80))


def skin_delete(skin_id):
    """Delete a skin made on this device. Needs "skins": true."""
    s = _sess()
    s.need("skins")
    sid = _s(skin_id, 80)
    if not sid.startswith("custom-"):
        raise ValueError("only skins you made can be deleted here")
    s.effect("skin.delete", id=sid)


def copy_skin_json(text):
    """Put a skin.json on the clipboard. Needs "skins": true."""
    s = _sess()
    s.need("skins")
    t = _s(text, 20000)
    if t:
        s.effect("clipboard.copy", text=t, note="skin.json copied.")


def toast(message):
    """A short message at the bottom of the screen."""
    _sess().effect("toast", text=_s(message, 200))


def close_plugin():
    """Close the plugin screen."""
    _sess().effect("exit")
