#include "media_scanner.h"
#include "vfs.h"
#include "nfo.h"
#include <map>
#include <filesystem>
#include <fstream>
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
const std::string kCacheHeader = "#hesper-cache-v3";
const std::string kCacheHeaderV2 = "#hesper-cache-v2";   // still readable: it just has no metadata columns

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


// ---------------------------------------------------------------------------------------------
// Local metadata (NFO + artwork). Works on plain strings so a local path and a network URL are
// handled the same way: "a/b/c.mkv" -> folder "a/b", leaf "c.mkv".
// ---------------------------------------------------------------------------------------------
using SideMap = std::unordered_map<std::string, std::unordered_map<std::string, SideFile>>;

constexpr uint64_t kNfoMaxBytes = 256 * 1024;

bool isSidecarExt(const std::string& lowerExt) {
    return lowerExt == ".nfo" || lowerExt == ".jpg" || lowerExt == ".jpeg" || lowerExt == ".png" ||
           lowerExt == ".webp" || lowerExt == ".tbn";
}

std::string dirOf(const std::string& p) {
    size_t k = p.find_last_of('/');
    return k == std::string::npos ? std::string() : p.substr(0, k);
}
std::string leafOf(const std::string& p) {
    size_t k = p.find_last_of('/');
    return k == std::string::npos ? p : p.substr(k + 1);
}
std::string stemOf(const std::string& filename) {
    size_t d = filename.find_last_of('.');
    return d == std::string::npos || d == 0 ? filename : filename.substr(0, d);
}

const SideFile* findSide(const SideMap& sides, const std::string& dir, const std::string& lowerName) {
    auto d = sides.find(dir);
    if (d == sides.end()) return nullptr;
    auto f = d->second.find(lowerName);
    return f == d->second.end() ? nullptr : &f->second;
}

// First image called <base>.<ext> in the folder (jpg, jpeg, png, webp, tbn), or null.
const SideFile* findImage(const SideMap& sides, const std::string& dir, const std::string& lowerBase) {
    static const char* const exts[] = {".jpg", ".jpeg", ".png", ".webp", ".tbn"};
    for (const char* ext : exts) {
        if (const SideFile* f = findSide(sides, dir, lowerBase + ext)) return f;
    }
    return nullptr;
}

// The folder that holds the whole show: the parent of a "Season N" folder, otherwise the folder itself.
std::string showDirOf(const std::string& dir) {
    int season = 0;
    if (parseSeasonFolder(leafOf(dir), season)) {
        std::string up = dirOf(dir);
        if (!up.empty()) return up;
    }
    return dir;
}

int videosIn(const std::unordered_map<std::string, int>& counts, const std::string& dir) {
    auto it = counts.find(dir);
    return it == counts.end() ? 0 : it->second;
}

// Reads small text files (NFO) from disk or from a network share. One connection per share is kept for
// the whole scan, so a library with hundreds of NFO files does not log in hundreds of times.
class SideReader {
public:
    bool read(const std::string& path, std::string& out) {
        out.clear();
        if (!vfs::isRemote(path)) {
            std::ifstream in(path, std::ios::binary);
            if (!in.is_open()) return false;
            std::string buf(kNfoMaxBytes, '\0');
            in.read(&buf[0], static_cast<std::streamsize>(buf.size()));
            buf.resize(static_cast<size_t>(in.gcount()));
            out = std::move(buf);
            return true;
        }
        vfs::Url u;
        if (!vfs::parseUrl(path, u)) return false;
        const std::string key = vfs::buildUrl({u.scheme, u.host, u.share, ""});
        auto it = conns_.find(key);
        if (it == conns_.end()) {
            vfs::Error err;
            it = conns_.emplace(key, vfs::connect(u, err)).first;     // a failed connect is remembered (null)
        }
        if (!it->second) return false;
        vfs::Error err;
        if (!it->second->open(u.path, err)) return false;
        uint64_t size = it->second->fileSize();
        if (size > kNfoMaxBytes) size = kNfoMaxBytes;
        std::string buf(static_cast<size_t>(size), '\0');
        uint64_t got = 0;
        while (got < size) {
            int64_t n = it->second->read(got, &buf[got], static_cast<size_t>(size - got));
            if (n <= 0) break;
            got += static_cast<uint64_t>(n);
        }
        buf.resize(static_cast<size_t>(got));
        out = std::move(buf);
        return got > 0 || size == 0;
    }
private:
    std::map<std::string, std::unique_ptr<vfs::Share>> conns_;
};

