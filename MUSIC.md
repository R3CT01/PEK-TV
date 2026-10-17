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
On Android the songs play in libmpv (`MpvAudioController.kt`, separate from the video player), so every format the
library lists plays: MP3, AAC / M4A, FLAC, Ogg, Opus, WAV, and also WMA, APE, WavPack, AIFF and ALAC. Everywhere else
the song plays in the browser's audio player, so what it can decode decides what plays: MP3, AAC / M4A, FLAC, Ogg, Opus
and WAV are fine; WMA, APE, WavPack, AIFF and ALAC files are listed but skipped with a message when played.
Music keeps playing with the screen off or the app in the background. Starting a movie or episode pauses the music. Each song opens its own mpv instance, so there is a short gap between
songs (gapless playback is not done yet).

## Backend
`backend/music.cpp` + `music_tags.cpp` (library, scanning, `/api/music/*`; see `music.h` for the routes), refreshed
after every normal scan through `MediaScanner::setAfterScan` and once when the tab is first opened. The song list is kept in
a SQLite database (`music.db`, next to `library.db`; an old `music_cache.tsv` is moved into it once and renamed
`.migrated`), so a restart does not re-read every file; only new or changed files are read, and a power cut cannot
leave a half-written cache. A damaged database is set aside as `music.db.corrupt` and rebuilt by the next scan.
Search (`/api/music/search`, `/api/music/songs?q=`) runs in memory over names that are folded once when the library is
published: capitals and accents are ignored ("beyonce" finds Beyoncé) and every word may come from a different field
("drake hotline"). Measured with the database as the search engine instead, it was slower at 500 and at 50,000 songs,
so the database only keeps the data. Front end: `www/music_player.js` (engine + bar) and `www/app_music.js` (screens).
Tests: `g++ -std=c++17 music_test.cpp music_tags.cpp -o music_test && ./music_test song.mp3 song.flac ...`

## Known limits
- Background play on Android uses a foreground service (`MusicService.kt`): a media notification with lock-screen
  controls, audio focus (pauses for calls, ducks for prompts) and pause when headphones are unplugged. The service
  stops after 10 minutes without playing.
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
