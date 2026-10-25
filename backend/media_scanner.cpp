#include "media_scanner.h"
#include "vfs.h"
#include "nfo.h"
#include "pekdb.h"
#include <unordered_set>
#include <map>
#include <set>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <sstream>
#include <iostream>
#include <algorithm>
#include <cctype>
#include <regex>
#include <unordered_map>
#include <array>
#include <memory>
#include <cstdio>
#include <chrono>
#include <system_error>

namespace fs = std::filesystem;

namespace {

const std::vector<std::string> kVideoExtensions = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v",
    ".ts", ".webm", ".flv", ".3gp"
};

// Adjust if ffprobe is bundled at a fixed path rather than on PATH.
const std::string kFfprobeBinary = "ffprobe";

// First line of the cache file. Bump when classification logic changes
// enough that old cached results should be recomputed.
const std::string kCacheHeader = "#hesper-cache-v2";

std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                    [](unsigned char c) { return std::tolower(c); });
    return s;
}

std::string shellEscape(const std::string& path) {
    // Wrap in single quotes and escape any embedded single quotes,
    // so filenames with spaces/parentheses/etc. survive the shell
    // call intact.
    std::string out = "'";
    for (char c : path) {
        if (c == '\'') out += "'\\''";
        else out += c;
    }
    out += "'";
    return out;
}

std::string runCommand(const std::string& cmd) {
    std::array<char, 4096> buffer;
    std::string result;
    std::unique_ptr<FILE, decltype(&pclose)> pipe(popen(cmd.c_str(), "r"), pclose);
    if (!pipe) return result;
    size_t n;
    while ((n = fread(buffer.data(), 1, buffer.size(), pipe.get())) > 0) {
        result.append(buffer.data(), n);
    }
    return result;
}

// Not a general JSON parser — ffprobe's tag vocabulary here is
// small and well-known, so a targeted regex per key is simpler and
// has no dependency, at the cost of not being a real parser. Good
// enough for pulling a handful of known string/number tags out of
// ffprobe's `-show_format -print_format json` output.
std::string extractTag(const std::string& json, const std::string& key) {
    // Value may contain escaped quotes/backslashes; key match is
    // case-insensitive because Matroska tags are often upper-case.
    std::regex re("\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", std::regex::icase);
    std::smatch m;
    if (!std::regex_search(json, m, re)) return "";
    std::string raw = m[1].str(), out;
    for (size_t i = 0; i < raw.size(); ++i) {
        if (raw[i] == '\\' && i + 1 < raw.size()) {
            char n = raw[++i];
            out += (n == 'n' || n == 't' || n == 'r') ? ' ' : n;   // \" -> ", \\ -> \, control escapes -> space
        } else {
            out += raw[i];
        }
    }
    return out;
}

// Tabs/newlines would corrupt the tab-delimited cache file.
std::string sanitizeField(std::string s) {
    for (char& c : s) if (c == '\t' || c == '\n' || c == '\r') c = ' ';
    return s;
}

int extractTagInt(const std::string& json, const std::string& key) {
    std::string v = extractTag(json, key);
    if (v.empty()) return 0;
    try {
        // Some taggers write "3" as "3/1" or "03"; just take the
        // leading digits.
        std::smatch m;
        if (std::regex_search(v, m, std::regex(R"(\d+)"))) return std::stoi(m[0].str());
    } catch (...) {}
    return 0;
}


// ------------------------------------------------------------
// Filename / folder fallback helpers
// ------------------------------------------------------------

const std::vector<std::string> kJunkTokens = {
    "480p", "576p", "720p", "1080p", "1080i", "2160p", "4k", "uhd",
    "x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx",
    "web", "webdl", "web-dl", "webrip", "web-rip", "bluray", "blu-ray",
    "bdrip", "brrip", "hdrip", "hdtv", "dvdrip", "dvd", "remux",
    "aac", "ac3", "dts", "ddp5", "dd5", "atmos", "hdr", "hdr10",
    "proper", "repack", "extended", "unrated", "multi", "dual"
};

// Folder names that are containers, not show names.
const std::vector<std::string> kGenericFolders = {
    "downloads", "download", "videos", "video", "movies", "movie",
    "tv", "tv shows", "tvshows", "shows", "series", "media", "documents",
    "storage", "sdcard", "emulated", "0", "new folder", "dcim"
};

bool isJunkToken(const std::string& lower_tok) {
    return std::find(kJunkTokens.begin(), kJunkTokens.end(), lower_tok) != kJunkTokens.end();
}

std::string trimSeparators(std::string s) {
    auto is_sep = [](unsigned char c) {
        return c == ' ' || c == '-' || c == '_' || c == '.' || c == '(' || c == '[' || c == ',' || c == ':';
    };
    while (!s.empty() && is_sep(s.back())) s.pop_back();
    size_t i = 0;
    while (i < s.size() && is_sep(s[i])) ++i;
    return s.substr(i);
}

// "Friends.S03E04.720p" -> "Friends S03E04 720p"; also drops [bracketed]
// groups (release groups, tags) and collapses runs of spaces.
std::string cleanSeparators(const std::string& in) {
    std::string out;
    int bracket_depth = 0;
    for (char c : in) {
        if (c == '[') { ++bracket_depth; continue; }
        if (c == ']') { if (bracket_depth > 0) --bracket_depth; continue; }
        if (bracket_depth > 0) continue;
        out += (c == '.' || c == '_') ? ' ' : c;
    }
    std::string collapsed;
    bool last_space = false;
    for (char c : out) {
        if (c == ' ') { if (!last_space) collapsed += c; last_space = true; }
        else { collapsed += c; last_space = false; }
    }
    return trimSeparators(collapsed);
}

// Cuts the name at the first release-junk token (1080p, x265, WEB-DL...).
std::string cutAtJunk(const std::string& name) {
    std::istringstream iss(name);
    std::string tok, out;
    while (iss >> tok) {
        if (isJunkToken(toLower(tok))) break;
        if (!out.empty()) out += ' ';
        out += tok;
    }
    return out;
}

// Show-name cleanup: drop (parenthesized) bits, trailing release year,
// junk tokens and dangling separators.
std::string cleanShowName(const std::string& raw) {
    std::string s = cleanSeparators(raw);

    std::string no_paren;
    int depth = 0;
    for (char c : s) {
        if (c == '(') { ++depth; continue; }
        if (c == ')') { if (depth > 0) --depth; continue; }
        if (depth == 0) no_paren += c;
    }
    s = cutAtJunk(trimSeparators(no_paren));

    static const std::regex trailing_year(R"(\s+(19|20)\d{2}$)");
    s = std::regex_replace(s, trailing_year, "");
    return trimSeparators(s);
}

// "friends" -> "Friends", "the office" -> "The Office". Left alone if it
// already has any uppercase letters (so "iCarly" / "NCIS" survive).
std::string prettyTitle(const std::string& in) {
    bool has_upper = false;
    for (unsigned char c : in) if (std::isupper(c)) { has_upper = true; break; }
    if (has_upper) return in;

    static const std::vector<std::string> small_words = {"a", "an", "the", "of", "and", "in", "on", "at", "to", "vs"};
    std::istringstream iss(in);
    std::string tok, out;
    bool first = true;
    while (iss >> tok) {
        bool small = std::find(small_words.begin(), small_words.end(), tok) != small_words.end();
        if (first || !small) tok[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(tok[0])));
        if (!out.empty()) out += ' ';
        out += tok;
        first = false;
    }
    return out;
}

// S03E04, s3e4, S03 E04, 3x04, "Season 3 Episode 4". Returns the offset
// where the pattern starts (so everything before it is the show name).
bool matchEpisodePattern(const std::string& name, size_t& start, int& season, int& episode) {
    static const std::regex sxe(R"((^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?![0-9]))", std::regex::icase);
    static const std::regex nxn(R"((^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?![0-9a-z]))", std::regex::icase);
    static const std::regex longform(R"((^|[^a-z0-9])season[ ._-]*(\d{1,2})[ ._-]*(?:-|,)?[ ._-]*(?:e|episode)[ ._-]*(\d{1,3})(?![0-9]))", std::regex::icase);

    for (const std::regex* re : {&sxe, &nxn, &longform}) {
        std::smatch m;
        if (std::regex_search(name, m, *re)) {
            try {
                season = std::stoi(m[2].str());
                episode = std::stoi(m[3].str());
            } catch (...) { continue; }
            if (season < 1 || episode < 1) continue;
            start = static_cast<size_t>(m.position(0)) + m[1].length();
            return true;
        }
    }
    return false;
}

