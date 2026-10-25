"""Cable Shot's live provider. PEK TV's player calls on_query(query) while one of this plugin's channels plays; it never
opens a screen. Four questions, the same four the old web plugin answered through pek.live.onQuery:

  {"op": "list"}                               the channel switcher: every channel and whether it has guide info
  {"op": "now",   "ids": [...]}                what is on and what is next, for the rows the guide is showing
  {"op": "guide", "ids": [...], "from", "to"}  the schedule of those channels between two times (seconds since 1970)
  {"op": "url",   "id": "..."}                 the stream of a channel the person switched to

A channel id is the key cable_core.channel_key() made (the same one ui.live_play(..., channel=key) was given).
The answers are plain lists: a programme is [start, stop, title, description]. PEK TV only passes these four ops, with
cleaned fields, and ignores anything else the plugin might try to do from here.
"""
import cable_core as cc
import pek_host as h


def ensure():
    """Channels and the stored guide. When the stored guide is old (or there is none), reading it again starts in the
    background: this answer does not wait for it, the next one will have it."""
    cc.load_channels()
    cc.load_cache()
    if cc.needs_refresh() and not cc.refresh_busy():
        cc.start_refresh()


def mini(p):
    return [p[0], p[1], p[2]] if p else 0


def on_query(query):
    ensure()
    op, now = query.get("op"), cc.now_sec()
    prog = cc.G["prog"]
    if op == "list":
        return {"guide": cc.G["matched"] > 0, "refreshing": cc.refresh_busy(),
                "channels": [[c["k"], c["n"], c["g"], 1 if c["k"] in prog else 0] for c in cc.G["channels"]]}
    if op == "now":
        out = {}
        for k in query.get("ids") or []:
            a = cc.around(prog.get(k) or [], now)
            out[k] = [mini(a["cur"]), mini(a["next"])]
        return out
    if op == "guide":
        lo, hi, out = int(query.get("from") or 0), int(query.get("to") or 0), {}
        for k in query.get("ids") or []:
            keep = []
            for p in prog.get(k) or []:
                if p[1] > lo and p[0] < hi:
                    keep.append([p[0], p[1], p[2], p[3] or ""])
                    if len(keep) >= 60:
                        break
            out[k] = keep
        return out
    if op == "url":
        ch = cc.G["by_key"].get(query.get("id"))
        if not ch:
            raise ValueError("unknown channel")
        try:
            h.write_json("last.json", {"k": ch["k"]})
        except Exception:
            pass
        return {"url": ch["u"], "title": ch["n"]}
    raise ValueError("unknown request")
