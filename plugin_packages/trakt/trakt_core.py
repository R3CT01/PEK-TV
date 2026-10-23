"""trakt_core: everything the Trakt plugin knows about Trakt. screen.py (sign-in, status, Sync now) and hooks.py
(scrobbling while you watch) both use it, each with its own pek_host.

How it talks to Trakt:
  * Sign-in is Trakt's "device" flow with PKCE: Trakt gives a short code, the person types it at trakt.tv/activate, and this
    plugin polls until Trakt says yes. Trakt apps no longer have a client secret; PKCE (a one-time code_verifier made on this
    device) takes its place, so no proxy or server is needed. A person who prefers their own Trakt app can enter its id instead.
  * Everything else goes straight to api.trakt.tv with the person's token.
  * Titles are matched with Trakt's search (title + year) once and the Trakt id is remembered in ids.json.
"""
import base64
import datetime
import hashlib
import json
import random
import time
from urllib.parse import quote

API = "https://api.trakt.tv"
CLIENT_ID = "JFK-Zd7iVqbi2tSQhTm1Si4HCTtV-QSGjcnhbQtx_s8"   # PEK TV's Trakt app (a public id, not a secret)
PKCE = "pkce.json"
VERIFIER_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
SETTINGS = "settings.json"
AUTH = "auth.json"
CLIENT = "client.json"
IDS = "ids.json"
STATE = "sync.json"
QUEUE = "queue.json"
OOB = "urn:ietf:wg:oauth:2.0:oob"
MAX_IDS = 3000
MAX_QUEUE = 100
PAGE = 500
DEFAULTS = {"scrobble": True, "push": True, "pull": True, "client_id": "", "client_secret": ""}   # client_secret: only for an old app of your own that still has one
NO_ANSWER = {"status": 0, "data": None, "page_count": 0, "retry_after": 0}


def iso(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() if t is None else t))


def epoch(s):
    """Trakt's ISO time ("2026-10-20T10:00:00.000Z") -> seconds since 1970 (UTC). 0 when it cannot be read."""
    try:
        d = datetime.datetime.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S")
        return int(d.replace(tzinfo=datetime.timezone.utc).timestamp())
    except Exception:
        return 0


def norm(s):
    return " ".join(str(s or "").lower().split())


