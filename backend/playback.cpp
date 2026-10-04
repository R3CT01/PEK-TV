#include "playback.h"
#include "vfs.h"
#include <algorithm>
#include <memory>
#include <vector>
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;

namespace {

std::string mimeForName(const std::string& name) {
    std::string ext = fs::path(name).extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return std::tolower(c); });
    if (ext == ".mkv")  return "video/x-matroska";
    if (ext == ".mp4" || ext == ".m4v") return "video/mp4";
    if (ext == ".mov")  return "video/quicktime";
    if (ext == ".avi")  return "video/x-msvideo";
    if (ext == ".webm") return "video/webm";
    if (ext == ".ts")   return "video/mp2t";
    if (ext == ".wmv")  return "video/x-ms-wmv";
    return "application/octet-stream";
}

void jsonError(httplib::Response& res, int status, const std::string& msg) {
    res.status = status;
    res.set_content("{\"error\": \"" + msg + "\"}", "application/json");
}

// Streams a file that lives on an SMB share. The player still just opens
// /api/stream/<id>; this reads the bytes from the share on demand, and httplib
// turns the player's Range requests into the right slices (seeking works).
void serveRemote(const MediaEntry& entry, httplib::Response& res) {
    vfs::Url u;
    if (!vfs::parseUrl(entry.path, u) || u.share.empty() || u.path.empty()) {
        jsonError(res, 404, "Bad network path");
        return;
    }
    vfs::Error err;
    std::shared_ptr<vfs::Share> share = vfs::connectShare(u.host, u.share, err);
    if (!share) { jsonError(res, 502, "Network share is not reachable"); return; }
    if (!share->open(u.path, err)) { jsonError(res, 404, "File is missing"); return; }
    uint64_t size = share->fileSize();

    res.set_header("Accept-Ranges", "bytes");
    res.set_content_provider(
        static_cast<size_t>(size), mimeForName(entry.filename),
        [share](size_t offset, size_t length, httplib::DataSink& sink) {
            static const size_t kChunk = 256 * 1024;
            std::vector<char> buf(std::min(length, kChunk));
            int64_t n = share->read(offset, buf.data(), buf.size());
            if (n <= 0) return false;          // error or unexpected end: abort the response
            return sink.write(buf.data(), static_cast<size_t>(n));
        });
}

} // namespace

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
        if (vfs::isRemote(entry.path)) {
            serveRemote(entry, res);
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
