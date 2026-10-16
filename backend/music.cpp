#include "music.h"
#include "music_tags.h"
#include "vfs.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <sys/stat.h>
#include <thread>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;

namespace {

// ================================================================ small helpers
std::string lower(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    return s;
}
std::string trimmed(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (unsigned char)s[a] <= ' ') ++a;
    while (b > a && (unsigned char)s[b - 1] <= ' ') --b;
    return s.substr(a, b - a);
}
std::string jsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += char(c);
        }
    }
    return o;
}
std::string fileExt(const std::string& name) {
    size_t d = name.rfind('.');
    return d == std::string::npos ? "" : lower(name.substr(d));
}
std::string stemOf(const std::string& name) {
    size_t d = name.rfind('.');
    return d == std::string::npos ? name : name.substr(0, d);
}
std::string leafOf(const std::string& p) {
    std::string s = p;
    while (!s.empty() && (s.back() == '/' || s.back() == '\\')) s.pop_back();
    size_t k = s.find_last_of("/\\");
    return k == std::string::npos ? s : s.substr(k + 1);
}
// Stable across builds and platforms (playlists keep these ids).
std::string stableId(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    char b[24];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)h);
    return b;
}
std::string sortKey(const std::string& s) {
    std::string k = lower(trimmed(s));
    if (k.compare(0, 4, "the ") == 0) k = k.substr(4);
    return k;
}
const char* mimeForAudio(const std::string& ext) {
    if (ext == ".mp3") return "audio/mpeg";
    if (ext == ".flac") return "audio/flac";
    if (ext == ".m4a" || ext == ".m4b") return "audio/mp4";
    if (ext == ".aac") return "audio/aac";
    if (ext == ".ogg" || ext == ".oga") return "audio/ogg";
    if (ext == ".opus") return "audio/ogg";
    if (ext == ".wav") return "audio/wav";
    if (ext == ".wma") return "audio/x-ms-wma";
    if (ext == ".aiff" || ext == ".aif") return "audio/aiff";
    return "application/octet-stream";
}
bool isCoverName(const std::string& name) {
    std::string e = fileExt(name);
    if (e != ".jpg" && e != ".jpeg" && e != ".png" && e != ".webp") return false;
    std::string s = lower(stemOf(name));
    return s == "cover" || s == "folder" || s == "front" || s == "album" || s == "albumart" || s == "albumartsmall" || s == "thumb";
}
int coverRank(const std::string& name) {          // lower = better
    std::string s = lower(stemOf(name));
    if (s == "cover") return 0;
    if (s == "folder") return 1;
    if (s == "front") return 2;
    if (s == "albumart") return 3;
    return 4;
}

// ================================================================ readers
class LocalReader : public musictags::Reader {
public:
    explicit LocalReader(const std::string& path) : f_(std::fopen(path.c_str(), "rb")) {
        if (f_) { std::fseek(f_, 0, SEEK_END); long n = std::ftell(f_); size_ = n < 0 ? 0 : (uint64_t)n; }
    }
    ~LocalReader() override { if (f_) std::fclose(f_); }
    bool ok() const { return f_ != nullptr; }
    uint64_t size() override { return size_; }
    int64_t read(uint64_t off, void* buf, size_t len) override {
        if (!f_) return -1;
        if (off >= size_) return 0;
        if (std::fseek(f_, (long)off, SEEK_SET) != 0) return -1;
        return (int64_t)std::fread(buf, 1, len, f_);
    }
private:
    FILE* f_ = nullptr;
    uint64_t size_ = 0;
};

class ShareReader : public musictags::Reader {      // a file already opened on a share
public:
    explicit ShareReader(vfs::Share& s) : s_(s), size_(s.fileSize()) {}
    uint64_t size() override { return size_; }
    int64_t read(uint64_t off, void* buf, size_t len) override { return s_.read(off, buf, len); }
private:
    vfs::Share& s_;
    uint64_t size_;
};

// Tag readers ask for many tiny pieces; a network round trip each would be slow. This serves them from one big block.
class BufferedReader : public musictags::Reader {
public:
    explicit BufferedReader(musictags::Reader& src, size_t block = 64 * 1024) : src_(src), block_(block), size_(src.size()) {}
    uint64_t size() override { return size_; }
    int64_t read(uint64_t off, void* buf, size_t len) override {
        if (off >= size_) return 0;
        len = (size_t)std::min<uint64_t>(len, size_ - off);
        if (len >= block_ * 2) return src_.read(off, buf, len);                 // a big read goes straight through
        size_t done = 0;
        while (done < len) {
            uint64_t at = off + done;
            if (!(at >= start_ && at < start_ + data_.size())) {
                start_ = at;
                data_.assign(std::min<uint64_t>(block_, size_ - at), '\0');
                int64_t n = src_.read(at, &data_[0], data_.size());
                if (n <= 0) { data_.clear(); return done ? (int64_t)done : n; }
                data_.resize((size_t)n);
            }
            size_t inBlock = (size_t)(at - start_);
            size_t take = std::min(len - done, data_.size() - inBlock);
            std::memcpy((char*)buf + done, data_.data() + inBlock, take);
            done += take;
        }
        return (int64_t)done;
    }
private:
    musictags::Reader& src_;
    size_t block_;
    uint64_t size_;
    uint64_t start_ = 0;
    std::string data_;
};

