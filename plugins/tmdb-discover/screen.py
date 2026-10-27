"""TMDb Discover for the Flutter UI.

Trending, top rated, popular and now playing rows for movies and TV, streaming-service chips, search, numbered
pages for every list, a detail page (cast, more like this, where to watch, trailer), favorites and an
"In library" badge. It runs in the same sandbox as backend.py, uses PEK TV's built-in TMDb access (a proxy that
holds PEK's key) and has an optional "use my own key" override kept in this plugin's data/ folder.

Data: TMDb. Streaming availability: JustWatch (via TMDb). Trailers: YouTube.
"""
import json
import re
import time
import unicodedata
from urllib.parse import quote

import pek_host as h
import pek_ui as ui

API = "https://api.themoviedb.org/3"                           # only used with a personal key
PROXY = "https://hesper-tmdb.aquariusibeats.workers.dev"       # PEK TV's built-in access (it adds the key)
IMG = "https://image.tmdb.org/t/p/w342"
IMG_WIDE = "https://image.tmdb.org/t/p/w780"          # backdrops (16:9) for landscape cards on a TV
IMG_PERSON = "https://image.tmdb.org/t/p/w185"
IMG_LOGO = "https://image.tmdb.org/t/p/w92"
PER_ROW = 18
MAX_PAGES = 500          # TMDb does not serve pages past 500
SETTINGS = "settings.json"
LIBRARY = "library.json"

PREFERRED = ["netflix", "hulu", "disney plus", "max", "hbo max", "amazon prime video", "prime video",
             "apple tv plus", "apple tv+", "paramount plus", "paramount+", "peacock", "peacock premium",
             "crunchyroll", "tubi tv", "pluto tv", "youtube"]
LABELS = {"disney plus": "Disney+", "apple tv plus": "Apple TV+", "paramount plus": "Paramount+",
          "amazon prime video": "Prime Video", "peacock premium": "Peacock", "tubi tv": "Tubi",
          "pluto tv": "Pluto TV"}

# ---------------------------------------------------------------- state
S = {
    "ready": False,
    "key": "", "key_draft": "", "key_msg": "",
    "region": "", "region_draft": "",
    "tab": "movie",            # 'movie' | 'tv' | 'settings'
    "provider": 0,             # TMDb provider id, 0 = all services
    "providers": {"movie": None, "tv": None},
    "prov_fail": {"movie": False, "tv": False},
    "pages": {},               # page key -> {"loading"} | {"items", "total"} | {"error"}
    "list": None,              # None | {"src", "title", "page", "total", "search"}
    "detail": None,            # None | {"item", "loading", "info", "error"}
    "hist": [],
    "query": "",
    "lib": {"movies": {}, "shows": {}, "n_movies": 0, "n_shows": 0, "loaded": False},
    "auth_error": False,
    "favs": {},                # 'movie:603' -> True (mirrors PEK TV's favorites)
    "favs_seen": None,
    "fav_msg": "",
    "autoplay": True,          # play the trailer when a detail page opens
    "sound": True,             # trailer sound (turn off if the device blocks sound autoplay)
    "seen_over": {},           # tmdb id -> {"value", "base"}: a watched mark that PEK has not reported back yet
}


# ---------------------------------------------------------------- helpers
def lang():
    return str(ui.ctx().get("lang") or "en-US")


def device_region():
    r = str(ui.ctx().get("region") or "US").upper()
    return r if re.match(r"^[A-Z]{2}$", r) else "US"


def region():
    return S["region"] or device_region()


def norm(s):
    """Same idea on both sides of the match: lower case, no accents, no punctuation, no (1999) suffix,
    '&' = 'and', leading the/a/an dropped."""
    raw = str(s or "")
    t = unicodedata.normalize("NFKD", raw.lower())
    t = re.sub(r"[\u0300-\u036f]", "", t)
    t = t.replace("&", " and ")
    t = re.sub(r"\(\s*(?:19|20)\d\d\s*\)\s*$", " ", t)
    t = re.sub(r"['\u2019`]", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"^(?:the|a|an) ", "", t)
    return t or raw.strip().lower()


def year_of(date):
    try:
        y = int(str(date or "")[:4])
    except ValueError:
        return 0
    return y if y > 1800 else 0


def map_item(r, kind):
    t = r.get("media_type") if r.get("media_type") in ("tv", "movie") else kind
    date = r.get("first_air_date") if t == "tv" else r.get("release_date")
    title = (r.get("name") if t == "tv" else r.get("title")) or r.get("title") or r.get("name") or "Untitled"
    alt = (r.get("original_name") if t == "tv" else r.get("original_title")) or ""
    vote = r.get("vote_average")
    return {
        "id": r.get("id"), "type": t, "title": str(title), "alt": str(alt), "year": year_of(date),
        "poster": IMG + r["poster_path"] if r.get("poster_path") else "",
        "poster_path": r.get("poster_path") or "",
        "backdrop": IMG_WIDE + r["backdrop_path"] if r.get("backdrop_path") else "",
        "overview": str(r.get("overview") or ""),
        "rating": float(vote) if isinstance(vote, (int, float)) else 0.0,
        "votes": r.get("vote_count") or 0,
    }