// Which NFO files apply to a video, and what they look like on disk right now.
struct NfoSet {
    const SideFile* own = nullptr;        // <video name>.nfo
    const SideFile* movie = nullptr;      // movie.nfo (only when the folder holds just this one video)
    const SideFile* show = nullptr;       // tvshow.nfo in the show folder
    std::string ownPath, moviePath, showPath;
};

NfoSet nfoFilesFor(const MediaEntry& e, const SideMap& sides, const std::unordered_map<std::string, int>& counts) {
    NfoSet s;
    const std::string dir = dirOf(e.path);
    const std::string base = toLower(stemOf(e.filename));
    if ((s.own = findSide(sides, dir, base + ".nfo"))) s.ownPath = dir + "/" + s.own->name;
    if (videosIn(counts, dir) == 1 && (s.movie = findSide(sides, dir, "movie.nfo"))) s.moviePath = dir + "/" + s.movie->name;
    const std::string sdir = showDirOf(dir);
    if ((s.show = findSide(sides, sdir, "tvshow.nfo"))) s.showPath = sdir + "/" + s.show->name;
    return s;
}

int64_t nfoSignature(const NfoSet& s) {
    int64_t sig = 0;
    auto mix = [&sig](const SideFile* f, int64_t salt) {
        if (f) sig += (f->mtime * 1000003 + static_cast<int64_t>(f->size)) * salt + salt;
    };
    mix(s.own, 1); mix(s.movie, 3); mix(s.show, 7);
    return sig;
}

// Applies the NFO files to a freshly classified entry. Returns false when a file exists but could not be read
// (the entry is then looked at again on the next scan instead of being trusted as "no metadata").
bool applyNfo(MediaEntry& e, const NfoSet& s, SideReader& reader) {
    bool complete = true;
    auto load = [&](const SideFile* f, const std::string& path, nfo::Info& out) {
        if (!f) return;
        std::string text;
        if (!reader.read(path, text)) { complete = false; return; }
        out = nfo::parse(text);
    };

    nfo::Info own, movie, show;
    load(s.own, s.ownPath, own);
    if (!own.ok) load(s.movie, s.moviePath, movie);
    load(s.show, s.showPath, show);
    if (show.ok && show.root != "tvshow") show = nfo::Info();

    const nfo::Info& item = own.ok ? own : movie;
    if (item.ok && item.root == "movie" && !item.title.empty()) {
        e.kind = MediaKind::Movie;
        e.title = sanitizeField(item.title);
        if (item.year > 0) e.year = item.year;
        e.overview = sanitizeField(item.plot);
        e.show_title.clear(); e.season = 0; e.episode = 0;
        e.guessed = false;
    } else if (item.ok && item.root == "episodedetails") {
        const int season = item.season > 0 ? item.season : (e.kind == MediaKind::Episode ? e.season : 0);
        const int episode = item.episode > 0 ? item.episode : (e.kind == MediaKind::Episode ? e.episode : 0);
        std::string showName = !item.showtitle.empty() ? item.showtitle : (show.ok ? show.title : std::string());
        if (showName.empty() && e.kind == MediaKind::Episode) showName = e.show_title;
        if (!showName.empty() && season > 0 && episode > 0) {
            const bool nameFromNfo = !item.showtitle.empty() || (show.ok && !show.title.empty());
            e.kind = MediaKind::Episode;
            e.show_title = sanitizeField(showName);
            e.season = season;
            e.episode = episode;
            e.ep_title = sanitizeField(item.title);
            e.overview = sanitizeField(item.plot);
            e.title.clear(); e.year = 0;
            if (nameFromNfo) e.guessed = false;
        }
    }

    if (e.kind == MediaKind::Episode && show.ok) {
        if (!show.title.empty()) { e.show_title = sanitizeField(show.title); e.guessed = false; }
        e.show_overview = sanitizeField(show.plot);
    }
    return complete;
}

