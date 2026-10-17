#ifndef TORRENT_ROUTES_H
#define TORRENT_ROUTES_H

#include "httplib.h"
#include <string>

// Registers the torrent API:
//   GET  /api/torrent/info                 {available}
//   POST /api/torrent/allow                url=..                   (a plugin vouches for a https .torrent link)
//   GET  /api/torrent/fetch                url=..                   (CORS-free page fetch for plugins)
//   POST /api/torrent/start                source (magnet, or a link vouched for via /allow), season, episode
//   GET  /api/torrent/<hash>/status
//   GET  /api/torrent/<hash>/stream        Range-capable video stream
//   POST /api/torrent/<hash>/stop
// The data dir holds the temporary download cache.
// Call setTorrentDataDir() once at startup, before the server starts.
void setTorrentDataDir(const std::string& dir);
void registerTorrentRoutes(httplib::Server& svr);

#endif
