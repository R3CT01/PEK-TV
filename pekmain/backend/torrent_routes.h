#ifndef TORRENT_ROUTES_H
#define TORRENT_ROUTES_H

#include "httplib.h"
#include <string>

// Registers the torrent API:
//   GET  /api/torrent/info                 {available, configured}
//   GET  /api/torrent/settings             {url, hasKey}            (the key is never sent back)
//   POST /api/torrent/settings             url=..&key=..            (key optional: blank keeps the old one)
//   GET  /api/torrent/search               kind, title, year, show, season, episode  -> ranked releases
//   POST /api/torrent/start                source (magnet or a link from a search result), season, episode
//   GET  /api/torrent/<hash>/status
//   GET  /api/torrent/<hash>/stream        Range-capable video stream
//   POST /api/torrent/<hash>/stop
// The data dir holds torrent.json (the provider settings) and the temporary download cache.
// Call setTorrentDataDir() once at startup, before the server starts.
void setTorrentDataDir(const std::string& dir);
void registerTorrentRoutes(httplib::Server& svr);

#endif
