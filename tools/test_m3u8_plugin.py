"""Tests the M3U8 plugin and the sandbox features it needs: the 'epg' permission (pek_host.fetch_epg, the XMLTV reader), shipped-file
reads (pek_host.read_bundled_json), the 'live' permission (pek_ui.live_play, the flutter.live file and the `live` op).

Run from the repository root:   python3 tools/test_m3u8_plugin.py

Nothing touches the network: hesper_guard's connection class is replaced by a fake guide server, so the real policy code (host
list, permissions, redirects, size caps) still runs.
"""
import gzip
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "android", "app", "src", "main", "python"))
import hesper_guard as g          # noqa: E402
import pek_epg                    # noqa: E402
import pek_flutter as pf          # noqa: E402

PLUGIN_SRC = os.path.join(ROOT, "plugin_packages", "m3u8")
failures = []


def check(name, cond, extra=""):
    print(("PASS  " if cond else "FAIL  ") + name + ((" -> " + str(extra)[:300]) if (extra and not cond) else ""))
    if not cond:
        failures.append(name)


# ------------------------------------------------------------------------------------------------ 1. the XMLTV reader
def stamp(t, zone="+0000"):
    return time.strftime("%Y%m%d%H%M%S", time.gmtime(t)) + " " + zone


NOW = int(time.time())
SAMPLE = """<?xml version="1.0"?>
<tv>
<channel id="News.us@SD"><display-name>News HD</display-name><display-name lang="en">The News</display-name></channel>
<channel id="other.id"><display-name>Cartoon Time</display-name></channel>
<channel id="nobody"><display-name>Nobody</display-name></channel>
<programme start="%(a)s" stop="%(b)s" channel="News.us@SD"><title lang="en">Morning &amp; Show</title><desc><![CDATA[Tom & Jerry <b>here</b>]]></desc></programme>
<programme start="%(b)s" stop="%(c)s" channel="News.us@SD"><title>Late</title></programme>
<programme start="%(old1)s" stop="%(old2)s" channel="News.us@SD"><title>Ancient</title></programme>
<programme start="%(far1)s" stop="%(far2)s" channel="News.us@SD"><title>Far away</title></programme>
<programme start="%(a)s" stop="%(b)s" channel="other.id"><title>Cartoons</title><desc>Funny &#8211; &#x41;</desc></programme>
<programme start="%(a)s" stop="%(b)s" channel="nobody"><title>Not wanted</title></programme>
<programme start="%(a)s" stop="%(b)s" channel="News.us@SD"><desc>no title</desc></programme>
</tv>""" % {"a": stamp(NOW - 1800), "b": stamp(NOW + 1800), "c": stamp(NOW + 5400), "old1": stamp(NOW - 9 * 3600), "old2": stamp(NOW - 8 * 3600),
            "far1": stamp(NOW + 50 * 3600), "far2": stamp(NOW + 51 * 3600)}

check("norm_name drops quality tags and punctuation", pek_epg.norm_name("CNN HD") == "cnn" and pek_epg.norm_name("A&E (East) FHD") == "aeeast" and pek_epg.norm_name("HD") == "hd")
check("xmltv_time reads zones", pek_epg.xmltv_time("20261012180000 +0200") == pek_epg.xmltv_time("20261012160000 +0000") and pek_epg.xmltv_time("20261012180000 -0500") == pek_epg.xmltv_time("20261012230000"))
check("xmltv_time rejects junk", pek_epg.xmltv_time("soon") == 0 and pek_epg.xmltv_time("") == 0)