def owned(item):
    names = [norm(item["title"])]
    if item.get("alt"):
        names.append(norm(item["alt"]))
    if item["type"] == "tv":
        for n in names:
            if n in S["lib"]["shows"]:
                return True
        return False
    for n in names:
        years = S["lib"]["movies"].get(n)
        if not years:
            continue
        if not item["year"]:
            return True
        for y in years:
            if not y or abs(y - item["year"]) <= 1:
                return True
    return False


def err_text(msg):
    m = str(msg or "")
    if re.search(r"HTTP (401|403)", m):
        if S["key"]:
            return "TMDb rejected your API key. Check it in Settings."
        return "PEK TV's built-in TMDb access was refused. Try again later, or add your own key in Settings."
    if re.search(r"HTTP 404", m):
        return "TMDb could not find that (404)."
    if re.search(r"HTTP 429", m):
        return "TMDb is busy right now (429). Try again in a moment."
    if re.search(r"HTTP 5\d\d", m):
        return "TMDb had a problem (" + m.replace("HTTP ", "")[:40] + "). Try again later."
    if re.search(r"larger than", m):
        return "TMDb sent more data than PEK TV allows."
    if re.search(r"time", m, re.I):
        return "TMDb took too long to answer."
    return "Couldn't reach TMDb. Check your connection."


def is_auth(msg):
    return re.search(r"HTTP (401|403)", str(msg or "")) is not None


def api(path, params=None):
    """Blocking: only call this from inside ui.background()."""
    q = ["language=" + quote(lang(), safe="")]
    if S["key"]:
        q.insert(0, "api_key=" + quote(S["key"], safe=""))
    p = params or {}
    for k in sorted(p.keys()):
        q.append(quote(str(k), safe="") + "=" + quote(str(p[k]), safe=""))
    # Personal key: straight to TMDb. No key: PEK TV's built-in access (the proxy adds the key).
    url = (API if S["key"] else PROXY) + path + "?" + "&".join(q)
    # A first try that fails is usually a hiccup (the phone just woke up, the proxy was cold, TMDb said 429 / 5xx), and
    # a list that failed used to stay empty (no pictures) until it was refreshed by hand. Try again a couple of times
    # inside this one background job, but never past the 25 second limit a job has.
    t0 = time.monotonic()
    wait = 1.0
    while True:
        try:
            return h.fetch_json(url, timeout=8)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            final = re.search(r"HTTP (401|403|404)", msg) is not None      # a key / not-found answer will not change
            if final or time.monotonic() - t0 > 11:
                raise
            time.sleep(wait)
            wait = min(wait * 2, 3.0)


def today():
    import datetime
    return datetime.date.today().isoformat()


def is_out(item, info):
    info = info or {}
    date = (info.get("first_air_date") if item["type"] == "tv" else info.get("release_date")) or ""
    status = str(info.get("status") or "")
    if re.match(r"^(Rumored|Planned)$", status, re.I):
        return False
    if item["type"] == "movie" and re.match(r"^(In Production|Post Production)$", status, re.I):
        return False
    if date:
        return date <= today()
    return re.match(r"^(Released|Ended|Returning Series|Canceled)$", status, re.I) is not None


def fav_key(item):
    return "%s:%s" % (item["type"], item["id"])


def sync_favs():
    """PEK TV tells us its favorites with every call; follow it when it changes (for example from the Favorites tab)."""
    cur = tuple(sorted(str(k) for k in (ui.ctx().get("favorites") or [])))
    if cur != S["favs_seen"]:
        S["favs_seen"] = cur
        S["favs"] = dict((k, True) for k in cur)


# ---------------------------------------------------------------- settings and library (data/ folder)
def load_settings():
    try:
        j = h.read_json(SETTINGS)
    except Exception:
        return
    if isinstance(j, dict):
        k = str(j.get("key") or "")
        if re.match(r"^[0-9a-fA-F]{32}$", k):
            S["key"] = k
        r = str(j.get("region") or "").upper()
        if re.match(r"^[A-Z]{2}$", r):
            S["region"] = r
        S["autoplay"] = j.get("autoplay") is not False
        S["sound"] = j.get("sound") is not False


def save_settings():
    data = {}
    if S["key"]:
        data["key"] = S["key"]
    if S["region"]:
        data["region"] = S["region"]
    if not S["autoplay"]:
        data["autoplay"] = False
    if not S["sound"]:
        data["sound"] = False
    try:
        h.write_json(SETTINGS, data)
        return True
    except Exception:
        return False


