#include "music.h"
#include "music_tags.h"
#include "music_online.h"
#include "vfs.h"
#include "pekdb.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <ctime>
#include <filesystem>
#include <functional>
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


// ---- multi-artist strings: "Main, Guest A, Guest B", "Main feat. Guest", "Main; Guest"
// The first name owns the song; the rest are featured / supporting. Names that contain a comma themselves
// ("Tyler, The Creator", "Earth, Wind & Fire" is left whole because we only split on ", ") are protected.
static std::vector<std::string> splitArtists(const std::string& in) {
    std::vector<std::string> out;
    std::string s = in;
    // normalise the "featuring" markers to a ';'
    const char* marks[] = {" feat. ", " feat ", " ft. ", " ft ", " featuring ", " Feat. ", " Ft. ", " Featuring ", " FEAT. ", " (feat. ", " (ft. "};
    for (const char* m : marks) {
        size_t pos = 0; std::string mk = m;
        while ((pos = s.find(mk, pos)) != std::string::npos) { s.replace(pos, mk.size(), ";"); pos += 1; }
    }
    // ", " splits unless what follows is "The ..." (Tyler, The Creator) or a suffix (Jr., Sr., Inc.)
    std::string cur;
    auto flush = [&]() {
        std::string t = cur;
        size_t a = t.find_first_not_of(" \t\r\n"), b = t.find_last_not_of(" \t\r\n)");
        if (a != std::string::npos) out.push_back(t.substr(a, b - a + 1));
        cur.clear();
    };
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (c == ';') { flush(); continue; }
        if (c == ',' && i + 1 < s.size() && s[i + 1] == ' ') {
            std::string rest = lower(s.substr(i + 2, 8));
            bool keep = rest.compare(0, 4, "the ") == 0 || rest.compare(0, 3, "jr.") == 0 || rest.compare(0, 3, "sr.") == 0 ||
                        rest.compare(0, 3, "inc") == 0 || (rest.compare(0, 2, "jr") == 0 && (rest.size() == 2 || !std::isalpha((unsigned char)rest[2])));
            if (!keep) { flush(); ++i; continue; }
        }
        cur += c;
    }
    flush();
    // drop duplicates (case-insensitive), keep order
    std::vector<std::string> uniq;
    for (auto& n : out) {
        bool dup = false;
        for (auto& u : uniq) if (lower(u) == lower(n)) { dup = true; break; }
        if (!dup && !n.empty()) uniq.push_back(n);
    }
    if (uniq.empty() && !trimmed(in).empty()) uniq.push_back(trimmed(in));
    return uniq;
}

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
    std::string rPrimary;                   // the first (owning) artist of rArtist
    std::string nTA, nAl;                   // folded (lower-case, no accents) title+artist and album, for searching
    std::vector<std::string> rFeatured;     // everyone after the first artist
};

