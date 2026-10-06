#ifndef TORRENT_H
#define TORRENT_H

#include <cstdint>
#include <string>
#include <vector>

// Torrent streaming for Hesper.
//
// The engine (libtorrent) is OPTIONAL at build time: compile torrent.cpp with
// -DHESPER_TORRENT and link libtorrent-rasterbar to get it. Without that define every
// call below still exists and reports "not available", so the rest of the app builds the
// same either way (same idea as SMB / NFS).
//
// How playback works: the player opens /api/torrent/<hash>/stream. The server answers
// Range requests by calling read(), which waits until the pieces covering that range have
// been downloaded (they are requested in playback order, nearest first) and returns bytes.
namespace torrent {

struct FileInfo {
    int index = 0;
    std::string path;
    uint64_t size = 0;
    bool video = false;
};

struct Status {
    std::string state;          // "metadata" | "buffering" | "ready" | "error"
    std::string name;
    std::string error;
    int peers = 0;
    int seeds = 0;
    int down_kbps = 0;          // KiB/s
    int up_kbps = 0;
    double file_progress = 0;   // 0..1, selected file
    double buffer_progress = 0; // 0..1, how much of the start-up buffer is in place
    bool ready = false;         // enough is buffered to start the player
    int file_index = -1;        // selected video file
    uint64_t file_size = 0;
    std::string file_name;
    std::vector<FileInfo> files;
};

// True when this build contains the torrent engine.
bool available();

// Where settings/cache live. Call once at startup (before the first add()).
void setDataDir(const std::string& dir);

// Starts (or re-uses) a torrent from a magnet link or a .torrent URL and picks the file to
// play: the episode matching season/episode when given (0 = unknown), otherwise the biggest
// video. Returns the info-hash (lowercase hex) or "" with err set.
std::string add(const std::string& source, int season, int episode, std::string& err);

// Same, from the bytes of a .torrent file (fetched by the caller).
std::string addFile(const std::string& torrentBytes, int season, int episode, std::string& err);

bool status(const std::string& hash, Status& out);

// Blocking read of the selected file. Returns bytes read, 0 at end of file, -1 on error or
// timeout. `abort` (optional) is polled while waiting so a closed connection stops the wait.
int64_t read(const std::string& hash, uint64_t offset, void* buf, size_t len,
             bool (*aborted)(void*) = nullptr, void* aborted_ctx = nullptr);

// Stops a torrent and deletes its downloaded data.
void remove(const std::string& hash);
void removeAll();

}  // namespace torrent

#endif