def build_library(movie_rows, show_rows):
    movies, shows, nm, ns = {}, {}, 0, 0
    for m in movie_rows:
        k = norm(m.get("title"))
        if not k:
            continue
        try:
            y = int(m.get("year") or 0)
        except (TypeError, ValueError):
            y = 0
        movies.setdefault(k, []).append(y)
        nm += 1
    for sh in show_rows:
        k = norm(sh.get("title"))
        if k:
            shows[k] = True
            ns += 1
    return {"movies": movies, "shows": shows, "n_movies": nm, "n_shows": ns, "loaded": True}


def read_library():
    """The list backend.py saved when PEK TV started (instant, but only as fresh as that start)."""
    try:
        j = h.read_json(LIBRARY)
    except Exception:
        return
    S["lib"] = build_library(j.get("movies", []), j.get("shows", []))


def refresh_library():
    """Asks the library scanner for its newest list, so new files show as "In library" without restarting PEK TV."""
    def work():
        return h.library_titles()

    def done(rows):
        if not rows:
            return                      # the scan has not saved anything yet: keep what we have
        S["lib"] = build_library([r for r in rows if r.get("kind") == "movie"],
                                 [r for r in rows if r.get("kind") != "movie"])

    ui.background(work, done, lambda msg: None)


# ---------------------------------------------------------------- numbered pages
# A "source" describes one TMDb list: {"path", "params", "type", "multi"?, "credits"?, "paged"?}.
# Every page of every source is cached under its own key, so rows, "See all" and Next / Prev never
# fetch the same page twice.
def page_key(src, page):
    return src["path"] + "?" + json.dumps(src.get("params") or {}, sort_keys=True) + "#" + str(page)


def extract(src, j):
    if src.get("credits"):             # an actor's films and shows, best known first
        seen = {}
        res = []
        for r in j.get("cast", []):
            if r.get("media_type") not in ("movie", "tv"):
                continue
            k = r["media_type"] + str(r.get("id"))
            if k in seen:
                continue
            seen[k] = 1
            res.append(r)
        res.sort(key=lambda r: -(r.get("popularity") or 0))
        return {"items": [map_item(r, r["media_type"]) for r in res[:60]], "total": 1}
    res = j.get("results", [])
    if src.get("multi"):
        res = [r for r in res if r.get("media_type") in ("movie", "tv")]
    return {"items": [map_item(r, src["type"]) for r in res],
            "total": max(1, min(int(j.get("total_pages") or 1), MAX_PAGES))}


def load_page(src, page):
    k = page_key(src, page)
    if k in S["pages"]:
        return
    S["pages"][k] = {"loading": True}
    p = dict(src.get("params") or {})
    if src.get("paged", True):
        p["page"] = page

    def work():
        return api(src["path"], p)

    def done(j):
        S["pages"][k] = extract(src, j)
        cur = S["list"]
        # First page of a list just arrived: now the page count is known, so fetch the next one.
        if cur and cur["page"] == page and page_key(cur["src"], page) == k:
            cur["total"] = S["pages"][k]["total"]
            ensure_loaded()

    def fail(msg):
        if is_auth(msg):
            S["auth_error"] = True
        S["pages"][k] = {"error": err_text(msg)}

    ui.background(work, done, fail)


def sections_for(kind):
    movie = kind == "movie"
    reg = {"region": region()} if movie else {}
    if S["provider"]:
        base = {"with_watch_providers": S["provider"], "watch_region": region(),
                "with_watch_monetization_types": "flatrate", "include_adult": "false"}
        pop = dict(base)
        pop["sort_by"] = "popularity.desc"
        top = dict(base)
        top["sort_by"] = "vote_average.desc"
        top["vote_count.gte"] = 300
        return [
            {"title": "Popular on this service", "path": "/discover/" + kind, "type": kind, "params": pop},
            {"title": "Top rated on this service", "path": "/discover/" + kind, "type": kind, "params": top},
        ]
    return [
        {"title": "Trending this week", "path": "/trending/" + kind + "/week", "type": kind, "params": {}},
        {"title": "Top rated", "path": "/" + kind + "/top_rated", "type": kind, "params": reg},
        {"title": "Popular", "path": "/" + kind + "/popular", "type": kind, "params": reg},
        ({"title": "Now playing in theaters", "path": "/movie/now_playing", "type": kind, "params": reg}
         if movie else
         {"title": "On the air", "path": "/tv/on_the_air", "type": kind, "params": {}}),
    ]


def pick_providers(items, reg):
    rows = []
    for p in items:
        if not p or not p.get("provider_id") or not p.get("provider_name"):
            continue
        if re.search(r"channel|with ads|standard", str(p["provider_name"]), re.I):
            continue
        n = str(p["provider_name"]).lower()
        pr = (p.get("display_priorities") or {}).get(reg)
        rows.append({"id": p["provider_id"], "label": LABELS.get(n, p["provider_name"]),
                     "rank": PREFERRED.index(n) if n in PREFERRED else -1,
                     "prio": pr if isinstance(pr, (int, float)) else 999})
    pref = sorted([r for r in rows if r["rank"] >= 0], key=lambda r: r["rank"])
    rest = sorted([r for r in rows if r["rank"] < 0], key=lambda r: r["prio"])
    seen, out = {}, []
    for r in pref + rest:
        if len(out) < 12 and r["label"] not in seen:
            seen[r["label"]] = 1
            out.append({"id": r["id"], "label": r["label"]})
    return out


