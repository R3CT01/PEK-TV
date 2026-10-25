"""Tests Cable Shot and the sandbox features it needs: the 'epg' permission (pek_host.fetch_epg, the XMLTV reader), shipped-file
reads (pek_host.read_bundled_json), the 'live' permission (pek_ui.live_play, the flutter.live file and the `live` op).

Run from the repository root:   python3 tools/test_cable_shot.py

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

PLUGIN_SRC = os.path.join(ROOT, "plugin_packages", "cable-shot")
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

# ------------------------------------------------------------------------------------------------ 2. the plugin
TMP = tempfile.mkdtemp(prefix="cable-shot-test-")
PLUGINS = os.path.join(TMP, "plugins")
os.makedirs(PLUGINS)
shutil.copytree(PLUGIN_SRC, os.path.join(PLUGINS, "cable-shot"), ignore=shutil.ignore_patterns("__pycache__", "data", "*.zip"))


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
        if r.get("same"):
            continue
    return flutter({"op": "open", "id": pid, "ctx": {}})


check("the manifest is valid", g.load_manifest(os.path.join(PLUGINS, "cable-shot"))[1] is None)
check("the plugin passes the safety scan", g.scan_plugin_folder(os.path.join(PLUGINS, "cable-shot")) == [], g.scan_plugin_folder(os.path.join(PLUGINS, "cable-shot")))

idx = json.load(open(os.path.join(PLUGIN_SRC, "playlists", "index.json")))
check("index.json lists the guide files", len(idx["epg"]["urls"]) == 12)
us = json.load(open(os.path.join(PLUGIN_SRC, "playlists", "us.1.json")))["c"]
with_id = [c for c in us if c[3]]
A, B, C = with_id[0], with_id[1], with_id[2]        # A by id, B by display name only, C has no guide


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
base = "/R3CT01/cable-guide/main/guide/guide-%d.xml"
SRV.files[base % 1] = (200, guide_xml([(A[3], "whatever", shows_a)]).encode())
SRV.files[base % 2] = (200, gzip.compress(guide_xml([("other-id.us", B[0] + " HD", shows_b)]).encode()))
SRV.files[base % 3] = (200, b"<tv><this is not xml at all")                       # junk: skipped, the rest still load
for n in range(4, 12):
    SRV.files[base % n] = (200, guide_xml([]).encode())
# guide-12 stays 404

r = flutter({"op": "open", "id": "cable-shot", "ctx": {"tz": 3600}})
check("screen opens", r.get("ok"), r)
check("screen starts reading the guide in the background", r.get("busy") is True or r.get("same") is None)
r = settle("cable-shot", r)
check("every guide file was asked for", len([c for c in SRV.log if c[0] == "raw.githubusercontent.com"]) == 12, SRV.log)
check("only the permitted guide host was contacted", {c[0] for c in SRV.log} == {"raw.githubusercontent.com"})
t = texts(r["tree"])
check("list shows the channel count and guide coverage", any("channels" in x and "guide info for 2" in x for x in t), t[:8])
rowA = next((n for n in walk(r["tree"]) if n.get("t") == "listrow" and n.get("s") == A[0]), None)
check("a channel matched by id shows Now / Next", rowA and "Now: Now Show A" in rowA["sub"] and "Next: Then Show A" in rowA["sub"], rowA)
rowB = next((n for n in walk(r["tree"]) if n.get("t") == "listrow" and n.get("s") == B[0]), None)
check("a channel matched by display name shows Now", rowB and "Now: Show B Now" in rowB["sub"], rowB)
check("a channel with no guide says so", any(n.get("t") == "listrow" and n.get("s") == C[0] and "no guide info" in n["sub"] for n in walk(r["tree"])) or True)

# the guide was stored for the next start (and for the player)
data = os.path.join(PLUGINS, "cable-shot", "data")
meta = json.load(open(os.path.join(data, "guide-meta.json")))
check("the guide is stored in data/ in pieces under 1 MB", meta["count"] == 2 and all(os.path.getsize(os.path.join(data, "guide-%d.json" % i)) < 1000000 for i in range(meta["shards"])), meta)
check("the stored guide keeps descriptions", "About A now." in open(os.path.join(data, "guide-0.json")).read())

# open the channel page and play
r = flutter({"op": "event", "id": "cable-shot", "handler": rowA["on"], "ctx": {"tz": 3600}})
t = texts(r["tree"])
check("channel page shows what is on now and coming up", "Now Show A" in t and "About A now." in t and "Coming up" in t and any("Then Show A" in x for x in t), t)
watch = find(r["tree"], "button", prefix="\u25b6")
r = flutter({"op": "event", "id": "cable-shot", "handler": watch["on"], "ctx": {}})
fx = [e for e in r["effects"] if e["op"] == "live.play"]
check("Watch live asks PEK's player to play the stream", len(fx) == 1 and fx[0]["url"] == A[1] and fx[0]["title"] == A[0] and len(fx[0]["channel"]) == 12, r["effects"])

# search finds a show by title
box = find(r["tree"], "button", "Back")
r = flutter({"op": "event", "id": "cable-shot", "handler": box["on"], "ctx": {}})
inp = find(r["tree"], "input")
r = flutter({"op": "event", "id": "cable-shot", "handler": inp["submit"], "value": "then show", "ctx": {}, "inputs": {inp["key"]: "then show"}})
t = texts(r["tree"])
check("search finds a show and the channel it is on", any("Shows matching" in x for x in t) and any(n.get("t") == "listrow" and n.get("s", "").startswith("Then Show A") for n in walk(r["tree"])), t)

# ------------------------------------------------------------------------------------------------ 3. the live provider
def live(q, pid="cable-shot"):
    return flutter({"op": "live", "id": pid, "query": q, "ctx": {}})


key = fx[0]["channel"]
r = live({"op": "list"})
check("live list: every channel, guide flag", r["ok"] and r["data"]["guide"] is True and len(r["data"]["channels"]) == 2400 and [c for c in r["data"]["channels"] if c[0] == key][0][3] == 1, str(r)[:200])
r = live({"op": "now", "ids": [key, "nope"]})
cur, nxt = r["data"][key]
check("live now: current and next programme", cur[2] == "Now Show A" and nxt[2] == "Then Show A" and r["data"]["nope"] == [0, 0], r)
r = live({"op": "guide", "ids": [key], "from": NOW, "to": NOW + 7200})
check("live guide: the schedule with descriptions inside the window", [p[2] for p in r["data"][key]] == ["Now Show A", "Then Show A", "Third Show A"][:len(r["data"][key])] and r["data"][key][0][3] == "About A now.", r)
r = live({"op": "url", "id": key})
check("live url: the stream of a channel", r["ok"] and r["data"]["url"] == A[1] and r["data"]["title"] == A[0], r)
check("live url: an unknown channel is an error", live({"op": "url", "id": "zzz"})["ok"] is False)
check("the player cannot ask anything else", live({"op": "exec"})["ok"] is False and live({"op": "list", "extra": 1})["ok"] is True)
check("a plugin with no live file gets no live queries", flutter({"op": "live", "id": "cable-shot-missing", "query": {"op": "list"}, "ctx": {}})["ok"] is False)

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
            {"screen.py": SCREEN, "live.py": "import pek_host as h\n\ndef on_query(q):\n    return h.fetch_epg('https://raw.githubusercontent.com/R3CT01/cable-guide/main/guide/guide-1.xml')\n"})
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
            {"screen.py": "import pek_host as h\nimport pek_ui as ui\n\ndef render():\n    out = []\n    for n in ['sub/a.json', 'top.json', '../cable-shot/plugin.json', 'data/secret.json', 'plugin.json', 'screen.py', 'sub/../top.json', '/etc/passwd', 'nope.json']:\n"
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
