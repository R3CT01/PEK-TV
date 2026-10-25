"""pek_epg: the XMLTV (TV guide) reader behind pek_host.fetch_epg().

This is HOST code (trusted, like hesper_guard.py), not plugin code. A plugin with the "epg" permission asks
pek_host.fetch_epg(url, ...) for one guide file; hesper_guard downloads it (only from a host in the plugin's
permissions.network, public addresses only, redirects re-checked) and hands the text to parse() here.

Why it is host code and not something every plugin does for itself:
  - a daily guide file is several MB; fetch_text() stops at 1 MB, and a regex over that much text plus a Python loop per
    programme would eat the time limit of a sandboxed screen;
  - the filter (only the channels the plugin actually has, only the next day or so) keeps what reaches the plugin, and
    what it has to store, small;
  - one reader means "Channel Name HD" and "channel name" match the same way in every plugin.

No XML library is used: the text is cut with regular expressions and only the five standard entities and numeric
references are decoded, so a hostile file cannot expand entities or fetch anything.
"""
import calendar
import html
import re

MAX_RAW_BYTES = 12 * 1000 * 1000        # what one guide download may be (after any gzip is unpacked: MAX_TEXT_BYTES)
MAX_TEXT_BYTES = 40 * 1000 * 1000
MAX_PER_CHANNEL = 80                    # programmes kept per channel inside the window
MAX_SCAN = 600000                       # programmes looked at in one file
TITLE_MAX = 120
DESC_MAX = 240

_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)
_QUALITY = re.compile(r"(fhd|uhd|hevc|4k|hd|sd)+$")
_ATTR = re.compile(r"""([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
_CHANNEL = re.compile(r"<channel\s+([^>]*)>(.*?)</channel>", re.S)
_DISPLAY = re.compile(r"<display-name[^>]*>(.*?)</display-name>", re.S)
_PROGRAMME = re.compile(r"<programme\s+([^>]*?)(?:/>|>(.*?)</programme>)", re.S)
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.S)
_DESC = re.compile(r"<desc[^>]*>(.*?)</desc>", re.S)
_CDATA = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.S)
_TAGS = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")
_TIME = re.compile(r"^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?\s*$")


def norm_name(s):
    """A channel name reduced to letters and digits, a trailing quality tag (HD, SD, FHD, UHD, 4K, HEVC) removed:
    "CNN HD" and "cnn" are the same channel."""
    n = _NON_WORD.sub("", str(s if s is not None else "").lower())
    t = _QUALITY.sub("", n)
    return t or n


def _text(s):
    """The text inside an element: CDATA kept as literal text, other tags dropped, entities decoded, spaces squeezed."""
    s = _CDATA.sub(lambda m: m.group(1).replace("&", "&amp;").replace("<", "&lt;"), s or "")
    s = _TAGS.sub("", s)
    return _SPACE.sub(" ", html.unescape(s)).strip()


def _attrs(s):
    out = {}
    for m in _ATTR.finditer(s or ""):
        out[m.group(1).lower()] = m.group(2) if m.group(2) is not None else m.group(3)
    return out


def xmltv_time(s):
    """'20261012180000 +0200' -> seconds since 1970 (no zone means UTC). 0 when it is not a time."""
    m = _TIME.match(str(s or ""))
    if not m:
        return 0
    y, mo, d, hh, mi, ss, zone = m.groups()
    try:
        t = calendar.timegm((int(y), int(mo), int(d), int(hh), int(mi), int(ss or 0), 0, 0, 0))
    except (ValueError, OverflowError):
        return 0
    if zone:
        off = int(zone[1:3]) * 3600 + int(zone[3:5]) * 60
        t -= -off if zone[0] == "-" else off
    return t


def parse(text, now, back_s=3 * 3600, ahead_s=36 * 3600, want_ids=None, want_names=None):
    """XMLTV text -> {"programmes": {channel id: [[start, stop, title, desc], ...]}, "names": {channel id: [normalized names]},
    "channels": n, "kept": n}.

    want_ids:   lower-case XMLTV channel ids the caller has (None = keep every channel);
    want_names: normalized names (norm_name) the caller has: a channel whose id is not wanted is still kept when one
                of its display names matches (None = no name matching).
    Only programmes that end after now - back_s and start before now + ahead_s are kept, sorted, at most MAX_PER_CHANNEL
    per channel. Titles are cut to TITLE_MAX and descriptions to DESC_MAX characters."""
    ids = set(str(i).lower() for i in want_ids) if want_ids is not None else None
    names_wanted = set(want_names) if want_names is not None else None
    filtering = ids is not None or names_wanted is not None
    lo, hi = now - back_s, now + ahead_s

    keep = {}                                    # channel id (as written in the file) -> normalized display names
    total = 0
    for m in _CHANNEL.finditer(text):
        cid = _attrs(m.group(1)).get("id")
        if not cid:
            continue
        total += 1
        norm = [norm_name(_text(d)) for d in _DISPLAY.findall(m.group(2))]
        norm = [n for n in norm if n]
        if not filtering or (ids is not None and cid.lower() in ids) or (names_wanted is not None and any(n in names_wanted for n in norm)):
            keep[cid] = norm
    programmes = {}
    scanned = kept = 0
    for m in _PROGRAMME.finditer(text):
        scanned += 1
        if scanned > MAX_SCAN:
            break
        a = _attrs(m.group(1))
        cid = a.get("channel")
        if not cid or (filtering and cid not in keep):
            continue
        s, e = xmltv_time(a.get("start")), xmltv_time(a.get("stop"))
        if not s or not e or e <= lo or s >= hi or e <= s:
            continue
        body = m.group(2) or ""
        t = _TITLE.search(body)
        title = _text(t.group(1)) if t else ""
        if not title:
            continue
        d = _DESC.search(body)
        row = programmes.setdefault(cid, [])
        if len(row) < MAX_PER_CHANNEL * 2:       # a little slack: sorted and cut below
            row.append([s, e, title[:TITLE_MAX], _text(d.group(1))[:DESC_MAX] if d else ""])
    for cid, row in programmes.items():
        row.sort(key=lambda p: p[0])
        del row[MAX_PER_CHANNEL:]
        kept += len(row)
    return {"programmes": programmes, "names": {c: keep.get(c, []) for c in programmes}, "channels": total, "kept": kept}


def unpack(raw):
    """The body of a download as text. A gzip file (a .xml.gz guide) is unpacked, never past MAX_TEXT_BYTES."""
    if raw[:2] == b"\x1f\x8b":
        import zlib
        d = zlib.decompressobj(31)
        out = d.decompress(raw, MAX_TEXT_BYTES + 1)
        if len(out) > MAX_TEXT_BYTES or d.unconsumed_tail:
            raise ValueError("guide file larger than %d MB once unpacked" % (MAX_TEXT_BYTES // 1000000))
        raw = out
    return raw.decode("utf-8", "replace")
