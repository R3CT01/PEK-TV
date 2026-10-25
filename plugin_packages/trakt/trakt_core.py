"""trakt_core: everything the Trakt plugin knows about Trakt. screen.py (sign-in, status, Sync now) and hooks.py
(scrobbling while you watch) both use it, each with its own pek_host.

How it talks to Trakt:
  * Sign-in is Trakt's "device" flow with PKCE: Trakt gives a short code, the person types it at trakt.tv/activate, and this
    plugin polls until Trakt says yes. Trakt apps no longer have a client secret; PKCE (a one-time code_verifier made on this
    device) takes its place, so no proxy or server is needed. A person who prefers their own Trakt app can enter its id instead.
  * Everything else goes straight to api.trakt.tv with the person's token.
  * Titles are matched with Trakt's search (title + year) once and the Trakt id is remembered in ids.json.
  * Every PEK TV profile has its own Trakt account: the token, the settings, the import position, the retry queues and the
    "what Trakt held last time" snapshots all live in files named after the profile (see Trakt.fname). Only ids.json, the
    title -> Trakt id cache, is shared, because it holds no account data.
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
RQUEUE = "rqueue.json"
FQUEUE = "fqueue.json"
SHARED = (IDS,)                      # the same for every profile: a title has one Trakt id whoever is watching
PER_PROFILE = (SETTINGS, AUTH, PKCE, STATE, QUEUE, RQUEUE, FQUEUE, "rsynced.json", "wsynced.json", "fsynced.json")
FIRST = "p1"                         # PEK TV's first profile; its files keep their old names, so an account linked before profiles existed stays on it
SNAP_MAX = 4000                      # most titles a "what Trakt held last time" snapshot keeps
OOB = "urn:ietf:wg:oauth:2.0:oob"
MAX_IDS = 3000
MAX_QUEUE = 100
MAX_RQUEUE = 300
PAGE = 500
DEFAULTS = {"scrobble": True, "push": True, "pull": True, "ratings": True, "favorites": True, "removals": True, "client_id": "", "client_secret": ""}   # client_secret: only for an old app of your own that still has one
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


def clean_profile(p):
    """A profile id made safe for a file name: letters, digits, '_' and '-', at most 24 characters. Nothing usable -> FIRST."""
    out = "".join(c for c in str(p or "") if (c.isascii() and c.isalnum()) or c in "_-")[:24]
    return out or FIRST


def profile_of(ui):
    """The id of the profile that is open in PEK TV. A PEK TV that does not tell plugins its profile (older than profiles for
    plugins) gives FIRST, which is how the plugin worked before: one account."""
    try:
        return clean_profile(ui.profile())
    except Exception:
        return FIRST


class Trakt:
    def __init__(self, host, profile=FIRST):
        self.h = host
        self.profile = clean_profile(profile)
        stored = self.load(SETTINGS, {})
        self.settings = dict(DEFAULTS)
        for k in DEFAULTS:
            if k in stored and isinstance(stored[k], type(DEFAULTS[k])):
                self.settings[k] = stored[k]
        self.auth = self.load(AUTH, {})
        self.acts = None                     # Trakt's last_activities answer of this event (see activity())

    # ------------------------------------------------------------------------------------------ storage
    def fname(self, name):
        """The file a piece of data lives in for this profile: profile p1 keeps the plain name, every other profile gets its id in front."""
        return name if name in SHARED or self.profile == FIRST else "%s.%s" % (self.profile, name)

    def load(self, name, default):
        try:
            v = self.h.read_json(self.fname(name))
        except Exception:
            return default
        return v if isinstance(v, type(default)) else default

    def save(self, name, obj):
        self.h.write_json(self.fname(name), obj)

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

    def erase(self):
        """This profile was removed from PEK TV: its Trakt account is signed out (the token is revoked at Trakt) and its files are emptied."""
        if self.linked():
            self.revoke()
        for n in PER_PROFILE:
            self.save(n, {})
        self.auth = {}

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

    # ------------------------------------------------------------------------------------------ removals made on Trakt
    # Trakt keeps no list of what was deleted. What it does is move the "last changed" time of a list when something is added OR removed,
    # so after such a change the whole list is read again and compared with a snapshot of what it held the last time we looked. A title
    # that was in the snapshot and is gone now was removed on Trakt. A title we never saw on Trakt (a rating made offline, a title Trakt
    # could not match) is never in a snapshot, so it is never removed here. Snapshots: rsynced.json (ratings), wsynced.json (watched),
    # fsynced.json (favorites).
    def skey(self, it):
        return "%s|%s|%d|%d|%d" % (it.get("kind") or "movie", norm(it.get("title")), int(it.get("year") or 0), int(it.get("season") or 0), int(it.get("episode") or 0))

    def snapshot_diff(self, name, current):
        """current = {key: item} Trakt holds now. Returns (items gone since the last snapshot, the time of that snapshot, suspicious).
        The snapshot is replaced by current. A big part of the list vanishing at once is held back ONCE (it may be a bad answer, not a
        clean-out): nothing is removed and the old snapshot stays; when the next look shows exactly the same, the removals are real."""
        snap = self.load(name, {})
        old = snap.get("items") if isinstance(snap.get("items"), dict) else {}
        since = int(snap.get("at") or 0)
        gone = [v for k, v in old.items() if k not in current]
        sig = hashlib.sha1("|".join(sorted(current)).encode("utf-8")).hexdigest()[:16]
        if len(gone) > 25 and len(gone) * 2 > len(old) and snap.get("doubt") != sig:
            snap["doubt"] = sig
            self.save(name, snap)
            return [], since, True
        self.save(name, {"at": int(time.time()), "items": current if len(current) <= SNAP_MAX else {}})
        return gone, since, False

    def gone_items(self, gone, since, **extra):
        """Items for PEK TV: what was removed on Trakt. "at" is the time we last knew it was there (PEK TV keeps anything changed
        on this device after that time)."""
        out = []
        for i in gone:
            at = max(int(since or 0), int(i.get("seen") or 0))
            if at > 0:
                out.append(dict({k: v for k, v in i.items() if k != "seen"}, at=at, **extra))
        return out

    def snapshot_touch(self, name, add=(), drop=()):
        """What we just sent to Trakt: it is on Trakt now (add) or is not any more (drop), so a later removal there is noticed."""
        snap = self.load(name, {})
        items = dict(snap["items"]) if isinstance(snap.get("items"), dict) else {}
        now = int(time.time())
        for it in add:
            items[self.skey(it)] = dict(it, seen=now)       # "seen": when we knew it was on Trakt (it was just sent)
        for it in drop:
            items.pop(self.skey(it), None)
        if len(items) > SNAP_MAX:
            return
        self.save(name, {"at": int(snap.get("at") or 0) or int(time.time()), "items": items})

    # ------------------------------------------------------------------------------------------ ratings (movies, episodes, shows: 1 to 10 on both sides)
    def rated_body(self, items, removing):
        """The body of POST /sync/ratings (or /remove) for [(item, trakt id)]: movies, whole shows, and episodes grouped show > season."""
        movies, shows, eps = [], [], {}
        for it, tid in items:
            kind = it.get("kind") or "movie"
            rate = {}
            if not removing:
                at = int(it.get("at") or 0)
                rate = {"rating": int(it["rating"]), "rated_at": iso(at) if at > 0 else iso()}
            if kind == "movie":
                movies.append(dict({"ids": {"trakt": tid}}, **rate))
            elif kind == "show":
                shows.append(dict({"ids": {"trakt": tid}}, **rate))
            else:
                seasons = eps.setdefault(tid, {})
                seasons.setdefault(int(it.get("season") or 0), []).append(dict({"number": int(it.get("episode") or 0)}, **rate))
        for tid, seasons in eps.items():
            shows.append({"ids": {"trakt": tid}, "seasons": [{"number": n, "episodes": e} for n, e in sorted(seasons.items())]})
        body = {}
        if movies:
            body["movies"] = movies
        if shows:
            body["shows"] = shows
        return body

    def push_ratings(self, items, deadline):
        """PEK -> Trakt: items are {"kind" ("movie" by default, "episode", "show"), "title", "year", "season", "episode", "rating" (1 to 10;
        0 removes it), "at" (seconds, optional)}. What does not get through (no network, out of time, Trakt busy) is kept in rqueue.json and
        sent by flush_rqueue(). Returns (sent, no match)."""
        todo, failed, missed = [], [], 0
        for it in items:
            if time.time() >= deadline:
                failed.append(it)
                continue
            kind = it.get("kind") or "movie"
            ref = {"kind": kind, "title": it["title"], "year": it.get("year", 0)}
            if kind != "movie":
                ref["kind"] = "show"
            tid = self.resolve(ref)
            if not tid:
                missed += 1
                continue
            todo.append((it, tid))
        sent = 0
        for removing in (False, True):
            group = [(it, tid) for it, tid in todo if (int(it.get("rating") or 0) <= 0) == removing]
            if not group:
                continue
            r = self.call("POST", "/sync/ratings/remove" if removing else "/sync/ratings", self.rated_body(group, removing))
            if r["status"] in (200, 201):
                sent += len(group)
                items_only = [it for it, tid in group]
                self.snapshot_touch("rsynced.json", add=[] if removing else items_only, drop=items_only if removing else [])
            else:
                failed += [it for it, tid in group]
        for it in failed:
            self.rqueue_add(it)
        return sent, missed

    def rqueue_add(self, it):
        q = self.load(RQUEUE, {})
        kind = it.get("kind") or "movie"
        key = "%s|%s|%d|%d|%d" % (kind, norm(it["title"]), int(it.get("year") or 0), int(it.get("season") or 0), int(it.get("episode") or 0))
        q.pop(key, None)                     # the newest rating of a title wins
        q[key] = {"kind": kind, "title": it["title"], "year": int(it.get("year") or 0), "season": int(it.get("season") or 0),
                  "episode": int(it.get("episode") or 0), "rating": int(it.get("rating") or 0), "at": int(it.get("at") or 0)}
        while len(q) > MAX_RQUEUE:
            q.pop(next(iter(q)))
        self.save(RQUEUE, q)

    def flush_rqueue(self, deadline):
        """Sends ratings that could not be sent earlier. Returns how many are still waiting."""
        q = self.load(RQUEUE, {})
        if not q or not self.linked():
            return len(q)
        self.save(RQUEUE, {})
        self.push_ratings(list(q.values()), deadline)      # anything that fails again goes back in the queue
        return len(self.load(RQUEUE, {}))

    def pull_ratings(self, deadline, quick=False, removals=True):
        """Trakt ratings (movies, shows, episodes) -> [{"kind", "title", "year", "season", "episode", "rating", "at"}] for PEK TV. quick=True
        (the periodic check) asks nothing but last_activities when no rating changed on Trakt since the last finished pull.
        removals=True also reports what was removed on Trakt since the last look, as items with "rating": 0 and "at" = when we last looked.
        Returns (items, finished, error text)."""
        state = self.load(STATE, {})
        if not isinstance(self.acts, dict):
            self.activity()
        d = self.acts
        act = None
        if isinstance(d, dict):
            act = []
            for k in ("movies", "shows", "episodes"):
                m = d.get(k)
                act.append(str(m.get("rated_at") or "") if isinstance(m, dict) else "")
        if quick and act is not None and state.get("ract") == act:
            return [], True, ""
        out = []
        for kind, path in (("movie", "movies"), ("show", "shows"), ("episode", "episodes")):
            page = 1
            while True:
                if time.time() >= deadline:
                    return out, False, ""
                r = self.call("GET", "/sync/ratings/%s?limit=%d&page=%d" % (path, PAGE, page))
                if r["status"] != 200 or not isinstance(r["data"], list):
                    return out, False, ("Trakt answered HTTP %d" % r["status"]) if r["status"] else "No answer from Trakt"
                for row in r["data"]:
                    if not isinstance(row, dict):
                        continue
                    rating = row.get("rating")
                    thing = row.get("movie") if kind == "movie" else row.get("show")
                    if not (isinstance(thing, dict) and thing.get("title") and isinstance(rating, int) and 1 <= rating <= 10):
                        continue
                    item = {"kind": kind, "title": str(thing["title"]), "year": int(thing.get("year") or 0) if kind == "movie" else 0,
                            "rating": rating, "at": epoch(row.get("rated_at"))}
                    if kind == "episode":
                        ep = row.get("episode")
                        if not (isinstance(ep, dict) and isinstance(ep.get("season"), int) and isinstance(ep.get("number"), int)):
                            continue
                        item["season"], item["episode"] = ep["season"], ep["number"]
                    out.append(item)
                if page >= max(1, r["page_count"]):
                    break
                page += 1
        gone, since, odd = self.snapshot_diff("rsynced.json", {self.skey(i): i for i in out})
        if removals:
            out += self.gone_items(gone, since, rating=0)
        if act is not None and not odd:
            state = self.load(STATE, {})
            state["ract"] = act
            self.save(STATE, state)
        return out, True, ""

    # ------------------------------------------------------------------------------------------ history removed on Trakt
    def watched_now(self, deadline):
        """Everything Trakt says is watched: ({key: item}, error text). The item is None when Trakt did not answer properly."""
        cur = {}
        r = self.call("GET", "/sync/watched/movies")
        if r["status"] != 200 or not isinstance(r["data"], list):
            return None, ("Trakt answered HTTP %d" % r["status"]) if r["status"] else "No answer from Trakt"
        for row in r["data"]:
            m = row.get("movie") if isinstance(row, dict) else None
            if isinstance(m, dict) and m.get("title") and int(row.get("plays") or 1) > 0:
                it = {"kind": "movie", "title": str(m["title"]), "year": int(m.get("year") or 0), "season": 0, "episode": 0}
                cur[self.skey(it)] = it
        if time.time() >= deadline:
            return None, ""
        r = self.call("GET", "/sync/watched/shows")
        if r["status"] != 200 or not isinstance(r["data"], list):
            return None, ("Trakt answered HTTP %d" % r["status"]) if r["status"] else "No answer from Trakt"
        for row in r["data"]:
            s = row.get("show") if isinstance(row, dict) else None
            if not (isinstance(s, dict) and s.get("title")):
                continue
            for se in row.get("seasons") or []:
                for ep in (se.get("episodes") or []) if isinstance(se, dict) else []:
                    if isinstance(ep, dict) and isinstance(se.get("number"), int) and isinstance(ep.get("number"), int) and int(ep.get("plays") or 1) > 0:
                        it = {"kind": "episode", "title": str(s["title"]), "year": 0, "season": se["number"], "episode": ep["number"]}
                        cur[self.skey(it)] = it
        return cur, ""

    def pull_removed(self, deadline, quick=False, report=True):
        """Watches removed on Trakt since the last look -> items for ui.set_watched_many(items, False); each carries "at" = when we last
        looked, so PEK TV keeps a title that was finished there since. quick=True costs nothing unless Trakt says a watch changed.
        report=False only refreshes the snapshot. Returns (items, finished, error text)."""
        state = self.load(STATE, {})
        if not isinstance(self.acts, dict):
            self.activity()
        d = self.acts
        act = None
        if isinstance(d, dict) and isinstance(d.get("movies"), dict) and isinstance(d.get("episodes"), dict):
            act = [str(d["movies"].get("watched_at") or ""), str(d["episodes"].get("watched_at") or "")]
        if quick and act is not None and state.get("wact") == act:
            return [], True, ""
        cur, error = self.watched_now(deadline)
        if cur is None:
            return [], False, error
        gone, since, odd = self.snapshot_diff("wsynced.json", cur)
        if act is not None and not odd:
            state = self.load(STATE, {})
            state["wact"] = act
            self.save(STATE, state)
        items = self.gone_items(gone, since) if report else []
        return items, True, ""

    # ------------------------------------------------------------------------------------------ favorites (movies and shows)
    def fav_ids(self, it):
        tmdb = int(it.get("tmdb") or 0)
        if tmdb > 0:
            return {"tmdb": tmdb}
        tid = self.resolve({"kind": "movie" if it.get("kind") == "movie" else "show", "title": it["title"], "year": it.get("year", 0)})
        return {"trakt": tid} if tid else None

    def push_favorites(self, items, value, deadline):
        """PEK -> Trakt favorites: items are {"kind" ("movie" | "show"), "title", "year", "tmdb"}; value True adds, False removes.
        What does not get through is kept in fqueue.json (see flush_fqueue). Returns (sent, no match)."""
        movies, shows, sent_items, failed, missed = [], [], [], [], 0
        for it in items:
            if time.time() >= deadline:
                failed.append(it)
                continue
            ids = self.fav_ids(it)
            if not ids:
                missed += 1
                continue
            (movies if it.get("kind") == "movie" else shows).append({"ids": ids})
            sent_items.append(it)
        sent = 0
        if sent_items:
            body = {}
            if movies:
                body["movies"] = movies
            if shows:
                body["shows"] = shows
            r = self.call("POST", "/sync/favorites" if value else "/sync/favorites/remove", body)
            if r["status"] in (200, 201):
                sent = len(sent_items)
                self.snapshot_touch("fsynced.json", add=sent_items if value else [], drop=[] if value else sent_items)
            else:
                failed += sent_items
        for it in failed:
            self.fqueue_add(it, value)
        return sent, missed

    def fqueue_add(self, it, value):
        q = self.load(FQUEUE, {})
        key = self.skey(it)
        q.pop(key, None)                     # the newest change of a title wins
        q[key] = {"item": {"kind": it.get("kind"), "title": it["title"], "year": int(it.get("year") or 0), "tmdb": int(it.get("tmdb") or 0)}, "value": bool(value)}
        while len(q) > MAX_RQUEUE:
            q.pop(next(iter(q)))
        self.save(FQUEUE, q)

    def flush_fqueue(self, deadline):
        """Sends favorite changes that could not be sent earlier. Returns how many are still waiting."""
        q = self.load(FQUEUE, {})
        if not q or not self.linked():
            return len(q)
        self.save(FQUEUE, {})
        for value in (True, False):
            group = [v["item"] for v in q.values() if v.get("value") is value]
            if group:
                self.push_favorites(group, value, deadline)    # a failure goes back in the queue
        return len(self.load(FQUEUE, {}))

    def pull_favorites(self, deadline, quick=False, removals=True):
        """Trakt favorites (movies, shows) -> (items, removed, finished, error text); both lists are {"kind", "title", "year", "tmdb"}.
        removed = taken off the favorites on Trakt since the last look (each with "at" = when we last looked).
        quick=True only costs the shared last_activities answer, and skips the list when Trakt does not report a favorites time."""
        state = self.load(STATE, {})
        if not isinstance(self.acts, dict):
            self.activity()
        d = self.acts
        act = None
        if isinstance(d, dict):
            parts = [str(d[k].get("favorited_at") or "") for k in ("movies", "shows") if isinstance(d.get(k), dict) and "favorited_at" in d[k]]
            act = parts if parts else None
        if quick and (act is None or state.get("fact") == act):
            return [], [], True, ""
        out = []
        page = 1
        while True:
            if time.time() >= deadline:
                return out, [], False, ""
            r = self.call("GET", "/sync/favorites?limit=%d&page=%d" % (PAGE, page))
            if r["status"] != 200 or not isinstance(r["data"], list):
                hint = " (favorites may need Trakt VIP)" if r["status"] in (402, 403) else ""
                return out, [], False, (("Trakt answered HTTP %d" % r["status"]) + hint) if r["status"] else "No answer from Trakt"
            for row in r["data"]:
                if not isinstance(row, dict):
                    continue
                kind = row.get("type") if row.get("type") in ("movie", "show") else ("movie" if isinstance(row.get("movie"), dict) else "show" if isinstance(row.get("show"), dict) else "")
                thing = row.get(kind) if kind else None
                if not (isinstance(thing, dict) and thing.get("title")):
                    continue
                ids = thing.get("ids") if isinstance(thing.get("ids"), dict) else {}
                out.append({"kind": kind, "title": str(thing["title"]), "year": int(thing.get("year") or 0) if kind == "movie" else 0,
                            "tmdb": int(ids.get("tmdb") or 0)})
            if page >= max(1, r["page_count"]):
                break
            page += 1
        gone, since, odd = self.snapshot_diff("fsynced.json", {self.skey(i): i for i in out})
        if act is not None and not odd:
            state = self.load(STATE, {})
            state["fact"] = act
            self.save(STATE, state)
        removed = self.gone_items(gone, since) if removals else []
        return out, removed, True, ""

    # ------------------------------------------------------------------------------------------ history in
    def activity(self):
        """The two times Trakt last saw a watch (movies, episodes): one small request that tells whether anything changed.
        None when Trakt does not answer properly (then the caller just asks for the history)."""
        r = self.call("GET", "/sync/last_activities")
        d = r["data"]
        if r["status"] != 200 or not isinstance(d, dict):
            return None
        self.acts = d                       # pull_ratings() reuses this answer: a tick still costs one request
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
