"""Snake Skin backend.

Runs once when PEK starts. It asks PEK for the titles in your library
(titles and years only, never file names or folders) and saves a small list to
data/library.json, which ui.js reads to mark the titles you already own.

It also ships the Python release search (release_search.py): `search()` below builds the
query, GETs the provider, parses it and returns the scored list. The same logic runs in
ui.js when you press Play, because that is where the click happens.
"""
import hesper_host as h

try:  # optional: needs `requests` and `beautifulsoup4` in PEK's Python
    import release_search as rs
except Exception as err:  # the library badge feature must keep working without them
    rs = None
    h.log("release search not loaded:", err)


def clean(text):
    return " ".join(str(text or "").split())


def search(title, season=0, episode=0, year=0):
    """Scored release list for a movie (season = episode = 0) or one episode, best first."""
    if rs is None:
        return []
    try:
        return rs.find_releases(clean(title), int(season or 0), int(episode or 0), int(year or 0))
    except Exception as err:
        h.log("release search failed:", err)
        return []


def run():
    try:
        items = h.library_titles()
    except Exception as err:
        h.log("library list not available:", err)
        items = []

    movies = []
    shows = []
    seen_movies = set()
    seen_shows = set()
    for item in items:
        title = clean(item.get("title"))
        if not title:
            continue
        if item.get("kind") == "movie":
            year = int(item.get("year") or 0)
            key = (title.lower(), year)
            if key not in seen_movies:
                seen_movies.add(key)
                movies.append({"title": title, "year": year})
        else:
            key = title.lower()
            if key not in seen_shows:
                seen_shows.add(key)
                shows.append({"title": title})

    h.write_json("library.json", {"movies": movies, "shows": shows})
    h.log("saved %d movies and %d shows" % (len(movies), len(shows)))
