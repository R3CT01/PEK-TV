"""Cable Shot: the plugin's tab. A TV directory for the channels bundled inside it: what is on now, how long is left, what is
up next. Tapping a channel opens PEK TV's own player; while it plays, the player's guide (the little tab on the right edge)
shows the same channels and schedule (see live.py).

This is the Python port of the old web plugin's ui.js. Channels come from playlists/*.json (shipped inside the plugin), the
guide from the "cable guide" XMLTV files listed in playlists/index.json, read with pek_host.fetch_epg() and kept in data/.
"""
import cable_core as cc
import pek_host as h
import pek_ui as ui

TITLE = "Cable Shot"
PAGE = 24

S = {
    "view": "list", "tab": "guide", "group": None, "query": "", "draft": "", "shows": None, "page": 1, "gpage": 1,
    "sel": "", "msg": "", "fav": {}, "last": "",
    "set": {"quick": False, "h12": True, "onlyGuide": False, "tiles": False},
}


# ------------------------------------------------------------------------------------------------ saved choices

def load_prefs():
    try:
        for k in h.read_json("fav.json"):
            S["fav"][str(k)] = True
    except Exception:
        pass
    try:
        sv = h.read_json("settings.json")
        for k in S["set"]:
            if isinstance(sv.get(k), bool):
                S["set"][k] = sv[k]
    except Exception:
        pass
    try:
        S["last"] = str(h.read_json("last.json").get("k") or "")
    except Exception:
        pass


def save_fav():
    try:
        h.write_json("fav.json", sorted(S["fav"].keys()))
    except Exception:
        S["msg"] = "Could not save favorites (storage is full)."


def save_set():
    try:
        h.write_json("settings.json", S["set"])
    except Exception:
        pass


def start():
    cc.load_channels()
    load_prefs()
    cc.load_cache()
    if cc.needs_refresh():
        cc.start_refresh()


# ------------------------------------------------------------------------------------------------ small helpers

def clock(sec):
    d = cc.local(sec)
    if S["set"]["h12"]:
        return "%d:%02d %s" % (d.hour % 12 or 12, d.minute, "AM" if d.hour < 12 else "PM")
    return "%02d:%02d" % (d.hour, d.minute)


def day_clock(sec, now):
    a, b = cc.local(sec), cc.local(now)
    return ("" if a.date() == b.date() else a.strftime("%a") + " ") + clock(sec)


def guide_of(ch):
    return cc.G["prog"].get(ch["k"])


def line_for(ch, now):
    arr = guide_of(ch)
    plain = (ch["g"] or ch["pl"]) + " \u00b7 no guide info"
    if not arr:
        return plain
    a = cc.around(arr, now)
    if not a["cur"] and not a["next"]:
        return plain
    parts = []
    if a["cur"]:
        parts.append("Now: %s (%s left)" % (cc.cut(a["cur"][2], 44), cc.span(a["cur"][1] - now)))
    if a["next"]:
        parts.append("Next: %s %s" % (cc.cut(a["next"][2], 36), day_clock(a["next"][0], now)))
    return " \u00b7 ".join(parts)


def visible():
    lst = cc.G["channels"]
    if S["tab"] == "fav":
        lst = [c for c in lst if S["fav"].get(c["k"])]
    if S["group"] is not None:
        lst = [c for c in lst if c["g"] == S["group"]]
    if S["set"]["onlyGuide"]:
        lst = [c for c in lst if guide_of(c)]
    if S["query"]:
        q = cc.lc(S["query"])
        lst = [c for c in lst if q in c["nl"]]
    return lst


def find_shows(q):
    now, ql, out = cc.now_sec(), cc.lc(q), []
    for ch in cc.G["channels"]:
        arr = guide_of(ch)
        if not arr:
            continue
        for p in arr:
            if p[1] <= now or p[0] > now + 36 * 3600:
                continue
            if ql in cc.lc(p[2]):
                out.append((ch, p))
                break
    out.sort(key=lambda r: r[1][0])
    return out[:12]


# ------------------------------------------------------------------------------------------------ actions

def play(ch):
    S["msg"] = ""
    S["last"] = ch["k"]
    try:
        h.write_json("last.json", {"k": ch["k"]})
    except Exception:
        pass
    try:
        ui.live_play(ch["u"], ch["n"], ch["k"])
    except Exception as e:
        S["msg"] = 'Could not start "%s": %s' % (ch["n"], e)


def open_channel(ch):
    if S["set"]["quick"]:
        play(ch)
        return
    S["sel"], S["view"], S["msg"] = ch["k"], "channel", ""
    ui.scroll_top()


def toggle_fav(ch):
    if S["fav"].get(ch["k"]):
        del S["fav"][ch["k"]]
    else:
        S["fav"][ch["k"]] = True
    save_fav()


def set_tab(t):
    S.update(tab=t, page=1, gpage=1, group=None, query="", draft="", shows=None)
    ui.scroll_top()


def go_list():
    S["view"], S["sel"] = "list", ""
    ui.scroll_top()


