# TMDb Discover

Trending, top rated, popular and now playing rows for movies and TV, streaming-service chips
(Netflix, Hulu, Disney+ ...), search, and an "In library" badge on titles you own. Open a title to get a
trailer that plays by itself at the top of the page, the description, the cast and more titles like it.

## No key needed

TMDb Discover is an official PEK TV plugin. It comes with the app and uses PEK TV's built-in TMDb access,
so you can open the **Discover** tab and start browsing straight away.

Optional: under **Settings > TMDb access** you can paste your own free v3 API key (themoviedb.org > Settings > API).
It is stored only in this plugin's private storage on this device and is sent only to api.themoviedb.org.
Remove it to go back to the built-in access.

## Pages

Every row has a **See all** button (and a last tile) that opens the whole list as numbered pages.
Use **Next** and **Prev** to move one page at a time, or **10 »** / **« 10** to jump ten. TMDb serves up to 500 pages
per list. Search results are paged the same way. The page after the one you are on is fetched in the background,
so Next is usually instant.

## Trailers

Open a title and its trailer sits at the very top of the page and starts by itself. Under **Settings > Trailers**:

- **Auto-play trailers** turns the automatic start on or off. When off, the player is still there; press play.
- **Trailer sound** turns sound off for trailers. If your device does not let a trailer start with sound,
  switch this off and the trailer will start muted.

Trailers are YouTube videos played through youtube-nocookie.com. That address is listed under this plugin's
network permissions. PEK TV sends nothing about you to it except what any embedded video player sends.

## Cast and more titles like it

Under the description, **Cast** shows the top billed actors with the characters they play. Press one to see their
other films and shows. **More like this** shows titles TMDb recommends for the one you opened. Press any title
to open it; Back steps back through everything you opened.

## Remote control and keyboard

Arrow keys move around, OK / Enter opens, and **Back** (Esc, Backspace or the remote's Back) steps out one screen
at a time: trailer page, then the list, then the rows, and only then does it close the plugin. Focus returns to the
title you came from. A loading wheel shows while a row or page is on its way.

## Region and language

Both follow the device (for example en-GB gives region GB). Change the region under Discover > Settings.

## "In library" badges

`backend.py` runs when PEK TV starts and saves the titles and years of your library to `data/library.json`.
Titles are compared after normalizing (case, accents, punctuation, "&"/"and", leading "The"), movies allow a
one-year difference. After installing, close and reopen PEK TV once so this runs.

Data provided by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
Streaming availability data provided by JustWatch.

## Favorites (1.3.0)

Open a title and press **♡ Add to favorites** (next to Back). It is added to PEK TV's **Favorites** tab, which is shared
with other plugins; press a favorite there to open it again, press and hold to remove it.

## Watch on... (1.3.0)

Under the description, every service the title streams on in your region (and, separately, where to rent or buy it) shows as a
button with the service's logo. Press one to open that service: on Android its app (or its website if the app is not installed),
elsewhere its website. A title that is on no service lists nothing. If the title is out and another installed plugin can play
movies and shows, a **Play with ...** button opens that plugin on the title.

## 1.7.1
- Pictures no longer stay blank until you refresh: a TMDb request that fails (a cold proxy, a 429 / 5xx answer, a dropped connection) is tried again by itself for up to about 11 seconds before the row shows an error. Posters that could not load are asked for again by the app.

## 1.7.2
- Trailer is full width and covers the top half of the screen on a TV, plays with no YouTube controls, play button or icons, and scrolls away with the page instead of staying pinned over the buttons.
- Remote: the D-pad no longer gets stuck in search boxes.
- Movie and show cards are landscape on a TV and portrait on a phone.

## 1.8.0
- Rate what you watch: the detail page has a "Rate this movie / show" line with ten star buttons. It is your own rating in PEK TV (the same one shown on the posters and sent to Trakt); press the star you already gave to take the rating off.

## 1.8.1
- Discover opens faster: the movie and TV rows are kept on the device and shown at once the next time (refreshed quietly when they are older than 30 minutes; the Refresh button always loads everything fresh).
- Posters further along a row are downloaded ahead of time, so scrolling sideways shows pictures instead of empty tiles.
- A poster that is still downloading shows a quiet empty tile, not its title, so a slow connection no longer looks like a title with no artwork.
