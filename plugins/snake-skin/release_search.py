"""Release search for Snake Skin (runs inside Hesper's plugin guard: no requests / bs4).

Add search sites in the SITES list below (or run add_site.py). Each entry is a search address
with {q} where the search words go. The page may be JSON or a web page that shows magnet links.
Remember: every site's host must also be listed under "network" in plugin.json.
"""
import html
import json
import math
import re
import unicodedata
from urllib.parse import quote, quote_plus

import hesper_host as h

SITES = [
    # SITES-START
    "https://yify.mobi/search/?q={q}",
    "https://1337x.to/search/{q}/1/",
    "https://thepiratebay.party/search/{q}/1/99/0",
    # SITES-END
]

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
]


# --------------------------------------------------------------------------- query
def normalize(text):
    t = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    t = t.lower().replace("&", " and ")
    t = re.sub(r"['`]", "", t)
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def build_query(title, season=0, episode=0, year=0):
    """'The Office', 2, 5 -> 'the office S02E05'; a movie -> 'dune 2021'."""
    parts = [normalize(title)]
    if season and episode:
        parts.append("S%02dE%02d" % (int(season), int(episode)))
    elif year:
        parts.append(str(int(year)))
    return " ".join(p for p in parts if p)


# --------------------------------------------------------------------------- reading a page
def _num(text):
    digits = re.sub(r"\D", "", str(text if text is not None else ""))
    return int(digits) if digits else 0


def _first(obj, keys):
    for k in keys:
        if obj.get(k) not in (None, ""):
            return obj.get(k)
    return ""


def _magnet(hash_, name):
    return "magnet:?xt=urn:btih:%s&dn=%s%s" % (
        hash_, quote(name), "".join("&tr=" + quote(t, safe="") for t in TRACKERS))


def _find_items(node, depth=0):
    if depth > 3:
        return None
    if isinstance(node, list):
        if node and all(isinstance(x, dict) for x in node) and any(
                _first(x, ["name", "title", "torrent_name", "release"]) for x in node):
            return node
        return None
    if isinstance(node, dict):
        for v in node.values():
            found = _find_items(v, depth + 1)
            if found:
                return found
    return None


def _from_json(data):
    out = []
    for o in _find_items(data) or []:
        title = str(_first(o, ["name", "title", "torrent_name", "release"]))
        magnet = str(_first(o, ["magnet", "magnet_link", "magnetLink", "magnet_uri", "magnetUri"]))
        hash_ = str(_first(o, ["info_hash", "infohash", "infoHash", "hash", "btih"]))
        seeders = _num(_first(o, ["seeders", "seeds", "seed", "se"]))
        ident = str(o.get("identifier") or "")
        if not magnet.lower().startswith("magnet:?"):
            if re.fullmatch(r"[0-9a-fA-F]{40}", hash_):
                magnet = _magnet(hash_, title)
            elif re.fullmatch(r"[A-Za-z0-9._-]+", ident):      # archive.org item: its .torrent file
                magnet = "https://archive.org/download/%s/%s_archive.torrent" % (ident, ident)
                seeders = _num(o.get("downloads"))              # popularity stands in for seeders
            else:
                magnet = ""
        if title and magnet:
            out.append({"title": title, "source": magnet, "seeders": seeders,
                        "size": _num(_first(o, ["size", "size_bytes", "bytes", "item_size", "total_size"]))})
    return out


def _size_from_text(text):
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b", text, re.I)
    if not m:
        return 0
    mult = {"k": 1024, "m": 1048576, "g": 1073741824, "t": 1099511627776}[m.group(2)[0].lower()]
    return int(float(m.group(1).replace(",", ".")) * mult)


def _from_html(text):
    out, seen = [], set()
    for m in re.finditer(r"""href\s*=\s*["'](magnet:\?[^"']+)["']""", text, re.I):
        href = html.unescape(m.group(1))
        hm = re.search(r"btih:([0-9a-z]{32,40})", href, re.I)
        if not hm or hm.group(1).lower() in seen:
            continue
        seen.add(hm.group(1).lower())
        start = text.rfind("<tr", 0, m.start())
        if start < 0 or m.start() - start > 4000:
            start = max(0, m.start() - 800)
        end = text.find("</tr>", m.end())
        if end < 0 or end - m.end() > 4000:
            end = min(len(text), m.end() + 800)
        row = text[start:end]
        title = ""
        dn = re.search(r"[?&]dn=([^&]+)", href)
        if dn:
            title = re.sub(r"\+", " ", dn.group(1))
            title = re.sub(r"%([0-9A-Fa-f]{2})", lambda x: chr(int(x.group(1), 16)), title)
        if len(title) < 6:
            for link in re.finditer(r"<a\b[^>]*>(.*?)</a>", row, re.S | re.I):
                t = html.unescape(re.sub(r"<[^>]+>", "", link.group(1))).strip()
                if len(t) > len(title):
                    title = t
        seeders = -1
        sm = re.search(r"""class\s*=\s*["'][^"']*seed[^"']*["'][^>]*>\s*(?:<[^>]+>\s*)*(\d[\d,]*)""", row, re.I)
        if sm:
            seeders = _num(sm.group(1))
        else:
            cells = re.findall(r"<td[^>]*>\s*(\d[\d,]*)\s*</td>", row, re.I)
            if len(cells) >= 2:
                seeders = _num(cells[0])
        out.append({"title": title, "source": href, "seeders": seeders, "size": _size_from_text(row)})
    return out