// Episode number alone ("E07", "Episode 7") — only trusted when the
// season comes from a "Season N" folder.
bool matchEpisodeOnly(const std::string& name, int& episode) {
    static const std::regex ep(R"((^|[^a-z0-9])(?:e|ep|episode)[ ._-]*(\d{1,3})(?![0-9]))", std::regex::icase);
    std::smatch m;
    if (!std::regex_search(name, m, ep)) return false;
    try { episode = std::stoi(m[2].str()); } catch (...) { return false; }
    return episode >= 1;
}

bool parseSeasonFolder(const std::string& folder, int& season) {
    static const std::regex long_re(R"(^(?:season|series)[ ._-]*(\d{1,2})(?![0-9]).*$)", std::regex::icase);
    static const std::regex short_re(R"(^s(\d{1,2})$)", std::regex::icase);
    std::smatch m;
    if (std::regex_match(folder, m, long_re) || std::regex_match(folder, m, short_re)) {
        try { season = std::stoi(m[1].str()); } catch (...) { return false; }
        return season >= 1;
    }
    return false;
}

bool isUsableShowFolder(const fs::path& dir, const std::vector<std::string>& roots) {
    std::string name = dir.filename().string();
    if (name.empty()) return false;
    for (const auto& r : roots) {
        if (vfs::isRemote(r)) {
            // fs::equivalent can't see network paths: compare the text instead.
            auto trim = [](std::string x) { while (!x.empty() && x.back() == '/') x.pop_back(); return x; };
            if (trim(dir.string()) == trim(r)) return false;
            continue;
        }
        std::error_code ec;
        if (fs::equivalent(dir, fs::path(r), ec) && !ec) return false;   // the source root itself
    }
    return std::find(kGenericFolders.begin(), kGenericFolders.end(), toLower(name)) == kGenericFolders.end();
}


// ---- NFO files (Kodi, Radarr, Sonarr, tinyMediaManager...): see nfo.h ----
// An NFO next to a video is the user's own word on what it is, so it wins over ffprobe tags and filename guesses.
// Looked for, in this order: "<video name>.nfo" (movie or episode), "movie.nfo" (only when the folder holds a single
// video), and "tvshow.nfo" (the show's title, in the show folder or above a "Season N" folder).
bool readNfo(const fs::path& p, nfo::Info& out) {
    std::error_code ec;
    if (!fs::is_regular_file(p, ec) || ec) return false;
    const auto size = fs::file_size(p, ec);
    if (ec || size == 0 || size > 256 * 1024) return false;       // not a real NFO: do not let a huge file slow a scan
    std::ifstream in(p, std::ios::binary);
    if (!in) return false;
    std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    out = nfo::parse(text);
    return out.ok;
}

int videosIn(const fs::path& dir) {                                // counts up to 2: enough to tell "one" from "several"
    int n = 0;
    std::error_code ec;
    fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
    if (ec) return 2;
    for (fs::directory_iterator end; it != end && n < 2; it.increment(ec)) {
        if (ec) break;
        std::error_code e2;
        if (!it->is_regular_file(e2) || e2) continue;
        const std::string ext = toLower(it->path().extension().string());
        if (std::find(kVideoExtensions.begin(), kVideoExtensions.end(), ext) != kVideoExtensions.end()) ++n;
    }
    return n;
}

// Fills kind / title / year / show / season / episode from the NFO. False = no usable NFO (nothing was changed).
bool applyNfo(MediaEntry& entry) {
    if (vfs::isRemote(entry.path)) return false;
    const fs::path video(entry.path), dir = video.parent_path();
    nfo::Info own;
    const bool haveOwn = readNfo(fs::path(video).replace_extension(".nfo"), own);

    if (haveOwn && own.root == "episodedetails" && own.episode > 0) {
        int folder_season = 0;
        fs::path show_dir = dir;
        if (parseSeasonFolder(dir.filename().string(), folder_season)) show_dir = dir.parent_path();
        std::string show = own.showtitle;
        if (show.empty()) {
            nfo::Info ts;
            if (readNfo(show_dir / "tvshow.nfo", ts) && ts.root == "tvshow") show = ts.title;
        }
        int season = own.season > 0 ? own.season : folder_season;
        if (season == 0) {
            size_t st; int se, ep;
            if (matchEpisodePattern(cleanSeparators(video.stem().string()), st, se, ep)) season = se;
        }
        if (show.empty() || season <= 0) return false;              // the old rules decide
        entry.kind = MediaKind::Episode;
        entry.show_title = sanitizeField(show);
        entry.season = season;
        entry.episode = own.episode;
        entry.title.clear(); entry.year = 0;
        entry.guessed = false;                                      // the NFO is authoritative: no TMDb name check
        return true;
    }

    nfo::Info mv;
    bool haveMovie = false;
    if (haveOwn && own.root == "movie") { mv = own; haveMovie = true; }
    else if (!haveOwn && videosIn(dir) <= 1 && readNfo(dir / "movie.nfo", mv) && mv.root == "movie") haveMovie = true;
    if (haveMovie && !mv.title.empty()) {
        entry.kind = MediaKind::Movie;
        entry.title = sanitizeField(mv.title);
        entry.year = mv.year;
        entry.show_title.clear(); entry.season = 0; entry.episode = 0;
        entry.guessed = false;
        return true;
    }
    return false;
}


// ---- Reading small files next to a video: the same code for local folders and network sources ----
// One FileIo per request: it keeps the last network connection open, so a lookup that lists a folder and then
// reads two files talks to the NAS / server once, not three times. Not thread-safe (like vfs::Share).
constexpr uint64_t kMaxArtBytes = 8ull * 1024 * 1024;

class FileIo {
public:
    // Names of the files in a folder (local path or network URL). False = it could not be listed.
    bool list(const std::string& dir, std::vector<std::string>& names) {
        names.clear();
        if (!vfs::isRemote(dir)) {
            std::error_code ec;
            fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
            if (ec) return false;
            for (fs::directory_iterator end; it != end && names.size() < 5000; it.increment(ec)) {
                if (ec) break;
                std::error_code e2;
                if (it->is_regular_file(e2) && !e2) names.push_back(it->path().filename().string());
            }
            return true;
        }
        vfs::Url u;
        vfs::Error err;
        if (!vfs::parseUrl(dir, u)) return false;
        vfs::Share* s = connect(u);
        if (!s) return false;
        std::vector<vfs::Entry> entries;
        if (!s->list(u.path, entries, err)) return false;
        for (const auto& e : entries)
            if (!e.is_dir && !e.name.empty() && names.size() < 5000) names.push_back(e.name);
        return true;
    }

    // The whole file, refused when it is bigger than maxBytes.
    bool read(const std::string& file, uint64_t maxBytes, std::string& out) {
        out.clear();
        if (!vfs::isRemote(file)) {
            std::error_code ec;
            const auto size = fs::file_size(file, ec);
            if (ec || size == 0 || size > maxBytes) return false;
            std::ifstream in(file, std::ios::binary);
            if (!in) return false;
            out.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
            return !out.empty();
        }
        vfs::Url u;
        vfs::Error err;
        if (!vfs::parseUrl(file, u)) return false;
        vfs::Share* s = connect(u);
        if (!s || !s->open(u.path, err)) return false;
        const uint64_t size = s->fileSize();
        if (size == 0 || size > maxBytes) return false;
        out.resize(static_cast<size_t>(size));
        uint64_t off = 0;
        while (off < size) {
            const int64_t n = s->read(off, &out[static_cast<size_t>(off)],
                                      static_cast<size_t>(std::min<uint64_t>(size - off, 64 * 1024)));
            if (n <= 0) break;
            off += static_cast<uint64_t>(n);
        }
        if (off != size) { out.clear(); return false; }
        return true;
    }