def load_providers(kind):
    if S["providers"][kind] is not None:
        return
    S["providers"][kind] = []
    S["prov_fail"][kind] = False
    reg = region()

    def work():
        return api("/watch/providers/" + kind, {"watch_region": reg})

    def done(j):
        S["providers"][kind] = pick_providers(j.get("results", []), reg)

    def fail(msg):
        S["providers"][kind] = []
        S["prov_fail"][kind] = True

    ui.background(work, done, fail)


def ensure_loaded():
    if S["tab"] == "settings":
        return
    cur = S["list"]
    if cur:
        e = S["pages"].get(page_key(cur["src"], cur["page"]))
        if not e:
            load_page(cur["src"], cur["page"])
        elif e.get("total"):
            cur["total"] = e["total"]
        if cur["src"].get("paged", True) and cur["page"] < (cur["total"] or 0):
            load_page(cur["src"], cur["page"] + 1)       # so Next is instant
        return
    load_providers(S["tab"])
    for sec in sections_for(S["tab"]):
        load_page(sec, 1)


# ---------------------------------------------------------------- navigation
# Screens stack up: browse -> list of pages -> detail -> (another detail | an actor's list).
def push_view():
    if S["detail"] or S["list"]:
        S["hist"].append({"detail": S["detail"], "list": S["list"]})


def back():
    if S["hist"]:
        prev = S["hist"].pop()
        S["detail"] = prev["detail"]
        S["list"] = prev["list"]
    elif S["detail"]:
        S["detail"] = None
    elif S["list"]:
        S["list"] = None
    ensure_loaded()


def reset_views():
    S["detail"] = None
    S["list"] = None
    S["hist"] = []


def reset_data():
    S["pages"] = {}
    S["providers"] = {"movie": None, "tv": None}


def select_tab(tab_id):
    S["tab"] = tab_id
    S["provider"] = 0
    reset_views()
    if tab_id == "settings":
        S["key_draft"] = ""
        S["region_draft"] = region()
        S["key_msg"] = ""
    ui.scroll_top()
    ensure_loaded()


def pick_provider(pid):
    S["provider"] = 0 if S["provider"] == pid else pid
    reset_views()
    ensure_loaded()


def all_services():
    S["provider"] = 0
    reset_views()
    ensure_loaded()


def refresh():
    reset_data()
    S["auth_error"] = False
    refresh_library()
    ensure_loaded()


def retry_providers():
    S["providers"][S["tab"]] = None
    ensure_loaded()


def retry_page(src, page):
    S["pages"].pop(page_key(src, page), None)
    ensure_loaded()


def open_list(src, title, search=False):
    push_view()
    S["detail"] = None
    S["list"] = {"src": src, "title": title, "page": 1, "total": 0, "search": search}
    ui.scroll_top()
    ensure_loaded()


def go_page(n):
    cur = S["list"]
    if not cur:
        return
    cur["page"] = max(1, min(n, cur["total"] or MAX_PAGES))
    ui.scroll_top()
    ensure_loaded()


def set_query(v):
    S["query"] = v


def do_search(term=None):
    if term is not None:
        S["query"] = term
    term = S["query"].strip()
    if not term:
        if S["list"] and S["list"]["search"]:
            S["list"] = None
        return
    S["detail"] = None
    S["hist"] = []
    S["list"] = None
    open_list({"path": "/search/multi", "params": {"query": term, "include_adult": "false"},
               "type": "movie", "multi": True}, "Results for \u201c" + term + "\u201d", True)


def clear_search():
    reset_views()
    S["query"] = ""


def open_person(c):
    open_list({"path": "/person/%s/combined_credits" % c["id"], "params": {}, "type": "movie",
               "credits": True, "paged": False}, c["name"])


def video_langs():
    code = (lang().split("-")[0] or "en").lower()
    return "en,null" if code == "en" else code + ",en,null"