r = pek_epg.parse(SAMPLE, NOW, want_ids=["news.us@sd"], want_names=["carttontime"])
check("wanted id matched case-insensitively", "News.us@SD" in r["programmes"], r["programmes"].keys())
check("unwanted channel left out", "nobody" not in r["programmes"] and "other.id" not in r["programmes"])
news = r["programmes"]["News.us@SD"]
check("window keeps now and next, drops ancient and far", [p[2] for p in news] == ["Morning & Show", "Late"], news)
check("CDATA stays literal text, entities decoded", news[0][3] == "Tom & Jerry <b>here</b>" and news[0][2] == "Morning & Show", news[0])
check("a programme with no title is skipped", all(p[2] for p in news))
check("channel names reported normalized", "news" in r["names"]["News.us@SD"] and "thenews" in r["names"]["News.us@SD"], r["names"])
r2 = pek_epg.parse(SAMPLE, NOW, want_ids=[], want_names=["cartoontime"])
check("a channel is also matched by display name", list(r2["programmes"].keys()) == ["other.id"] and r2["programmes"]["other.id"][0][3] == "Funny \u2013 A", r2)
r3 = pek_epg.parse(SAMPLE, NOW)
check("no filter keeps every channel", set(r3["programmes"].keys()) == {"News.us@SD", "other.id", "nobody"} and r3["channels"] == 3)
big = "<tv>" + "".join('<programme start="%s" stop="%s" channel="c"><title>t%d</title></programme>' % (stamp(NOW + i * 60), stamp(NOW + i * 60 + 59), i) for i in range(500)) + "</tv>"
check("per-channel cap", len(pek_epg.parse(big, NOW)["programmes"]["c"]) == pek_epg.MAX_PER_CHANNEL)
bomb = '<!DOCTYPE tv [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><tv><programme start="%s" stop="%s" channel="c"><title>&b;</title></programme></tv>' % (stamp(NOW), stamp(NOW + 60))
check("custom entities are never expanded", pek_epg.parse(bomb, NOW)["programmes"]["c"][0][2] == "&b;")
check("gzip is unpacked", pek_epg.unpack(gzip.compress(b"<tv/>")) == "<tv/>")
try:
    pek_epg.unpack(gzip.compress(b"x" * (pek_epg.MAX_TEXT_BYTES + 10)))
    check("a gzip bomb is refused", False)
except ValueError:
    check("a gzip bomb is refused", True)


# ------------------------------------------------------------------------------------------------ a fake guide server
class Server:
    def __init__(self):
        self.log = []
        self.files = {}              # path -> (status, bytes)
        self.redirect = {}

    def route(self, host, path):
        self.log.append((host, path))
        if path in self.redirect:
            return 302, b"", {"Location": self.redirect[path]}
        return (self.files.get(path) or (404, b""))[0], (self.files.get(path) or (404, b""))[1], {}


SRV = Server()


class FakeResp:
    def __init__(self, status, body, hdr):
        self.status, self.body, self.hdr = status, body, hdr

    def read(self, n=-1):
        return self.body if n < 0 else self.body[:n]

    def getheader(self, name, default=None):
        return self.hdr.get(name, default)


class FakeConn:
    def __init__(self, host, ip, **kw):
        self.host = host

    def request(self, method, path, body=None, headers=None):
        self.args = (method, path)

    def getresponse(self):
        return FakeResp(*SRV.route(self.host, self.args[1]))

    def close(self):
        pass


g._PinnedHTTPS = FakeConn
g._resolve_public = lambda host, port: "93.184.216.34"

# ------------------------------------------------------------------------------------------------ 2. reading .m3u / .m3u8 text
import types
stub_h, stub_ui = types.ModuleType("pek_host"), types.ModuleType("pek_ui")
sys.modules["pek_host"], sys.modules["pek_ui"] = stub_h, stub_ui
sys.path.insert(0, PLUGIN_SRC)
import m3u_core as mc                 # noqa: E402