// ================================================================ data model
struct Track {
    std::string id, path, filename;
    uint64_t size = 0;
    int64_t mtime = 0;
    // read from the file
    std::string title, artist, albumArtist, album, genre;
    int track = 0, disc = 0, year = 0;
    double duration = 0;
    bool hasArt = false;
    // from the folder / file name (used where the file's own tags are empty)
    std::string fbArtist, fbAlbum, fbTitle, albumDir;
    int fbTrack = 0, fbDisc = 0;
    std::string folderArt;                  // cover.jpg / folder.jpg ... next to the file
    // resolved for display
    std::string rTitle, rArtist, rAlbum;
};

struct Album {
    std::string id, title, artist;
    int year = 0;
    double duration = 0;
    int64_t added = 0;
    std::vector<int> tracks;
    bool art = false;
};
struct Artist {
    std::string id, name;
    std::vector<int> albums;
    int trackCount = 0;
};
struct Snapshot {
    std::vector<Track> tracks;               // sorted by title
    std::vector<Album> albums;               // sorted by artist, year, title
    std::vector<Artist> artists;             // sorted by name
    std::unordered_map<std::string, int> trackById, albumById, artistById;
    std::unordered_map<std::string, int> albumOfTrack;   // track id -> album index
};

// ---- folder / file name fallbacks
bool isDiscFolder(const std::string& name) {
    std::string s = lower(trimmed(name));
    size_t i = 0;
    if (s.compare(0, 4, "disc") == 0 || s.compare(0, 4, "disk") == 0) i = 4;
    else if (s.compare(0, 2, "cd") == 0) i = 2;
    else return false;
    while (i < s.size() && (s[i] == ' ' || s[i] == '.' || s[i] == '_' || s[i] == '-')) ++i;
    if (i >= s.size()) return false;
    for (; i < s.size(); ++i) if (s[i] < '0' || s[i] > '9') return false;
    return true;
}
int discNumberOf(const std::string& name) {
    std::string s = lower(trimmed(name));
    size_t i = s.find_first_of("0123456789");
    return i == std::string::npos ? 0 : std::atoi(s.c_str() + i);
}
// "01 - Title", "01. Title", "1-02 Title", "01_Title"  ->  track (+disc), title
void parseFileName(const std::string& stem, int& disc, int& track, std::string& title) {
    disc = 0; track = 0;
    size_t i = 0;
    auto digits = [&](size_t from, size_t& end) { size_t j = from; while (j < stem.size() && stem[j] >= '0' && stem[j] <= '9') ++j; end = j; return j - from; };
    size_t e1; size_t n1 = digits(0, e1);
    if (n1 >= 1 && n1 <= 3 && e1 < stem.size()) {
        size_t sep = e1;
        if (stem[sep] == '-' && sep + 1 < stem.size() && stem[sep + 1] >= '0' && stem[sep + 1] <= '9') {          // disc-track
            size_t e2; size_t n2 = digits(sep + 1, e2);
            if (n2 >= 1 && n2 <= 3 && e2 < stem.size() && (stem[e2] == ' ' || stem[e2] == '.' || stem[e2] == '_' || stem[e2] == '-')) {
                disc = std::atoi(stem.substr(0, n1).c_str()); track = std::atoi(stem.substr(sep + 1, n2).c_str()); i = e2;
            }
        }
        if (!track && (stem[e1] == ' ' || stem[e1] == '.' || stem[e1] == '_' || stem[e1] == '-')) { track = std::atoi(stem.substr(0, n1).c_str()); i = e1; }
    }
    if (track) while (i < stem.size() && (stem[i] == ' ' || stem[i] == '.' || stem[i] == '_' || stem[i] == '-')) ++i;
    title = trimmed(stem.substr(i));
    if (title.empty()) title = trimmed(stem);
}
void deriveFromPath(Track& t, const std::vector<std::string>& relDirs) {
    int disc = 0, trk = 0;
    std::string title;
    parseFileName(stemOf(t.filename), disc, trk, title);
    t.fbTitle = title; t.fbTrack = trk; t.fbDisc = disc;
    std::vector<std::string> dirs = relDirs;
    int folderDisc = 0;
    if (!dirs.empty() && isDiscFolder(dirs.back())) { folderDisc = discNumberOf(dirs.back()); dirs.pop_back(); }
    if (folderDisc && !t.fbDisc) t.fbDisc = folderDisc;
    std::string dirKey;
    for (const auto& d : dirs) dirKey += "/" + d;
    t.albumDir = dirKey;
    if (dirs.size() >= 2) { t.fbAlbum = dirs.back(); t.fbArtist = dirs[dirs.size() - 2]; }
    else if (dirs.size() == 1) {
        t.fbAlbum = dirs[0];
        size_t dash = dirs[0].find(" - ");                               // "Artist - Album"
        if (dash != std::string::npos && dash > 0) { t.fbArtist = trimmed(dirs[0].substr(0, dash)); t.fbAlbum = trimmed(dirs[0].substr(dash + 3)); }
    }
    if (t.fbArtist.empty()) {                                           // a loose "Artist - Title" file name
        size_t dash = title.find(" - ");
        if (dash != std::string::npos && dash > 0 && dash + 3 < title.size()) { t.fbArtist = trimmed(title.substr(0, dash)); t.fbTitle = trimmed(title.substr(dash + 3)); }
    }
}