def open_detail(item):
    push_view()
    d = {"item": item, "loading": True, "info": None, "error": ""}
    S["detail"] = d
    ui.scroll_top()

    def work():
        return api("/%s/%s" % (item["type"], item["id"]), {
            "append_to_response": "watch/providers,videos,credits,recommendations,similar",
            "include_video_language": video_langs()})

    def done(j):
        d["info"] = j
        d["loading"] = False
        # A title opened from Favorites only knew its id: fill in the rest from TMDb's answer.
        name = j.get("name") if item["type"] == "tv" else j.get("title")
        if name:
            item["title"] = str(name)
        if not item["poster_path"] and j.get("poster_path"):
            item["poster_path"] = j["poster_path"]
            item["poster"] = IMG + j["poster_path"]
            if j.get("backdrop_path") and not item.get("backdrop"):
                item["backdrop"] = IMG_WIDE + j["backdrop_path"]
        if not item["rating"]:
            item["rating"] = float(j.get("vote_average") or 0)
            item["votes"] = j.get("vote_count") or 0
        if not item["year"]:
            item["year"] = year_of(j.get("release_date") or j.get("first_air_date"))
        if not item["overview"]:
            item["overview"] = str(j.get("overview") or "")

    def fail(msg):
        if is_auth(msg):
            S["auth_error"] = True
        d["error"] = err_text(msg)
        d["loading"] = False

    ui.background(work, done, fail)


def on_launch(intent):
    """PEK TV opened this plugin on a title (the Favorites tab)."""
    try:
        tmdb_id = int(intent.get("id"))
    except (TypeError, ValueError):
        return
    kind = "tv" if intent.get("type") == "tv" else "movie"
    S["tab"] = kind
    S["provider"] = 0
    S["query"] = ""
    reset_views()
    ensure_loaded()
    try:
        yr = int(intent.get("year") or 0)
    except (TypeError, ValueError):
        yr = 0
    open_detail({"id": tmdb_id, "type": kind, "title": str(intent.get("title") or "Loading\u2026"), "alt": "",
                 "year": yr, "poster": "", "poster_path": "", "backdrop": "", "overview": "", "rating": 0.0, "votes": 0})


# ---------------------------------------------------------------- favorites
def toggle_fav(item):
    k = fav_key(item)
    S["fav_msg"] = ""
    try:
        if k in S["favs"]:
            ui.favorite_remove(k)
            del S["favs"][k]
        else:
            ui.favorite_add(item["type"], item["id"], item["title"], item["year"], item["poster_path"])
            S["favs"][k] = True
    except Exception:
        S["fav_msg"] = "Could not update your favorites."


# ---------------------------------------------------------------- watched, and other plugins that can play
def watched_state(item):
    """Is the movie in PEK's Watch History? A mark we just made counts until PEK reports the same thing back."""
    cur = ui.is_watched("movie", item["title"], item["year"])
    ov = S["seen_over"].get(item["id"])
    if ov is not None:
        if ov["base"] == cur:
            return ov["value"]
        del S["seen_over"][item["id"]]
    return cur


def toggle_watched(item):
    base = ui.is_watched("movie", item["title"], item["year"])
    nxt = not watched_state(item)
    ui.set_watched("movie", item["title"], item["year"], nxt)
    S["seen_over"][item["id"]] = {"value": nxt, "base": base}


def open_with(plugin, item):
    S["fav_msg"] = ""
    try:
        ui.open_plugin(plugin["id"], item["type"], item["id"], item["title"], item["year"])
    except Exception:
        S["fav_msg"] = "Could not open " + plugin["name"] + "."


def streamer_buttons(item, info):
    """"Play with <plugin>" for every other installed plugin that can play movies and shows."""
    if not is_out(item, info):
        return []
    try:
        lst = ui.streamers()
    except Exception:
        return []
    if not lst:
        return []
    return [ui.heading("Play with a plugin"),
            ui.row([ui.button(p["name"], lambda p=p: open_with(p, item), primary=True) for p in lst])]


# ---------------------------------------------------------------- settings actions
def set_autoplay(v):
    S["autoplay"] = bool(v)
    save_settings()


def set_sound(v):
    S["sound"] = bool(v)
    save_settings()



def set_key_draft(v):
    S["key_draft"] = v


def set_region_draft(v):
    S["region_draft"] = v


def save_key(text=None):
    if text is not None:
        S["key_draft"] = text
    k = S["key_draft"].strip()
    if not k:
        S["key_msg"] = "Paste your TMDb API key first."
        return
    if k.startswith("eyJ") or len(k) > 40:
        S["key_msg"] = "That looks like the long v4 token. Use the shorter \"API Key\" (v3) from your TMDb account."
        return
    if not re.match(r"^[0-9a-fA-F]{32}$", k):
        S["key_msg"] = "A v3 API key is 32 letters and digits. Check for missing characters."
        return
    S["key_msg"] = "Checking the key\u2026"
    previous = S["key"]
    S["key"] = k

    def work():
        return api("/configuration", {})

    def done(j):
        S["key_draft"] = ""
        S["auth_error"] = False
        reset_data()
        if save_settings():
            S["key_msg"] = "Key saved."
        else:
            S["key_msg"] = "The key works, but it could not be saved on this device. You will need to enter it again next time."

    def fail(msg):
        S["key_msg"] = err_text(msg)       # worded for the key that was just tried, so do this first
        S["key"] = previous

    ui.background(work, done, fail)