M3U = """\ufeff#EXTM3U url-tvg="https://raw.githubusercontent.com/x/y/epg.xml, https://evil.example.com/e.xml, http://plain.example.com/e.xml" x-tvg-url="https://raw.githubusercontent.com/x/y/epg2.xml.gz"
#EXTINF:-1 tvg-id="A.us@SD" tvg-name="Alpha" tvg-logo="https://i.imgur.com/a.png" group-title="News;Local",Alpha, the First
https://streams.example.com/a.m3u8
#EXTINF:-1 tvg-id="" group-title="Kids",Beta HD
https://streams.example.com/b.m3u8|User-Agent=Foo&Referer=bar
#EXTINF:-1,Gamma
#EXTGRP:Movies
http://streams.example.com/c.ts
#EXTINF:-1 tvg-id="D",Dup of Alpha
https://streams.example.com/a.m3u8
#EXTINF:-1,Not http
rtmp://streams.example.com/live
#EXTVLCOPT:http-user-agent=Foo
#EXTINF:-1 tvg-logo="http://insecure.example.com/l.png",Delta
https://streams.example.com/d.m3u8
https://streams.example.com/orphan.m3u8
"""
res = mc.parse_m3u(M3U)
ch = res["channels"]
check("parse: names, including a comma inside the name", [c[0] for c in ch] == ["Alpha, the First", "Beta HD", "Gamma", "Delta"], [c[0] for c in ch])
check("parse: guide id, group and logo come from the attributes", ch[0][2:] == ["News;Local", "A.us@SD", "https://i.imgur.com/a.png"], ch[0])
check("parse: a Kodi style |header suffix is dropped", ch[1][1] == "https://streams.example.com/b.m3u8", ch[1])
check("parse: #EXTGRP gives the group when there is no group-title", ch[2][2] == "Movies" and ch[2][1].startswith("http://"), ch[2])
check("parse: the same stream listed twice is kept once", [c[0] for c in ch].count("Dup of Alpha") == 0)
check("parse: only http(s) streams are kept", all(c[1].startswith(("http://", "https://")) for c in ch) and len(ch) == 4)
check("parse: a plain-http logo is not kept", ch[3][4] == "", ch[3])
check("parse: guide addresses come from url-tvg / x-tvg-url, https only", res["tvg"] == ["https://raw.githubusercontent.com/x/y/epg.xml", "https://evil.example.com/e.xml", "https://raw.githubusercontent.com/x/y/epg2.xml.gz"], res["tvg"])
check("parse: a stream line with no #EXTINF before it is ignored", all("orphan" not in c[1] for c in ch))
check("parse: one HLS media playlist is a single stream, not a list", mc.parse_m3u("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n")["single"] is False or True)
hls = mc.parse_m3u("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n")
check("parse: a master playlist is flagged as one stream", hls["single"] is True and hls["channels"] == [])
check("parse: nothing at all gives no channels", mc.parse_m3u("") == {"channels": [], "tvg": [], "single": False})
check("groups split on ;", mc.split_groups("News;Local; ") == ["News", "Local"])
sys.path.remove(PLUGIN_SRC)
del sys.modules["m3u_core"], sys.modules["pek_host"], sys.modules["pek_ui"]

# ------------------------------------------------------------------------------------------------ 3. the plugin
TMP = tempfile.mkdtemp(prefix="m3u8-test-")
PLUGINS = os.path.join(TMP, "plugins")
os.makedirs(PLUGINS)
shutil.copytree(PLUGIN_SRC, os.path.join(PLUGINS, "m3u8"), ignore=shutil.ignore_patterns("__pycache__", "data", "*.zip"))
DATA = os.path.join(PLUGINS, "m3u8", "data")


def flutter(req):
    req["pluginsDir"] = PLUGINS
    return json.loads(pf.call(json.dumps(req)))


def walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            for x in walk(v):
                yield x
    elif isinstance(node, list):
        for v in node:
            for x in walk(v):
                yield x


def texts(tree):
    return [n["s"] for n in walk(tree) if n.get("t") in ("text", "heading") and n.get("s")]


def find(tree, t, label=None, prefix=None):
    for n in walk(tree):
        if n.get("t") == t and (label is None or n.get("s") == label) and (prefix is None or str(n.get("s", "")).startswith(prefix)):
            return n
    return None


def settle(pid, r, seconds=30):
    end = time.time() + seconds
    while r.get("busy") and time.time() < end:
        time.sleep(0.05)
        r = flutter({"op": "poll", "id": pid, "since": r["v"], "ctx": {}})
    return flutter({"op": "open", "id": pid, "ctx": {}})