// ================================================================ the library
class MusicLibrary {
public:
    MusicLibrary(std::string cacheFile, MediaScanner* scanner) : cacheFile_(std::move(cacheFile)), scanner_(scanner) {
        loadCache();
        publish(cache_);
    }

    std::shared_ptr<const Snapshot> snapshot() {
        std::lock_guard<std::mutex> l(snapMutex_);
        return snap_;
    }
    bool scanning() const { return scanning_.load(); }

    // Starts a background scan (several requests in a row are folded into one extra pass).
    void scanAsync() {
        everStarted_.store(true);
        if (scanning_.exchange(true)) { pending_.store(true); return; }
        std::thread([this]() {
            do {
                pending_.store(false);
                try { runScan(); } catch (const std::exception& e) { std::cout << "[Music] Scan failed: " << e.what() << std::endl; }
            } while (pending_.load());
            scanning_.store(false);
        }).detach();
    }
    void scanOnceIfNeeded() { if (!everStarted_.load()) scanAsync(); }

    // ---- cover pictures
    bool cover(const Track& t, bool embeddedFirst, std::string& bytes, std::string& mime);

private:
    std::string cacheFile_;
    MediaScanner* scanner_;
    std::mutex snapMutex_;
    std::shared_ptr<const Snapshot> snap_ = std::make_shared<Snapshot>();
    std::vector<Track> cache_;                       // what the last scan (or the cache file) knew
    std::atomic<bool> scanning_{false}, pending_{false}, everStarted_{false};

    // ---------------------------------------------------------------- cache file
    static std::string esc(const std::string& s) {
        std::string o;
        for (char c : s) { if (c == '\\') o += "\\\\"; else if (c == '\t') o += "\\t"; else if (c == '\n') o += "\\n"; else if (c == '\r') o += "\\r"; else o += c; }
        return o;
    }
    static std::string unesc(const std::string& s) {
        std::string o;
        for (size_t i = 0; i < s.size(); ++i) {
            if (s[i] == '\\' && i + 1 < s.size()) { char n = s[++i]; o += (n == 't') ? '\t' : (n == 'n') ? '\n' : (n == 'r') ? '\r' : n; }
            else o += s[i];
        }
        return o;
    }
    static const char* header() { return "PEKMUSIC2"; }

    void loadCache() {
        std::ifstream in(cacheFile_);
        if (!in) return;
        std::string line;
        if (!std::getline(in, line) || line != header()) return;
        while (std::getline(in, line)) {
            std::vector<std::string> f;
            size_t pos = 0;
            while (true) { size_t t = line.find('\t', pos); if (t == std::string::npos) { f.push_back(line.substr(pos)); break; } f.push_back(line.substr(pos, t - pos)); pos = t + 1; }
            if (f.size() < 20) continue;
            Track t;
            try {
                t.path = unesc(f[0]); t.size = std::stoull(f[1]); t.mtime = std::stoll(f[2]);
                t.title = unesc(f[3]); t.artist = unesc(f[4]); t.albumArtist = unesc(f[5]); t.album = unesc(f[6]); t.genre = unesc(f[7]);
                t.track = std::stoi(f[8]); t.disc = std::stoi(f[9]); t.year = std::stoi(f[10]); t.duration = std::stod(f[11]); t.hasArt = f[12] == "1";
                t.fbArtist = unesc(f[13]); t.fbAlbum = unesc(f[14]); t.fbTitle = unesc(f[15]); t.fbTrack = std::stoi(f[16]);
                t.fbDisc = std::stoi(f[17]); t.albumDir = unesc(f[18]); t.folderArt = unesc(f[19]);
            } catch (...) { continue; }
            t.filename = leafOf(t.path);
            t.id = stableId(t.path);
            cache_.push_back(std::move(t));
        }
        std::cout << "[Music] Loaded " << cache_.size() << " song(s) from the cache." << std::endl;
    }
    void saveCache(const std::vector<Track>& tracks) {
        std::string tmp = cacheFile_ + ".tmp";
        {
            std::ofstream out(tmp, std::ios::trunc);
            if (!out) return;
            out << header() << "\n";
            for (const auto& t : tracks) {
                out << esc(t.path) << '\t' << t.size << '\t' << t.mtime << '\t' << esc(t.title) << '\t' << esc(t.artist) << '\t' << esc(t.albumArtist)
                    << '\t' << esc(t.album) << '\t' << esc(t.genre) << '\t' << t.track << '\t' << t.disc << '\t' << t.year << '\t' << t.duration
                    << '\t' << (t.hasArt ? 1 : 0) << '\t' << esc(t.fbArtist) << '\t' << esc(t.fbAlbum) << '\t' << esc(t.fbTitle) << '\t' << t.fbTrack
                    << '\t' << t.fbDisc << '\t' << esc(t.albumDir) << '\t' << esc(t.folderArt) << '\n';
            }
        }
        std::error_code ec;
        fs::rename(tmp, cacheFile_, ec);
        if (ec) { fs::remove(cacheFile_, ec); fs::rename(tmp, cacheFile_, ec); }
    }

    // ---------------------------------------------------------------- scanning
    struct ScanCtx {
        std::unordered_map<std::string, const Track*> old;        // by path
        std::vector<Track> found;
        size_t probed = 0;
        bool firstScan = false;
    };

