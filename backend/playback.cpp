#include "playback.h"
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;

void registerPlaybackRoutes(httplib::Server& svr, MediaScanner* scanner) {
    // Make sure common video containers get the right Content-Type.
    svr.set_file_extension_and_mimetype_mapping("mkv",  "video/x-matroska");
    svr.set_file_extension_and_mimetype_mapping("mp4",  "video/mp4");
    svr.set_file_extension_and_mimetype_mapping("m4v",  "video/mp4");
    svr.set_file_extension_and_mimetype_mapping("mov",  "video/quicktime");
    svr.set_file_extension_and_mimetype_mapping("avi",  "video/x-msvideo");
    svr.set_file_extension_and_mimetype_mapping("webm", "video/webm");
    svr.set_file_extension_and_mimetype_mapping("ts",   "video/mp2t");
    svr.set_file_extension_and_mimetype_mapping("wmv",  "video/x-ms-wmv");

    // A paused player stops reading; give the socket longer before dropping it.
    svr.set_write_timeout(30, 0);

    // Only ids the scanner handed out are served, so there is no way to ask
    // for an arbitrary path on the device.
    svr.Get(R"(/api/stream/([A-Za-z0-9]+))",
            [scanner](const httplib::Request& req, httplib::Response& res) {
        MediaEntry entry;
        if (!scanner->findById(req.matches[1].str(), entry)) {
            res.status = 404;
            res.set_content("{\"error\": \"Unknown media id\"}", "application/json");
            return;
        }
        std::error_code ec;
        if (!fs::is_regular_file(entry.path, ec)) {
            res.status = 404;
            res.set_content("{\"error\": \"File is missing\"}", "application/json");
            return;
        }
        res.set_file_content(entry.path);   // handles Range requests itself
    });
}