def reload_guide():
    S["msg"] = "" if cc.start_refresh(force=True) else "The guide is already loading."


# ------------------------------------------------------------------------------------------------ screens

def pager(page, total, setter):
    pages = max(1, (total + PAGE - 1) // PAGE)
    if pages <= 1:
        return None

    def go(p):
        def run():
            setter(p)
            ui.scroll_top()
        return run

    kids = []
    lo, hi = max(1, page - 2), min(pages, page + 2)
    if page > 1:
        kids.append(ui.button("\u2039 Prev", go(page - 1)))
    if lo > 1:
        kids.append(ui.button("1", go(1), selected=page == 1))
        if lo > 2:
            kids.append(ui.text("\u2026"))
    for p in range(lo, hi + 1):
        kids.append(ui.button(str(p), go(p), selected=p == page))
    if hi < pages:
        if hi < pages - 1:
            kids.append(ui.text("\u2026"))
        kids.append(ui.button(str(pages), go(pages), selected=page == pages))
    if page < pages:
        kids.append(ui.button("Next \u203a", go(page + 1)))
    return ui.row(kids)


def set_page(p):
    S["page"] = p


def set_gpage(p):
    S["gpage"] = p


def channel_row(ch, now):
    title = ("\u2605 " if S["fav"].get(ch["k"]) else "") + ch["n"]
    return ui.list_row(title, line_for(ch, now), lambda ch=ch: open_channel(ch))


def channel_tile(ch, now):
    arr = guide_of(ch)
    a = cc.around(arr, now) if arr else None
    badge = cc.span(a["cur"][1] - now) if a and a["cur"] else ""
    title = ("\u2605 " if S["fav"].get(ch["k"]) else "") + ch["n"]
    return ui.poster_card(title, line_for(ch, now), ch["l"], lambda ch=ch: open_channel(ch), badge=badge, kind="show")


def pick_group(name):
    S["group"], S["tab"], S["page"] = name, "guide", 1
    ui.scroll_top()


def submit_search(t):
    S["draft"], S["query"], S["page"] = t, t.strip(), 1
    S["shows"] = find_shows(S["query"]) if S["query"] else None


def clear_group():
    S["group"], S["page"] = None, 1


def clear_query():
    S["query"], S["draft"], S["shows"], S["page"] = "", "", None, 1


def set_draft(t):
    S["draft"] = t


def guide_status():
    if cc.refresh_busy():
        return "Loading the guide\u2026"
    return ""


def list_screen():
    now, kids = cc.now_sec(), []
    kids.append(ui.heading(TITLE))
    if S["msg"]:
        kids.append(ui.text(S["msg"]))
    top = [ui.button("Settings", lambda: S.update(view="settings"))]
    last = cc.G["by_key"].get(S["last"])
    if last:
        top.append(ui.button("\u25b6 Last: " + cc.cut(last["n"], 28), lambda: play(last)))
    kids.append(ui.row(top))
    kids.append(ui.tabs([("guide", "Guide"), ("groups", "Categories"), ("fav", "Favorites")], S["tab"], set_tab))
    st = guide_status()
    if st:
        kids.append(ui.text(st))

    if S["tab"] == "groups":
        groups = cc.G["groups"]
        kids.append(ui.text("%d categories" % len(groups)))
        for g in groups[(S["gpage"] - 1) * PAGE:S["gpage"] * PAGE]:
            kids.append(ui.list_row(g["name"] or "Uncategorized", "%d channel%s" % (g["count"], "" if g["count"] == 1 else "s"),
                                    lambda name=g["name"]: pick_group(name)))
        gp = pager(S["gpage"], len(groups), set_gpage)
        if gp:
            kids.append(gp)
        return ui.column(kids)

    kids.append(ui.text_input("Search channels or shows", S["draft"], set_draft, placeholder="Channel name, or a show to find",
                              on_submit=submit_search, key="cable-search"))
    chips = []
    if S["group"] is not None:
        chips.append(ui.button("Category: %s  \u2715" % (S["group"] or "Uncategorized"), clear_group))
    if S["query"]:
        chips.append(ui.button("Search: %s  \u2715" % cc.cut(S["query"], 20), clear_query))
    if chips:
        kids.append(ui.row(chips))

    shows = S["shows"]
    if shows:
        kids.append(ui.heading("Shows matching \u201c%s\u201d" % cc.cut(S["query"], 24)))
        for ch, p in shows:
            if p[0] <= now:
                when = "On now, %s left" % cc.span(p[1] - now)
            else:
                when = "Starts %s (in %s)" % (day_clock(p[0], now), cc.span(p[0] - now))
            kids.append(ui.list_row("%s \u2014 %s" % (cc.cut(p[2], 60), ch["n"]), when, lambda ch=ch: open_channel(ch)))

    lst = visible()
    if shows and lst:
        kids.append(ui.heading("Channels"))
    if not lst:
        if not shows:
            if S["tab"] == "fav":
                kids.append(ui.text("No favorites yet. Open a channel and add it."))
            elif cc.G["channels"]:
                kids.append(ui.text("No channels match."))
            else:
                kids.append(ui.text("No channels in this plugin yet. The developer adds .m3u files with add_m3u.py before zipping it."))
        return ui.column(kids)
    with_guide = len([c for c in lst if guide_of(c)])
    kids.append(ui.text("%d channel%s" % (len(lst), "" if len(lst) == 1 else "s") + (" \u00b7 guide info for %d" % with_guide if with_guide else "")))
    items = lst[(S["page"] - 1) * PAGE:S["page"] * PAGE]
    if S["set"]["tiles"]:
        kids.append(ui.grid([channel_tile(c, now) for c in items], min_col=190))
    else:
        for c in items:
            kids.append(channel_row(c, now))
    pg = pager(S["page"], len(lst), set_page)
    if pg:
        kids.append(pg)
    return ui.column(kids)


def channel_screen(ch):
    now, kids = cc.now_sec(), []
    kids.append(ui.heading(ch["n"]))
    sub = [ch["g"]] if cc.lc(ch["g"]) == cc.lc(ch["pl"]) else [ch["g"], ch["pl"]]
    kids.append(ui.text(" \u00b7 ".join([x for x in sub if x])))
    if S["msg"]:
        kids.append(ui.text(S["msg"]))
    kids.append(ui.button("\u25b6  Watch live", lambda: play(ch), primary=True, autofocus="play"))
    kids.append(ui.button("\u2605 Remove from favorites" if S["fav"].get(ch["k"]) else "\u2606 Add to favorites", lambda: toggle_fav(ch)))

    arr = guide_of(ch)
    a = cc.around(arr, now) if arr else None
    if not a or (not a["cur"] and not a["next"]):
        kids.append(ui.text("No guide information for this channel."))
    else:
        if a["cur"]:
            cur = a["cur"]
            total, done = cur[1] - cur[0], now - cur[0]
            frac = max(0.0, min(1.0, done / float(total))) if total > 0 else 0.0
            kids.append(ui.heading("On now"))
            kids.append(ui.text(cur[2]))
            kids.append(ui.text("%s \u2013 %s \u00b7 %s left" % (clock(cur[0]), clock(cur[1]), cc.span(cur[1] - now))))
            kids.append(ui.text("%s  %d%%" % (cc.bar(frac), round(frac * 100))))
            if cur[3]:
                kids.append(ui.text(cur[3]))
            if a["next"]:
                kids.append(ui.text("Next up: %s in %s" % (a["next"][2], cc.span(a["next"][0] - now))))
        if a["upcoming"]:
            kids.append(ui.heading("Coming up"))
            for p in a["upcoming"]:
                kids.append(ui.text("%s  \u00b7  in %s  \u00b7  %s (%s)" % (day_clock(p[0], now), cc.span(p[0] - now), p[2], cc.span(p[1] - p[0]))))
    kids.append(ui.button("Back", go_list))
    return ui.column(kids)


def flip(name, after=None):
    def run(v):
        S["set"][name] = bool(v)
        if after:
            after()
        save_set()
    return run


def first_page():
    S["page"] = 1


def settings_screen():
    kids = [ui.heading(TITLE + " settings")]
    kids.append(ui.toggle("Tap a channel to watch it right away", S["set"]["quick"], flip("quick")))
    kids.append(ui.toggle("Show channels as tiles", S["set"]["tiles"], flip("tiles", first_page)))
    kids.append(ui.toggle("12-hour clock", S["set"]["h12"], flip("h12")))
    kids.append(ui.toggle("Only channels with guide info", S["set"]["onlyGuide"], flip("onlyGuide", first_page)))

    urls = cc.G["idx"]["epg"]["urls"] if cc.G["idx"] else []
    kids.append(ui.heading("Guide"))
    kids.append(ui.text("%d channels in %d list(s); guide info for %d." % (len(cc.G["channels"]), len(cc.G["idx"]["playlists"]) if cc.G["idx"] else 0, cc.G["matched"])))
    age = cc.guide_age()
    if age is not None:
        kids.append(ui.text("Guide last updated %s ago." % cc.span(age)))
    if urls:
        kids.append(ui.text(guide_status() or cc.G["note"] or "The guide has not been loaded yet."))
        kids.append(ui.button("Reload the guide now", reload_guide))
    else:
        kids.append(ui.text("This plugin has no guide address, so channels are listed without schedules."))
    kids.append(ui.button("Back", go_list))
    return ui.column(kids)


def render():
    if not cc.G["loaded"]:
        return ui.column(ui.heading(TITLE), ui.spinner("Loading channels\u2026", True))
    cc.load_cache()                              # the player may have refreshed the guide while this screen was closed
    ui.set_back(go_list if S["view"] != "list" else None)
    if S["view"] == "channel" and S["sel"] in cc.G["by_key"]:
        return channel_screen(cc.G["by_key"][S["sel"]])
    if S["view"] == "settings":
        return settings_screen()
    return list_screen()