    void takeOrProbe(ScanCtx& ctx, Track& t, musictags::Reader* reader) {
        auto it = ctx.old.find(t.path);
        if (it != ctx.old.end() && it->second->size == t.size && it->second->mtime == t.mtime) {
            const Track& o = *it->second;                          // unchanged: reuse what the file said last time
            t.title = o.title; t.artist = o.artist; t.albumArtist = o.albumArtist; t.album = o.album; t.genre = o.genre;
            t.track = o.track; t.disc = o.disc; t.year = o.year; t.duration = o.duration; t.hasArt = o.hasArt;
            return;
        }
        ++ctx.probed;
        if (!reader) return;
        musictags::Tags tags;
        BufferedReader buffered(*reader);
        try { musictags::readTags(buffered, fileExt(t.filename), tags); } catch (...) {}
        t.title = tags.title; t.artist = tags.artist; t.albumArtist = tags.albumArtist; t.album = tags.album; t.genre = tags.genre;
        t.track = tags.track; t.disc = tags.disc; t.year = tags.year; t.duration = tags.duration; t.hasArt = tags.hasArt;
    }

    void progress(ScanCtx& ctx) {
        scanned_.store(ctx.found.size());
        if (ctx.firstScan && ctx.probed > 0 && ctx.probed % 250 == 0) publish(ctx.found);     // show the first results while the rest is still being read
    }