def remove_key():
    S["key"] = ""
    S["key_draft"] = ""
    S["key_msg"] = "Key removed. Using PEK TV's built-in access."
    S["auth_error"] = False
    reset_data()
    reset_views()
    save_settings()


def save_region(text=None):
    if text is not None:
        S["region_draft"] = text
    r = S["region_draft"].strip().upper()
    if not re.match(r"^[A-Z]{2}$", r):
        S["key_msg"] = "Use a 2-letter country code, for example US or GB."
        return
    S["region"] = r
    S["provider"] = 0
    reset_data()
    reset_views()
    S["key_msg"] = "Region set to " + r + "."
    save_settings()


def auto_region():
    S["region"] = ""
    S["region_draft"] = device_region()
    S["provider"] = 0
    reset_data()
    reset_views()
    S["key_msg"] = "Using your device region: " + device_region() + "."
    save_settings()


# ---------------------------------------------------------------- views
def poster(item, focus_key=""):
    sub = " \u00b7 ".join([str(x) for x in (item["year"] or "", "TV" if item["type"] == "tv" else "Movie") if x])
    mine = owned(item)
    return ui.poster_card(item["title"], sub + " \u00b7 In your library" if mine else sub, item["poster"],
                          lambda: open_detail(item), badge="In library" if mine else "", autofocus=focus_key,
                          year=item["year"] or 0, kind="show" if item["type"] == "tv" else "movie",
                          backdrop=item.get("backdrop", ""), wide=True)


def poster_row(items, focus_key=""):
    return ui.grid([poster(it, focus_key if i == 0 else "") for i, it in enumerate(items)], min_col=150, scroll=True)


def section_row(sec):
    e = S["pages"].get(page_key(sec, 1))
    head = ui.row(ui.heading(sec["title"]), ui.button("See all", lambda: open_list(sec, sec["title"])))
    if not e or e.get("loading"):
        return ui.column(head, ui.spinner("Loading\u2026"))
    if e.get("error"):
        return ui.column(head, ui.text(e["error"]), ui.button("Try again", lambda: retry_page(sec, 1)))
    if not e["items"]:
        return ui.column(head, ui.text("Nothing to show here."))
    cards = [poster(it) for it in e["items"][:PER_ROW]]
    cards.append(ui.card("See all", "Browse every page", lambda: open_list(sec, sec["title"])))
    return ui.column(head, ui.grid(cards, min_col=150, scroll=True))


def chips():
    lst = S["providers"][S["tab"]]
    if lst is None:
        return None
    if S["prov_fail"][S["tab"]]:
        return ui.row(ui.text("Could not load streaming services."), ui.button("Try again", retry_providers))
    if not lst:
        return ui.text("Streaming service filters are not available for region " + region() + ".")
    allb = ui.button("All services", all_services, selected=S["provider"] == 0)
    btns = [ui.button(p["label"], lambda pid=p["id"]: pick_provider(pid), selected=S["provider"] == p["id"]) for p in lst]
    return ui.column(ui.text("Streaming in " + region()), ui.row(allb, btns))


def attribution():
    return ui.column(
        ui.text("This product uses the TMDB API but is not endorsed or certified by TMDB."),
        ui.text("Streaming availability data provided by JustWatch. Trailers play from YouTube."))


def pick_trailer(info):
    vids = [x for x in ((info or {}).get("videos") or {}).get("results", [])
            if x and x.get("site") == "YouTube" and re.match(r"^[A-Za-z0-9_-]{11}$", str(x.get("key") or ""))
            and x.get("type") in ("Trailer", "Teaser")]
    if not vids:
        return None
    want = (lang().split("-")[0] or "en").lower()

    def score(x):
        return (4 if x.get("type") == "Trailer" else 2) + (2 if x.get("official") else 0) + (1 if x.get("iso_639_1") == want else 0)

    vids.sort(key=lambda x: -score(x))
    return vids[0]


def cast_row(info):
    cast = [c for c in (info.get("credits") or {}).get("cast", []) if c and c.get("id") and c.get("name")][:20]
    if not cast:
        return None
    cards = []
    for c in cast:
        label = c["name"] + " \u00b7 " + c["character"] if c.get("character") else c["name"]
        cards.append(ui.poster_card(label, "See their other titles",
                                    IMG_PERSON + c["profile_path"] if c.get("profile_path") else "",
                                    lambda c=c: open_person(c)))
    return ui.column(ui.heading("Cast"), ui.grid(cards, min_col=130, scroll=True))


def related_row(item, info):
    rec = (info.get("recommendations") or {}).get("results", [])
    sim = (info.get("similar") or {}).get("results", [])
    lst = [map_item(r, item["type"]) for r in (rec if rec else sim)[:PER_ROW]]
    if not lst:
        return None
    return ui.column(ui.heading("More like this"), poster_row(lst))