    static std::string parent(const std::string& p) {
        if (vfs::isRemote(p)) return vfs::parent(p);
        return fs::path(p).parent_path().string();
    }
    static std::string join(const std::string& dir, const std::string& name) {
        if (vfs::isRemote(dir)) return vfs::join(dir, name);
        return (fs::path(dir) / name).string();
    }
    // The last segment of a folder path / URL: "Season 1" (used to tell a season folder from a show folder).
    static std::string leaf(const std::string& dir) {
        std::string d = dir;
        while (d.size() > 1 && (d.back() == '/' || d.back() == '\\')) d.pop_back();
        size_t slash = d.find_last_of("/\\");
        return slash == std::string::npos ? d : d.substr(slash + 1);
    }

private:
    vfs::Share* connect(const vfs::Url& u) {
        if (vfs::hasShares(u.scheme) && u.share.empty()) return nullptr;
        const std::string key = u.scheme + "://" + u.host + "/" + u.share;
        if (conn_ && key == conn_key_) return conn_.get();
        vfs::Error err;
        conn_ = vfs::connect(u, err);
        conn_key_ = conn_ ? key : std::string();
        return conn_.get();
    }
    std::string conn_key_;
    std::unique_ptr<vfs::Share> conn_;
};

// The real file name in a listing that matches one of the wanted lowercase names (first wanted name wins), or "".
std::string pickName(const std::vector<std::string>& names, const std::vector<std::string>& wanted) {
    for (const auto& w : wanted)
        for (const auto& n : names)
            if (toLower(n) == w) return n;
    return "";
}

// "poster" -> {"poster.jpg", "poster.jpeg", "poster.png", "poster.webp"} for each base, in order.
std::vector<std::string> artNames(const std::vector<std::string>& bases) {
    static const char* kExt[] = {"jpg", "jpeg", "png", "webp"};
    std::vector<std::string> out;
    for (const auto& b : bases)
        for (const char* e : kExt) out.push_back(toLower(b) + "." + e);
    return out;
}

int videoCount(const std::vector<std::string>& names) {
    int n = 0;
    for (const auto& name : names) {
        const std::string ext = toLower(fs::path(name).extension().string());
        if (std::find(kVideoExtensions.begin(), kVideoExtensions.end(), ext) != kVideoExtensions.end()) ++n;
    }
    return n;
}

bool readNfoFrom(FileIo& io, const std::string& dir, const std::string& name, nfo::Info& out) {
    if (name.empty()) return false;
    std::string text;
    if (!io.read(FileIo::join(dir, name), 256 * 1024, text)) return false;   // not a real NFO: never slurp a huge file
    out = nfo::parse(text);
    return out.ok;
}

// What the user's files say about one video file (a movie or an episode). Same rules as applyNfo(): the NFO named like
// the video wins; "movie.nfo" and folder-level artwork only count when the movie is alone in its folder.
MediaScanner::Local resolveVideo(FileIo& io, const MediaEntry& e) {
    MediaScanner::Local out;
    const std::string dir = FileIo::parent(e.path);
    std::vector<std::string> names;
    if (dir.empty() || !io.list(dir, names)) return out;
    const bool episode = e.kind == MediaKind::Episode;
    const std::string stem = toLower(fs::path(e.filename).stem().string());
    const bool alone = videoCount(names) <= 1;

    nfo::Info info;
    const std::string own = pickName(names, {stem + ".nfo"});
    bool have = readNfoFrom(io, dir, own, info);
    if (have && info.root != (episode ? "episodedetails" : "movie")) have = false;
    if (!have && own.empty() && !episode && alone)
        have = readNfoFrom(io, dir, pickName(names, {"movie.nfo"}), info) && info.root == "movie";
    if (have) { out.title = info.title; out.plot = info.plot; }

    std::vector<std::string> bases = episode ? std::vector<std::string>{stem + "-thumb", stem}
                                             : std::vector<std::string>{stem + "-poster", stem};
    if (!episode && alone) { bases.push_back("poster"); bases.push_back("folder"); bases.push_back("cover"); }
    const std::string art = pickName(names, artNames(bases));
    if (!art.empty()) out.art = FileIo::join(dir, art);
    return out;
}

// The folder that holds tvshow.nfo and the show's poster: the show folder, one above a "Season N" folder.
std::string showDirOfEpisode(const MediaEntry& e) {
    const std::string dir = FileIo::parent(e.path);
    int season = 0;
    return parseSeasonFolder(FileIo::leaf(dir), season) ? FileIo::parent(dir) : dir;
}


// ---- helpers for the library database (library.db) ----
std::string jsonEsc(const std::string& in) {
    std::string o;
    o.reserve(in.size() + 2);
    for (unsigned char c : in) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += static_cast<char>(c);
        }
    }
    return o;
}

// The modification times of the NFO files that describe a title (local files only): changes when one is edited, so the
// database re-reads it. Network sources are only re-read when the video itself changed (a stat per NFO over a network
// share, for thousands of titles at every scan, is not worth it).
std::string nfoStampLocal(const std::vector<fs::path>& paths) {
    std::string out;
    for (const auto& p : paths) {
        std::error_code ec;
        if (!fs::is_regular_file(p, ec) || ec) continue;
        const auto t = fs::last_write_time(p, ec);
        if (ec) continue;
        out += std::to_string(static_cast<long long>(t.time_since_epoch().count())) + ",";
    }
    return out;
}

// The NFO of one movie: "<video>.nfo", else "movie.nfo" when the movie is alone in its folder (same rules as resolveVideo).
bool readMovieNfo(FileIo& io, const MediaEntry& e, nfo::Info& out) {
    const std::string dir = FileIo::parent(e.path);
    std::vector<std::string> names;
    if (dir.empty() || !io.list(dir, names)) return false;
    const std::string stem = toLower(fs::path(e.filename).stem().string());
    const std::string own = pickName(names, {stem + ".nfo"});
    nfo::Info info;
    bool have = readNfoFrom(io, dir, own, info) && info.root == "movie";
    if (!have && own.empty() && videoCount(names) <= 1)
        have = readNfoFrom(io, dir, pickName(names, {"movie.nfo"}), info) && info.root == "movie";
    if (have) out = info;
    return have;
}

// The show's tvshow.nfo, found from one of its episodes.
bool readShowNfo(FileIo& io, const MediaEntry& episode, nfo::Info& out) {
    const std::string dir = showDirOfEpisode(episode);
    std::vector<std::string> names;
    if (dir.empty() || !io.list(dir, names)) return false;
    nfo::Info info;
    if (readNfoFrom(io, dir, pickName(names, {"tvshow.nfo"}), info) && info.root == "tvshow") { out = info; return true; }
    return false;
}

const int kDbVersion = 1;

// Tables:
//   media        every video file found (what media_cache.tsv held) plus a folded title for searching
//   title_meta   one row per movie ('m:<media id>') and per show ('s:<folded show title>') whose NFO was looked at;
//                `stamp` says what it was read from, so only new or edited NFOs are read again
//   title_genre / title_person   genres, and actors (kind 0) / directors (kind 1) of those titles
const char* const kSchema = R"SQL(
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY, path TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  kind INTEGER NOT NULL, title TEXT NOT NULL, year INTEGER NOT NULL, show_title TEXT NOT NULL,
  season INTEGER NOT NULL, episode INTEGER NOT NULL, norm TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS media_kind ON media(kind, year);