    void walkLocal(const fs::path& dir, std::vector<std::string>& rel, ScanCtx& ctx, int depth) {
        if (depth > 14) return;
        std::error_code ec;
        std::vector<std::string> files, dirs;
        for (fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec), end; !ec && it != end; it.increment(ec)) {
            std::string name = it->path().filename().string();
            if (name.empty() || name[0] == '.') { if (name == ".nomedia") return; continue; }
            std::error_code e2;
            if (it->is_directory(e2)) dirs.push_back(name); else if (it->is_regular_file(e2)) files.push_back(name);
        }
        std::sort(files.begin(), files.end());
        std::sort(dirs.begin(), dirs.end());
        std::string art;
        int bestRank = 99;
        for (const auto& n : files) if (isCoverName(n) && coverRank(n) < bestRank) { bestRank = coverRank(n); art = (dir / n).string(); }
        for (const auto& n : files) {
            if (!musictags::isAudioExtension(fileExt(n))) continue;
            Track t;
            t.path = (dir / n).string(); t.filename = n; t.id = stableId(t.path);
            struct stat st;
            if (::stat(t.path.c_str(), &st) != 0) continue;
            t.size = (uint64_t)st.st_size;
            t.mtime = (int64_t)st.st_mtime;
            deriveFromPath(t, rel);
            t.folderArt = art;
            auto it = ctx.old.find(t.path);
            bool same = it != ctx.old.end() && it->second->size == t.size && it->second->mtime == t.mtime;
            if (same) takeOrProbe(ctx, t, nullptr);
            else { LocalReader r(t.path); takeOrProbe(ctx, t, r.ok() ? &r : nullptr); }
            ctx.found.push_back(std::move(t));
            progress(ctx);
        }
        for (const auto& d : dirs) { rel.push_back(d); walkLocal(dir / d, rel, ctx, depth + 1); rel.pop_back(); }
    }

    bool walkRemote(vfs::Share& share, const vfs::Url& base, const std::string& relPath, std::vector<std::string>& rel, ScanCtx& ctx, int depth) {
        if (depth > 14) return true;
        std::vector<vfs::Entry> list;
        vfs::Error err;
        if (!share.list(relPath, list, err)) return depth > 0;               // only a failing top folder means "unreachable"
        for (const auto& e : list) if (e.name == ".nomedia") return true;
        std::sort(list.begin(), list.end(), [](const vfs::Entry& a, const vfs::Entry& b) { return a.name < b.name; });
        auto urlOf = [&](const std::string& child) { return vfs::buildUrl({base.scheme, base.host, base.share, child}); };
        std::string art;
        int bestRank = 99;
        for (const auto& e : list) if (!e.is_dir && isCoverName(e.name) && coverRank(e.name) < bestRank) { bestRank = coverRank(e.name); art = urlOf(relPath.empty() ? e.name : relPath + "/" + e.name); }
        for (const auto& e : list) {
            if (e.is_dir || e.name.empty() || e.name[0] == '.' || !musictags::isAudioExtension(fileExt(e.name))) continue;
            std::string child = relPath.empty() ? e.name : relPath + "/" + e.name;
            Track t;
            t.path = urlOf(child); t.filename = e.name; t.id = stableId(t.path); t.size = e.size; t.mtime = e.mtime;
            deriveFromPath(t, rel);
            t.folderArt = art;
            auto it = ctx.old.find(t.path);
            bool same = it != ctx.old.end() && it->second->size == t.size && it->second->mtime == t.mtime;
            if (same) takeOrProbe(ctx, t, nullptr);
            else {
                vfs::Error oe;
                if (share.open(child, oe)) { ShareReader r(share); takeOrProbe(ctx, t, &r); }
                else takeOrProbe(ctx, t, nullptr);
            }
            ctx.found.push_back(std::move(t));
            progress(ctx);
        }
        for (const auto& e : list) {
            if (!e.is_dir || e.name.empty() || e.name[0] == '.') continue;
            rel.push_back(e.name);
            walkRemote(share, base, relPath.empty() ? e.name : relPath + "/" + e.name, rel, ctx, depth + 1);
            rel.pop_back();
        }
        return true;
    }

    void runScan() {
        std::vector<std::string> dirs = scanner_->getMediaDirs();
        ScanCtx ctx;
        std::vector<Track> previous;
        {
            auto s = snapshot();
            previous = s->tracks;
            if (previous.empty()) previous = cache_;
        }
        for (const auto& t : previous) ctx.old[t.path] = &t;
        ctx.firstScan = previous.empty();
        scanned_.store(0);
        std::cout << "[Music] Scanning " << dirs.size() << " source folder(s)..." << std::endl;

        for (const auto& dir : dirs) {
            if (!vfs::isRemote(dir)) {
                std::error_code ec;
                if (!fs::is_directory(dir, ec)) continue;
                std::vector<std::string> rel;
                walkLocal(dir, rel, ctx, 0);
                continue;
            }
            bool reached = false;
            vfs::Url u;
            if (vfs::parseUrl(dir, u) && !(vfs::hasShares(u.scheme) && u.share.empty())) {
                vfs::Error err;
                std::shared_ptr<vfs::Share> share = vfs::connect(u, err);
                if (share) {
                    std::vector<std::string> rel;
                    reached = walkRemote(*share, u, u.path, rel, ctx, 0);
                }
            }
            if (!reached) {                                       // NAS switched off, Wi-Fi down ...: keep what we knew
                std::string prefix = dir;
                while (!prefix.empty() && prefix.back() == '/') prefix.pop_back();
                prefix += "/";
                size_t kept = 0;
                for (const auto& t : previous) if (t.path.compare(0, prefix.size(), prefix) == 0) { ctx.found.push_back(t); ++kept; }
                std::cout << "[Music] Keeping " << kept << " earlier song(s) from unreachable " << dir << std::endl;
            }
        }
        // the same file reached twice (a source inside another source) counts once
        std::set<std::string> seen;
        std::vector<Track> unique;
        for (auto& t : ctx.found) if (seen.insert(t.path).second) unique.push_back(std::move(t));
        cache_ = unique;
        publish(unique);
        saveCache(unique);
        std::cout << "[Music] Scan complete: " << unique.size() << " song(s), " << ctx.probed << " read from files." << std::endl;
    }

    // ---------------------------------------------------------------- grouping
    void publish(const std::vector<Track>& input) {
        auto s = std::make_shared<Snapshot>();
        s->tracks = input;
        for (auto& t : s->tracks) {
            t.rTitle = !t.title.empty() ? t.title : (!t.fbTitle.empty() ? t.fbTitle : stemOf(t.filename));
            t.rArtist = !t.artist.empty() ? t.artist : (!t.albumArtist.empty() ? t.albumArtist : (!t.fbArtist.empty() ? t.fbArtist : "Unknown Artist"));
            t.rAlbum = !t.album.empty() ? t.album : (!t.fbAlbum.empty() ? t.fbAlbum : "Unknown Album");
            if (!t.track) t.track = t.fbTrack;
            if (!t.disc) t.disc = t.fbDisc;
        }
        std::sort(s->tracks.begin(), s->tracks.end(), [](const Track& a, const Track& b) {
            std::string ka = sortKey(a.rTitle), kb = sortKey(b.rTitle);
            if (ka != kb) return ka < kb;
            return a.path < b.path;
        });
        for (size_t i = 0; i < s->tracks.size(); ++i) s->trackById[s->tracks[i].id] = (int)i;

        // Who is the album's artist? The tag when there is one; otherwise the artist most songs share, or
        // "Various Artists" when it is a mix (three or more artists with no clear owner).
        struct Group { std::map<std::string, int> counts; int total = 0; std::string display; };
        std::map<std::string, Group> groups;      // lower(album)|albumDir
        for (const auto& t : s->tracks) {
            if (!t.albumArtist.empty()) continue;
            Group& g = groups[lower(t.rAlbum) + "|" + t.albumDir];
            g.counts[t.rArtist]++; g.total++;
        }
        std::map<std::string, std::string> groupArtist;
        for (auto& kv : groups) {
            std::string best; int bestN = 0;
            for (auto& c : kv.second.counts) if (c.second > bestN) { bestN = c.second; best = c.first; }
            bool mix = kv.second.counts.size() >= 3 && bestN * 10 < kv.second.total * 6;
            groupArtist[kv.first] = mix ? "Various Artists" : best;
        }
        std::map<std::string, int> albumIndexByKey;
        std::vector<Album> albums;
        std::vector<std::string> albumTitleKey;
        for (size_t i = 0; i < s->tracks.size(); ++i) {
            const Track& t = s->tracks[i];
            std::string aa = !t.albumArtist.empty() ? t.albumArtist : groupArtist[lower(t.rAlbum) + "|" + t.albumDir];
            std::string key = lower(t.rAlbum) + "|" + lower(aa);
            auto f = albumIndexByKey.find(key);
            int ai;
            if (f == albumIndexByKey.end()) {
                Album a; a.id = stableId("album:" + key); a.title = t.rAlbum; a.artist = aa;
                ai = (int)albums.size(); albums.push_back(a); albumIndexByKey[key] = ai;
            } else ai = f->second;
            Album& a = albums[ai];
            a.tracks.push_back((int)i);
            a.duration += t.duration;
            a.added = std::max(a.added, t.mtime);
            if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
            if (t.hasArt || !t.folderArt.empty()) a.art = true;
        }
        for (auto& a : albums) {
            std::sort(a.tracks.begin(), a.tracks.end(), [&](int x, int y) {
                const Track& p = s->tracks[x]; const Track& q = s->tracks[y];
                if (p.disc != q.disc) return p.disc < q.disc;
                if (p.track != q.track) return p.track < q.track;
                return p.filename < q.filename;
            });
        }
        std::sort(albums.begin(), albums.end(), [](const Album& a, const Album& b) {
            std::string ka = sortKey(a.artist), kb = sortKey(b.artist);
            if (ka != kb) return ka < kb;
            int ya = a.year ? a.year : 9999, yb = b.year ? b.year : 9999;      // unknown years last
            if (ya != yb) return ya < yb;
            return sortKey(a.title) < sortKey(b.title);
        });
        s->albums = std::move(albums);
        std::map<std::string, int> artistIndex;
        for (size_t i = 0; i < s->albums.size(); ++i) {
            const Album& a = s->albums[i];
            s->albumById[a.id] = (int)i;
            for (int ti : a.tracks) s->albumOfTrack[s->tracks[ti].id] = (int)i;
            std::string k = lower(a.artist);
            auto f = artistIndex.find(k);
            int ar;
            if (f == artistIndex.end()) { Artist r; r.id = stableId("artist:" + k); r.name = a.artist; ar = (int)s->artists.size(); s->artists.push_back(r); artistIndex[k] = ar; }
            else ar = f->second;
            s->artists[ar].albums.push_back((int)i);
            s->artists[ar].trackCount += (int)a.tracks.size();
        }
        std::sort(s->artists.begin(), s->artists.end(), [](const Artist& a, const Artist& b) { return sortKey(a.name) < sortKey(b.name); });
        for (size_t i = 0; i < s->artists.size(); ++i) s->artistById[s->artists[i].id] = (int)i;
        {
            std::lock_guard<std::mutex> l(snapMutex_);
            snap_ = s;
        }
    }

    std::atomic<size_t> scanned_{0};
};

