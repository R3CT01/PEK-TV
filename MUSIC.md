# Music

The **Music** tab plays the songs in the same folders you already added for movies and shows (local folders and
network sources: SMB, NFS, FTP, WebDAV, UPnP). Nothing extra to set up; put music in one of your source folders and
scan.

## What it shows
- **Albums, Artists, Songs, Playlists, Search**, album and artist pages, a Now Playing screen with the queue, and a
  small player bar that stays on screen while you browse (above the tab bar on phones).
- Shuffle, repeat (off / all / one), seek, 15-second skips, next / previous, play next, add to queue.
- Playlists are kept per profile on this device (not synced to PEK Cloud yet). Your queue and position are
  remembered between sessions (paused, so nothing starts by itself).
- TV remote / keyboard media keys (play-pause, next, previous, stop) work while music is queued.

## Search and filters
The search box finds artists, albums and songs by any words ("drake hotline"; capitals and accents are ignored). Under it, **Genre** and **Year**
narrow whatever you are looking at: the Albums, Artists and Songs tabs, and the search results. **Year** offers decades ("1990s") and single years,
**Genre** the genres found in your tags with a song count each; **Clear** removes both. In music mode's Search page, choosing only a genre or year lists
what matches (so "all Rock from the 1990s" is two taps).
- A genre tag such as `Rock; Pop` counts as both genres (`;` or the NUL separator of ID3v2.4 splits; a `/` does not, so `R&B/Soul` stays one genre).
- An album's year is its earliest song's year; an album's genres are all its songs' genres; an artist passes a filter when one of their albums does.
- Songs with no year tag are left out while a year is chosen; songs with no genre tag while a genre is chosen.
- API: `genre=`, `year=` and `decade=` on `/api/music/albums`, `/artists`, `/songs` and `/search`; `/api/music/facets` lists the genres and years for the pickers.
  Songs and albums also carry `year` / `genres` in their JSON. Code: `music.cpp` (`MusicFilter`), `music_filters.dart` (pickers), `music.dart` (`_onFilters`).

## How songs are recognised
Tags are read straight from the files (no ffprobe, so it works on Android and on network shares): MP3 (ID3v1 / v2.2 /
v2.3 / v2.4), FLAC, Ogg Vorbis / Opus, M4A / M4B. Embedded covers are used; otherwise `cover.jpg`, `folder.jpg`,
`front.jpg` or `albumart.jpg` next to the songs.
Where tags are missing the folder layout fills in (slug-style names such as `21-savage` or `a_lot` are shown as `21 savage`, `a lot`; names with capitals or spaces like `Jay-Z` are left alone): `Artist/Album/01 - Title.mp3`, `Artist - Album/01 Title.mp3`, a
`CD1` / `Disc 2` / `Bonus Tracks` / `Deluxe` / `Extras` sub-folder inside an album, or a loose `Artist - Title.mp3`.
Folders are searched at any depth. A wrapper folder at the top (`Music`, `Songs`, `Audio`, `Download`) is ignored when
working out the artist, and songs lying directly in an artist folder that also has album folders become that artist's
**Singles** album.
Albums are grouped by album + album artist; an album with three or more different artists and no album-artist tag
becomes **Various Artists**. Folders containing a `.nomedia` file are skipped (same as videos).

## Covers and photos
Pictures come from the song's own tag, then `cover.jpg` / `folder.jpg` ... beside it. With **Online art** switched on
(button above the Albums and Artists lists; off by default) the gaps are filled from the internet: artist photos
(Artists list and artist page), album covers, and a cover for each single song (loose songs, "Singles"). Deezer's public
search is asked first, Apple's iTunes search is the fallback; no key is needed. Only exact artist names are accepted for
photos. Artist, album and song names are sent to those services. Every answer, also "nothing found", is kept in
`music_art/` next to `music.db` until the next manual **Rescan Library** (a startup scan keeps it). Code:
`backend/music_online.h`.

## Playback support
Songs play in libmpv (`MpvAudioController.kt`, separate from the video player), so every format the library lists
plays: MP3, AAC / M4A, FLAC, Ogg, Opus, WAV, and also WMA, APE, WavPack, AIFF and ALAC.
Music keeps playing with the screen off or the app in the background. Starting a movie or episode pauses the music. Each song opens its own mpv instance, so there is a short gap between
songs (gapless playback is not done yet).

## Files that cannot be played
Some files are listed by the scanner but cannot be opened: a 0-byte file, a damaged download, a format libmpv does not support.
When the engine ends a song before it ever loaded, the player does **not** report a crash:
- The host (`MpvController.fail(crashed = false)`) shows "This file can't be played (it may be damaged)" and sends an `error` event
  to Dart. "Player has crashed - please restart" is now only shown when mpv itself cannot start, and that case still sends `ended`.
- `PekPlayer.failed` (`mpv.dart`) turns true on `error` (and is cleared by `reset()` before each load).
- `MusicController` (`_onFailed`) marks the song in `unplayable` (song ids, saved per profile under `pek_music_unplayable_v1`) and calls
  `next(auto: true)`. Next, and the end of a song, skip marked songs, and **repeat never reloads a marked song**, so a bad file cannot loop.
  At the end of the queue the player stops (with repeat on it wraps to the first song that is not marked); if nothing playable is left it stops.
