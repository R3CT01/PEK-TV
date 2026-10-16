#ifndef MUSIC_H
#define MUSIC_H

#include <string>
#include "httplib.h"
#include "media_scanner.h"

// The Music library. Songs are found in the same source folders as movies and shows (local folders and network
// sources alike); each file's own tags say what it is, the folder layout fills the gaps. Registers:
//   GET /api/music/status                       { scanning, tracks, albums, artists }
//   GET /api/music/albums                       every album (title, artist, year, track count, length, added, art)
//   GET /api/music/artists                      every album artist
//   GET /api/music/album?id=                    one album with its tracks in order
//   GET /api/music/artist?id=                   one artist with their albums
//   GET /api/music/songs?offset=&limit=&q=      all songs A-Z (optionally filtered), paged
//   GET /api/music/search?q=                    artists, albums and songs matching a word
//   GET /api/music/art?album=<id> | ?track=<id> | ?artist=<id>
//                                               the picture (the file's own, else cover.jpg / folder.jpg ..., else
//                                               online when switched on: artist photo, album cover, single's cover)
//   GET /api/music/stream/<trackId>             the audio file itself, with Range support (seeking)
// Scanning runs after every normal scan (MediaScanner::setAfterScan) and once when the Music tab is first used.
// Needs no ffprobe: see music_tags.h.
//
// dataDir: a writable folder for the cache (music_cache.tsv), so a restart does not re-read every file.
void registerMusicRoutes(httplib::Server& svr, MediaScanner* scanner, const std::string& dataDir);

// Online art (artist photos, album and single covers; music_online.h) is kept on disk until a manual rescan:
// /api/rescan calls this. GET/POST /api/music/online reads / sets the on-off switch (POST ?enabled=1|0).
void musicOnlineClearCache();

#endif