class Trakt:
    def __init__(self, host):
        self.h = host
        stored = self.load(SETTINGS, {})
        self.settings = dict(DEFAULTS)
        for k in DEFAULTS:
            if k in stored and isinstance(stored[k], type(DEFAULTS[k])):
                self.settings[k] = stored[k]
        self.auth = self.load(AUTH, {})

    # ------------------------------------------------------------------------------------------ storage
    def load(self, name, default):
        try:
            v = self.h.read_json(name)
        except Exception:
            return default
        return v if isinstance(v, type(default)) else default

    def save(self, name, obj):
        self.h.write_json(name, obj)

    def set_setting(self, key, value):
        if key in DEFAULTS:
            self.settings[key] = value
            self.save(SETTINGS, self.settings)

    def on(self, key):
        return bool(self.settings.get(key))

    def linked(self):
        return bool(self.auth.get("access_token") and self.auth.get("refresh_token"))

    # ------------------------------------------------------------------------------------------ the app
    def custom(self):
        return bool(self.settings["client_id"])

    def client_id(self):
        return self.settings["client_id"] if self.custom() else CLIENT_ID

    def oauth(self, path, body):
        """A sign-in call, straight to Trakt. Only the app id goes along (PKCE needs no secret); an old own app that still
        has a secret may add it in the settings."""
        b = dict(body)
        b["client_id"] = self.client_id()
        if self.custom() and self.settings["client_secret"]:
            b["client_secret"] = self.settings["client_secret"]
        return self.h.request_json("POST", API + path, body=b, headers={"trakt-api-version": "2", "trakt-api-key": self.client_id()})

    # ------------------------------------------------------------------------------------------ sign in
    def start_login(self):
        """Returns {user_code, verification_url, device_code, interval, expires_in} or raises."""
        rng = random.SystemRandom()
        verifier = "".join(rng.choice(VERIFIER_CHARS) for _ in range(96))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
        r = self.oauth("/oauth/device/code", {"code_challenge": challenge, "code_challenge_method": "S256"})
        d = r["data"]
        if r["status"] != 200 or not isinstance(d, dict) or not d.get("user_code") or not d.get("device_code"):
            raise ConnectionError("Trakt did not give a code (HTTP %d)" % r["status"])
        self.save(PKCE, {"device_code": str(d["device_code"]), "verifier": verifier})   # the screen and the poll may be separate sessions
        return d

    def poll_login(self, device_code):
        """One check. 'ok' when approved (tokens saved), else pending / slow / expired / denied / invalid."""
        saved = self.load(PKCE, {})
        body = {"code": device_code}
        if saved.get("device_code") == device_code and saved.get("verifier"):
            body["code_verifier"] = saved["verifier"]
        r = self.oauth("/oauth/device/token", body)
        st = r["status"]
        if st == 200 and isinstance(r["data"], dict) and r["data"].get("access_token"):
            self.store_tokens(r["data"])
            self.save(PKCE, {})
            return "ok"
        return {400: "pending", 429: "slow", 410: "expired", 418: "denied", 404: "invalid", 409: "invalid"}.get(st, "error")

    def store_tokens(self, d):
        made = d.get("created_at")
        made = made if isinstance(made, (int, float)) and made > 0 else time.time()
        life = d.get("expires_in")
        life = life if isinstance(life, (int, float)) and life > 0 else 86400
        self.auth = {"access_token": str(d["access_token"]), "refresh_token": str(d.get("refresh_token") or ""), "expires_at": made + life}
        self.save(AUTH, self.auth)

    def forget(self):
        self.auth = {}
        self.save(AUTH, {})

    def revoke(self):
        tok = self.auth.get("access_token")
        if tok:
            try:
                self.oauth("/oauth/revoke", {"token": tok})
            except Exception:
                pass
        self.forget()

    def refresh(self):
        """Trades the refresh token for a new access token. False when it could not (signed out if Trakt refused it).
        The screen and the hooks are separate sessions sharing auth.json and a refresh token works once, so whatever
        another session already stored is looked at first."""
        latest = self.load(AUTH, {})
        if latest.get("access_token") and latest.get("access_token") != self.auth.get("access_token") and latest.get("expires_at", 0) - time.time() > 300:
            self.auth = latest
            return True
        rt = self.auth.get("refresh_token")
        if not rt:
            return False
        try:
            r = self.oauth("/oauth/token", {"refresh_token": rt, "grant_type": "refresh_token", "redirect_uri": OOB})
        except Exception:
            return False
        if r["status"] == 200 and isinstance(r["data"], dict) and r["data"].get("access_token"):
            self.store_tokens(r["data"])
            return True
        if r["status"] in (400, 401):
            latest = self.load(AUTH, {})
            if latest.get("refresh_token") and latest.get("refresh_token") != rt:
                self.auth = latest                 # the other session got there first
                return True
            self.forget()
        return False

    def token(self):
        if not self.auth.get("access_token"):
            return ""
        if self.auth.get("expires_at", 0) - time.time() < 300:
            self.refresh()
        return str(self.auth.get("access_token", ""))

    # ------------------------------------------------------------------------------------------ requests
    def call(self, method, path, body=None, auth=True):
        headers = {"trakt-api-version": "2", "trakt-api-key": self.client_id()}
        if auth:
            tok = self.token()
            if not tok:
                return dict(NO_ANSWER, status=401)
            headers["Authorization"] = "Bearer " + tok
        r = self.h.request_json(method, API + path, body=body, headers=headers)
        if r["status"] == 401 and auth and self.refresh():
            headers["Authorization"] = "Bearer " + str(self.auth.get("access_token", ""))
            r = self.h.request_json(method, API + path, body=body, headers=headers)
        return r

    def username(self):
        r = self.call("GET", "/users/settings")
        if r["status"] == 200 and isinstance(r["data"], dict):
            u = r["data"].get("user")
            if isinstance(u, dict):
                return str(u.get("username") or u.get("name") or "")
        return ""

    # ------------------------------------------------------------------------------------------ matching
    def ident(self, item):
        if item["kind"] == "movie":
            return "m|%s|%d" % (norm(item["title"]), int(item.get("year") or 0))
        return "s|%s" % norm(item["title"])

    def resolve(self, item):
        """The Trakt id of a movie, or of an episode's show (0 = Trakt has no match). Remembered in ids.json."""
        ids = self.load(IDS, {})
        key = self.ident(item)
        if key in ids:
            return int(ids[key])
        title = str(item["title"])
        if item["kind"] == "movie":
            q = "/search/movie?limit=5&query=" + quote(title) + ("&years=%d" % int(item["year"]) if item.get("year") else "")
            field = "movie"
        else:
            q = "/search/show?limit=5&query=" + quote(title)
            field = "show"
        r = self.call("GET", q, auth=False)
        found = 0
        if r["status"] == 200 and isinstance(r["data"], list):
            rows = [x.get(field) for x in r["data"] if isinstance(x, dict) and isinstance(x.get(field), dict)]
            rows = [x for x in rows if isinstance(x.get("ids"), dict) and x["ids"].get("trakt")]
            same = [x for x in rows if norm(x.get("title")) == norm(title)]
            pick = (same or rows or [None])[0]
            if pick:
                found = int(pick["ids"]["trakt"])
        if found:
            if len(ids) >= MAX_IDS:
                for k in list(ids)[:MAX_IDS // 6]:
                    ids.pop(k, None)
            ids[key] = found
            self.save(IDS, ids)
        return found

    def media(self, item):
        """The Trakt object for scrobbling, or None when the title cannot be matched."""
        tid = self.resolve(item)
        if not tid:
            return None
        if item["kind"] == "movie":
            return {"movie": {"ids": {"trakt": tid}}}
        return {"show": {"ids": {"trakt": tid}}, "episode": {"season": int(item["season"]), "number": int(item["episode"])}}

    # ------------------------------------------------------------------------------------------ scrobble
    def scrobble(self, action, item, percent):
        """action = start / pause / stop. Returns 'ok', 'nomatch', 'limited' or 'error'."""
        obj = self.media(item)
        if obj is None:
            return "nomatch"
        body = dict(obj)
        body["progress"] = round(max(0.0, min(100.0, float(percent))), 2)
        r = self.call("POST", "/scrobble/" + action, body)
        if r["status"] in (200, 201, 409):          # 409: Trakt already has this watch, which is fine
            return "ok"
        return "limited" if r["status"] == 429 else "error"

    # ------------------------------------------------------------------------------------------ history out
    def history_body(self, items, stamp=""):
        movies = []
        shows = {}
        missed = 0
        for it in items:
            tid = self.resolve(it)
            if not tid:
                missed += 1
                continue
            if it["kind"] == "movie":
                m = {"ids": {"trakt": tid}}
                if stamp:
                    m["watched_at"] = it.get("at") or stamp
                movies.append(m)
            else:
                seasons = shows.setdefault(tid, {})
                e = {"number": int(it["episode"])}
                if stamp:
                    e["watched_at"] = it.get("at") or stamp
                seasons.setdefault(int(it["season"]), []).append(e)
        body = {}
        if movies:
            body["movies"] = movies
        if shows:
            body["shows"] = [{"ids": {"trakt": tid}, "seasons": [{"number": s, "episodes": eps} for s, eps in sorted(seasons.items())]} for tid, seasons in shows.items()]
        return body, missed

    def push_marks(self, items, value, deadline):
        """PEK -> Trakt for 'mark watched / unwatched'. Items that did not fit in the time (or failed) are queued when adding."""
        stamp = iso() if value else ""
        todo = []
        rest = []
        missed = 0
        for it in items:
            if time.time() >= deadline:
                rest.append(it)
            elif self.resolve(it):
                todo.append(it)
            else:
                missed += 1
        body, unused = self.history_body(todo, stamp)
        sent = 0
        ok = True
        if body:
            r = self.call("POST", "/sync/history" if value else "/sync/history/remove", body)
            ok = r["status"] in (200, 201)
            if ok:
                sent = len(todo)
        if value:
            for it in rest + ([] if ok else todo):
                self.queue_add(dict(it, at=stamp))
        return sent, missed

    # ------------------------------------------------------------------------------------------ retry queue
    def queue_add(self, item):
        q = self.load(QUEUE, [])
        entry = {k: item[k] for k in ("kind", "title", "year", "season", "episode") if k in item}
        entry["at"] = item.get("at") or iso()
        q.append(entry)
        self.save(QUEUE, q[-MAX_QUEUE:])

    def flush_queue(self, deadline):
        """Sends what could not be sent earlier (no network, Trakt busy). Returns how many are still waiting."""
        q = self.load(QUEUE, [])
        if not q or not self.linked():
            return len(q)
        batch = q[:40]
        for it in batch:
            if time.time() >= deadline:
                return len(q)
            self.resolve(it)
        body, missed = self.history_body(batch, iso())
        if body:
            r = self.call("POST", "/sync/history", body)
            if r["status"] not in (200, 201):
                return len(q)
        self.save(QUEUE, q[len(batch):])
        return max(0, len(q) - len(batch))

    # ------------------------------------------------------------------------------------------ history in
    def activity(self):
        """The two times Trakt last saw a watch (movies, episodes): one small request that tells whether anything changed.
        None when Trakt does not answer properly (then the caller just asks for the history)."""
        r = self.call("GET", "/sync/last_activities")
        d = r["data"]
        if r["status"] != 200 or not isinstance(d, dict):
            return None
        def at(k):
            v = d.get(k)
            return str(v.get("watched_at") or "") if isinstance(v, dict) else ""
        return [at("movies"), at("episodes")]

    def pull(self, deadline, quick=False):
        """Trakt history -> items PEK should mark watched. Remembers where it stopped in sync.json, so a big first import
        carries on at the next call. Each item carries "at", when it was watched (seconds since 1970; the newest watch of
        an item wins). quick=True is for the periodic check while PEK TV runs: when Trakt's last_activities shows nothing
        new since the last finished import, that one request is all it costs. Returns (items, finished, error text)."""
        state = self.load(STATE, {})
        act = self.activity()
        if quick and act is not None and state.get("done") is True and state.get("act") == act:
            return [], True, ""
        out = {}
        finished = True
        error = ""
        for kind in ("movies", "episodes"):
            st = state.get(kind) if isinstance(state.get(kind), dict) else {}
            since = str(st.get("since") or "")
            page = int(st.get("page") or 1)
            pending = str(st.get("pending") or "")
            while True:
                if time.time() >= deadline:
                    finished = False
                    break
                path = "/sync/history/%s?limit=%d&page=%d" % (kind, PAGE, page) + ("&start_at=" + quote(since) if since else "")
                r = self.call("GET", path)
                if r["status"] != 200 or not isinstance(r["data"], list):
                    error = "Trakt answered HTTP %d" % r["status"] if r["status"] else "No answer from Trakt"
                    finished = False
                    break
                rows = r["data"]
                if page == 1:
                    pending = str(rows[0].get("watched_at") or "") if rows and isinstance(rows[0], dict) else ""
                for row in rows:
                    it = self.row_item(kind, row)
                    if it:
                        k = (it["kind"], norm(it["title"]), it["year"], it["season"], it["episode"])
                        if k not in out:                 # newest first: the first row of an item is its latest watch
                            out[k] = it
                if page >= max(1, r["page_count"]):
                    since = pending or since
                    page = 1
                    pending = ""
                    break
                page += 1
            state[kind] = {"since": since, "page": page, "pending": pending}
            if error:
                break
        state["done"] = bool(finished and not error and act is not None)
        state["act"] = act if state["done"] else None
        self.save(STATE, state)
        return list(out.values()), finished, error

    def row_item(self, kind, row):
        if not isinstance(row, dict):
            return None
        if kind == "movies":
            m = row.get("movie")
            if isinstance(m, dict) and m.get("title"):
                return {"kind": "movie", "title": str(m["title"]), "year": int(m.get("year") or 0), "season": 0, "episode": 0,
                        "at": epoch(row.get("watched_at"))}
            return None
        s, e = row.get("show"), row.get("episode")
        if isinstance(s, dict) and isinstance(e, dict) and s.get("title") and e.get("number") is not None:
            return {"kind": "episode", "title": str(s["title"]), "year": 0, "season": int(e.get("season") or 0), "episode": int(e["number"]),
                    "at": epoch(row.get("watched_at"))}
        return None