- Marked songs are greyed out in every song list (`TrackRow` in `music.dart`) with "Can't be played · the file may be damaged".
  Tapping one (or choosing it from an album or playlist) still tries it, so a file that was repaired or replaced plays again;
  once it opens and reports a length (`_onDuration`) the mark is removed.
- The video player closes when a video will not open (`player.dart`, `_onFailed`), without the "Up next" countdown.
The scanner itself does not check files yet, so a damaged file appears in the library until someone tries to play it.

## Home-screen widget
Phones and tablets can add a **PEK TV music** widget (long-press the home screen > Widgets). It is 4 x 2 cells and resizable, drawn in
the PEK Ember colours (fixed colours: it does not follow the profile's skin): cover, title, artist, and previous / play-pause / next.
- `android/.../MusicWidget.kt` (an `AppWidgetProvider`) only mirrors `MusicState`. `MusicService` calls `MusicWidget.update` every time it
  redraws the notification, and once more when it stops. Nothing visible changed = nothing is sent.
- The buttons send the same `ACTION_PLAY / PAUSE / NEXT / PREV` the notification buttons use. A tap on the card opens the app.
- While the service is not running (nothing playing, or the app was closed) there is nothing to control and the service cannot be started
  from a home-screen button on newer Android, so the widget shows "PEK TV / Nothing playing" with no buttons and a tap opens the app.
- The cover is cut square, scaled to 192 px and rounded before it is sent (widget pictures go through a size-limited channel).
- Files: `res/layout/widget_music.xml`, `res/xml/music_widget_info.xml` (and `res/xml-v31/` with grid-cell size and a live preview),
  `res/drawable/widget_*.xml` and `ic_widget_*.xml`, the `ember_*` colours in `res/values/colors.xml`, `res/values/widget_strings.xml`,
  and the `<receiver android:name=".MusicWidget">` in `AndroidManifest.xml`. Android TV has no home-screen widgets.

## Backend
`backend/music.cpp` + `music_tags.cpp` (library, scanning, `/api/music/*`; see `music.h` for the routes), refreshed
after every normal scan through `MediaScanner::setAfterScan` and once when the tab is first opened. The song list is kept in
a SQLite database (`music.db`, next to `library.db`; an old `music_cache.tsv` is moved into it once and renamed
`.migrated`), so a restart does not re-read every file; only new or changed files are read, and a power cut cannot
leave a half-written cache. A damaged database is set aside as `music.db.corrupt` and rebuilt by the next scan.
Search (`/api/music/search`, `/api/music/songs?q=`) runs in memory over names that are folded once when the library is
published: capitals and accents are ignored ("beyonce" finds Beyoncé) and every word may come from a different field
("drake hotline"). Measured with the database as the search engine instead, it was slower at 500 and at 50,000 songs,
so the database only keeps the data. Front end: `flutter_ui/lib/src/music_controller.dart` (engine + queue), `music.dart` and `music_fullscreen.dart` (screens).
Tests: `g++ -std=c++17 music_test.cpp music_tags.cpp -o music_test && ./music_test song.mp3 song.flac ...`

## Known limits
- Background play on Android uses a foreground service (`MusicService.kt`): a media notification with lock-screen
  controls, audio focus (pauses for calls, ducks for prompts) and pause when headphones are unplugged. The service
  stops after 10 minutes without playing. The home-screen widget follows the same state (see above).
- The list of files marked "Can't be played" is kept on the device, per profile, and is not synced to PEK Cloud.
- Cover pictures are sent at their original size; very large covers on a big album grid cost memory on weak devices.
- Scanning a large library on a network share the first time can take a while (results appear as they are read).

## Full-screen player

Open **Music > Now Playing > Full screen**. The cover (album, single or artist art) fills the background and the screen
turns to landscape with the system bars hidden. **Lyrics** turns on time-synced lyrics (the background blurs so they stay
readable; the choice is remembered). **Browse** (top-right) opens a side window with Queue, Playlists, Albums, Artists
and Songs; picking something plays it and the window stays open. On a TV remote: arrows move, OK presses, Left/Right on
the seek bar skips 10 seconds, Back closes the browse window first and then the screen. `L` toggles lyrics on a keyboard.

## Offline library (covers + lyrics)

While **Online art & lyrics** is on, the server walks the whole library after every scan and saves each artist photo,
album / single cover and song's lyrics to disk (`music_art` in the data folder). The **Offline library** card at the top of
Music > Albums / Artists shows a live percentage, with Music (songs read), Covers and Lyrics counts. Saved items show
instantly and keep working with no internet, even if Online art is switched off later. Items already saved are skipped, so
running it again is quick; **Stop / Continue / Check for new songs** control it. Pictures inside the song files and
`cover.jpg` / `folder.jpg` beside them are already offline and are not copied. If the services can't be reached
(12 failures in a row) it pauses with "Continue" instead of marking things as missing. The disk cache is cleared by a
manual rescan, as before. Songs themselves are never copied: they play from your folders or network shares.

Songs or albums that no service knows (bootlegs, mixtapes) simply keep the note icon; **Retry missing covers & lyrics**
on the card asks the services again for everything that came back empty. Covers are matched leniently: "(Deluxe)",
"[Remastered]", "feat." tails and curly quotes are ignored, and if the album is not listed one of its songs is tried.
