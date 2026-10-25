"""Trakt hooks. PEK TV calls on_event() without any screen being open:

  app_start      once when the app starts: bring new Trakt history into PEK TV and resend anything that failed earlier
  tick           every few minutes while PEK TV is open and nothing is playing, and when the app comes back to the front:
                 one small request asks Trakt whether anything new was watched elsewhere; only then is the history fetched
  play / resume  playback started or continued        -> POST /scrobble/start
  pause          playback paused                      -> POST /scrobble/pause
  stop           the player closed (or the next episode took over) -> POST /scrobble/stop
  watched        the person marked movies / episodes watched or unwatched -> POST /sync/history[/remove]
  rated          the person rated a movie (1 to 10) or removed the rating -> POST /sync/ratings[/remove]
                 (Trakt ratings come in at app_start and tick, through ui.set_ratings_many)
  favorited      the person added movies / shows to the favorites, or removed them -> POST /sync/favorites[/remove]
                 (Trakt favorites come in at app_start and, when Trakt reports a favorites time, at tick: ui.set_favorites_many)

Removals made on Trakt (a watch, a rating, a favorite) come back too: after Trakt says a list changed, the list is read again and
compared with what it held last time (see trakt_core.snapshot_diff). The "removals" switch turns that off.

An event is {"type", "kind", "title", "year", "season", "episode", "position", "duration", "percent"} (for an episode "title" is the
show's title). PEK TV never sends file names, folders or ids. Trakt counts a watch at 80%.
"""
import time

import pek_host as h
import pek_ui as ui
import trakt_core as tc


def apply(items):
    for i in range(0, len(items), 300):
        ui.set_watched_many(items[i:i + 300], True)


def apply_ratings(items):
    for i in range(0, len(items), 300):
        ui.set_ratings_many(items[i:i + 300])


def apply_removed(items):
    for i in range(0, len(items), 300):
        ui.set_watched_many(items[i:i + 300], False)


def apply_favorites(items, removed):
    for i in range(0, len(items), 300):
        ui.set_favorites_many(items[i:i + 300], True)
    for i in range(0, len(removed), 300):
        ui.set_favorites_many(removed[i:i + 300], False)


def on_event(ev):
    t = tc.Trakt(h)
    if not t.linked():
        return
    kind = ev.get("type")
    now = time.time()
    if kind == "app_start":
        # one hook may run 25 seconds: every step gets a time to start by, and a step cut short carries on at the next tick
        if t.on("pull"):
            items, finished, error = t.pull(now + 10)
            apply(items)
        t.flush_queue(now + 12)
        if t.on("ratings"):
            t.flush_rqueue(now + 13)
            items, finished, error = t.pull_ratings(now + 16, removals=t.on("removals"))
            apply_ratings(items)
        if t.on("pull"):
            gone, finished, error = t.pull_removed(now + 19, quick=True, report=t.on("removals"))
            apply_removed(gone)
        if t.on("favorites"):
            t.flush_fqueue(now + 20)
            items, removed, finished, error = t.pull_favorites(now + 23, removals=t.on("removals"))
            apply_favorites(items, removed)
    elif kind == "tick":
        if t.on("pull"):
            items, finished, error = t.pull(now + 8, quick=True)
            apply(items)
        if t.on("ratings"):
            items, finished, error = t.pull_ratings(now + 11, quick=True, removals=t.on("removals"))
            apply_ratings(items)
        if t.on("pull"):
            gone, finished, error = t.pull_removed(now + 14, quick=True, report=t.on("removals"))
            apply_removed(gone)
        if t.on("favorites"):
            items, removed, finished, error = t.pull_favorites(now + 18, quick=True, removals=t.on("removals"))
            apply_favorites(items, removed)
    elif kind in ("play", "resume"):
        if t.on("scrobble"):
            t.scrobble("start", ev, ev["percent"])
    elif kind == "pause":
        if t.on("scrobble"):
            t.scrobble("pause", ev, ev["percent"])
    elif kind == "stop":
        if t.on("scrobble"):
            try:
                result = t.scrobble("stop", ev, ev["percent"])
            except Exception:
                result = "error"
            if result in ("error", "limited") and ev["percent"] >= 80:
                t.queue_add(ev)                    # a finished watch is not lost: it is sent at the next start
            elif result == "ok":
                t.flush_queue(now + 12)
    elif kind == "rated":
        if t.on("ratings"):
            t.push_ratings(ev["items"], now + 18)
    elif kind == "favorited":
        if t.on("favorites"):
            t.push_favorites(ev["items"], ev["value"], now + 18)
    elif kind == "watched":
        if t.on("push"):
            t.push_marks(ev["items"], ev["value"], now + 18)
