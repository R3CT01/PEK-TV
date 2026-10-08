# Snake Skin

A third-party PEK plugin: browse movies and TV (trending, top rated, popular, now playing),
filter by streaming service, watch trailers, see the cast, and press **Play**.

## Play
- **Movie:** open it and press Play.
- **TV show:** open it, pick a season, tap an episode.

Snake Skin's built-in release search builds a query for that title/episode, fetches and scores the results, then PEK buffers the start
and opens the player while the rest downloads. Closing the player stops the torrent and deletes the
temporary data. If several releases are found, the best match (quality + seeders) plays; turn on
**Settings > Playing > Let me choose the release** to pick yourself. After playing, "Other releases"
lists the alternatives in case one was bad.

## What you need
1. **A TMDb API key** (free, v3): themoviedb.org > Settings > API. Paste it in this plugin's Settings tab.
2. **Search sites (no Torznab needed).** The list lives between the `SITES-START` / `SITES-END` markers in
   `ui.js` and `release_search.py`. Easiest: run `python add_site.py "https://site/search?q={q}"` (from the
   plugin folder's parent, see add_site.py); it adds the link to both files and the host to `plugin.json`.
   No sites are built in: Snake Skin only searches the sites you add. Reinstall the plugin after changing sites.
3. **A PEK build with the torrent engine** (otherwise the Play button says it can't play torrents).

## Permissions (shown when you install it)
- `network`: api.themoviedb.org, image.tmdb.org, www.youtube-nocookie.com
- `storage`: its own settings (your TMDb key, trailer options)
- `library`: its Python part reads titles + years (not file names) to mark "In library"
- `torrent`: start streams through PEK

Data: TMDb. Streaming availability: JustWatch (via TMDb). Trailers: YouTube.