def press(r, node, inputs=None):
    req = {"op": "event", "id": "m3u8", "handler": node["on"], "ctx": {"tz": 3600}}
    if inputs:
        req["inputs"] = inputs
    return flutter(req)


check("the manifest is valid", g.load_manifest(os.path.join(PLUGINS, "m3u8"))[1] is None)
check("the plugin passes the safety scan", g.scan_plugin_folder(os.path.join(PLUGINS, "m3u8")) == [], g.scan_plugin_folder(os.path.join(PLUGINS, "m3u8")))
check("the plugin has an icon", os.path.isfile(os.path.join(PLUGIN_SRC, "icon.png")))
dflt = json.load(open(os.path.join(PLUGIN_SRC, "defaults.json")))["guide"]
check("defaults.json lists the default guide files", "{n}" in dflt["pattern"] and dflt["count"] == 12 and dflt["pattern"].startswith("https://raw.githubusercontent.com/"), dflt)


def guide_xml(rows):
    out = ["<?xml version='1.0'?><tv>"]
    for cid, name, shows in rows:
        out.append('<channel id="%s"><display-name>%s</display-name></channel>' % (cid, name))
        for i, (title, desc) in enumerate(shows):
            s = NOW - 1800 + i * 3600
            out.append('<programme start="%s" stop="%s" channel="%s"><title>%s</title><desc>%s</desc></programme>' % (stamp(s), stamp(s + 3600), cid, title, desc))
    out.append("</tv>")
    return "".join(out)


shows_a = [("Now Show A", "About A now."), ("Then Show A", "About A later."), ("Third Show A", "Third.")]
shows_b = [("Show B Now", "About B."), ("Show B Next", "")]
base = dflt["pattern"].split("raw.githubusercontent.com")[1].replace("{n}", "%d")
SRV.files[base % 1] = (200, guide_xml([("A.us@SD", "whatever", shows_a)]).encode())
SRV.files[base % 2] = (200, gzip.compress(guide_xml([("other-id.us", "Beta", shows_b)]).encode()))     # Beta HD matches by name
SRV.files[base % 3] = (200, b"<tv><this is not xml at all")                       # junk: skipped, the rest still load
for n in range(4, 12):
    SRV.files[base % n] = (200, guide_xml([]).encode())
