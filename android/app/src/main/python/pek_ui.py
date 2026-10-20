"""pek_ui: the UI toolkit for a plugin's Python screen (screen.py), drawn by the Flutter UI.

This is the Python twin of the `ui` object and the `pek` global that a plugin's ui.js gets in the web UI.
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


def poster_card(title, sub="", poster="", on=None, badge="", autofocus=""):
    """A poster tile. The picture only loads from a host listed under permissions.network in plugin.json."""
    return {"t": "poster", "s": _s(title, 200), "sub": _s(sub, 300), "img": _s(poster, 600),
            "badge": _s(badge, 40), "af": _s(autofocus, 100), "on": _sess().register(on, 0)}


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
    """What one press opens (the same rules as plan() in www/providers.js)."""
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
    return dict(_sess().ctx)


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


def _watched_key(kind, title, year):
    # The same text as Store.keyFor in the Flutter app (and histKey() in sync.js), so history and the cloud agree.
    t = " ".join(str(title or "").lower().split())
    if kind != "movie" or not t:
        raise ValueError("only movies can be marked watched here")
    return "m|%s|%d" % (t, int(year or 0))


def is_watched(kind, title, year=0):
    """Is this movie in PEK TV's Watch History? Needs "watched": true."""
    s = _sess()
    s.need("watched")
    try:
        key = _watched_key(kind, title, year)
    except ValueError:
        return False
    return key in (s.ctx.get("watched") or [])


def set_watched(kind, title, year=0, value=True):
    """Mark a movie watched / unwatched in PEK TV's Watch History (the history the person sees; it syncs). Needs
    "watched": true."""
    s = _sess()
    s.need("watched")
    _watched_key(kind, title, year)       # validates
    s.effect("watched.set", kind=kind, title=_s(title, 200), year=int(year or 0), value=bool(value))


def toast(message):
    """A short message at the bottom of the screen."""
    _sess().effect("toast", text=_s(message, 200))


def close_plugin():
    """Close the plugin screen."""
    _sess().effect("exit")
