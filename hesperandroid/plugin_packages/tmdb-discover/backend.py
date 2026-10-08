"""PEK Discover backend.

Runs once when Hesper starts. It asks Hesper for the titles in your library
(titles and years only, never file names or folders) and saves a small list to
data/library.json, which ui.js reads to mark the titles you already own.
"""
import hesper_host as h


def clean(text):
    return " ".join(str(text or "").split())


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