CREATE INDEX IF NOT EXISTS media_norm ON media(norm);
CREATE TABLE IF NOT EXISTS title_meta(
  key TEXT PRIMARY KEY, stamp TEXT NOT NULL, name TEXT NOT NULL, year INTEGER NOT NULL, rating REAL NOT NULL,
  runtime INTEGER NOT NULL, mpaa TEXT NOT NULL, studio TEXT NOT NULL, studio_norm TEXT NOT NULL,
  collection TEXT NOT NULL, collection_norm TEXT NOT NULL, has_nfo INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS title_genre(
  key TEXT NOT NULL, genre TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(key, genre)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS genre_idx ON title_genre(genre);
CREATE TABLE IF NOT EXISTS title_person(
  key TEXT NOT NULL, kind INTEGER NOT NULL, norm TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, ord INTEGER NOT NULL,
  PRIMARY KEY(key, kind, norm)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS person_idx ON title_person(kind, norm);
)SQL";

std::string normOf(const MediaEntry& e) {
    if (e.kind == MediaKind::Movie) return pekdb::fold(e.title);
    if (e.kind == MediaKind::Episode) return pekdb::fold(e.show_title);
    return pekdb::fold(fs::path(e.filename).stem().string());
}

// Writes the whole entry list: new and changed rows are saved, rows for files that are gone are removed. One
// transaction, so an interruption leaves the previous state.
bool writeEntries(pekdb::Db& db, const std::vector<MediaEntry>& all) {
    pekdb::Tx tx(db);
    if (!tx.ok()) return false;
    {
        pekdb::Stmt up(db,
            "INSERT INTO media(id,path,filename,size,mtime,kind,title,year,show_title,season,episode,norm) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET path=excluded.path,filename=excluded.filename,size=excluded.size,mtime=excluded.mtime,"
            "kind=excluded.kind,title=excluded.title,year=excluded.year,show_title=excluded.show_title,season=excluded.season,"
            "episode=excluded.episode,norm=excluded.norm");
        if (!up.ok()) return false;
        for (const auto& e : all) {
            up.text(1, e.id).text(2, e.path).text(3, e.filename).i64(4, static_cast<long long>(e.size_bytes)).i64(5, e.mtime)
              .i64(6, static_cast<int>(e.kind)).text(7, e.title).i64(8, e.year).text(9, e.show_title).i64(10, e.season)
              .i64(11, e.episode).text(12, normOf(e));
            if (!up.run()) return false;
            up.reset();
        }
    }
    std::vector<std::string> gone;
    {
        std::unordered_set<std::string> keep;
        keep.reserve(all.size() * 2);
        for (const auto& e : all) keep.insert(e.id);
        pekdb::Stmt sel(db, "SELECT id FROM media");
        while (sel.step()) { std::string id = sel.str(0); if (!keep.count(id)) gone.push_back(std::move(id)); }
    }
    if (!gone.empty()) {
        pekdb::Stmt del(db, "DELETE FROM media WHERE id=?");
        for (const auto& id : gone) { del.text(1, id); del.run(); del.reset(); }
    }
    return tx.commit();
}

// The old tab-separated cache (media_cache.tsv): read once, to carry its classifications into the database.
std::vector<MediaEntry> readLegacyCache(const std::string& path) {
    std::vector<MediaEntry> loaded;
    std::ifstream in(path);
    if (!in.is_open()) return loaded;
    std::string line;
    if (!std::getline(in, line) || line != kCacheHeader) return loaded;      // an older layout: a fresh scan is better
    while (std::getline(in, line)) {
        std::istringstream iss(line);
        MediaEntry e;
        std::string size_str, mtime_str, kind_str, year_str, season_str, episode_str;
        if (std::getline(iss, e.id, '\t') && std::getline(iss, e.path, '\t') && std::getline(iss, e.filename, '\t') &&
            std::getline(iss, size_str, '\t') && std::getline(iss, mtime_str, '\t') && std::getline(iss, kind_str, '\t') &&
            std::getline(iss, e.title, '\t') && std::getline(iss, year_str, '\t') && std::getline(iss, e.show_title, '\t') &&
            std::getline(iss, season_str, '\t') && std::getline(iss, episode_str)) {
            try {
                e.size_bytes = std::stoull(size_str);
                e.mtime = std::stoll(mtime_str);
                const int k = std::stoi(kind_str);
                e.kind = (k == 0) ? MediaKind::Movie : (k == 1) ? MediaKind::Episode : MediaKind::Unclassified;
                e.year = std::stoi(year_str);
                e.season = std::stoi(season_str);
                e.episode = std::stoi(episode_str);
            } catch (...) { continue; }
            loaded.push_back(std::move(e));
        }
    }
    return loaded;
}

} // namespace

MediaScanner::MediaScanner(std::string sources_file_path, std::string cache_file_path)
    : sources_file_path_(std::move(sources_file_path)), cache_file_path_(std::move(cache_file_path)) {}

bool MediaScanner::listSubdirectories(const std::string& dir_path, std::vector<std::string>& out) {
    std::error_code ec;
    if (!fs::exists(dir_path, ec) || !fs::is_directory(dir_path, ec)) return false;

    out.clear();
    for (const auto& entry : fs::directory_iterator(dir_path, ec)) {
        if (ec) break;
        std::error_code entry_ec;
        if (!entry.is_directory(entry_ec) || entry_ec) continue;

        std::string name = entry.path().filename().string();
        if (name.empty() || name[0] == '.') continue; // hidden folders stay out of the picker

        out.push_back(entry.path().string());
    }
    std::sort(out.begin(), out.end());
    return true;
}

bool MediaScanner::addMediaDir(const std::string& path) {
    if (vfs::isRemote(path)) {
        // Reachability is checked by the API route before this; here the URL
        // only has to be well formed and name a share (smb://host/share[/folder]).
        vfs::Url u;
        if (!vfs::parseUrl(path, u)) return false;
        if (vfs::hasShares(u.scheme) && u.share.empty()) return false;
    } else {
        std::error_code ec;
        if (!fs::exists(path, ec) || !fs::is_directory(path, ec)) return false;
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (std::find(media_dirs_.begin(), media_dirs_.end(), path) == media_dirs_.end()) {
        media_dirs_.push_back(path);
        persistSourcesToDisk();
    }
    return true;
}

bool MediaScanner::removeMediaDir(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto before = media_dirs_.size();
    media_dirs_.erase(std::remove(media_dirs_.begin(), media_dirs_.end(), path), media_dirs_.end());
    bool removed = media_dirs_.size() != before;
    if (removed) persistSourcesToDisk();
    return removed;
}

std::vector<std::string> MediaScanner::getMediaDirs() {
    std::lock_guard<std::mutex> lock(mutex_);
    return media_dirs_;
}

bool MediaScanner::isVideoFile(const std::string& extension) {
    std::string ext = toLower(extension);
    return std::find(kVideoExtensions.begin(), kVideoExtensions.end(), ext) != kVideoExtensions.end();
}

bool MediaScanner::dirHasNomedia(const std::string& dir_path) {
    std::error_code ec;   // non-throwing: unreadable folders must not abort the scan
    return fs::exists(fs::path(dir_path) / ".nomedia", ec);
}

std::string MediaScanner::makeId(const std::string& path) {
    size_t h = std::hash<std::string>{}(path);
    std::ostringstream oss;
    oss << std::hex << h;
    return oss.str();
}

void MediaScanner::probeAndClassify(MediaEntry& entry) {
    if (vfs::isRemote(entry.path)) {      // ffprobe can't open smb:// - the filename fallback takes over
        entry.kind = MediaKind::Unclassified;
        return;
    }
    std::string cmd = kFfprobeBinary + " -v quiet -print_format json -show_format " +
                       shellEscape(entry.path) + " 2>/dev/null";
    std::string json = runCommand(cmd);

    if (json.empty()) {
        std::cout << "[MediaScanner] ffprobe produced no output for " << entry.filename
                   << " (is ffprobe installed/on PATH?)" << std::endl;
        entry.kind = MediaKind::Unclassified;
        return;
    }

    std::string show = extractTag(json, "show");
    int season = extractTagInt(json, "season_number");
    int episode = extractTagInt(json, "episode_sort");
    if (episode == 0) episode = extractTagInt(json, "episode_id"); // some taggers use this key instead

    std::string title = extractTag(json, "title");
    std::string date = extractTag(json, "date");

    if (!show.empty() && season > 0 && episode > 0) {
        entry.kind = MediaKind::Episode;
        entry.show_title = show;
        entry.season = season;
        entry.episode = episode;
    } else if (!title.empty()) {
        entry.kind = MediaKind::Movie;
        entry.title = title;
        if (date.size() >= 4) {
            try { entry.year = std::stoi(date.substr(0, 4)); } catch (...) {}
        }
    } else {
        entry.kind = MediaKind::Unclassified;
    }
}

void MediaScanner::classifyFromFilename(MediaEntry& entry, const std::vector<std::string>& media_roots) {
    fs::path p(entry.path);
    std::string name = cleanSeparators(p.stem().string());
    fs::path dir = p.parent_path();

    // Folder context: "Show/Season 3/file" or "Show/file".
    int folder_season = 0;
    std::string folder_show;
    if (parseSeasonFolder(dir.filename().string(), folder_season)) {
        fs::path show_dir = dir.parent_path();
        if (isUsableShowFolder(show_dir, media_roots)) folder_show = cleanShowName(show_dir.filename().string());
    } else if (isUsableShowFolder(dir, media_roots)) {
        folder_show = cleanShowName(dir.filename().string());
    }

    // 1) Episode: SxxEyy / NxNN / "Season N Episode N" in the filename.
    size_t start = 0;
    int season = 0, episode = 0;
    if (matchEpisodePattern(name, start, season, episode)) {
        std::string show = cleanShowName(name.substr(0, start));
        if (show.empty()) show = folder_show;
        if (!show.empty()) {
            entry.kind = MediaKind::Episode;
            entry.show_title = prettyTitle(show);
            entry.season = season;
            entry.episode = episode;
            entry.guessed = true;
            return;
        }
    }

    // 2) Episode number only, season from a "Season N" folder.
    if (folder_season > 0 && !folder_show.empty() && matchEpisodeOnly(name, episode)) {
        entry.kind = MediaKind::Episode;
        entry.show_title = prettyTitle(folder_show);
        entry.season = folder_season;
        entry.episode = episode;
        entry.guessed = true;
        return;
    }

    // 3) Movie: only when the name carries a release year, which is a
    //    strong signal ("The.Matrix.1999.1080p.mkv", "Heat (1995).mp4").
    //    Anything vaguer stays Unknown rather than being guessed.
    static const std::regex year_re(R"((^|[^0-9])((?:19|20)\d{2})(?![0-9]|x\d))");
    for (auto it = std::sregex_iterator(name.begin(), name.end(), year_re); it != std::sregex_iterator(); ++it) {
        size_t year_pos = static_cast<size_t>(it->position(2));
        std::string title = cleanShowName(name.substr(0, year_pos));
        if (title.empty()) continue;   // year is the first thing in the name — probably part of the title ("2012")
        try {
            entry.year = std::stoi((*it)[2].str());
        } catch (...) { continue; }
        entry.kind = MediaKind::Movie;
        entry.title = prettyTitle(title);
        entry.guessed = true;
        return;
    }

    entry.kind = MediaKind::Unclassified;
}

void MediaScanner::setShowResolver(ShowResolver resolver) {
    std::lock_guard<std::mutex> lock(scan_mutex_);
    show_resolver_ = std::move(resolver);
}

void MediaScanner::scanDirectory(const std::string& dir_path, std::vector<MediaEntry>& found) {
    std::error_code ec;
    if (!fs::is_directory(dir_path, ec) || ec) return;
    if (dirHasNomedia(dir_path)) {
        std::cout << "[MediaScanner] Skipping (.nomedia): " << dir_path << std::endl;
        return;
    }

    // Every filesystem call below uses an error_code: this runs on a
    // detached thread, so an uncaught filesystem_error (e.g. a
    // permission-denied folder under /storage/emulated/0) would
    // std::terminate the entire server.
    fs::directory_iterator it(dir_path, fs::directory_options::skip_permission_denied, ec);
    if (ec) {
        std::cout << "[MediaScanner] Cannot read " << dir_path << ": " << ec.message() << std::endl;
        return;
    }

    for (fs::directory_iterator end; it != end; it.increment(ec)) {
        if (ec) break;
        const auto& e = *it;
        std::error_code entry_ec;

        bool is_dir = e.is_directory(entry_ec);
        if (entry_ec) continue;
        if (is_dir) {
            if (e.is_symlink(entry_ec)) continue;   // avoid symlink loops
            std::string name = e.path().filename().string();
            if (!name.empty() && name[0] == '.') continue;
            scanDirectory(e.path().string(), found);
            continue;
        }

        if (!isVideoFile(e.path().extension().string())) continue;

        MediaEntry entry;
        entry.path = e.path().string();
        entry.filename = e.path().filename().string();
        entry.id = makeId(entry.path);
        entry.size_bytes = fs::file_size(e.path(), entry_ec);
        if (entry_ec) continue;
        auto ftime = fs::last_write_time(e.path(), entry_ec);
        entry.mtime = entry_ec ? 0 : std::chrono::duration_cast<std::chrono::seconds>(
                                         ftime.time_since_epoch()).count();

        found.push_back(std::move(entry));
    }
}

bool MediaScanner::scanRemote(const std::string& root_url, std::vector<MediaEntry>& found) {
    vfs::Url u;
    if (!vfs::parseUrl(root_url, u)) return false;
    if (vfs::hasShares(u.scheme) && u.share.empty()) return false;
    vfs::Error err;
    auto share = vfs::connect(u, err);
    if (!share) {
        std::cout << "[MediaScanner] Cannot reach " << root_url << ": " << err.msg << std::endl;
        return false;
    }
    return scanRemoteDir(*share, u, u.path, found, 0);
}

bool MediaScanner::scanRemoteDir(vfs::Share& share, const vfs::Url& base, const std::string& rel,
                                 std::vector<MediaEntry>& found, int depth) {
    if (depth > 16) return true;
    std::vector<vfs::Entry> list;
    vfs::Error err;
    if (!share.list(rel, list, err)) {
        std::cout << "[MediaScanner] Cannot read " << vfs::buildUrl({base.scheme, base.host, base.share, rel})
                  << ": " << err.msg << std::endl;
        return depth > 0;     // only a failing top folder means "unreachable"
    }
    for (const auto& e : list) {
        if (e.name == ".nomedia") {
            std::cout << "[MediaScanner] Skipping (.nomedia): " << vfs::buildUrl({base.scheme, base.host, base.share, rel}) << std::endl;
            return true;
        }
    }
    std::sort(list.begin(), list.end(), [](const vfs::Entry& a, const vfs::Entry& b) { return a.name < b.name; });
    for (const auto& e : list) {
        if (e.name.empty() || e.name[0] == '.') continue;
        std::string child = rel.empty() ? e.name : rel + "/" + e.name;
        if (e.is_dir) {
            scanRemoteDir(share, base, child, found, depth + 1);
            continue;
        }
        if (!isVideoFile(fs::path(e.name).extension().string())) continue;
        MediaEntry entry;
        entry.path = vfs::buildUrl({base.scheme, base.host, base.share, child});
        entry.filename = e.name;
        entry.id = makeId(entry.path);
        entry.size_bytes = e.size;
        entry.mtime = e.mtime;
        found.push_back(std::move(entry));
    }
    return true;
}

void MediaScanner::scan(bool onlyNewSources) {
    struct ActiveGuard { std::atomic<int>& n; explicit ActiveGuard(std::atomic<int>& a) : n(a) { ++n; } ~ActiveGuard() { --n; } } activeGuard(active_scans_);
    std::lock_guard<std::mutex> scan_lock(scan_mutex_);
    {
        std::lock_guard<std::mutex> lock(local_mutex_);
        local_cache_.clear();       // files may have changed: look at the NFOs and artwork again
    }
    std::vector<std::string> dirs_snapshot;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        dirs_snapshot = media_dirs_;
    }

    std::unordered_map<std::string, MediaEntry> previous;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& e : entries_) previous[e.path] = e;
    }

    std::vector<MediaEntry> fresh;
    for (const auto& dir : dirs_snapshot) {
        bool known = false;
        if (onlyNewSources) {            // light scan: a folder that already has files in the library is left alone
            std::string pre = dir;
            while (!pre.empty() && pre.back() == '/') pre.pop_back();
            pre += "/";
            for (const auto& kv : previous) if (kv.first.compare(0, pre.size(), pre) == 0) { known = true; break; }
        }
        if (known) {
            std::string pre = dir;
            while (!pre.empty() && pre.back() == '/') pre.pop_back();
            pre += "/";
            for (const auto& kv : previous) if (kv.first.compare(0, pre.size(), pre) == 0) fresh.push_back(kv.second);
            continue;
        }
        if (!vfs::isRemote(dir)) { scanDirectory(dir, fresh); continue; }
        if (scanRemote(dir, fresh)) continue;
        // The network source is unreachable (NAS off, Wi-Fi down...). Keep what we
        // already knew about it instead of emptying the library.
        std::string prefix = dir;
        while (!prefix.empty() && prefix.back() == '/') prefix.pop_back();
        prefix += "/";
        size_t kept = 0;
        for (const auto& kv : previous) {
            if (kv.first.compare(0, prefix.size(), prefix) == 0) { fresh.push_back(kv.second); ++kept; }
        }
        std::cout << "[MediaScanner] Keeping " << kept << " earlier file(s) from unreachable " << dir << std::endl;
    }

    for (auto& entry : fresh) {
        auto it = previous.find(entry.path);
        if (it != previous.end() &&
            it->second.size_bytes == entry.size_bytes &&
            it->second.mtime == entry.mtime) {
            // Unchanged on disk — reuse the prior classification
            // rather than re-invoking ffprobe (the expensive step).
            entry.kind = it->second.kind;
            entry.title = it->second.title;
            entry.year = it->second.year;
            entry.show_title = it->second.show_title;
            entry.season = it->second.season;
            entry.episode = it->second.episode;
            applyNfo(entry);          // cheap (a few small files), so an edited NFO is picked up on the next scan
        } else {
            if (applyNfo(entry)) {    // described by an NFO: no ffprobe, no filename guessing
                std::cout << "[MediaScanner] From NFO: " << entry.filename << std::endl;
                continue;
            }
            std::cout << "[MediaScanner] Probing: " << entry.filename << std::endl;
            probeAndClassify(entry);

            // A file with only a bare title tag but an unmistakable
            // SxxEyy name is an episode, not a movie.
            bool tag_movie_named_like_episode = false;
            if (entry.kind == MediaKind::Movie) {
                size_t st; int se, ep;
                tag_movie_named_like_episode =
                    matchEpisodePattern(cleanSeparators(fs::path(entry.path).stem().string()), st, se, ep);
            }

            if (entry.kind == MediaKind::Unclassified || tag_movie_named_like_episode) {
                MediaEntry guess = entry;
                classifyFromFilename(guess, dirs_snapshot);
                if (guess.kind == MediaKind::Episode ||
                    (guess.kind == MediaKind::Movie && entry.kind == MediaKind::Unclassified)) {
                    entry = std::move(guess);
                }
            }

            // Confirm guessed show names (once per distinct name) so
            // "friends" becomes TMDb's "Friends". Tag-derived names and
            // the no-key / offline case are left exactly as parsed.
            if (entry.guessed && entry.kind == MediaKind::Episode && show_resolver_) {
                std::string key = toLower(entry.show_title);
                auto cached = resolved_names_.find(key);
                if (cached == resolved_names_.end()) {
                    std::string official;
                    try { official = show_resolver_(entry.show_title); } catch (...) {}
                    cached = resolved_names_.emplace(key, sanitizeField(official)).first;
                }
                if (!cached->second.empty()) entry.show_title = cached->second;
            }

            if (entry.kind != MediaKind::Unclassified && entry.guessed) {
                std::cout << "[MediaScanner]   -> guessed from filename: "
                          << (entry.kind == MediaKind::Episode
                                  ? entry.show_title + " S" + std::to_string(entry.season) + "E" + std::to_string(entry.episode)
                                  : entry.title + " (" + std::to_string(entry.year) + ")")
                          << std::endl;
            }
        }
    }

    size_t indexed = fresh.size();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        entries_ = std::move(fresh);
    }

    std::cout << "[MediaScanner] Scan complete. " << indexed << " file(s) indexed." << std::endl;
    persistToDb();

    std::function<void()> after;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        after = after_scan_;
    }
    if (after) { try { after(); } catch (...) {} }
    try { indexMetadata(); } catch (const std::exception& ex) { std::cout << "[MediaScanner] Reading details failed: " << ex.what() << std::endl; }
}

