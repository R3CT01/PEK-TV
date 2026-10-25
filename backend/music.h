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
//   GET /api/music/album?id=                    one album with its tracks in order (songs carry year and genres, albums genres)
//   GET /api/music/artist?id=                   one artist with their albums
//   GET /api/music/songs?offset=&limit=&q=      all songs A-Z (optionally filtered), paged
//   GET /api/music/search?q=                    artists, albums and songs matching a word
//   Filters (optional on albums, artists, songs and search): &genre=Rock  &year=1994  &decade=1990
//     genre: a song has the genre (a tag like "Rock; Pop" counts as both; capitals and accents are ignored); year / decade:
//     the song's year (an album's year is its earliest song's); an artist passes when one of their albums does.
//     /api/music/search also works with only a filter (no q): it lists what matches, with longer caps.
//   GET /api/music/facets                       { genres: [{name, count}] most songs first, years: [{year, count}] newest first }
//   GET /api/music/art?album=<id> | ?track=<id> | ?artist=<id>
//                                               the picture (the file's own, else cover.jpg / folder.jpg ..., else
//                                               online when switched on: artist photo, album cover, single's cover)
//   GET /api/music/stream/<trackId>             the audio file itself, with Range support (seeking)
// Scanning runs after every normal scan (MediaScanner::setAfterScan) and once when the Music tab is first used.
// Needs no ffprobe: see music_tags.h.
//
// dataDir: a writable folder for the song database (music.db; an old music_cache.tsv is moved into it), so a restart does not re-read every file.
void registerMusicRoutes(httplib::Server& svr, MediaScanner* scanner, const std::string& dataDir);

// Online art (artist photos, album and single covers; music_online.h) is kept on disk until a manual rescan:
// /api/rescan calls this. GET/POST /api/music/online reads / sets the on-off switch (POST ?enabled=1|0).
void musicOnlineClearCache();

#endif