bool MusicLibrary::cover(const Track& t, bool embeddedFirst, std::string& bytes, std::string& mime) {
    auto embedded = [&]() -> bool {
        if (!t.hasArt) return false;
        musictags::Picture pic;
        bool ok = false;
        if (!vfs::isRemote(t.path)) {
            LocalReader r(t.path);
            if (!r.ok()) return false;
            ok = musictags::readCover(r, fileExt(t.filename), pic);
        } else {
            vfs::Url u; vfs::Error err;
            if (!vfs::parseUrl(t.path, u) || (vfs::hasShares(u.scheme) && u.share.empty())) return false;
            std::shared_ptr<vfs::Share> share = vfs::connect(u, err);
            if (!share || !share->open(u.path, err)) return false;
            ShareReader r(*share);
            BufferedReader b(r, 256 * 1024);
            ok = musictags::readCover(b, fileExt(t.filename), pic);
        }
        if (!ok) return false;
        bytes = std::move(pic.data); mime = pic.mime.empty() ? "image/jpeg" : pic.mime;
        return true;
    };
    auto folder = [&]() -> bool { return !t.folderArt.empty() && MediaScanner::readArtwork(t.folderArt, bytes, mime); };
    if (embeddedFirst) return embedded() || folder();
    return folder() || embedded();
}

// ---------------------------------------------------------------- tiny cache of cover bytes (a grid asks for many at once)
struct ArtCache {
    std::mutex m;
    std::deque<std::string> order;
    std::map<std::string, std::pair<std::string, std::string>> items;   // key -> (mime, bytes)
    size_t bytes = 0;
    bool get(const std::string& k, std::string& mime, std::string& data) {
        std::lock_guard<std::mutex> l(m);
        auto it = items.find(k);
        if (it == items.end()) return false;
        mime = it->second.first; data = it->second.second;
        return true;
    }
    void put(const std::string& k, const std::string& mime, const std::string& data) {
        std::lock_guard<std::mutex> l(m);
        if (data.size() > (4u << 20) || items.count(k)) return;
        items[k] = {mime, data}; order.push_back(k); bytes += data.size();
        while ((order.size() > 96 || bytes > (24u << 20)) && !order.empty()) {
            auto old = items.find(order.front());
            if (old != items.end()) { bytes -= old->second.second.size(); items.erase(old); }
            order.pop_front();
        }
    }
};

