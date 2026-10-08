# PEK Discover

Trending, top rated, popular and now playing rows for movies and TV, streaming-service chips
(Netflix, Hulu, Disney+ ...), search, descriptions, and an "In library" badge on titles you own.

## Add your TMDb key

1. Make a free account at themoviedb.org, then open Settings > API and copy the **API Key** (the short v3 key, not the long "Read Access Token").
2. In PEK open the **Discover** tab. It starts on **Settings**.
3. Paste the key into **API Key (v3)** and tap **Save key**. PEK checks it with TMDb before saving.

The key is stored only in this plugin's private storage on this device and is sent only to api.themoviedb.org.

## Region and language

Both follow the device (for example en-GB gives region GB). Change the region under Discover > Settings.

## "In library" badges

`backend.py` runs when PEK starts and saves the titles and years of your library to `data/library.json`.
Titles are compared after normalizing (case, accents, punctuation, "&"/"and", leading "The"), movies allow a
one-year difference. After installing, close and reopen PEK once so this runs.

Data provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
Streaming availability data provided by JustWatch.