void MediaScanner::setAfterScan(std::function<void()> callback) {
    std::lock_guard<std::mutex> lock(mutex_);
    after_scan_ = std::move(callback);
}

std::vector<MediaEntry> MediaScanner::getMovies() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<MediaEntry> out;
    for (const auto& e : entries_) if (e.kind == MediaKind::Movie) out.push_back(e);
    return out;
}

std::vector<MediaEntry> MediaScanner::getEpisodes() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<MediaEntry> out;
    for (const auto& e : entries_) if (e.kind == MediaKind::Episode) out.push_back(e);
    return out;
}

std::vector<MediaEntry> MediaScanner::getUnclassified() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<MediaEntry> out;
    for (const auto& e : entries_) if (e.kind == MediaKind::Unclassified) out.push_back(e);
    return out;
}

bool MediaScanner::findById(const std::string& id, MediaEntry& out) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& e : entries_) {
        if (e.id == id) { out = e; return true; }
    }
    return false;
}

// ---- the user's own plots and artwork (see media_scanner.h) ----
MediaScanner::Local MediaScanner::cachedLocal(const std::string& key, const std::function<Local()>& make) {
    const auto now = std::chrono::steady_clock::now();
    {
        std::lock_guard<std::mutex> lock(local_mutex_);
        auto it = local_cache_.find(key);
        if (it != local_cache_.end() && now - it->second.first < std::chrono::minutes(2)) return it->second.second;
    }
    Local value = make();                       // slow (network): never hold the lock while it runs
    std::lock_guard<std::mutex> lock(local_mutex_);
    if (local_cache_.size() > 4000) local_cache_.clear();
    local_cache_[key] = {now, value};
    return value;
}

