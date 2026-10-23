
#ifndef SERVER_H
#define SERVER_H

#include <string>
#include <vector>
#include <functional>
#include "media_scanner.h"

class PekServer {
public:
    // Declare start with the plugin data provider callback parameter,
    // plus the MediaScanner backing /api/movies, /api/shows, and
    // /api/movie-details.
    static void start(int port, const std::string& plugins_dir,
                       const std::string& skins_dir,
                       std::function<std::vector<std::string>()> get_plugins,
                       MediaScanner* scanner);

    // Looks up a TV show name on TMDb and returns the official title, or
    // "" if there is no TMDB_API_KEY, no network, or no close match.
    // Pass to MediaScanner::setShowResolver().
    static std::string resolveShowName(const std::string& guess);
};

#endif