struct Album {
    std::string id, title, artist;
    std::string norm;                        // folded title+artist, for searching
    std::vector<std::string> featured;       // other artists on the album's songs
    int year = 0;
    double duration = 0;
    int64_t added = 0;
    std::vector<int> tracks;
    bool art = false;
};
struct Artist {
    std::string id, name;
    std::string norm;                        // folded name, for searching
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
// Names taken from a folder or file name (not from the song's tags) often come as slugs: "21-savage", "a_lot".
// Show them as words ("21 savage", "a lot"). Underscores always become spaces. Hyphens only do when the name is
// a slug (no spaces and no capital letters), so "Jay-Z", "Ne-Yo" and "Artist - Title" are left alone.
std::string prettyName(const std::string& in) {
    std::string s = trimmed(in);
    bool hasSpace = false, hasUpper = false;
    for (unsigned char c : s) { if (c == ' ') hasSpace = true; if (c >= 'A' && c <= 'Z') hasUpper = true; }
    const bool slug = !hasSpace && !hasUpper;
    std::string o;
    o.reserve(s.size());
    for (char c : s) {
        if (c == '_' || (c == '-' && slug)) c = ' ';
        if (c == ' ' && !o.empty() && o.back() == ' ') continue;      // no double spaces
        o += c;
    }
    return trimmed(o);
}

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
// "Bonus Tracks", "Extras", "Deluxe", "Instrumentals" ... : a sub-folder that belongs to the album above it.
bool isPartFolder(const std::string& name) {
    std::string s = lower(trimmed(name));
    static const char* words[] = {"bonus", "extras", "extra", "deluxe", "instrumentals", "instrumental", "acapellas", "acapella"};
    for (const char* w : words) {
        size_t n = std::strlen(w);
        if (s.compare(0, n, w) == 0 && (s.size() == n || s[n] == ' ' || s[n] == '-' || s[n] == '_' || s[n] == '.')) return true;
    }
    return false;
}
// A folder that only holds the library (e.g. the source is "/storage/emulated/0" and the music is in "Music/").
bool isWrapperFolder(const std::string& name) {
    std::string s = lower(trimmed(name));
    return s == "music" || s == "songs" || s == "audio" || s == "download" || s == "downloads";
}
void deriveFromPath(Track& t, const std::vector<std::string>& relDirs) {
    int disc = 0, trk = 0;
    std::string title;
    parseFileName(stemOf(t.filename), disc, trk, title);
    t.fbTitle = title; t.fbTrack = trk; t.fbDisc = disc;
    std::vector<std::string> dirs = relDirs;
    if (!dirs.empty() && isWrapperFolder(dirs.front())) dirs.erase(dirs.begin());
    // Artist/Album/CD1, Artist/Album/Disc 2, Artist/Album/Bonus Tracks: the sub-folder is part of the album
    int folderDisc = 0;
    for (int pass = 0; pass < 2 && !dirs.empty(); ++pass) {
        if (isDiscFolder(dirs.back())) { if (!folderDisc) folderDisc = discNumberOf(dirs.back()); dirs.pop_back(); }
        else if (dirs.size() >= 3 && isPartFolder(dirs.back())) dirs.pop_back();
        else break;
    }
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

// Needs the whole folder tree, so it runs after a scan: a top-level folder that has album folders inside it is an
// artist folder, and the songs lying directly in it (singles) belong to that artist instead of an "album" named
// after the artist.
void inferFromTree(std::vector<Track>& tracks) {
    std::set<std::string> audioDirs;
    for (const auto& t : tracks) if (!t.albumDir.empty()) audioDirs.insert(t.albumDir);
    auto hasSubFolders = [&](const std::string& d) {
        std::string p = d + "/";
        auto it = audioDirs.lower_bound(p);
        return it != audioDirs.end() && it->compare(0, p.size(), p) == 0;
    };
    for (auto& t : tracks) {
        if (t.albumDir.size() < 2 || t.albumDir.find('/', 1) != std::string::npos) continue;     // top-level folders only
        if (!hasSubFolders(t.albumDir)) continue;
        t.fbArtist = t.albumDir.substr(1);
        t.fbAlbum = "Singles";
    }
}

// ================================================================ the music database (music.db)
// One table, `tracks`: what music_cache.tsv held (every song's tags, so a restart does not re-read the files). Saving is
// incremental and atomic (one transaction), so a power cut can never leave a half-written cache. Searching does NOT go
// through the database: measured at 500 and 50,000 songs, the in-memory search (see matchWords) is faster than any query,
// so the database is only the durable copy.
class MusicStore {
public:
    bool open(const std::string& path) {
        if (!w_.open(path)) return false;
        if (!w_.exec("CREATE TABLE IF NOT EXISTS tracks("
                     "path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,"
                     "album_artist TEXT NOT NULL, album TEXT NOT NULL, genre TEXT NOT NULL, track INTEGER NOT NULL, disc INTEGER NOT NULL,"
                     "year INTEGER NOT NULL, duration REAL NOT NULL, has_art INTEGER NOT NULL, fb_artist TEXT NOT NULL, fb_album TEXT NOT NULL,"
                     "fb_title TEXT NOT NULL, fb_track INTEGER NOT NULL, fb_disc INTEGER NOT NULL, album_dir TEXT NOT NULL, folder_art TEXT NOT NULL)"))
            return false;
        // Future schema changes: add `if (v < 2) { ALTER ...; }` steps here, then raise the number.
        if (w_.userVersion() < 1) w_.setUserVersion(1);
        return true;
    }

    bool loadTracks(std::vector<Track>& out) {
        pekdb::Stmt st(w_, "SELECT path,size,mtime,title,artist,album_artist,album,genre,track,disc,year,duration,has_art,"
                           "fb_artist,fb_album,fb_title,fb_track,fb_disc,album_dir,folder_art FROM tracks");
        if (!st.ok()) return false;
        while (st.step()) {
            Track t;
            t.path = st.str(0); t.size = static_cast<uint64_t>(st.num(1)); t.mtime = st.num(2);
            t.title = st.str(3); t.artist = st.str(4); t.albumArtist = st.str(5); t.album = st.str(6); t.genre = st.str(7);
            t.track = static_cast<int>(st.num(8)); t.disc = static_cast<int>(st.num(9)); t.year = static_cast<int>(st.num(10));
            t.duration = st.dbl(11); t.hasArt = st.num(12) != 0;
            t.fbArtist = st.str(13); t.fbAlbum = st.str(14); t.fbTitle = st.str(15); t.fbTrack = static_cast<int>(st.num(16));
            t.fbDisc = static_cast<int>(st.num(17)); t.albumDir = st.str(18); t.folderArt = st.str(19);
            out.push_back(std::move(t));
        }
        return true;
    }

    // New and changed songs are saved, songs that are gone are removed: one transaction.
    bool saveTracks(const std::vector<Track>& all) {
        pekdb::Tx tx(w_);
        if (!tx.ok()) return false;
        {
            pekdb::Stmt up(w_, "INSERT INTO tracks(path,size,mtime,title,artist,album_artist,album,genre,track,disc,year,duration,has_art,"
                               "fb_artist,fb_album,fb_title,fb_track,fb_disc,album_dir,folder_art) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                               "ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,title=excluded.title,artist=excluded.artist,"
                               "album_artist=excluded.album_artist,album=excluded.album,genre=excluded.genre,track=excluded.track,disc=excluded.disc,"
                               "year=excluded.year,duration=excluded.duration,has_art=excluded.has_art,fb_artist=excluded.fb_artist,"
                               "fb_album=excluded.fb_album,fb_title=excluded.fb_title,fb_track=excluded.fb_track,fb_disc=excluded.fb_disc,"
                               "album_dir=excluded.album_dir,folder_art=excluded.folder_art");
            if (!up.ok()) return false;
            for (const auto& t : all) {
                up.text(1, t.path).i64(2, static_cast<long long>(t.size)).i64(3, t.mtime).text(4, t.title).text(5, t.artist)
                  .text(6, t.albumArtist).text(7, t.album).text(8, t.genre).i64(9, t.track).i64(10, t.disc).i64(11, t.year)
                  .real(12, t.duration).i64(13, t.hasArt ? 1 : 0).text(14, t.fbArtist).text(15, t.fbAlbum).text(16, t.fbTitle)
                  .i64(17, t.fbTrack).i64(18, t.fbDisc).text(19, t.albumDir).text(20, t.folderArt);
                if (!up.run()) return false;
                up.reset();
            }
        }
        std::vector<std::string> gone;
        {
            std::set<std::string> keep;
            for (const auto& t : all) keep.insert(t.path);
            pekdb::Stmt sel(w_, "SELECT path FROM tracks");
            while (sel.step()) { std::string p = sel.str(0); if (!keep.count(p)) gone.push_back(std::move(p)); }
        }
        if (!gone.empty()) {
            pekdb::Stmt del(w_, "DELETE FROM tracks WHERE path=?");
            for (const auto& p : gone) { del.text(1, p); del.run(); del.reset(); }
        }
        return tx.commit();
    }

private:
    pekdb::Db w_;
};

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
    size_t scannedCount() const { return scanned_.load(); }
    std::function<void()> onScanDone;                // called (on the scan thread) when a scan has finished

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
            if (onScanDone) { try { onScanDone(); } catch (...) { } }
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
    std::vector<Track> cache_;                       // what the last scan (or the cache) knew
    std::unique_ptr<MusicStore> store_;              // music.db; null when SQLite could not be opened (then music_cache.tsv is used)
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
        auto fresh = std::make_unique<MusicStore>();
        if (fresh->open((fs::path(cacheFile_).parent_path() / "music.db").string())) {
            store_ = std::move(fresh);
            std::vector<Track> loaded;
            store_->loadTracks(loaded);
            if (loaded.empty() && fs::exists(cacheFile_)) {            // one-time move of the old cache file into the database
                std::vector<Track> old;
                readTsv(old);
                if (!old.empty() && store_->saveTracks(old)) {
                    std::error_code ec;
                    fs::rename(cacheFile_, cacheFile_ + ".migrated", ec);
                    std::cout << "[Music] Moved " << old.size() << " song(s) from the old cache file into the database." << std::endl;
                    loaded = std::move(old);
                    for (auto& t : loaded) { t.filename = leafOf(t.path); t.id = stableId(t.path); }
                    cache_ = std::move(loaded);
                    std::cout << "[Music] Loaded " << cache_.size() << " song(s) from the database." << std::endl;
                    return;
                }
            }
            for (auto& t : loaded) { t.filename = leafOf(t.path); t.id = stableId(t.path); }
            cache_ = std::move(loaded);
            std::cout << "[Music] Loaded " << cache_.size() << " song(s) from the database." << std::endl;
            return;
        }
        std::cout << "[Music] The music database is unavailable: using the cache file." << std::endl;
        readTsv(cache_);
    }
    // The old tab-separated cache (also the fallback when the database cannot be opened).
    void readTsv(std::vector<Track>& out) {
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
            out.push_back(std::move(t));
        }
        std::cout << "[Music] Read " << out.size() << " song(s) from the cache file." << std::endl;
    }
    void saveCache(const std::vector<Track>& tracks) {
        if (store_) {
            if (!store_->saveTracks(tracks)) std::cout << "[Music] Could not save the song cache to the database." << std::endl;
            return;
        }
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
        // First scan: publish what has been read so far (albums and artists too) about every 1.5 s, not only every
        // 250 songs, so a small library or a slow share fills in step by step instead of appearing at the end.
        if (!ctx.firstScan || ctx.probed == 0) return;
        auto now = std::chrono::steady_clock::now();
        if (now - lastPublish_ >= std::chrono::milliseconds(1500)) { lastPublish_ = now; publish(ctx.found); }
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
        lastPublish_ = std::chrono::steady_clock::now();
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
        inferFromTree(unique);
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
            t.rTitle = !t.title.empty() ? t.title : prettyName(!t.fbTitle.empty() ? t.fbTitle : stemOf(t.filename));
            t.rArtist = !t.artist.empty() ? t.artist : (!t.albumArtist.empty() ? t.albumArtist : (!t.fbArtist.empty() ? prettyName(t.fbArtist) : "Unknown Artist"));
            t.rAlbum = !t.album.empty() ? t.album : (!t.fbAlbum.empty() ? prettyName(t.fbAlbum) : "Unknown Album");
            // The song belongs to the FIRST artist; everyone after is featured / supporting.
            auto names = splitArtists(t.rArtist);
            t.rPrimary = names.empty() ? t.rArtist : names[0];
            t.rFeatured.assign(names.size() > 1 ? names.begin() + 1 : names.end(), names.end());
            if (!t.track) t.track = t.fbTrack;
            if (!t.disc) t.disc = t.fbDisc;
            t.nTA = pekdb::fold(t.rTitle + " " + t.rArtist);
            t.nAl = pekdb::fold(t.rAlbum);
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
            g.counts[t.rPrimary]++; g.total++;
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
            std::string aa;
            if (!t.albumArtist.empty()) { auto an = splitArtists(t.albumArtist); aa = an.empty() ? t.albumArtist : an[0]; }
            else aa = groupArtist[lower(t.rAlbum) + "|" + t.albumDir];
            std::string key = lower(t.rAlbum) + "|" + lower(aa);
            auto f = albumIndexByKey.find(key);
            int ai;
            if (f == albumIndexByKey.end()) {
                Album a; a.id = stableId("album:" + key); a.title = t.rAlbum; a.artist = aa; a.norm = pekdb::fold(a.title + " " + a.artist);
                ai = (int)albums.size(); albums.push_back(a); albumIndexByKey[key] = ai;
            } else ai = f->second;
            Album& a = albums[ai];
            {
                auto addFeat = [&](const std::string& n) {
                    if (lower(n) == lower(a.artist)) return;
                    for (auto& f2 : a.featured) if (lower(f2) == lower(n)) return;
                    a.featured.push_back(n);
                };
                if (!t.albumArtist.empty()) { auto an = splitArtists(t.albumArtist); for (size_t k = 1; k < an.size(); ++k) addFeat(an[k]); }
                for (auto& n : t.rFeatured) addFeat(n);
                if (lower(t.rPrimary) != lower(a.artist) && a.artist != "Various Artists") addFeat(t.rPrimary);
            }
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
            if (f == artistIndex.end()) { Artist r; r.id = stableId("artist:" + k); r.name = a.artist; r.norm = pekdb::fold(r.name); ar = (int)s->artists.size(); s->artists.push_back(r); artistIndex[k] = ar; }
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
    std::chrono::steady_clock::time_point lastPublish_{};
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

// ---------------------------------------------------------------- offline library
// Walks the whole library once and keeps every online extra on disk (artist photos, album and single covers, lyrics),
// so they show instantly and keep working with no internet. Runs by itself after each scan while Online art & lyrics
// is on, or on demand (/api/music/offline). Items already kept are skipped, so repeating it is cheap and a stopped /
// interrupted run simply continues. Songs, albums and covers that live in the files themselves are already offline.
bool isSinglesTitle(const std::string& title);
struct OfflineJob {
    struct Item { int kind; std::string a, b, c; double dur; std::vector<std::pair<std::string, std::string>> songs; };      // kind: 0 lyrics, 1 artist photo, 2 album cover, 3 single cover
    std::atomic<bool> running{false}, stop{false}, again{false};
    std::atomic<int> total{0}, done{0}, lyTotal{0}, lyDone{0}, lyFound{0}, cvTotal{0}, cvDone{0}, cvFound{0}, failed{0}, songs{0};
    std::atomic<int64_t> finishedAt{0};
    std::mutex m;
    std::string phase = "idle";                                      // idle | scanning | working | done | stopped | offline | off

    void setPhase(const std::string& p) { std::lock_guard<std::mutex> l(m); phase = p; }
    std::string getPhase() { std::lock_guard<std::mutex> l(m); return phase; }

    void start(const std::shared_ptr<MusicLibrary>& lib) {
        if (!musiconline::kAvailable) return;
        if (running.exchange(true)) { again.store(true); return; }
        stop.store(false); again.store(false);
        std::thread([this, lib]() {
            try { run(lib); } catch (const std::exception& e) { std::cout << "[Music] Offline sync failed: " << e.what() << std::endl; setPhase("stopped"); }
            running.store(false);
            if (again.exchange(false) && !stop.load() && musiconline::store().on.load()) start(lib);
        }).detach();
    }

    void run(const std::shared_ptr<MusicLibrary>& lib) {
        auto& st = musiconline::store();
        if (!st.on.load()) { setPhase("off"); return; }
        total = done = lyTotal = lyDone = lyFound = cvTotal = cvDone = cvFound = failed = 0;
        finishedAt = 0;
        setPhase("scanning");
        while (lib->scanning() && !stop.load()) std::this_thread::sleep_for(std::chrono::milliseconds(400));
        if (stop.load()) { setPhase("stopped"); return; }
        auto s = lib->snapshot();
        songs = (int)s->tracks.size();

        std::vector<Item> items;                                     // pictures first (they are what you see), then lyrics
        std::set<std::string> seen;
        for (const auto& a : s->artists) if (seen.insert("r|" + lower(a.name)).second) items.push_back({1, a.name, "", "", 0});
        for (const auto& al : s->albums) {
            if (isSinglesTitle(al.title)) continue;
            bool local = al.art;
            if (!local) for (int ti : al.tracks) if (s->tracks[ti].hasArt || !s->tracks[ti].folderArt.empty()) { local = true; break; }
            if (!local && seen.insert("a|" + lower(al.artist) + "|" + lower(al.title)).second) {
                Item it{2, al.artist, al.title, "", 0, {}};
                for (int ti : al.tracks) { if (it.songs.size() >= 3) break; it.songs.push_back({s->tracks[ti].rPrimary, s->tracks[ti].rTitle}); }
                items.push_back(std::move(it));
            }
        }
        for (const auto& t : s->tracks) {
            auto f = s->albumOfTrack.find(t.id);
            bool singles = f != s->albumOfTrack.end() && isSinglesTitle(s->albums[f->second].title);
            if (singles && !t.hasArt && t.folderArt.empty() && seen.insert("s|" + lower(t.rPrimary) + "|" + lower(t.rTitle)).second)
                items.push_back({3, t.rPrimary, t.rTitle, "", 0});
        }
        for (const auto& it : items) ++cvTotal;
        size_t nPics = items.size();
        for (const auto& t : s->tracks)
            if (seen.insert("l|" + lower(t.rPrimary) + "|" + lower(t.rTitle) + "|" + std::to_string((int)(t.duration / 4))).second)
                items.push_back({0, t.rPrimary, t.rTitle, t.rAlbum, t.duration});
        lyTotal = (int)(items.size() - nPics);
        total = (int)items.size();
        setPhase("working");

        std::atomic<size_t> next{0};
        std::atomic<int> streak{0};                                  // lookups in a row that could not reach the service
        auto worker = [&]() {
            for (;;) {
                if (stop.load() || streak.load() >= 12) return;
                size_t i = next.fetch_add(1);
                if (i >= items.size()) return;
                const Item& it = items[i];
                int r;
                std::string x, y;
                if (it.kind == 0) r = musiconline::lyricsEx(it.a, it.b, it.c, it.dur, x, y);
                else {
                    r = musiconline::lookupEx(it.kind == 1 ? "artist" : it.kind == 2 ? "album" : "song", it.a, it.b, x, y);
                    if (it.kind == 2 && r != 1)                              // same fallback as the cover route: one of its songs may have the picture
                        for (const auto& sg : it.songs) { int r2 = musiconline::lookupEx("song", sg.first, sg.second, x, y); if (r2 == 1) { r = 1; break; } if (r2 < 0) r = -1; }
                }
                if (r < 0) { ++failed; ++streak; } else streak = 0;
                if (it.kind == 0) { ++lyDone; if (r == 1) ++lyFound; } else { ++cvDone; if (r == 1) ++cvFound; }
                ++done;
            }
        };
        std::vector<std::thread> pool;
        for (int i = 0; i < 3; ++i) pool.emplace_back(worker);
        for (auto& th : pool) th.join();

        if (stop.load()) setPhase("stopped");
        else if (streak.load() >= 12) setPhase("offline");
        else { setPhase("done"); finishedAt = (int64_t)std::time(nullptr); }
        std::cout << "[Music] Offline sync: " << done.load() << "/" << total.load() << " (lyrics found " << lyFound.load()
                  << ", covers found " << cvFound.load() << ", could not reach " << failed.load() << ")" << std::endl;
    }

    std::string json(const std::shared_ptr<MusicLibrary>& lib) {
        std::string ph = getPhase();
        bool scanningNow = lib->scanning();
        int t = total.load(), d = done.load();
        int pct = t > 0 ? (int)((long long)d * 100 / t) : (ph == "done" ? 100 : 0);
        if (ph == "done") pct = 100;
        auto n = [](int v) { return std::to_string(v); };
        auto snap = lib->snapshot();
        return std::string("{\"available\":") + (musiconline::kAvailable ? "true" : "false") + ",\"enabled\":" + (musiconline::store().on.load() ? "true" : "false") +
               ",\"running\":" + (running.load() ? "true" : "false") + ",\"scanning\":" + (scanningNow ? "true" : "false") + ",\"phase\":\"" + ph + "\"" +
               ",\"percent\":" + n(pct) + ",\"total\":" + n(t) + ",\"done\":" + n(d) + ",\"failed\":" + n(failed.load()) +
               ",\"music\":{\"songs\":" + n((int)snap->tracks.size()) + ",\"albums\":" + n((int)snap->albums.size()) + ",\"ready\":" + (scanningNow ? "false" : "true") + "}" +
               ",\"covers\":{\"done\":" + n(cvDone.load()) + ",\"total\":" + n(cvTotal.load()) + ",\"found\":" + n(cvFound.load()) + "}" +
               ",\"lyrics\":{\"done\":" + n(lyDone.load()) + ",\"total\":" + n(lyTotal.load()) + ",\"found\":" + n(lyFound.load()) + "}" +
               ",\"finishedAt\":" + std::to_string(finishedAt.load()) + "}";
    }
};

// ---------------------------------------------------------------- JSON
std::string num(double v) {
    char b[32];
    std::snprintf(b, sizeof b, "%.0f", v < 0 ? 0 : v);
    return b;
}
// The folder-name fallback calls loose songs "Singles" (or "Unknown Album"): one picture for that "album" would be wrong,
// so each of its songs gets its own cover and the album card shows the artist's photo.
bool isSinglesTitle(const std::string& title) {
    std::string l = lower(trimmed(title));
    return l == "singles" || l == "unknown album";
}
bool onlineOn() { return musiconline::store().on.load(); }

std::string strArr(const std::vector<std::string>& v) {
    std::string j = "[";
    for (size_t i = 0; i < v.size(); ++i) { if (i) j += ","; j += "\"" + jsonEscape(v[i]) + "\""; }
    return j + "]";
}
// Search: the query is folded the same way as the stored names (capitals and accents ignored, punctuation = space) and
// split into words; a song, album or artist matches when EVERY word appears somewhere in its folded text. Both sides are
// folded once (the names when the library is published, the query once per request), so a search is a few substring
// finds per item with no allocation.
std::vector<std::string> searchWords(const std::string& raw) { return pekdb::words(pekdb::fold(raw)); }

bool matchWords(const std::vector<std::string>& words, const std::string& a, const std::string* b = nullptr) {
    for (const auto& w : words)
        if (a.find(w) == std::string::npos && (!b || b->find(w) == std::string::npos)) return false;
    return true;
}

std::string trackJson(const Snapshot& s, int ti, bool withAlbum) {
    const Track& t = s.tracks[ti];
    std::string j = "{\"id\":\"" + t.id + "\",\"title\":\"" + jsonEscape(t.rTitle) + "\",\"artist\":\"" + jsonEscape(t.rArtist) +
                    "\",\"primary\":\"" + jsonEscape(t.rPrimary) + "\",\"featured\":" + strArr(t.rFeatured) + ",\"track\":" + std::to_string(t.track) + ",\"disc\":" + std::to_string(t.disc) + ",\"duration\":" + num(t.duration);
    if (withAlbum) {
        j += ",\"album\":\"" + jsonEscape(t.rAlbum) + "\"";
        auto f = s.albumOfTrack.find(t.id);
        if (f != s.albumOfTrack.end()) {
            const Album& al = s.albums[f->second];
            if (isSinglesTitle(al.title)) j += std::string(",\"art\":") + ((t.hasArt || !t.folderArt.empty() || onlineOn()) ? "true" : "false");   // its own cover: no albumId
            else j += ",\"albumId\":\"" + al.id + "\",\"art\":" + ((al.art || onlineOn()) ? "true" : "false");
        }
    }
    return j + ",\"ext\":\"" + jsonEscape(fileExt(t.filename)) + "\"}";
}
std::string albumJson(const Album& a) {
    return "{\"id\":\"" + a.id + "\",\"title\":\"" + jsonEscape(a.title) + "\",\"artist\":\"" + jsonEscape(a.artist) + "\",\"featured\":" + strArr(a.featured) + ",\"year\":" + std::to_string(a.year) +
           ",\"tracks\":" + std::to_string(a.tracks.size()) + ",\"duration\":" + num(a.duration) + ",\"added\":" + std::to_string(a.added) +
           ",\"art\":" + ((a.art || onlineOn()) ? "true" : "false") + ",\"singles\":" + (isSinglesTitle(a.title) ? "true" : "false") + "}";
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

// ---------------------------------------------------------------- cover lookup (shared by the route and its background worker)
// Finds the picture for one /api/music/art request: the song's own, cover.jpg beside it, then (online art) the services.
// blocking = false never touches the network: online answers come only from what is already on disk, and [unresolved]
// counts the lookups that still have to be made. blocking = true is the background worker's full lookup.
static bool resolveArt(const std::shared_ptr<MusicLibrary>& lib, const std::shared_ptr<const Snapshot>& s,
                       const std::string& albumId, const std::string& trackId, const std::string& artistId,
                       bool blocking, int& unresolved, std::string& bytes, std::string& mime) {
    auto online = [&](const char* kind, const std::string& a, const std::string& b) {
        int r = blocking ? musiconline::lookupEx(kind, a, b, bytes, mime) : musiconline::lookupCachedEx(kind, a, b, bytes, mime);
        if (r < 0) ++unresolved;
        return r == 1;
    };
    // local pictures first: the song's own, then cover.jpg / folder.jpg beside it
    auto albumLocal = [&](const Album& a) {
        for (int ti : a.tracks) if (s->tracks[ti].hasArt && lib->cover(s->tracks[ti], true, bytes, mime)) return true;
        for (int ti : a.tracks) if (!s->tracks[ti].folderArt.empty() && lib->cover(s->tracks[ti], false, bytes, mime)) return true;
        return false;
    };
    bool ok = false;
    if (!artistId.empty()) {
        auto f = s->artistById.find(artistId);
        if (f != s->artistById.end()) {
            const Artist& a = s->artists[f->second];
            ok = online("artist", a.name, "");                                          // a photo of the artist (online art only)
            if (!ok) for (int ai : a.albums) if (albumLocal(s->albums[ai])) { ok = true; break; }   // else one of their covers
        }
    } else if (!albumId.empty()) {
        auto f = s->albumById.find(albumId);
        if (f != s->albumById.end()) {
            const Album& a = s->albums[f->second];
            if (isSinglesTitle(a.title)) ok = online("artist", a.artist, "");           // "Singles" shows the artist
            else {
                ok = albumLocal(a);
                if (!ok) ok = online("album", a.artist, a.title);
                if (!ok) {                                                              // the album is not listed: one of its songs may be (singles, deluxe editions)
                    int tried = 0;
                    for (int ti : a.tracks) {
                        if (tried++ >= 3) break;
                        const Track& tt = s->tracks[ti];
                        if (online("song", tt.rPrimary, tt.rTitle)) { ok = true; break; }
                    }
                }
            }
        }
    } else {
        auto f = s->trackById.find(trackId);
        if (f != s->trackById.end()) {
            const Track& t = s->tracks[f->second];
            ok = lib->cover(t, true, bytes, mime);
            if (!ok) {
                // a copy, not a reference: splitArtists() returns a temporary vector
                const std::string albumArtist = !t.albumArtist.empty() ? splitArtists(t.albumArtist)[0] : t.rPrimary;
                if (!isSinglesTitle(t.rAlbum)) ok = online("album", albumArtist, t.rAlbum);
                if (!ok) ok = online("song", t.rPrimary, t.rTitle);                     // a single: its own cover
            }
        }
    }
    return ok;
}

// Online covers are looked up here, one or two at a time, newest request first (that is what is on screen), instead of
// on the server's request threads: a grid asking for hundreds of covers used to park every request thread waiting for a
// lookup slot, so the song list, the player and everything else queued behind them.
struct ArtBg {
    std::mutex m;
    std::condition_variable cv;
    std::deque<std::pair<std::string, std::function<void()>>> q;
    std::set<std::string> queued;
    int started = 0;
    void post(const std::string& key, std::function<void()> f) {
        std::lock_guard<std::mutex> l(m);
        if (queued.count(key) || q.size() >= 1000) return;
        queued.insert(key);
        q.emplace_front(key, std::move(f));
        if (started < 2) { ++started; std::thread([this]() { loop(); }).detach(); }
        cv.notify_one();
    }
    void loop() {
        for (;;) {
            std::pair<std::string, std::function<void()>> job;
            {
                std::unique_lock<std::mutex> l(m);
                cv.wait(l, [this]() { return !q.empty(); });
                job = std::move(q.front());
                q.pop_front();
            }
            try { job.second(); } catch (...) {}
            std::lock_guard<std::mutex> l(m);
            queued.erase(job.first);
        }
    }
};
static ArtBg& artBg() { static ArtBg* b = new ArtBg(); return *b; }     // never destroyed: its threads outlive static teardown

// ================================================================ routes
void registerMusicRoutes(httplib::Server& svr, MediaScanner* scanner, const std::string& dataDir) {
    std::error_code ec;
    if (!dataDir.empty()) fs::create_directories(dataDir, ec);
    auto lib = std::make_shared<MusicLibrary>((fs::path(dataDir) / "music_cache.tsv").string(), scanner);
    auto art = std::make_shared<ArtCache>();
    musiconline::store().init(dataDir);
    auto offline = std::make_shared<OfflineJob>();
    // After every scan, keep the pictures and lyrics for the (new) songs too, while Online art & lyrics is on.
    lib->onScanDone = [lib, offline]() { if (musiconline::store().on.load()) offline->start(lib); };

    // Every normal scan (startup, rescan, a new source) refreshes the music too, on its own thread.
    scanner->setAfterScan([lib]() { lib->scanAsync(); });

    svr.Get("/api/music/status", [lib](const httplib::Request&, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        auto s = lib->snapshot();
        jsonOut(res, std::string("{\"scanning\":") + (lib->scanning() ? "true" : "false") + ",\"tracks\":" + std::to_string(s->tracks.size()) +
                         ",\"albums\":" + std::to_string(s->albums.size()) + ",\"artists\":" + std::to_string(s->artists.size()) +
                         ",\"scanned\":" + std::to_string(lib->scannedCount()) + "}");
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
                 ",\"tracks\":" + std::to_string(a.trackCount) + ",\"art\":" + (art ? "true" : "false") + ",\"photo\":" + (onlineOn() ? "true" : "false") + ",\"albumId\":\"" +
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
        std::string j = "{\"id\":\"" + a.id + "\",\"name\":\"" + jsonEscape(a.name) + "\",\"tracks\":" + std::to_string(a.trackCount) + ",\"photo\":" + (onlineOn() ? "true" : "false") + ",\"albums\":[";
        for (size_t i = 0; i < a.albums.size(); ++i) { if (i) j += ","; j += albumJson(s->albums[a.albums[i]]); }
        jsonOut(res, j + "]}");
    });

    svr.Get("/api/music/songs", [lib](const httplib::Request& req, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        auto s = lib->snapshot();
        const std::vector<std::string> qw = searchWords(req.get_param_value("q"));
        size_t offset = (size_t)std::max(0, std::atoi(req.get_param_value("offset").c_str()));
        size_t limit = (size_t)std::min(500, std::max(1, req.has_param("limit") ? std::atoi(req.get_param_value("limit").c_str()) : 200));
        size_t total = 0;
        std::string items;
        for (size_t i = 0; i < s->tracks.size(); ++i) {
            const Track& t = s->tracks[i];
            if (!qw.empty() && !matchWords(qw, t.nTA, &t.nAl)) continue;     // every word in the title, artist or album
            if (total >= offset && total < offset + limit) { if (!items.empty()) items += ","; items += trackJson(*s, (int)i, true); }
            ++total;
        }
        jsonOut(res, "{\"total\":" + std::to_string(total) + ",\"offset\":" + std::to_string(offset) + ",\"songs\":[" + items + "]}");
    });

    svr.Get("/api/music/search", [lib](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        const std::vector<std::string> qw = searchWords(req.get_param_value("q"));
        std::string ar, al, so;
        int na = 0, nl = 0, ns = 0;
        if (!qw.empty()) {
            std::vector<int> ia, il, is;
            for (size_t i = 0; i < s->artists.size() && ia.size() < 20; ++i) if (matchWords(qw, s->artists[i].norm)) ia.push_back((int)i);
            for (size_t i = 0; i < s->albums.size() && il.size() < 40; ++i) if (matchWords(qw, s->albums[i].norm)) il.push_back((int)i);
            for (size_t i = 0; i < s->tracks.size() && is.size() < 60; ++i) if (matchWords(qw, s->tracks[i].nTA)) is.push_back((int)i);
            for (int i : ia) {
                const Artist& a = s->artists[i];
                if (na++) ar += ",";
                bool art = false;
                for (int ai : a.albums) if (s->albums[ai].art) { art = true; break; }
                ar += "{\"id\":\"" + a.id + "\",\"name\":\"" + jsonEscape(a.name) + "\",\"albums\":" + std::to_string(a.albums.size()) + ",\"tracks\":" + std::to_string(a.trackCount) +
                      ",\"art\":" + (art ? "true" : "false") + ",\"photo\":" + (onlineOn() ? "true" : "false") + ",\"albumId\":\"" + (a.albums.empty() ? "" : s->albums[a.albums[0]].id) + "\"}";
            }
            for (int i : il) { if (nl++) al += ","; al += albumJson(s->albums[i]); }
            for (int i : is) { if (ns++) so += ","; so += trackJson(*s, i, true); }
        }
        jsonOut(res, "{\"artists\":[" + ar + "],\"albums\":[" + al + "],\"songs\":[" + so + "]}");
    });

    svr.Get("/api/music/art", [lib, art](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        std::string albumId = req.get_param_value("album"), trackId = req.get_param_value("track"), artistId = req.get_param_value("artist");
        std::string key = !artistId.empty() ? "r:" + artistId : albumId.empty() ? "t:" + trackId : "a:" + albumId;
        std::string mime, bytes;
        if (!art->get(key, mime, bytes)) {
            int unresolved = 0;
            if (!resolveArt(lib, s, albumId, trackId, artistId, false, unresolved, bytes, mime)) {
                if (unresolved > 0 && onlineOn()) {
                    // Not on disk yet: fetch it in the background and answer 503 at once (Retry-After), so no request thread waits.
                    // Asking again a few seconds later finds it. 404 stays for "there is none".
                    artBg().post(key, [lib, art, s, albumId, trackId, artistId, key]() {
                        std::string b, m;
                        int u = 0;
                        if (resolveArt(lib, s, albumId, trackId, artistId, true, u, b, m)) art->put(key, m, b);
                    });
                    res.status = 503;
                    res.set_header("Retry-After", "3");
                    res.set_header("Cache-Control", "no-store");
                    res.set_content("{\"error\": \"Artwork is being fetched\"}", "application/json");
                    return;
                }
                notFound(res, "No artwork");
                return;
            }
            art->put(key, mime, bytes);
        }
        res.set_header("Cache-Control", "private, max-age=3600");
        res.set_content(bytes, mime);
    });

    // Lyrics (LRCLIB). Follows the same on / off switch as the online pictures: song names are sent to lrclib.net.
    // Answer: {"synced":"[00:12.34] line\n...","plain":"..."}; 404 when nothing is found or online lookups are off.
    svr.Get("/api/music/lyrics", [lib](const httplib::Request& req, httplib::Response& res) {
        auto s = lib->snapshot();
        auto f = s->trackById.find(req.get_param_value("track"));
        if (f == s->trackById.end()) { notFound(res, "No such song"); return; }
        const Track& t = s->tracks[f->second];
        std::string synced, plain;
        if (!musiconline::lyrics(t.rPrimary, t.rTitle, t.rAlbum, t.duration, synced, plain)) { notFound(res, "No lyrics"); return; }
        res.set_header("Cache-Control", "private, max-age=3600");
        jsonOut(res, "{\"synced\":\"" + jsonEscape(synced) + "\",\"plain\":\"" + jsonEscape(plain) + "\"}");
    });


    // Offline library: progress of saving covers + lyrics on disk. GET = status; POST ?action=start | stop.
    svr.Get("/api/music/offline", [lib, offline](const httplib::Request&, httplib::Response& res) {
        lib->scanOnceIfNeeded();
        jsonOut(res, offline->json(lib));
    });
    svr.Post("/api/music/offline", [lib, offline](const httplib::Request& req, httplib::Response& res) {
        std::string a = req.get_param_value("action");
        if (a == "stop") offline->stop.store(true);
        else if (a == "retry") {                                  // ask again for everything that came back empty
            if (!musiconline::store().on.load()) offline->setPhase("off");
            else if (!offline->running.load()) { musiconline::store().forgetMisses(); offline->start(lib); }
        }
        else if (a == "start") {
            if (!musiconline::store().on.load()) offline->setPhase("off");
            else if (!offline->running.load()) offline->start(lib);
        }
        jsonOut(res, offline->json(lib));
    });

    // Online art (artist photos, album and single covers) on / off. On by default (the user can switch it off): names are sent to Deezer / Apple.
    svr.Get("/api/music/online", [](const httplib::Request&, httplib::Response& res) {
        jsonOut(res, std::string("{\"available\":") + (musiconline::kAvailable ? "true" : "false") + ",\"enabled\":" + (onlineOn() ? "true" : "false") + "}");
    });
    svr.Post("/api/music/online", [lib, offline](const httplib::Request& req, httplib::Response& res) {
        std::string v = req.get_param_value("enabled");
        musiconline::store().setEnabled(v == "1" || v == "true");
        if (musiconline::store().on.load()) offline->start(lib);
        jsonOut(res, std::string("{\"available\":") + (musiconline::kAvailable ? "true" : "false") + ",\"enabled\":" + (onlineOn() ? "true" : "false") + "}");
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

// A manual rescan forgets the pictures found online (and the "nothing found" answers), so they are looked up afresh.
void musicOnlineClearCache() { musiconline::store().clear(); }
