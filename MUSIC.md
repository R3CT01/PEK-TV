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
Where tags are missing the folder layout fills in: `Artist/Album/01 - Title.mp3`, `Artist - Album/01 Title.mp3`, a
`CD1` / `Disc 2` sub-folder, or a loose `Artist - Title.mp3`.
Albums are grouped by album + album artist; an album with three or more different artists and no album-artist tag
becomes **Various Artists**. Folders containing a `.nomedia` file are skipped (same as videos).

## Playback support
The song plays in the web view's audio player, so what it can decode decides what plays: MP3, AAC / M4A, FLAC, Ogg,
Opus and WAV are fine. WMA, APE, WavPack, AIFF and ALAC files are listed but skipped with a message when played.
Starting a movie or episode pauses the music.

## Backend
`backend/music.cpp` + `music_tags.cpp` (library, scanning, `/api/music/*`; see `music.h` for the routes), refreshed
after every normal scan through `MediaScanner::setAfterScan` and once when the tab is first opened. A cache file
(`music_cache.tsv`, next to `media_cache.tsv`) means a restart does not re-read every file; only new or changed files
are read. Front end: `www/music_player.js` (engine + bar) and `www/app_music.js` (screens).
Tests: `g++ -std=c++17 music_test.cpp music_tags.cpp -o music_test && ./music_test song.mp3 song.flac ...`

## Known limits
- Playing while the app is in the background / screen off, lock-screen controls and a notification need a native
  service on Android; not done yet.
- Cover pictures are sent at their original size; very large covers on a big album grid cost memory on weak devices.
- Scanning a large library on a network share the first time can take a while (results appear as they are read).