MediaScanner::Local MediaScanner::localMovie(const MediaEntry& entry) {
    if (entry.kind != MediaKind::Movie) return Local();
    return cachedLocal("m:" + entry.id, [&]() { FileIo io; return resolveVideo(io, entry); });
}

MediaScanner::Local MediaScanner::localEpisode(const std::string& show, int season, int episode) {
    const std::string key = toLower(show);
    return cachedLocal("e:" + key + "|" + std::to_string(season) + "|" + std::to_string(episode), [&]() {
        FileIo io;
        for (const auto& e : getEpisodes()) {
            if (e.season != season || e.episode != episode || toLower(e.show_title) != key) continue;
            Local l = resolveVideo(io, e);
            if (!l.plot.empty() || !l.art.empty()) return l;     // the same episode in another folder may still have one
        }
        return Local();
    });
}

MediaScanner::Local MediaScanner::localShow(const std::string& show) {
    const std::string key = toLower(show);
    return cachedLocal("s:" + key, [&]() {
        FileIo io;
        Local out;
        std::set<std::string> tried;                // one look per show folder, not one per episode
        for (const auto& e : getEpisodes()) {
            if (toLower(e.show_title) != key) continue;
            const std::string dir = showDirOfEpisode(e);
            if (dir.empty() || !tried.insert(dir).second) continue;
            std::vector<std::string> names;
            if (!io.list(dir, names)) continue;
            nfo::Info ts;
            if (out.plot.empty() && readNfoFrom(io, dir, pickName(names, {"tvshow.nfo"}), ts) && ts.root == "tvshow") {
                out.title = ts.title;
                out.plot = ts.plot;
            }
            if (out.art.empty()) {
                const std::string art = pickName(names, artNames({"poster", "folder", "cover", "show"}));
                if (!art.empty()) out.art = FileIo::join(dir, art);
            }
            if (!out.plot.empty() && !out.art.empty()) break;
            if (tried.size() >= 8) break;           // a show spread over many folders: stop looking
        }
        return out;
    });
}

bool MediaScanner::readArtwork(const std::string& art, std::string& bytes, std::string& mime) {
    if (art.empty()) return false;
    const std::string ext = toLower(fs::path(art).extension().string());
    if (ext == ".jpg" || ext == ".jpeg") mime = "image/jpeg";
    else if (ext == ".png") mime = "image/png";
    else if (ext == ".webp") mime = "image/webp";
    else return false;
    FileIo io;
    return io.read(art, kMaxArtBytes, bytes);
}

// ================================================================ the library database
MediaScanner::~MediaScanner() = default;

void MediaScanner::openDb() {
    db_path_ = (fs::path(cache_file_path_).parent_path() / "library.db").string();
    auto db = std::make_unique<pekdb::Db>();
    if (!db->open(db_path_) || !db->exec(kSchema)) {
        std::cout << "[MediaScanner] The library database is unavailable (" << db_path_ << "): files will be re-scanned at every start." << std::endl;
        return;
    }
    // Future schema changes: add `if (v < 2) { ALTER ...; }` steps here, then raise kDbVersion.
    if (db->userVersion() < kDbVersion) db->setUserVersion(kDbVersion);
    db_ = std::move(db);
}

void MediaScanner::persistToDb() {
    if (!db_) return;
    std::vector<MediaEntry> snapshot;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        snapshot = entries_;
    }
    if (!writeEntries(*db_, snapshot)) std::cout << "[MediaScanner] Could not save the library: " << db_->lastError() << std::endl;
}