def parse_body(text):
    t = str(text or "").strip()
    if t[:1] in ("{", "["):
        try:
            return _from_json(json.loads(t))
        except ValueError:
            pass
    return _from_html(t)


# --------------------------------------------------------------------------- scoring
def _episode_match(name, season, episode):
    n = name.lower()
    s, e = int(season), int(episode)
    if re.search(r"s0*%d[ ._-]?e0*%d(?!\d)" % (s, e), n) or re.search(r"(?<!\d)%dx0*%d(?!\d)" % (s, e), n):
        return "episode"
    if re.search(r"s0*%d(?!\d|e)" % s, n) or re.search(r"season[ ._-]*0*%d(?!\d)" % s, n):
        return "pack"
    return None


def _quality(name):
    n = normalize(name)
    if re.search(r"\b(2160p|4k|uhd)\b", n):
        return 2160
    for q in (1080, 720, 480):
        if "%dp" % q in n:
            return q
    return 0


def _size_text(b):
    if not b or b < 2:
        return "size unknown"
    units, i, v = ["B", "KB", "MB", "GB", "TB"], 0, float(b)
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return ("%.2f %s" if i >= 3 else "%.0f %s") % (v, units[i])


def score(item, title, season=0, episode=0, year=0):
    """A number, or None when the result should be dropped."""
    name = item["title"]
    norm = normalize(name)
    padded = " " + norm + " "
    if item["seeders"] == 0:
        return None
    if not all((" %s " % tok) in padded for tok in normalize(title).split()):
        return None
    total = 0.0
    if season and episode:
        kind = _episode_match(name, season, episode)
        if kind is None:
            return None
        total += 60 if kind == "episode" else 15
    elif year:
        if re.search(r"(?<!\d)%d(?!\d)" % int(year), name):
            total += 25
        elif re.search(r"(?<!\d)(19|20)\d\d(?!\d)", name):
            return None
    # Not a full movie/episode: trailers, commercials, clips and tiny files.
    if re.search(r"\b(trailer|teaser|commercial|promo|featurette|behind the scenes|review|reaction|clips?|sample|soundtrack|ost)\b", norm):
        return None
    if item["size"] > 1 and item["size"] < (40 if (season and episode) else 350) * 1048576:
        return None
    q = _quality(name)
    total += {2160: 12, 1080: 15, 720: 8, 480: 2}.get(q, 0)
    if re.search(r"\b(cam|camrip|hdcam|ts|hdts|telesync|tc)\b", norm):
        return None
    if item["seeders"] > 0:
        total += min(math.log10(item["seeders"] + 1) * 20, 60)
    return total


# --------------------------------------------------------------------------- public entry
def find_releases(title, season=0, episode=0, year=0, sites=None):
    """Query every site, parse, drop bad results, score. Best first."""
    variants = [build_query(title, season, episode, year)]
    if year and not (season and episode):
        variants.append(normalize(title))          # some sites do better without the year
    items, last_error = [], None
    for words in variants:
        for tmpl in (sites if sites is not None else SITES):
            try:
                body = h.fetch_text(tmpl.replace("{q}", quote_plus(words)),
                                    headers={"User-Agent": USER_AGENT}, timeout=8, max_bytes=1000000)
                items.extend(parse_body(body))
            except Exception as err:  # one broken site must not stop the others
                last_error = err
        if items:
            break
    if not items and last_error is not None:
        raise last_error
    ranked, seen = [], set()
    for it in items:
        sc = score(it, title, season, episode, year)
        key = it["source"].lower()
        if sc is None or key in seen:
            continue
        seen.add(key)
        ranked.append((sc, it))
    ranked.sort(key=lambda p: p[0], reverse=True)
    return [{
        "title": it["title"], "source": it["source"], "seeders": max(0, it["seeders"]),
        "size": it["size"], "size_text": _size_text(it["size"]), "quality": _quality(it["title"]),
        "pack": bool(season and episode and _episode_match(it["title"], season, episode) == "pack"),
        "score": round(sc, 1),
    } for sc, it in ranked][:25]


def find_best_release(title, season=0, episode=0, year=0, sites=None):
    found = find_releases(title, season, episode, year, sites)
    return found[0] if found else None