def provider_buttons(item, info):
    wp = (((info or {}).get("watch/providers") or {}).get("results") or {}).get(region())
    if not wp:
        return []

    def uniq(lst):
        seen, out = {}, []
        for p in lst or []:
            if not p or not p.get("provider_id") or not p.get("provider_name") or p["provider_id"] in seen:
                continue
            seen[p["provider_id"]] = 1
            out.append(p)
        return out[:12]

    def btns(lst):
        return ui.row([ui.provider_button(p["provider_name"], IMG_LOGO + p["logo_path"] if p.get("logo_path") else "",
                                          item["title"], item["type"], item["id"], region()) for p in lst])

    stream = uniq((wp.get("flatrate") or []) + (wp.get("free") or []) + (wp.get("ads") or []))
    buy = uniq((wp.get("rent") or []) + (wp.get("buy") or []))
    out = []
    if stream:
        out.append(ui.heading("Watch on"))
        out.append(btns(stream))
    if buy:
        out.append(ui.heading("Rent or buy"))
        out.append(btns(buy))
    return out


def detail_view():
    d = S["detail"]
    item = d["item"]
    info = d["info"] or {}
    kids = []
    meta = [str(item["year"]) if item["year"] else "", "TV show" if item["type"] == "tv" else "Movie"]
    if item["rating"]:
        meta.append("%.1f (%s votes)" % (item["rating"], item["votes"]))
    if info.get("runtime"):
        meta.append("%s min" % info["runtime"])
    if info.get("number_of_seasons"):
        n = info["number_of_seasons"]
        meta.append("%s %s" % (n, "season" if n == 1 else "seasons"))
    back_btn = ui.button("Back", back, autofocus="detail:%s%s" % (item["type"], item["id"]))
    trailer = None if (d["loading"] or d["error"]) else pick_trailer(info)
    if trailer:      # the trailer goes first: PEK pins it to the very top of the page
        kids.append(ui.video(trailer["key"], autoplay=S["autoplay"], muted=not S["sound"], title=item["title"] + " trailer"))
    if d["loading"]:
        kids.append(back_btn)
        kids.append(ui.spinner("Loading\u2026", True))
    else:
        is_fav = fav_key(item) in S["favs"]
        top = [back_btn, ui.button("In your favorites" if is_fav else "Add to favorites",
                                   lambda: toggle_fav(item), selected=is_fav)]
        if trailer:
            top.append(ui.button("Open in YouTube", lambda: ui.open_trailer(trailer["key"])))
        kids.append(ui.row(top))
        if item["type"] == "movie":
            seen = watched_state(item)
            kids.append(ui.button("Watched \u00b7 mark as unwatched" if seen else "Mark as watched",
                                  lambda: toggle_watched(item), selected=seen))
        if S["fav_msg"]:
            kids.append(ui.text(S["fav_msg"]))
        kids.append(ui.rating_stars("show" if item["type"] == "tv" else "movie", item["title"], item["year"]))
    kids.append(ui.heading(item["title"]))
    kids.append(ui.text(" \u00b7 ".join([m for m in meta if m])))
    if owned(item):
        kids.append(ui.text("In your library"))
    if info.get("tagline"):
        kids.append(ui.text("\u201c" + str(info["tagline"]) + "\u201d"))
    overview = info.get("overview") or item["overview"]
    kids.append(ui.text(overview or ("Loading\u2026" if d["loading"] else "No description available.")))
    if info.get("genres"):
        kids.append(ui.text("Genres: " + ", ".join([g["name"] for g in info["genres"] if g.get("name")])))
    if d["error"]:
        kids.append(ui.text(d["error"]))
    if not d["loading"] and not d["error"]:
        if not is_out(item, info):
            date = (info.get("first_air_date") if item["type"] == "tv" else info.get("release_date")) or ""
            kids.append(ui.text("Not out yet" + (" \u2014 " + date if date > today() else "") + "."))
        kids.extend(provider_buttons(item, info))
        kids.extend(streamer_buttons(item, info))
        c = cast_row(info)
        if c:
            kids.append(c)
        r = related_row(item, info)
        if r:
            kids.append(r)
    kids.append(attribution())
    return ui.column(kids)


def pager(cur):
    total = cur["total"] or 0
    if total <= 1 and cur["page"] <= 1:
        return None
    page = cur["page"]
    kids = []
    if page > 10:
        kids.append(ui.button("-10", lambda: go_page(page - 10)))
    if page > 1:
        kids.append(ui.button("Prev", lambda: go_page(page - 1)))
    kids.append(ui.text("Page %d%s" % (page, " of %d" % total if total else "")))
    if not total or page < total:
        kids.append(ui.button("Next", lambda: go_page(page + 1)))
    if total and page + 10 <= total:
        kids.append(ui.button("+10", lambda: go_page(page + 10)))
    return ui.row(kids)