void MediaScanner::indexMetadata() {
    if (!db_) return;
    std::vector<MediaEntry> all;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        all = entries_;
    }
    std::unordered_map<std::string, std::string> have;                    // key -> stamp already stored
    {
        pekdb::Stmt st(*db_, "SELECT key, stamp FROM title_meta");
        while (st.step()) have[st.str(0)] = st.str(1);
    }

    struct Job {
        std::string key, stamp, name;
        bool show = false;
        MediaEntry first;
        std::vector<MediaEntry> more;          // other folders of the same show
    };
    std::vector<Job> jobs;
    std::set<std::string> valid;
    std::map<std::string, Job> shows;          // folded show title -> job
    for (const auto& e : all) {
        if (e.kind == MediaKind::Movie) {
            Job j;
            j.key = "m:" + e.id; j.name = e.title; j.first = e;
            j.stamp = std::to_string(e.size_bytes) + ":" + std::to_string(e.mtime);
            if (!vfs::isRemote(e.path)) {
                const fs::path v(e.path);
                j.stamp += "|" + nfoStampLocal({fs::path(v).replace_extension(".nfo"), v.parent_path() / "movie.nfo"});
            }
            valid.insert(j.key);
            const auto it = have.find(j.key);
            if (it == have.end() || it->second != j.stamp) jobs.push_back(std::move(j));
        } else if (e.kind == MediaKind::Episode) {
            const std::string norm = pekdb::fold(e.show_title);
            if (norm.empty()) continue;
            Job& j = shows[norm];
            if (j.key.empty()) { j.key = "s:" + norm; j.show = true; j.name = e.show_title; j.first = e; continue; }
            const std::string dir = showDirOfEpisode(e);
            if (j.more.size() >= 2 || dir == showDirOfEpisode(j.first)) continue;
            bool seen = false;
            for (const auto& m : j.more) if (showDirOfEpisode(m) == dir) seen = true;
            if (!seen) j.more.push_back(e);
        }
    }
    for (auto& kv : shows) {
        Job& j = kv.second;
        j.stamp = "r";
        if (!vfs::isRemote(j.first.path)) {
            std::vector<fs::path> nf{fs::path(showDirOfEpisode(j.first)) / "tvshow.nfo"};
            for (const auto& m : j.more) nf.push_back(fs::path(showDirOfEpisode(m)) / "tvshow.nfo");
            j.stamp = "l|" + nfoStampLocal(nf);
        }
        valid.insert(j.key);
        const auto it = have.find(j.key);
        if (it == have.end() || it->second != j.stamp) jobs.push_back(j);
    }

    // Titles that left the library take their rows with them.
    std::vector<std::string> stale;
    for (const auto& kv : have) if (!valid.count(kv.first)) stale.push_back(kv.first);
    if (!stale.empty()) {
        pekdb::Tx tx(*db_);
        if (tx.ok()) {
            {
                pekdb::Stmt a(*db_, "DELETE FROM title_meta WHERE key=?"), g(*db_, "DELETE FROM title_genre WHERE key=?"),
                            p(*db_, "DELETE FROM title_person WHERE key=?");
                for (const auto& k : stale) { a.text(1, k).run(); a.reset(); g.text(1, k).run(); g.reset(); p.text(1, k).run(); p.reset(); }
            }
            tx.commit();
        }
    }

    index_total_ = static_cast<int>(jobs.size());
    index_done_ = 0;
    if (jobs.empty()) return;
    std::cout << "[MediaScanner] Reading details for " << jobs.size() << " title(s)..." << std::endl;

    FileIo io;
    const size_t kBatch = 100;       // titles per transaction (each commit is synced to disk)
    for (size_t b = 0; b < jobs.size(); b += kBatch) {
        const size_t end = std::min(jobs.size(), b + kBatch);
        std::vector<std::pair<bool, nfo::Info>> read;          // slow part (files, maybe over the network) outside the transaction
        for (size_t i = b; i < end; ++i) {
            const Job& j = jobs[i];
            nfo::Info info;
            bool has = false;
            try {
                if (!j.show) has = readMovieNfo(io, j.first, info);
                else {
                    has = readShowNfo(io, j.first, info);
                    for (size_t m = 0; !has && m < j.more.size(); ++m) has = readShowNfo(io, j.more[m], info);
                }
            } catch (...) { has = false; }
            read.emplace_back(has, std::move(info));
        }
        pekdb::Tx tx(*db_);
        if (!tx.ok()) continue;
        {
            pekdb::Stmt meta(*db_, "INSERT OR REPLACE INTO title_meta(key,stamp,name,year,rating,runtime,mpaa,studio,studio_norm,collection,collection_norm,has_nfo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
            pekdb::Stmt delG(*db_, "DELETE FROM title_genre WHERE key=?"), delP(*db_, "DELETE FROM title_person WHERE key=?");
            pekdb::Stmt insG(*db_, "INSERT OR IGNORE INTO title_genre(key,genre) VALUES(?,?)");
            pekdb::Stmt insP(*db_, "INSERT OR IGNORE INTO title_person(key,kind,norm,name,role,ord) VALUES(?,?,?,?,?,?)");
            for (size_t i = b; i < end; ++i) {
                const Job& j = jobs[i];
                const bool has = read[i - b].first;
                const nfo::Info& n = read[i - b].second;
                const std::string studio = n.studios.empty() ? std::string() : n.studios[0];
                meta.text(1, j.key).text(2, j.stamp).text(3, has && !n.title.empty() ? n.title : j.name).i64(4, n.year)
                    .real(5, n.rating).i64(6, n.runtime).text(7, n.mpaa).text(8, studio).text(9, pekdb::fold(studio))
                    .text(10, n.collection).text(11, pekdb::fold(n.collection)).i64(12, has ? 1 : 0);
                meta.run(); meta.reset();
                delG.text(1, j.key).run(); delG.reset();
                delP.text(1, j.key).run(); delP.reset();
                for (const auto& g : n.genres) { insG.text(1, j.key).text(2, g).run(); insG.reset(); }
                int ord = 0;
                for (const auto& a : n.actors) {
                    const std::string norm = pekdb::fold(a.name);
                    if (norm.empty()) continue;
                    insP.text(1, j.key).i64(2, 0).text(3, norm).text(4, a.name).text(5, a.role).i64(6, ord++).run(); insP.reset();
                }
                ord = 0;
                for (const auto& d : n.directors) {
                    const std::string norm = pekdb::fold(d);
                    if (norm.empty()) continue;
                    insP.text(1, j.key).i64(2, 1).text(3, norm).text(4, d).text(5, "").i64(6, ord++).run(); insP.reset();
                }
            }
        }
        tx.commit();
        index_done_ = static_cast<int>(end);
    }
    std::cout << "[MediaScanner] Details read." << std::endl;
}

