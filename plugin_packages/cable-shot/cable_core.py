"""cable_core: the channels and the TV guide of Cable Shot, shared by screen.py (the Cable Shot tab) and live.py (what the
player asks while a channel plays: its channel switcher, the guide and the now / next banner).

The screen and the live provider run in separate sessions, each with its own copy of this module. They share only the
plugin's data/ folder: whoever refreshes the guide writes it there (guide-N.json plus guide-meta.json), and the other one
picks it up when guide-meta.json changes.

Where things come from:
  playlists/index.json + playlists/*.json   channels that shipped inside the plugin       (pek_host.read_bundled_json)
  the guide addresses in index.json         XMLTV files of the "cable guide", re-read     (pek_host.fetch_epg, 'epg' permission)
                                            every few hours; only what the plugin's own channels need is kept
"""
import datetime
import hashlib
import json
import time

import pek_host as h
import pek_ui as ui

PAST = 3 * 3600                  # a programme that ended up to 3 hours ago is still kept
AHEAD_HOURS = 24                 # how far ahead the guide is read
STALE_AFTER = 6 * 3600           # the guide is read again when what is stored is older than this
SHARD_BYTES = 900000             # one data/ file may hold 1 MB: the stored guide is cut into pieces below this
DESC_KEEP = 10                   # per channel, this many programmes keep a description in the stored guide
DESC_CUT = 140
LOCK_SECONDS = 240               # the screen and the player do not both download the guide at the same moment

G = {"loaded": False, "idx": None, "channels": [], "by_key": {}, "groups": [], "prog": {}, "stamp": 0, "matched": 0, "note": "", "bad": ""}
R = {"urls": [], "i": 0, "ok": 0, "bad": [], "acc": {}, "nm": {}, "active": False, "want": None}


def lc(s):
    return str(s if s is not None else "").lower()


def cut(s, n):
    s = str(s or "")
    return s if len(s) <= n else s[:n - 1] + "\u2026"


def now_sec():
    return int(time.time())


def local(sec):
    """A moment as the device's local date and time."""
    return datetime.datetime.fromtimestamp(sec + ui.tz_offset(sec), datetime.timezone.utc)


# ------------------------------------------------------------------------------------------------ channels

def channel_key(url):
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def read_index():
    try:
        idx = h.read_bundled_json("playlists/index.json")
    except Exception:
        idx = {}
    if not isinstance(idx, dict):
        idx = {}
    idx.setdefault("playlists", [])
    ep = idx.get("epg")
    idx["epg"] = ep if isinstance(ep, dict) else {}
    idx["epg"]["urls"] = [u for u in (idx["epg"].get("urls") or []) if isinstance(u, str)]
    return idx


def load_channels():
    """Reads the bundled channel lists once. Each channel: k (key), n name, u stream, g group, i guide id, l logo,
    pl list name, nn normalized name, nl lower-case name."""
    if G["loaded"]:
        return
    idx = read_index()
    chans, seen = [], set()
    for pl in idx["playlists"]:
        for part in pl.get("parts") or []:
            try:
                data = h.read_bundled_json("playlists/" + str(part))
            except Exception:
                continue
            for r in data.get("c") or []:
                if not isinstance(r, list) or len(r) < 2 or not r[1]:
                    continue
                url = str(r[1])
                k = channel_key(url)
                if k in seen:                       # the same stream listed twice
                    continue
                seen.add(k)
                name = str(r[0] or "")
                chans.append({"k": k, "n": name, "u": url, "g": str(r[2] if len(r) > 2 else ""), "i": str(r[3] if len(r) > 3 else ""),
                              "l": str(r[4] if len(r) > 4 else ""), "pl": str(pl.get("name") or ""), "nn": h.epg_norm(name), "nl": lc(name)})
    counts = {}
    for c in chans:
        counts[c["g"]] = counts.get(c["g"], 0) + 1
    names = sorted(counts.keys(), key=lambda g: (g == "", lc(g)))
    G["idx"] = idx
    G["channels"] = chans
    G["by_key"] = {c["k"]: c for c in chans}
    G["groups"] = [{"name": g, "count": counts[g]} for g in names]
    G["loaded"] = True


# ------------------------------------------------------------------------------------------------ what is on

def fresh(arr, now):
    return bool(arr) and arr[-1][1] > now


def around(arr, now):
    """What is on at `now`: {"cur": programme or None, "next": programme or None, "upcoming": [next 6]}."""
    i = 0
    while i < len(arr) and arr[i][1] <= now:
        i += 1
    if i >= len(arr):
        return {"cur": None, "next": None, "upcoming": []}
    cur = None
    if arr[i][0] <= now:
        cur = arr[i]
        i += 1
    return {"cur": cur, "next": arr[i] if i < len(arr) else None, "upcoming": arr[i:i + 6]}