// ---------------------------------------------------------------- JSON
std::string num(double v) {
    char b[32];
    std::snprintf(b, sizeof b, "%.0f", v < 0 ? 0 : v);
    return b;
}
std::string trackJson(const Snapshot& s, int ti, bool withAlbum) {
    const Track& t = s.tracks[ti];
    std::string j = "{\"id\":\"" + t.id + "\",\"title\":\"" + jsonEscape(t.rTitle) + "\",\"artist\":\"" + jsonEscape(t.rArtist) +
                    "\",\"track\":" + std::to_string(t.track) + ",\"disc\":" + std::to_string(t.disc) + ",\"duration\":" + num(t.duration);
    if (withAlbum) {
        j += ",\"album\":\"" + jsonEscape(t.rAlbum) + "\"";
        auto f = s.albumOfTrack.find(t.id);
        if (f != s.albumOfTrack.end()) j += ",\"albumId\":\"" + s.albums[f->second].id + "\",\"art\":" + (s.albums[f->second].art ? "true" : "false");
    }
    return j + ",\"ext\":\"" + jsonEscape(fileExt(t.filename)) + "\"}";
}
std::string albumJson(const Album& a) {
    return "{\"id\":\"" + a.id + "\",\"title\":\"" + jsonEscape(a.title) + "\",\"artist\":\"" + jsonEscape(a.artist) + "\",\"year\":" + std::to_string(a.year) +
           ",\"tracks\":" + std::to_string(a.tracks.size()) + ",\"duration\":" + num(a.duration) + ",\"added\":" + std::to_string(a.added) +
           ",\"art\":" + (a.art ? "true" : "false") + "}";
}
void jsonOut(httplib::Response& res, const std::string& body) {
    res.set_header("Cache-Control", "no-store");
    res.set_content(body, "application/json");
}
void notFound(httplib::Response& res, const std::string& msg) {
    res.status = 404;
    res.set_content("{\"error\": \"" + msg + "\"}", "application/json");
}

} // namespace