std::string MediaScanner::searchJson(const SearchQuery& sq) {
    const bool shows = sq.type == "shows";
    const std::string field = shows ? "shows" : "movies";
    if (!db_) return "{\"total\":0,\"" + field + "\":[]}";

    const std::string from = shows
        ? " FROM (SELECT norm, MIN(show_title) AS name, MAX(mtime) AS added FROM media WHERE kind=1 GROUP BY norm) m"
          " LEFT JOIN title_meta t ON t.key = 's:' || m.norm WHERE 1=1"
        : " FROM media m LEFT JOIN title_meta t ON t.key = 'm:' || m.id WHERE m.kind=0";
    const std::string key = shows ? "('s:' || m.norm)" : "('m:' || m.id)";
    const std::string year = shows ? "COALESCE(t.year,0)" : "m.year";
    const std::string added = shows ? "m.added" : "m.mtime";

    std::string where;
    std::vector<std::string> binds;
    auto like = [](const std::string& w) { return "%" + pekdb::likeEscape(w) + "%"; };
    for (const auto& w : pekdb::words(pekdb::fold(sq.q))) {
        where += " AND (m.norm LIKE ? ESCAPE '\\' OR CAST(" + year + " AS TEXT) = ?"
                 " OR EXISTS (SELECT 1 FROM title_genre g WHERE g.key = " + key + " AND g.genre LIKE ? ESCAPE '\\')"
                 " OR EXISTS (SELECT 1 FROM title_person p WHERE p.key = " + key + " AND p.norm LIKE ? ESCAPE '\\')"
                 " OR t.studio_norm LIKE ? ESCAPE '\\' OR t.collection_norm LIKE ? ESCAPE '\\')";
        binds.insert(binds.end(), {like(w), w, like(w), like(w), like(w), like(w)});
    }
    if (!sq.genre.empty()) {
        where += " AND EXISTS (SELECT 1 FROM title_genre g WHERE g.key = " + key + " AND g.genre = ?)";
        binds.push_back(sq.genre);
    }
    auto person = [&](const std::string& who, int kind) {
        const std::string n = pekdb::fold(who);
        if (n.empty()) return;
        where += " AND EXISTS (SELECT 1 FROM title_person p WHERE p.key = " + key + " AND p.kind = " + std::to_string(kind) + " AND p.norm = ?)";
        binds.push_back(n);
    };
    person(sq.actor, 0);
    person(sq.director, 1);
    if (!sq.studio.empty()) { where += " AND t.studio_norm LIKE ? ESCAPE '\\'"; binds.push_back(like(pekdb::fold(sq.studio))); }
    if (!sq.collection.empty()) { where += " AND t.collection_norm = ?"; binds.push_back(pekdb::fold(sq.collection)); }
    if (sq.year > 0) { where += " AND " + year + " = ?"; binds.push_back(std::to_string(sq.year)); }
    if (sq.decade > 0) { where += " AND " + year + " BETWEEN ? AND ?"; binds.push_back(std::to_string(sq.decade)); binds.push_back(std::to_string(sq.decade + 9)); }

    std::string order = " ORDER BY m.norm";
    if (sq.sort == "year") order = " ORDER BY " + year + " DESC, m.norm";
    else if (sq.sort == "added") order = " ORDER BY " + added + " DESC, m.norm";
    else if (sq.sort == "rating") order = " ORDER BY COALESCE(t.rating,0) DESC, m.norm";

    auto bindAll = [&](pekdb::Stmt& st) { for (size_t i = 0; i < binds.size(); ++i) st.text(static_cast<int>(i + 1), binds[i]); };

    long long total = 0;
    {
        pekdb::Stmt c(*db_, "SELECT count(*)" + from + where);
        bindAll(c);
        if (c.step()) total = c.num(0);
    }
    const int limit = std::max(1, std::min(sq.limit, 5000));
    pekdb::Stmt st(*db_, std::string("SELECT ") + (shows ? "m.name" : "m.id") + from + where + order + " LIMIT ? OFFSET ?");
    bindAll(st);
    st.i64(static_cast<int>(binds.size() + 1), limit).i64(static_cast<int>(binds.size() + 2), std::max(0, sq.offset));
    std::string items;
    while (st.step()) {
        if (!items.empty()) items += ",";
        items += "\"" + jsonEsc(st.str(0)) + "\"";
    }
    return "{\"total\":" + std::to_string(total) + ",\"" + field + "\":[" + items + "]}";
}

std::string MediaScanner::facetsJson(const std::string& type, const std::string& actorPrefix, int limit) {
    const bool shows = type == "shows";
    const std::string prefix = shows ? "s:%" : "m:%";
    std::string out = "{\"indexing\":{\"done\":" + std::to_string(index_done_.load()) + ",\"total\":" + std::to_string(index_total_.load()) + "}";
    if (!db_) return out + ",\"genres\":[],\"decades\":[],\"years\":[],\"actors\":[],\"directors\":[]}";
    limit = std::max(1, std::min(limit, 500));

    auto list = [&](const std::string& name, const std::string& sql, const std::vector<std::string>& binds, bool numeric, const char* numKey = "decade") {
        pekdb::Stmt st(*db_, sql);
        for (size_t i = 0; i < binds.size(); ++i) st.text(static_cast<int>(i + 1), binds[i]);
        std::string items;
        while (st.step()) {
            if (!items.empty()) items += ",";
            items += numeric ? std::string("{\"") + numKey + "\":" + std::to_string(st.num(0)) + ",\"count\":" + std::to_string(st.num(1)) + "}"
                             : "{\"name\":\"" + jsonEsc(st.str(0)) + "\",\"count\":" + std::to_string(st.num(1)) + "}";
        }
        out += ",\"" + name + "\":[" + items + "]";
    };
    const std::string lim = " LIMIT " + std::to_string(limit);
    list("genres", "SELECT MIN(genre), count(*) c FROM title_genre WHERE key LIKE ? GROUP BY genre ORDER BY c DESC, genre" + lim, {prefix}, false);
    list("decades", shows
        ? "SELECT (year/10)*10 d, count(*) FROM title_meta WHERE key LIKE ? AND year>0 GROUP BY d ORDER BY d DESC"
        : "SELECT (year/10)*10 d, count(*) FROM media WHERE kind=0 AND year>0 AND ? LIKE 'm:%' GROUP BY d ORDER BY d DESC", {prefix}, true);
    list("years", shows
        ? "SELECT year d, count(*) FROM title_meta WHERE key LIKE ? AND year>0 GROUP BY d ORDER BY d DESC"
        : "SELECT year d, count(*) FROM media WHERE kind=0 AND year>0 AND ? LIKE 'm:%' GROUP BY d ORDER BY d DESC", {prefix}, true, "year");
    const std::string fp = pekdb::likeEscape(pekdb::fold(actorPrefix));
    list("actors", "SELECT MIN(name), count(*) c FROM title_person WHERE kind=0 AND key LIKE ? AND norm LIKE ? ESCAPE '\\' GROUP BY norm ORDER BY c DESC, norm" + lim,
         {prefix, "%" + fp + "%"}, false);
    list("directors", "SELECT MIN(name), count(*) c FROM title_person WHERE kind=1 AND key LIKE ? AND norm LIKE ? ESCAPE '\\' GROUP BY norm ORDER BY c DESC, norm" + lim,
         {prefix, "%" + fp + "%"}, false);   // the same name-part box narrows the director list too
    return out + "}";
}

// One folder path per line. NOTE: assumes the caller already holds
// mutex_ (called from addMediaDir/removeMediaDir) — does not lock
// itself, to avoid deadlocking on the same non-recursive mutex.
void MediaScanner::persistSourcesToDisk() {
    std::ofstream out(sources_file_path_, std::ios::trunc);
    if (!out.is_open()) {
        std::cout << "[MediaScanner] Could not write sources to " << sources_file_path_ << std::endl;
        return;
    }
    for (const auto& dir : media_dirs_) out << dir << '\n';
}

void MediaScanner::loadFromDisk() {
    // Sources first.
    {
        std::ifstream in(sources_file_path_);
        std::vector<std::string> loaded_dirs;
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty()) loaded_dirs.push_back(line);
        }
        std::lock_guard<std::mutex> lock(mutex_);
        media_dirs_ = std::move(loaded_dirs);
        std::cout << "[MediaScanner] Loaded " << media_dirs_.size() << " source folder(s)." << std::endl;
    }

    // Then the classified-file library (SQLite; an old media_cache.tsv is imported once).
    openDb();
    if (!db_) return;
    if (db_->scalar("SELECT count(*) FROM media") == 0 && fs::exists(cache_file_path_)) {
        std::vector<MediaEntry> old = readLegacyCache(cache_file_path_);
        if (!old.empty() && writeEntries(*db_, old)) {
            std::error_code ec;
            fs::rename(cache_file_path_, cache_file_path_ + ".migrated", ec);
            std::cout << "[MediaScanner] Moved " << old.size() << " entries from the old cache file into the database." << std::endl;
        } else if (old.empty()) {
            std::cout << "[MediaScanner] The old cache file is from an older version; re-scanning all files." << std::endl;
        }
    }
    std::vector<MediaEntry> loaded;
    {
        pekdb::Stmt st(*db_, "SELECT id,path,filename,size,mtime,kind,title,year,show_title,season,episode FROM media");
        while (st.step()) {
            MediaEntry e;
            e.id = st.str(0); e.path = st.str(1); e.filename = st.str(2);
            e.size_bytes = static_cast<uint64_t>(st.num(3)); e.mtime = st.num(4);
            const int k = static_cast<int>(st.num(5));
            e.kind = (k == 0) ? MediaKind::Movie : (k == 1) ? MediaKind::Episode : MediaKind::Unclassified;
            e.title = st.str(6); e.year = static_cast<int>(st.num(7)); e.show_title = st.str(8);
            e.season = static_cast<int>(st.num(9)); e.episode = static_cast<int>(st.num(10));
            loaded.push_back(std::move(e));
        }
    }
    std::lock_guard<std::mutex> lock(mutex_);
    entries_ = std::move(loaded);
    std::cout << "[MediaScanner] Loaded " << entries_.size() << " entries from cache." << std::endl;
}