// Picks the artwork files for an entry from the sidecar files seen in this scan. No file reads, so it
// runs for every entry on every scan and a poster dropped into a folder shows up after the next rescan.
void resolveArt(MediaEntry& e, const SideMap& sides, const std::unordered_map<std::string, int>& counts) {
    e.poster.clear(); e.fanart.clear(); e.thumb.clear(); e.show_poster.clear(); e.show_fanart.clear();
    int64_t newest = 0;
    const std::string dir = dirOf(e.path);
    const std::string base = toLower(stemOf(e.filename));
    auto pick = [&](std::string& dest, const std::string& folder, const std::vector<std::string>& names) {
        for (const auto& n : names) {
            if (const SideFile* f = findImage(sides, folder, n)) {
                dest = folder + "/" + f->name;
                newest = std::max(newest, f->mtime);
                return;
            }
        }
    };
    const bool alone = videosIn(counts, dir) == 1;    // folder-wide names ("poster.jpg") only mean something for a lone video

    if (e.kind == MediaKind::Movie || e.kind == MediaKind::Unclassified) {
        std::vector<std::string> poster = {base + "-poster", base};
        std::vector<std::string> fanart = {base + "-fanart", base + "-backdrop", base + "-background"};
        if (alone) {
            for (const char* n : {"poster", "folder", "cover", "movie"}) poster.push_back(n);
            for (const char* n : {"fanart", "backdrop", "background"}) fanart.push_back(n);
        }
        pick(e.poster, dir, poster);
        pick(e.fanart, dir, fanart);
    } else if (e.kind == MediaKind::Episode) {
        pick(e.thumb, dir, {base + "-thumb", base});
        const std::string sdir = showDirOf(dir);
        pick(e.show_poster, sdir, {"poster", "folder", "cover", "show"});
        pick(e.show_fanart, sdir, {"fanart", "backdrop", "background"});
    }
    e.art_v = newest;
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

        {
            const std::string ext = toLower(e.path().extension().string());
            if (isSidecarExt(ext)) {
                std::error_code sec;
                if (e.is_regular_file(sec) && !sec) {
                    const uint64_t sz = fs::file_size(e.path(), sec);
                    auto ft = fs::last_write_time(e.path(), sec);
                    const int64_t mt = sec ? 0 : std::chrono::duration_cast<std::chrono::seconds>(ft.time_since_epoch()).count();
                    noteSidecar(e.path().string(), e.path().filename().string(), mt, sec ? 0 : sz);
                }
                continue;
            }
        }
        if (!isVideoFile(e.path().extension().string())) continue;

        MediaEntry entry;
        entry.path = e.path().string();
        entry.filename = e.path().filename().string();
        entry.id = makeId(entry.path);
        video_counts_[dirOf(entry.path)]++;
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
        {
            const std::string ext = toLower(fs::path(e.name).extension().string());
            if (isSidecarExt(ext)) {
                noteSidecar(vfs::buildUrl({base.scheme, base.host, base.share, child}), e.name, e.mtime, e.size);
                continue;
            }
        }
        if (!isVideoFile(fs::path(e.name).extension().string())) continue;
        MediaEntry entry;
        entry.path = vfs::buildUrl({base.scheme, base.host, base.share, child});
        entry.filename = e.name;
        entry.id = makeId(entry.path);
        video_counts_[dirOf(entry.path)]++;
        entry.size_bytes = e.size;
        entry.mtime = e.mtime;
        found.push_back(std::move(entry));
    }
    return true;
}

void MediaScanner::noteSidecar(const std::string& file_path, const std::string& name, int64_t mtime, uint64_t size) {
    SideFile f;
    f.name = name; f.mtime = mtime; f.size = size;
    sides_[dirOf(file_path)][toLower(name)] = std::move(f);
}

