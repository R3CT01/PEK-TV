"""Trakt hooks. PEK TV calls on_event() without any screen being open:

  app_start      once when the app starts: bring new Trakt history into PEK TV and resend anything that failed earlier
  tick           every few minutes while PEK TV is open and nothing is playing, and when the app comes back to the front:
                 one small request asks Trakt whether anything new was watched elsewhere; only then is the history fetched
  play / resume  playback started or continued        -> POST /scrobble/start
  pause          playback paused                      -> POST /scrobble/pause
  stop           the player closed (or the next episode took over) -> POST /scrobble/stop
  watched        the person marked movies / episodes watched or unwatched -> POST /sync/history[/remove]

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


def on_event(ev):
    t = tc.Trakt(h)
    if not t.linked():
        return
    kind = ev.get("type")
    now = time.time()
    if kind == "app_start":
        if t.on("pull"):
            items, finished, error = t.pull(now + 16)
            apply(items)
        t.flush_queue(now + 22)
    elif kind == "tick":
        if t.on("pull"):
            items, finished, error = t.pull(now + 10, quick=True)
            apply(items)
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
    elif kind == "watched":
        if t.on("push"):
            t.push_marks(ev["items"], ev["value"], now + 18)
