#ifndef PLAYBACK_H
#define PLAYBACK_H

#include "httplib.h"
#include "media_scanner.h"

// Video-playback side of the backend. Registers:
//   GET /api/stream/<id>  - serves the library file with that id, with HTTP
//                           Range support so players can seek.
// Players (Android ExoPlayer today, a browser <video> or other player later)
// just open that URL, the same way Kodi addons hand Kodi a resolved URL.
void registerPlaybackRoutes(httplib::Server& svr, MediaScanner* scanner);

#endif