// ================================================================ routes
void registerMusicRoutes(httplib::Server& svr, MediaScanner* scanner, const std::string& dataDir) {
    std::error_code ec;
    if (!dataDir.empty()) fs::create_directories(dataDir, ec);
    auto lib = std::make_shared<MusicLibrary>((fs::path(dataDir) / "music_cache.tsv").string(), scanner);
    auto art = std::make_shared<ArtCache>();

    // Every normal scan (startup, rescan, a new source) refreshes the music too, on its own thread.
    scanner->setAfterScan([lib]() { lib->scanAsync(); });

    svr.Get("/api/music/status", [lib](const httplib::Request&, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        auto s = lib->snapshot();
        jsonOut(res, std::string("{\"scanning\":") + (lib->scanning() ? "true" : "false") + ",\"tracks\":" + std::to_string(s->tracks.size()) +
                         ",\"albums\":" + std::to_string(s->albums.size()) + ",\"artists\":" + std::to_string(s->artists.size()) + "}");
    });

    svr.Get("/api/music/albums", [lib](const httplib::Request&, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        auto s = lib->snapshot();
        std::string j = std::string("{\"scanning\":") + (lib->scanning() ? "true" : "false") + ",\"albums\":[";
        for (size_t i = 0; i < s->albums.size(); ++i) { if (i) j += ","; j += albumJson(s->albums[i]); }
        jsonOut(res, j + "]}");
    });

    svr.Get("/api/music/artists", [lib](const httplib::Request&, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        auto s = lib->snapshot();
        std::string j = std::string("{\"scanning\":") + (lib->scanning() ? "true" : "false") + ",\"artists\":[";
        for (size_t i = 0; i < s->artists.size(); ++i) {
            const Artist& a = s->artists[i];
            if (i) j += ",";
            bool art = false;
            for (int ai : a.albums) if (s->albums[ai].art) { art = true; break; }
            j += "{\"id\":\"" + a.id + "\",\"name\":\"" + jsonEscape(a.name) + "\",\"albums\":" + std::to_string(a.albums.size()) +
                 ",\"tracks\":" + std::to_string(a.trackCount) + ",\"art\":" + (art ? "true" : "false") + ",\"albumId\":\"" +
                 (a.albums.empty() ? "" : s->albums[a.albums[0]].id) + "\"}";
        }
        jsonOut(res, j + "]}");
    });

    svr.Get("/api/music/album", [lib](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        auto f = s->albumById.find(req.get_param_value("id"));
        if (f == s->albumById.end()) { notFound(res, "Unknown album"); return; }
        const Album& a = s->albums[f->second];
        std::string j = albumJson(a);
        j.pop_back();
        j += ",\"list\":[";
        for (size_t i = 0; i < a.tracks.size(); ++i) { if (i) j += ","; j += trackJson(*s, a.tracks[i], false); }
        jsonOut(res, j + "]}");
    });

    svr.Get("/api/music/artist", [lib](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        auto f = s->artistById.find(req.get_param_value("id"));
        if (f == s->artistById.end()) { notFound(res, "Unknown artist"); return; }
        const Artist& a = s->artists[f->second];
        std::string j = "{\"id\":\"" + a.id + "\",\"name\":\"" + jsonEscape(a.name) + "\",\"tracks\":" + std::to_string(a.trackCount) + ",\"albums\":[";
        for (size_t i = 0; i < a.albums.size(); ++i) { if (i) j += ","; j += albumJson(s->albums[a.albums[i]]); }
        jsonOut(res, j + "]}");
    });

    svr.Get("/api/music/songs", [lib](const httplib::Request& req, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        auto s = lib->snapshot();
        std::string q = lower(trimmed(req.get_param_value("q")));
        size_t offset = (size_t)std::max(0, std::atoi(req.get_param_value("offset").c_str()));
        size_t limit = (size_t)std::min(500, std::max(1, req.has_param("limit") ? std::atoi(req.get_param_value("limit").c_str()) : 200));
        size_t total = 0;
        std::string items;
        for (size_t i = 0; i < s->tracks.size(); ++i) {
            const Track& t = s->tracks[i];
            if (!q.empty() && lower(t.rTitle).find(q) == std::string::npos && lower(t.rArtist).find(q) == std::string::npos && lower(t.rAlbum).find(q) == std::string::npos) continue;
            if (total >= offset && total < offset + limit) { if (!items.empty()) items += ","; items += trackJson(*s, (int)i, true); }
            ++total;
        }
        jsonOut(res, "{\"total\":" + std::to_string(total) + ",\"offset\":" + std::to_string(offset) + ",\"songs\":[" + items + "]}");
    });

    svr.Get("/api/music/search", [lib](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        std::string q = lower(trimmed(req.get_param_value("q")));
        std::string ar, al, so;
        int na = 0, nl = 0, ns = 0;
        if (!q.empty()) {
            for (const auto& a : s->artists) {
                if (na >= 20 || lower(a.name).find(q) == std::string::npos) continue;
                if (na++) ar += ",";
                bool art = false;
                for (int ai : a.albums) if (s->albums[ai].art) { art = true; break; }
                ar += "{\"id\":\"" + a.id + "\",\"name\":\"" + jsonEscape(a.name) + "\",\"albums\":" + std::to_string(a.albums.size()) + ",\"tracks\":" + std::to_string(a.trackCount) +
                      ",\"art\":" + (art ? "true" : "false") + ",\"albumId\":\"" + (a.albums.empty() ? "" : s->albums[a.albums[0]].id) + "\"}";
            }
            for (const auto& a : s->albums) {
                if (nl >= 40 || (lower(a.title).find(q) == std::string::npos && lower(a.artist).find(q) == std::string::npos)) continue;
                if (nl++) al += ",";
                al += albumJson(a);
            }
            for (size_t i = 0; i < s->tracks.size() && ns < 60; ++i) {
                const Track& t = s->tracks[i];
                if (lower(t.rTitle).find(q) == std::string::npos && lower(t.rArtist).find(q) == std::string::npos) continue;
                if (ns++) so += ",";
                so += trackJson(*s, (int)i, true);
            }
        }
        jsonOut(res, "{\"artists\":[" + ar + "],\"albums\":[" + al + "],\"songs\":[" + so + "]}");
    });

    svr.Get("/api/music/art", [lib, art](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        std::string albumId = req.get_param_value("album"), trackId = req.get_param_value("track");
        std::string key = albumId.empty() ? "t:" + trackId : "a:" + albumId;
        std::string mime, bytes;
        if (!art->get(key, mime, bytes)) {
            bool ok = false;
            if (!albumId.empty()) {
                auto f = s->albumById.find(albumId);
                if (f != s->albumById.end()) {
                    const Album& a = s->albums[f->second];
                    // the first song that carries its own picture, else any song with a cover.jpg beside it
                    for (int ti : a.tracks) if (s->tracks[ti].hasArt && lib->cover(s->tracks[ti], true, bytes, mime)) { ok = true; break; }
                    if (!ok) for (int ti : a.tracks) if (!s->tracks[ti].folderArt.empty() && lib->cover(s->tracks[ti], false, bytes, mime)) { ok = true; break; }
                }
            } else {
                auto f = s->trackById.find(trackId);
                if (f != s->trackById.end()) ok = lib->cover(s->tracks[f->second], true, bytes, mime);
            }
            if (!ok) { notFound(res, "No artwork"); return; }
            art->put(key, mime, bytes);
        }
        res.set_header("Cache-Control", "private, max-age=3600");
        res.set_content(bytes, mime);
    });

    svr.Get(R"(/api/music/stream/([A-Za-z0-9]+))", [lib](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        auto f = s->trackById.find(req.matches[1].str());
        if (f == s->trackById.end()) { notFound(res, "Unknown song"); return; }
        const Track& t = s->tracks[f->second];
        const std::string mime = mimeForAudio(fileExt(t.filename));
        if (!vfs::isRemote(t.path)) {
            std::error_code e;
            if (!fs::is_regular_file(t.path, e)) { notFound(res, "File is missing"); return; }
            res.set_file_content(t.path, mime);              // handles Range requests itself
            return;
        }
        vfs::Url u; vfs::Error err;
        if (!vfs::parseUrl(t.path, u) || (vfs::hasShares(u.scheme) && u.share.empty()) || u.path.empty()) { notFound(res, "Bad network path"); return; }
        std::shared_ptr<vfs::Share> share = vfs::connect(u, err);
        if (!share) { res.status = 502; res.set_content("{\"error\": \"Network share is not reachable\"}", "application/json"); return; }
        if (!share->open(u.path, err)) { notFound(res, "File is missing"); return; }
        uint64_t size = share->fileSize();
        res.set_header("Accept-Ranges", "bytes");
        res.set_content_provider((size_t)size, mime, [share](size_t offset, size_t length, httplib::DataSink& sink) {
            static const size_t kChunk = 256 * 1024;
            std::vector<char> buf(std::min(length, kChunk));
            int64_t n = share->read(offset, buf.data(), buf.size());
            if (n <= 0) return false;
            return sink.write(buf.data(), (size_t)n);
        });
    });
}