def list_view():
    cur = S["list"]
    e = S["pages"].get(page_key(cur["src"], cur["page"]))
    if e and e.get("total"):
        cur["total"] = e["total"]
    kids = [ui.row(ui.button("Back", back), ui.heading(cur["title"]))]
    pg = None if cur["src"].get("paged") is False else pager(cur)
    if pg:
        kids.append(pg)
    if not e or e.get("loading"):
        kids.append(ui.spinner("Loading page %d\u2026" % cur["page"], True))
    elif e.get("error"):
        kids.append(ui.text(e["error"]))
        kids.append(ui.button("Try again", lambda: retry_page(cur["src"], cur["page"])))
    elif not e["items"]:
        kids.append(ui.text("Nothing to show here."))
    else:
        fk = "list:%s:%d" % (cur["title"], cur["page"])
        kids.append(ui.grid([poster(it, fk if i == 0 else "") for i, it in enumerate(e["items"])], min_col=150))
        if pg:
            kids.append(pager(cur))
    return ui.column(kids)


def settings_view():
    kids = [ui.heading("TMDb access")]
    if S["key"]:
        kids.append(ui.text("Using your own TMDb key. Remove it to go back to the built-in access."))
    else:
        kids.append(ui.text("Built in: PEK TV's own TMDb access is used, so there is nothing to set up. Optional: "
                            "paste your own free v3 API key (themoviedb.org > Settings > API) to use that instead. "
                            "It is stored only inside this plugin on this device."))
    kids.append(ui.text_input("API Key (v3)", S["key_draft"], set_key_draft, placeholder="32-character key",
                              secret=True, on_submit=save_key, key="tmdb-key"))
    kids.append(ui.row(ui.button("Use my key", save_key, primary=True),
                       ui.button("Remove key", remove_key) if S["key"] else None))
    kids.append(ui.heading("Region"))
    kids.append(ui.text("Streaming services and \"now playing\" follow your device region (" + device_region() +
                        "). Using: " + region() + "."))
    kids.append(ui.text_input("Country code", S["region_draft"], set_region_draft, placeholder="US",
                              on_submit=save_region, key="tmdb-region"))
    kids.append(ui.row(ui.button("Set region", save_region), ui.button("Use device region", auto_region)))
    if S["key_msg"]:
        kids.append(ui.text(S["key_msg"]))
    kids.append(ui.heading("Your library"))
    lib = S["lib"]
    if lib["loaded"]:
        kids.append(ui.text("%d movies and %d shows are marked \"In library\". The list refreshes when PEK TV starts and when you press Refresh."
                            % (lib["n_movies"], lib["n_shows"])))
    else:
        kids.append(ui.text("Library list not available yet. Add a media folder and let it scan, then press Refresh."))
    kids.append(ui.heading("Trailers"))
    kids.append(ui.toggle("Auto-play trailers when a title opens", S["autoplay"], set_autoplay))
    kids.append(ui.toggle("Trailer sound", S["sound"], set_sound))
    kids.append(ui.text("Trailers play from YouTube. If your device blocks sound from starting by itself, turn Trailer sound off."))
    kids.append(attribution())
    return ui.column(kids)


def browse_view():
    if S["auth_error"]:
        return ui.column(ui.card(
            "TMDb rejected your API key" if S["key"] else "PEK TV's built-in TMDb access was refused",
            "Tap to open Settings and check it." if S["key"] else "Tap to open Settings and add your own key instead.",
            lambda: select_tab("settings")))
    kids = [chips()]
    for sec in sections_for(S["tab"]):
        kids.append(section_row(sec))
    return ui.column(kids)


# ---------------------------------------------------------------- entry points
def start():
    load_settings()
    read_library()
    refresh_library()
    S["region_draft"] = region()
    S["ready"] = True
    ensure_loaded()


def render():
    sync_favs()
    ui.set_back(back if (S["detail"] or S["list"]) else None)
    if not S["ready"]:
        return ui.column(ui.spinner("Loading\u2026", True))
    if S["detail"]:
        return detail_view()
    kids = []
    if S["tab"] != "settings":
        # One search pill (its arrow submits), then the tabs and Refresh on one line.
        kids.append(ui.text_input("", S["query"], set_query, placeholder="Search movies and TV shows",
                                  on_submit=do_search, key="tmdb-search"))
    in_search = bool(S["list"] and S["list"]["search"])
    if not S["list"]:
        kids.append(ui.row(
            ui.tabs([("movie", "Movies"), ("tv", "TV Shows"), ("settings", "Settings")], S["tab"], select_tab),
            ui.button("Refresh", refresh) if S["tab"] != "settings" else None))
    elif S["tab"] != "settings":
        kids.append(ui.row(ui.button("Clear search", clear_search) if in_search else None,
                           ui.button("Refresh", refresh)))
    if S["tab"] == "settings":
        kids.append(settings_view())
    elif S["auth_error"]:
        kids.append(browse_view())
    elif S["list"]:
        kids.append(list_view())
    else:
        kids.append(browse_view())
    if S["tab"] != "settings":
        kids.append(attribution())
    return ui.column(kids)