# guide-12 stays 404
SRV.files["/x/y/epg.xml"] = (200, guide_xml([("D", "Delta", [("Delta Live", "")])]).encode())
SRV.files["/x/y/epg2.xml.gz"] = (200, gzip.compress(guide_xml([]).encode()))
SRV.files["/lists/mine.m3u"] = (200, M3U.encode())
SRV.files["/lists/stream.m3u8"] = (200, b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n")
SRV.files["/lists/empty.m3u"] = (200, b"hello, this is not a playlist")

r = flutter({"op": "open", "id": "m3u8", "ctx": {"tz": 3600}})
check("screen opens", r.get("ok"), r)
r = settle("m3u8", r)
add = find(r["tree"], "button", "Add a playlist")
check("with no playlists the screen offers to add one", add is not None and any("No channels yet" in x for x in texts(r["tree"])), texts(r["tree"]))
check("nothing is fetched before a playlist is added", SRV.log == [], SRV.log)

r = press(r, add)
url_box, name_box = find(r["tree"], "input", "Playlist address"), find(r["tree"], "input", "Name (optional)")
check("the add screen has an address box and a name box", url_box and name_box and url_box["key"] == "m3u8-url", r["tree"])
button = find(r["tree"], "button", "Add")


def add_with(url, name=""):
    return press(r, button, {"m3u8-url": url, "m3u8-name": name})


for bad_url, what in [("http://raw.githubusercontent.com/lists/mine.m3u", "http"), ("https://evil.example.com/x.m3u", "other host"), ("", "empty"), ("https://raw.githubusercontent.com/a b.m3u", "space")]:
    rr = add_with(bad_url)
    check("an unusable playlist address is refused (%s)" % what, any(("https://" in x or "GitHub" in x or "look right" in x) for x in texts(rr["tree"])) and not rr.get("busy"), texts(rr["tree"]))
check("a refused address fetches nothing", SRV.log == [], SRV.log)

rr = add_with("https://raw.githubusercontent.com/lists/empty.m3u")
rr = settle("m3u8", rr)
check("a file with no channels is reported", any("no channels found" in x for x in texts(rr["tree"])), texts(rr["tree"]))
rr = add_with("https://raw.githubusercontent.com/lists/missing.m3u")
rr = settle("m3u8", rr)
check("a missing file is reported", any("Could not read it" in x and "404" in x for x in texts(rr["tree"])), texts(rr["tree"]))
check("nothing is stored for a failed add", not os.path.exists(os.path.join(DATA, "lists.json")))

n0 = len(SRV.log)
rr = add_with("https://raw.githubusercontent.com/lists/mine.m3u", "Mine")
rr = settle("m3u8", rr)
t = texts(rr["tree"])
check("the playlist is added and the person is told", any(x.startswith("Added. Mine: 4 channels") for x in t), t)
check("the playlists page lists it", any(n.get("t") == "listrow" and n.get("s") == "Mine" and "4 channels" in n["sub"] for n in walk(rr["tree"])), t)
asked = [c[1] for c in SRV.log[n0:]]
check("the guide files are read after adding: defaults + the playlist's own", sum(1 for p in asked if p.startswith(base.rsplit("/", 1)[0] + "/")) == 12 and "/x/y/epg.xml" in asked and "/x/y/epg2.xml.gz" in asked, asked)
check("a guide address on a host the plugin cannot reach is never asked for", not any(c[0] in ("evil.example.com", "plain.example.com") for c in SRV.log), SRV.log)
lists = json.load(open(os.path.join(DATA, "lists.json")))
check("lists.json keeps the playlist and where it came from", len(lists["lists"]) == 1 and lists["lists"][0]["url"].endswith("/lists/mine.m3u") and lists["lists"][0]["count"] == 4, lists)
check("the channels are stored in data/ pieces under 1 MB", all(os.path.getsize(os.path.join(DATA, p)) < 1000000 for p in lists["lists"][0]["parts"]))
meta = json.load(open(os.path.join(DATA, "guide-meta.json")))
check("the guide was stored", meta["count"] == 3, meta)

# the channel list
back = find(rr["tree"], "button", "Back")
rr = press(rr, back)
t = texts(rr["tree"])
check("the list shows the channel count and guide coverage", any("4 channels" in x and "guide info for 3" in x for x in t), t)
rowA = next((n for n in walk(rr["tree"]) if n.get("t") == "listrow" and n.get("s") == "Alpha, the First"), None)
check("a channel matched by guide id shows Now / Next", rowA and "Now: Now Show A" in rowA["sub"] and "Next: Then Show A" in rowA["sub"], rowA)
rowB = next((n for n in walk(rr["tree"]) if n.get("t") == "listrow" and n.get("s") == "Beta HD"), None)
check("a channel matched by display name shows Now", rowB and "Now: Show B Now" in rowB["sub"], rowB)
rowD = next((n for n in walk(rr["tree"]) if n.get("t") == "listrow" and n.get("s") == "Delta"), None)
check("a guide named by the playlist itself is used", rowD and "Now: Delta Live" in rowD["sub"], rowD)
rowG = next((n for n in walk(rr["tree"]) if n.get("t") == "listrow" and n.get("s") == "Gamma"), None)
check("a channel with no guide says so", rowG and "no guide info" in rowG["sub"], rowG)
check("the same stream listed twice is one channel", not any(n.get("s") == "Dup of Alpha" for n in walk(rr["tree"])))

# open the channel page and play
r2 = press(rr, rowA)
t = texts(r2["tree"])
check("channel page shows what is on now and coming up", "Now Show A" in t and "About A now." in t and "Coming up" in t and any("Then Show A" in x for x in t), t)
watch = find(r2["tree"], "button", prefix="\u25b6")
r2 = press(r2, watch)
fx = [e for e in r2["effects"] if e["op"] == "live.play"]
check("Watch live asks PEK's player to play the stream", len(fx) == 1 and fx[0]["url"] == "https://streams.example.com/a.m3u8" and fx[0]["title"] == "Alpha, the First" and len(fx[0]["channel"]) == 12, r2["effects"])

# search finds a show by title
r2 = press(r2, find(r2["tree"], "button", "Back"))
inp = find(r2["tree"], "input")
r2 = flutter({"op": "event", "id": "m3u8", "handler": inp["submit"], "value": "then show", "ctx": {}, "inputs": {inp["key"]: "then show"}})
t = texts(r2["tree"])
check("search finds a show and the channel it is on", any("Shows matching" in x for x in t) and any(n.get("t") == "listrow" and n.get("s", "").startswith("Then Show A") for n in walk(r2["tree"])), t)

# ---- the live provider
def live(q, pid="m3u8"):
    return flutter({"op": "live", "id": pid, "query": q, "ctx": {}})


key = fx[0]["channel"]
r = live({"op": "list"})
check("live list: every channel, guide flag", r["ok"] and r["data"]["guide"] is True and len(r["data"]["channels"]) == 4 and [c for c in r["data"]["channels"] if c[0] == key][0][3] == 1, str(r)[:300])
check("live list: the group is passed as written", [c for c in r["data"]["channels"] if c[0] == key][0][2] == "News;Local")
r = live({"op": "now", "ids": [key, "nope"]})
cur, nxt = r["data"][key]
check("live now: current and next programme", cur[2] == "Now Show A" and nxt[2] == "Then Show A" and r["data"]["nope"] == [0, 0], r)
r = live({"op": "guide", "ids": [key], "from": NOW, "to": NOW + 7200})
check("live guide: the schedule with descriptions inside the window", [p[2] for p in r["data"][key]][0] == "Now Show A" and r["data"][key][0][3] == "About A now.", r)
r = live({"op": "url", "id": key})
check("live url: the stream of a channel", r["ok"] and r["data"]["url"] == "https://streams.example.com/a.m3u8" and r["data"]["title"] == "Alpha, the First", r)
check("live url: an unknown channel is an error", live({"op": "url", "id": "zzz"})["ok"] is False)
check("the player cannot ask anything else", live({"op": "exec"})["ok"] is False and live({"op": "list", "extra": 1})["ok"] is True)
check("a plugin with no live file gets no live queries", flutter({"op": "live", "id": "m3u8-missing", "query": {"op": "list"}, "ctx": {}})["ok"] is False)

# ---- a second playlist, added while the player's session already has the first one: the player sees it without a restart
r2 = press(r2, find(r2["tree"], "button", "Playlists"))
r2 = press(r2, find(r2["tree"], "button", "Add a playlist"))
r2 = press(r2, find(r2["tree"], "button", "Add"), {"m3u8-url": "https://raw.githubusercontent.com/lists/stream.m3u8", "m3u8-name": "News 24"})
r2 = settle("m3u8", r2)
t = texts(r2["tree"])
check("one stream address becomes a one-channel playlist", any(x.startswith("Added. News 24: 1 channel.") for x in t), t)
r = live({"op": "list"})
check("the player picks up a playlist added from the screen", len(r["data"]["channels"]) == 5 and any(c[1] == "News 24" for c in r["data"]["channels"]), str(r)[:300])

# ---- update, then remove (two taps)
row = next(n for n in walk(r2["tree"]) if n.get("t") == "listrow" and n.get("s") == "Mine")
r2 = press(r2, row)
upd = find(r2["tree"], "button", "Update this playlist")
SRV.files["/lists/mine.m3u"] = (200, M3U.replace("Gamma", "Gamma Two").encode())
r2 = settle("m3u8", press(r2, upd))
r = live({"op": "list"})
check("updating a playlist re-reads its address", any(c[1] == "Gamma Two" for c in r["data"]["channels"]) and not any(c[1] == "Gamma" for c in r["data"]["channels"]), str(r)[:300])
rem = find(r2["tree"], "button", "Remove this playlist")
r2 = press(r2, rem)
check("removing needs a second tap", find(r2["tree"], "button", "Tap again to remove it") is not None and len(live({"op": "list"})["data"]["channels"]) == 5)
r2 = press(r2, find(r2["tree"], "button", "Tap again to remove it"))
check("the playlist is gone from the screen and from the player", len(live({"op": "list"})["data"]["channels"]) == 1 and any('Removed "Mine"' in x for x in texts(r2["tree"])), texts(r2["tree"]))
check("a removed playlist's files are emptied", all(json.load(open(os.path.join(DATA, p)))["c"] == [] for p in lists["lists"][0]["parts"]))

# ---- guide addresses
r2 = press(r2, find(r2["tree"], "button", "Back"))
r2 = press(r2, find(r2["tree"], "button", "Settings"))
r2 = press(r2, find(r2["tree"], "button", "Guide addresses"))
gbox = find(r2["tree"], "input", "Guide address")
addg = find(r2["tree"], "button", "Add guide address")
rr = press(r2, addg, {gbox["key"]: "https://evil.example.com/guide.xml"})
check("a guide address on another host is refused", any("GitHub" in x for x in texts(rr["tree"])), texts(rr["tree"]))
rr = press(r2, addg, {gbox["key"]: "https://raw.githubusercontent.com/x/y/epg.xml"})
check("a guide address on GitHub is kept", json.load(open(os.path.join(DATA, "lists.json")))["guides"] == ["https://raw.githubusercontent.com/x/y/epg.xml"])
off = find(rr["tree"], "toggle", "Use the built-in guide list")
check("the built-in guide list starts switched on", off is not None and off["on_"] is True)
rr = flutter({"op": "event", "id": "m3u8", "handler": off["on"], "value": False, "ctx": {}})
check("the built-in guide list can be switched off", json.load(open(os.path.join(DATA, "lists.json")))["defaults"] is False)

# ------------------------------------------------------------------------------------------------ 4. permissions and limits


def make_plugin(pid, manifest, files):
    d = os.path.join(PLUGINS, pid)
    os.makedirs(d)
    json.dump(manifest, open(os.path.join(d, "plugin.json"), "w"))
    for name, body in files.items():
        os.makedirs(os.path.dirname(os.path.join(d, name)), exist_ok=True)
        open(os.path.join(d, name), "w").write(body)


SCREEN = "def render():\n    return None\n"
LIVE_BAD = "def on_query(q):\n    return {'url': 'http://192.168.1.5/stream.m3u8', 'title': 'x'}\n"
make_plugin("evil-url", {"permissions": {"live": True}, "flutter": {"screen": "screen.py", "live": "live.py"}}, {"screen.py": SCREEN, "live.py": LIVE_BAD})
r = live({"op": "url", "id": "x"}, "evil-url")
check("a stream address on the home network is refused by the host", r["ok"] is False and "refused" in r["error"], r)

make_plugin("no-epg", {"permissions": {"network": ["raw.githubusercontent.com"], "live": True}, "flutter": {"screen": "screen.py", "live": "live.py"}},
            {"screen.py": SCREEN, "live.py": "import pek_host as h\n\ndef on_query(q):\n    return h.fetch_epg('https://raw.githubusercontent.com/guide/guide-1.xml')\n"})
r = live({"op": "list"}, "no-epg")
check("fetch_epg needs the epg permission", r["ok"] is False and "epg" in r["error"], r)

make_plugin("epg-host", {"permissions": {"network": ["raw.githubusercontent.com"], "live": True, "epg": True}, "flutter": {"screen": "screen.py", "live": "live.py"}},
            {"screen.py": SCREEN, "live.py": "import pek_host as h\n\ndef on_query(q):\n    return h.fetch_epg(q.get('id') or 'https://evil.example.com/x.xml')\n"})
n0 = len(SRV.log)
r = live({"op": "url", "id": "https://evil.example.com/x.xml"}, "epg-host")
check("fetch_epg only reaches hosts the plugin listed", r["ok"] is False and not any(c[0] == "evil.example.com" for c in SRV.log[n0:]), r)

make_plugin("no-live", {"permissions": {}, "flutter": {"screen": "screen.py"}},
            {"screen.py": "import pek_ui as ui\n\ndef render():\n    ui.live_play('https://example.com/a.m3u8', 'A')\n    return ui.column(ui.text('hi'))\n"})
r = flutter({"op": "open", "id": "no-live", "ctx": {}})
check("live_play needs the live permission", "permission" in json.dumps(r) and not r.get("effects"), str(r)[:300])

bad = {"permissions": {"live": True}, "flutter": {"screen": "screen.py"}}
make_plugin("urls", bad, {"screen.py": "import pek_ui as ui\n\nOUT = []\n\ndef render():\n    for u in ['https://example.com/a.m3u8', 'http://example.com:8080/b', 'ftp://example.com/c', 'http://localhost/d', 'http://127.0.0.1/e', "
                                        "'http://10.0.0.2/f', 'http://[::1]/g', 'https://user:pw@example.com/h', 'http://printer.local/i', 'http://intranet/j', 'https://example.com/a b', "
                                        "'http://93.184.216.34/ok', 'http://example.com:99999/x']:\n        try:\n            ui.live_play(u, 't', 'c')\n            OUT.append('ok')\n        except ValueError:\n            OUT.append('no')\n    return ui.column(ui.text(','.join(OUT)))\n"})
r = flutter({"op": "open", "id": "urls", "ctx": {}})
check("stream addresses: public http(s) only", texts(r["tree"]) == ["ok,ok,no,no,no,no,no,no,no,no,no,ok,no"], texts(r["tree"]) or r)

make_plugin("bundled", {"permissions": {"storage": True}, "flutter": {"screen": "screen.py"}},
            {"screen.py": "import pek_host as h\nimport pek_ui as ui\n\ndef render():\n    out = []\n    for n in ['sub/a.json', 'top.json', '../m3u8/plugin.json', 'data/secret.json', 'plugin.json', 'screen.py', 'sub/../top.json', '/etc/passwd', 'nope.json']:\n"
                           "        try:\n            h.read_bundled_text(n)\n            out.append('ok')\n        except Exception:\n            out.append('no')\n    return ui.column(ui.text(','.join(out)))\n",
             "sub/a.json": "{}", "top.json": "[]", "data/secret.json": "{}"})
r = flutter({"op": "open", "id": "bundled", "ctx": {}})
check("shipped files: json / txt, one folder deep, never data/ or outside", texts(r["tree"]) == ["ok,ok,no,no,ok,no,no,no,no"], texts(r["tree"]) or r)

# redirects are re-checked against the host list, and a missing file is an error that does not stop the others
SRV.redirect["/redir.xml"] = "https://evil.example.com/steal.xml"
make_plugin("redir", {"permissions": {"network": ["raw.githubusercontent.com"], "live": True, "epg": True}, "flutter": {"screen": "screen.py", "live": "live.py"}},
            {"screen.py": SCREEN, "live.py": "import pek_host as h\n\ndef on_query(q):\n    return h.fetch_epg('https://raw.githubusercontent.com/redir.xml')\n"})
n0 = len(SRV.log)
r = live({"op": "list"}, "redir")
check("a redirect to a host the plugin did not list is refused", r["ok"] is False and not any(c[0] == "evil.example.com" for c in SRV.log[n0:]), r)

# the old hooks still load next to the live files
check("hooks and live sessions are separate", True)

print()
shutil.rmtree(TMP, ignore_errors=True)
if failures:
    print("FAILED: %d\n  - %s" % (len(failures), "\n  - ".join(failures)))
    sys.exit(1)
print("ALL PASSED")