def span(sec):
    mins = max(0, int(round(sec / 60.0)))
    if mins < 1:
        return "under a minute"
    if mins < 60:
        return "%d min" % mins
    hrs, rest = mins // 60, mins % 60
    if hrs >= 48:
        return "%d days" % (hrs // 24)
    return "%d h" % hrs + (" %d min" % rest if rest else "")


def bar(frac):
    n = max(0, min(10, int(round(frac * 10))))
    return "\u25b0" * n + "\u25b1" * (10 - n)


# ------------------------------------------------------------------------------------------------ the stored guide

def load_cache():
    """Reads the stored guide when it changed since last time. True when something new was loaded."""
    try:
        meta = h.read_json("guide-meta.json")
    except Exception:
        return False
    if not isinstance(meta, dict) or not meta.get("generated") or meta.get("generated") == G["stamp"]:
        return False
    prog = {}
    for i in range(int(meta.get("shards") or 0)):
        try:
            part = h.read_json("guide-%d.json" % i)
        except Exception:
            return False                            # a piece is missing or being rewritten: keep what we have
        prog.update(part.get("p") or {})
    G["prog"] = prog
    G["matched"] = len(prog)
    G["stamp"] = meta["generated"]
    return True


def save_cache(prog, now):
    shards, cur, size = [], {}, 0
    for k in prog:
        n = len(json.dumps(prog[k])) + len(k) + 6
        if cur and size + n > SHARD_BYTES:
            shards.append(cur)
            cur, size = {}, 0
        cur[k] = prog[k]
        size += n
    if cur:
        shards.append(cur)
    for i, sh in enumerate(shards):
        h.write_json("guide-%d.json" % i, {"p": sh})
    h.write_json("guide-meta.json", {"generated": now, "shards": len(shards), "count": len(prog)})


def guide_age():
    return now_sec() - int(G["stamp"] or 0) if G["stamp"] else None


def needs_refresh():
    if not G["idx"] or not G["idx"]["epg"]["urls"]:
        return False
    if not G["stamp"]:
        return True
    return now_sec() - int(G["stamp"]) > STALE_AFTER


def lock_free():
    try:
        at = int((h.read_json("guide-lock.json") or {}).get("at") or 0)
    except Exception:
        at = 0
    return now_sec() - at > LOCK_SECONDS


def set_lock(on):
    try:
        h.write_json("guide-lock.json", {"at": now_sec() if on else 0})
    except Exception:
        pass


# ------------------------------------------------------------------------------------------------ reading the guide

def want_lists():
    if R["want"] is None:
        ids, names = set(), set()
        for c in G["channels"]:
            if c["i"]:
                ids.add(lc(c["i"]))
            if c["nn"]:
                names.add(c["nn"])
        R["want"] = (sorted(ids), sorted(names))
    return R["want"]


def refresh_busy():
    return R["active"]


def start_refresh(force=False, then=None):
    """Reads every guide file in turn, one background job each (a job may take 25 seconds, a screen draw only 6). Safe to
    call from either session; does nothing when a refresh is already running or the other session is doing one."""
    load_channels()
    urls = G["idx"]["epg"]["urls"] if G["idx"] else []
    if R["active"] or not urls:
        return False
    if not force and not lock_free():
        return False
    set_lock(True)
    R.update(urls=list(urls), i=0, ok=0, bad=[], acc={}, nm={}, active=True, then=then)
    G["note"] = "Loading the guide\u2026"
    step()
    return True


def step():
    if R["i"] >= len(R["urls"]):
        finish()
        return
    url = R["urls"][R["i"]]
    ids, names = want_lists()

    def work():
        return h.fetch_epg(url, ids, names, 3, AHEAD_HOURS, 10)

    def done(res):
        try:
            merge(res)
            R["ok"] += 1
        except Exception as e:                        # a file the reader could not make sense of: skip it, keep going
            R["bad"].append("unreadable guide file: " + cut(str(e), 60))
        R["i"] += 1
        step()

    def fail(message):
        host = url.replace("https://", "").split("/")[0]
        R["bad"].append("%s: %s" % (host, cut(message, 80)))
        R["i"] += 1
        step()

    ui.background(work, done, fail)


def merge(res):
    for cid, progs in (res.get("programmes") or {}).items():
        row = R["acc"].setdefault(lc(cid), {})
        for p in progs:
            row[p[0]] = p                             # the same start time listed twice keeps one
    for cid, names in (res.get("names") or {}).items():
        for nm in names:
            if nm not in R["nm"]:
                R["nm"][nm] = lc(cid)


def finish():
    try:
        build()
    finally:
        R["active"] = False
        R["acc"], R["nm"] = {}, {}
        set_lock(False)
    cb = R.get("then")
    if cb:
        cb()


def build():
    now = now_sec()
    prog = {}
    for c in G["channels"]:
        row = R["acc"].get(lc(c["i"])) if c["i"] else None
        if row is None and c["nn"] in R["nm"]:
            row = R["acc"].get(R["nm"][c["nn"]])
        if not row:
            continue
        arr = [p for p in sorted(row.values(), key=lambda p: p[0]) if p[1] > now - PAST]
        if not fresh(arr, now):
            continue
        # descriptions only for the first few programmes: that is what the guide shows, and it keeps the stored file small
        prog[c["k"]] = [[p[0], p[1], p[2], cut(p[3], DESC_CUT) if j < DESC_KEEP else ""] for j, p in enumerate(arr)]
    total, ok = len(R["urls"]), R["ok"]
    if ok and prog:
        try:
            save_cache(prog, now)
            G["prog"], G["matched"], G["stamp"] = prog, len(prog), now
        except Exception as e:                        # storage full or similar: the guide is still used from memory
            G["prog"], G["matched"], G["stamp"] = prog, len(prog), now
            R["bad"].append("could not store the guide: " + cut(str(e), 60))
    G["note"] = "%d of %d guide files loaded" % (ok, total) + ("; " + "; ".join(R["bad"][:3]) if R["bad"] else "")
    G["bad"] = "; ".join(R["bad"][:3])