void MediaScanner::scan() {
    std::lock_guard<std::mutex> scan_lock(scan_mutex_);
    sides_.clear();
    video_counts_.clear();
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
        if (!vfs::isRemote(dir)) { scanDirectory(dir, fresh); continue; }
        if (scanRemote(dir, fresh)) continue;
        // The network source is unreachable (NAS off, Wi-Fi down...). Keep what we
        // already knew about it instead of emptying the library.
        std::string prefix = dir;
        while (!prefix.empty() && prefix.back() == '/') prefix.pop_back();
        prefix += "/";
        size_t kept = 0;
        for (const auto& kv : previous) {
            if (kv.first.compare(0, prefix.size(), prefix) == 0) { fresh.push_back(kv.second); fresh.back().carried = true; ++kept; }
        }
        std::cout << "[MediaScanner] Keeping " << kept << " earlier file(s) from unreachable " << dir << std::endl;
    }

    SideReader reader;   // network connections for reading NFO files, shared by the whole loop
    for (auto& entry : fresh) {
        if (entry.carried) continue;   // its source is offline: keep exactly what we knew

        // NFO files that apply to this video. When one is added, edited or removed the entry is classified again.
        const NfoSet nfos = nfoFilesFor(entry, sides_, video_counts_);
        const int64_t curNfoSig = nfoSignature(nfos);

        auto it = previous.find(entry.path);
        if (it != previous.end() &&
            it->second.size_bytes == entry.size_bytes &&
            it->second.mtime == entry.mtime &&
            it->second.nfo_sig == curNfoSig) {
            // Unchanged on disk — reuse the prior classification
            // rather than re-invoking ffprobe (the expensive step).
            entry.kind = it->second.kind;
            entry.title = it->second.title;
            entry.year = it->second.year;
            entry.show_title = it->second.show_title;
            entry.season = it->second.season;
            entry.episode = it->second.episode;
            entry.overview = it->second.overview;
            entry.ep_title = it->second.ep_title;
            entry.show_overview = it->second.show_overview;
            entry.nfo_sig = it->second.nfo_sig;
        } else {
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

            // NFO files beat tags and guesses: they are the exact title / show / season / episode the person
            // (or Radarr, Sonarr, Kodi ...) wrote down. Done before the TMDb name check below, which then
            // skips anything the NFO already named.
            entry.nfo_sig = 0;
            if (curNfoSig != 0) {
                const bool complete = applyNfo(entry, nfos, reader);
                entry.nfo_sig = complete ? curNfoSig : -1;       // -1: try again on the next scan
                if (entry.kind != MediaKind::Unclassified && !entry.guessed) {
                    std::cout << "[MediaScanner]   -> from NFO: "
                              << (entry.kind == MediaKind::Episode
                                      ? entry.show_title + " S" + std::to_string(entry.season) + "E" + std::to_string(entry.episode)
                                      : entry.title + " (" + std::to_string(entry.year) + ")")
                              << std::endl;
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

    // Artwork: cheap, no file reads, so every entry is looked at on every scan.
    for (auto& entry : fresh) {
        if (entry.carried) { entry.carried = false; continue; }   // offline source: its artwork paths stay as they were
        resolveArt(entry, sides_, video_counts_);
    }
    sides_.clear();
    video_counts_.clear();

    size_t indexed = fresh.size();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        entries_ = std::move(fresh);
    }

    std::cout << "[MediaScanner] Scan complete. " << indexed << " file(s) indexed." << std::endl;
    persistCacheToDisk();
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

bool MediaScanner::findShow(const std::string& title, MediaEntry& out) {
    const std::string key = toLower(title);
    std::lock_guard<std::mutex> lock(mutex_);
    const MediaEntry* first = nullptr;
    for (const auto& e : entries_) {
        if (e.kind != MediaKind::Episode || toLower(e.show_title) != key) continue;
        if (!e.show_poster.empty() || !e.show_overview.empty() || !e.show_fanart.empty()) { out = e; return true; }
        if (!first) first = &e;
    }
    if (!first) return false;
    out = *first;
    return true;
}

bool MediaScanner::findEpisode(const std::string& title, int season, int episode, MediaEntry& out) {
    const std::string key = toLower(title);
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& e : entries_) {
        if (e.kind == MediaKind::Episode && e.season == season && e.episode == episode && toLower(e.show_title) == key) {
            out = e;
            return true;
        }
    }
    return false;
}

// Tab-delimited cache — internal only, never served directly.
// First line is kCacheHeader. Columns: id, path, filename, size, mtime, kind(0=Movie/1=Episode/2=Unclassified),
// title, year, show_title, season, episode, then (v3) overview, ep_title, show_overview, poster, fanart, thumb,
// show_poster, show_fanart, art_v, nfo_sig
void MediaScanner::persistCacheToDisk() {
    std::ofstream out(cache_file_path_, std::ios::trunc);
    if (!out.is_open()) {
        std::cout << "[MediaScanner] Could not write cache to " << cache_file_path_ << std::endl;
        return;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    out << kCacheHeader << '\n';
    for (const auto& e : entries_) {
        out << e.id << '\t' << sanitizeField(e.path) << '\t' << sanitizeField(e.filename) << '\t'
            << e.size_bytes << '\t' << e.mtime << '\t'
            << static_cast<int>(e.kind) << '\t'
            << sanitizeField(e.title) << '\t' << e.year << '\t'
            << sanitizeField(e.show_title) << '\t' << e.season << '\t' << e.episode << '\t'
            << sanitizeField(e.overview) << '\t' << sanitizeField(e.ep_title) << '\t' << sanitizeField(e.show_overview) << '\t'
            << sanitizeField(e.poster) << '\t' << sanitizeField(e.fanart) << '\t' << sanitizeField(e.thumb) << '\t'
            << sanitizeField(e.show_poster) << '\t' << sanitizeField(e.show_fanart) << '\t'
            << e.art_v << '\t' << e.nfo_sig << '\n';
    }
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

    // Then the classified-file cache.
    std::ifstream in(cache_file_path_);
    if (!in.is_open()) return;

    std::vector<MediaEntry> loaded;
    std::string line;

    // A cache written before the filename/folder fallback existed (no
    // version header) holds every untagged file as Unclassified. Drop it
    // so the next scan re-identifies those files instead of reusing the
    // stale "Unknown" result.
    // v2 caches (no metadata columns) are still read: nothing is lost, the metadata is simply filled in by the next scan.
    if (!std::getline(in, line) || (line != kCacheHeader && line != kCacheHeaderV2)) {
        std::cout << "[MediaScanner] Cache is from an older version; re-scanning all files." << std::endl;
        return;
    }

    while (std::getline(in, line)) {
        // Split on tabs, keeping empty fields.
        std::vector<std::string> f;
        size_t start = 0;
        for (;;) {
            size_t tab = line.find('\t', start);
            if (tab == std::string::npos) { f.push_back(line.substr(start)); break; }
            f.push_back(line.substr(start, tab - start));
            start = tab + 1;
        }
        if (f.size() < 11) continue;
        MediaEntry e;
        try {
            e.id = f[0]; e.path = f[1]; e.filename = f[2];
            e.size_bytes = std::stoull(f[3]);
            e.mtime = std::stoll(f[4]);
            int k = std::stoi(f[5]);
            e.kind = (k == 0) ? MediaKind::Movie : (k == 1) ? MediaKind::Episode : MediaKind::Unclassified;
            e.title = f[6];
            e.year = std::stoi(f[7]);
            e.show_title = f[8];
            e.season = std::stoi(f[9]);
            e.episode = std::stoi(f[10]);
            if (f.size() >= 21) {
                e.overview = f[11]; e.ep_title = f[12]; e.show_overview = f[13];
                e.poster = f[14]; e.fanart = f[15]; e.thumb = f[16];
                e.show_poster = f[17]; e.show_fanart = f[18];
                e.art_v = std::stoll(f[19]);
                e.nfo_sig = std::stoll(f[20]);
            }
        } catch (...) { continue; }
        loaded.push_back(std::move(e));
    }

    std::lock_guard<std::mutex> lock(mutex_);
    entries_ = std::move(loaded);
    std::cout << "[MediaScanner] Loaded " << entries_.size() << " entries from cache." << std::endl;
}
