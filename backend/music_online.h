#ifndef MUSIC_ONLINE_H
#define MUSIC_ONLINE_H

// Online pictures and lyrics for the Music tab: artist photos, album covers and covers for single songs.
// Used only when the song files and their folders have no picture of their own, and only when the user turned
// "Online art" on. Deezer's public search is asked first (no key needed), Apple's iTunes search is the fallback for
// albums and songs. Every answer (also "nothing found") is kept in <dataDir>/music_art until the next manual rescan,
// so a picture is looked up once. Needs a build with CPPHTTPLIB_OPENSSL_SUPPORT; without it nothing is looked up.

#include "httplib.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace musiconline {

// ---------------------------------------------------------------- tiny JSON reader (only what the search answers need)
struct J {
    enum T { Null, Bool, Num, Str, Arr, Obj } t = Null;
    std::string s;
    double n = 0;
    std::vector<J> a;
    std::vector<std::pair<std::string, J>> o;
    const J* get(const char* k) const {
        if (t != Obj) return nullptr;
        for (const auto& p : o) if (p.first == k) return &p.second;
        return nullptr;
    }
    std::string str(const char* k) const { const J* v = get(k); return v && v->t == Str ? v->s : std::string(); }
};

struct Parser {
    const std::string& s;
    size_t i = 0;
    int depth = 0;
    explicit Parser(const std::string& x) : s(x) {}
    void ws() { while (i < s.size() && (unsigned char)s[i] <= ' ') ++i; }
    bool lit(const char* w) { size_t n = std::char_traits<char>::length(w); if (s.compare(i, n, w) != 0) return false; i += n; return true; }
    bool string(std::string& o) {
        if (i >= s.size() || s[i] != '"') return false;
        ++i;
        while (i < s.size()) {
            char c = s[i++];
            if (c == '"') return true;
            if (c != '\\') { o += c; continue; }
            if (i >= s.size()) return false;
            char e = s[i++];
            switch (e) {
                case 'n': o += '\n'; break;
                case 't': o += '\t'; break;
                case 'r': o += '\r'; break;
                case 'b': case 'f': break;
                case 'u': {
                    if (i + 4 > s.size()) return false;
                    unsigned cp = (unsigned)std::strtoul(s.substr(i, 4).c_str(), nullptr, 16);
                    i += 4;
                    if (cp >= 0xD800 && cp <= 0xDFFF) { o += '?'; break; }     // surrogate pairs are not needed here
                    if (cp < 0x80) o += (char)cp;
                    else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
                    else { o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
                    break;
                }
                default: o += e;                                                 // \" \\ \/
            }
        }
        return false;
    }
    bool parse(J& out) {
        ws();
        if (i >= s.size() || depth > 32) return false;
        char c = s[i];
        if (c == '{' || c == '[') {
            const bool obj = c == '{';
            const char close = obj ? '}' : ']';
            ++i; ++depth;
            out.t = obj ? J::Obj : J::Arr;
            ws();
            if (i < s.size() && s[i] == close) { ++i; --depth; return true; }
            for (;;) {
                std::string key;
                if (obj) {
                    ws();
                    if (!string(key)) return false;
                    ws();
                    if (i >= s.size() || s[i] != ':') return false;
                    ++i;
                }
                J v;
                if (!parse(v)) return false;
                if (obj) out.o.emplace_back(std::move(key), std::move(v)); else out.a.push_back(std::move(v));
                ws();
                if (i >= s.size()) return false;
                if (s[i] == ',') { ++i; continue; }
                if (s[i] == close) { ++i; --depth; return true; }
                return false;
            }
        }
        if (c == '"') { out.t = J::Str; return string(out.s); }
        if (lit("true") || lit("false")) { out.t = J::Bool; return true; }
        if (lit("null")) { out.t = J::Null; return true; }
        char* end = nullptr;
        out.n = std::strtod(s.c_str() + i, &end);
        if (end == s.c_str() + i) return false;
        out.t = J::Num;
        i = (size_t)(end - s.c_str());
        return true;
    }
};

// ---------------------------------------------------------------- names
inline std::string norm(const std::string& in) {                  // letters and digits only, lower case
    std::string o;
    for (size_t i = 0; i < in.size(); ++i) {
        unsigned char c = (unsigned char)in[i];
        if (c == 0xE2 && i + 2 < in.size() && ((unsigned char)in[i + 1] == 0x80 || (unsigned char)in[i + 1] == 0x81)) { i += 2; continue; }   // ’ “ ” – … and friends
        if (c >= 128) o += (char)c;
        else if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')) o += (char)c;
        else if (c >= 'A' && c <= 'Z') o += (char)(c - 'A' + 'a');
    }
    return o;
}
inline std::string core(const std::string& in) {                   // "Song (feat. X) [Remastered] - Deluxe" -> "song"
    std::string s; int depth = 0;
    for (char c : in) {
        if (c == '(' || c == '[') ++depth;
        else if (c == ')' || c == ']') { if (depth) --depth; }
        else if (!depth) s += c;
    }
    size_t k = s.find(" - ");
    if (k != std::string::npos && k > 0) s = s.substr(0, k);
    return norm(s);
}
inline bool similar(const std::string& x, const std::string& y) {  // same name, or one holds the other ("Album (Deluxe)")
    std::string a = norm(x), b = norm(y);
    if (a.empty() || b.empty()) return false;
    if (a == b) return true;
    { std::string ca = core(x), cb = core(y); if (!ca.empty() && ca == cb) return true; }
    return (a.size() >= 4 && b.find(a) != std::string::npos) || (b.size() >= 4 && a.find(b) != std::string::npos);
}
inline std::string enc(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string o;
    for (unsigned char c : s) {
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c;
        else { o += '%'; o += hex[c >> 4]; o += hex[c & 15]; }
    }
    return o;
}
// "$uicideboy$, Aristos Petrou, Scott Arceneaux Jr." (an album artist tag with every credit) -> the whole string first,
// then each single name, so the lookups can still find the real artist.
inline std::vector<std::string> artistNames(const std::string& in) {
    std::vector<std::string> out;
    auto add = [&](std::string x) {
        size_t b = x.find_first_not_of(" \t"), e = x.find_last_not_of(" \t");
        if (b == std::string::npos) return;
        x = x.substr(b, e - b + 1);
        for (const auto& y : out) if (norm(y) == norm(x)) return;
        out.push_back(x);
    };
    add(in);
    std::string cur;
    auto flush = [&]() { add(cur); cur.clear(); };
    for (size_t i = 0; i < in.size(); ++i) {
        char c = in[i];
        if (c == ',' || c == ';' || c == '/' || c == '&') { flush(); continue; }
        auto word = [&](const char* w) { size_t n = std::char_traits<char>::length(w); return in.compare(i, n, w) == 0; };
        if (word(" feat. ") || word(" ft. ") || word(" with ") || word(" and ") || word(" x ")) {
            flush();
            while (i + 1 < in.size() && in[i + 1] != ' ') ++i;      // skip the joining word
            ++i;
            continue;
        }
        cur += c;
    }
    flush();
    return out;
}
inline bool similarAny(const std::string& x, const std::vector<std::string>& names) {
    for (const auto& n : names) if (similar(x, n)) return true;
    return false;
}
inline std::string noQuotes(std::string s) { for (char& c : s) if (c == '"') c = ' '; return s; }

// ---------------------------------------------------------------- network
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
constexpr bool kAvailable = true;

inline void caBundle(httplib::SSLClient& c) {
    const char* f = std::getenv("SSL_CERT_FILE"); const char* d = std::getenv("SSL_CERT_DIR");
    bool hf = f && *f, hd = d && *d;
    if (hf || hd) c.set_ca_cert_path(hf ? f : "", hd ? d : "");
}

// at most a few lookups at once, and the search services are not hit faster than ~7 times a second
struct Gate {
    std::mutex m;
    std::condition_variable cv;
    int running = 0;
    std::chrono::steady_clock::time_point next{};
};
inline Gate& gate() { static Gate g; return g; }
struct Slot {
    Slot() {
        std::unique_lock<std::mutex> l(gate().m);
        gate().cv.wait(l, [] { return gate().running < 4; });
        ++gate().running;
    }
    ~Slot() { { std::lock_guard<std::mutex> l(gate().m); --gate().running; } gate().cv.notify_one(); }
};
inline void pace() {
    std::chrono::steady_clock::time_point at;
    {
        std::lock_guard<std::mutex> l(gate().m);
        auto now = std::chrono::steady_clock::now();
        at = gate().next > now ? gate().next : now;
        gate().next = at + std::chrono::milliseconds(140);
    }
    std::this_thread::sleep_until(at);
}

inline bool httpsGet(const std::string& host, const std::string& path, std::string& body, bool api) {
    if (api) pace();
    httplib::SSLClient cli(host, 443);
    caBundle(cli);
    cli.set_connection_timeout(6);
    cli.set_read_timeout(10);
    cli.set_follow_location(true);
    httplib::Headers h = {{"User-Agent", "PEK-TV (music covers)"}, {"Accept", "*/*"}};
    auto r = cli.Get(path, h);
    if (!r || r->status != 200 || r->body.empty()) return false;
    body = std::move(r->body);
    return true;
}
#else
constexpr bool kAvailable = false;
struct Slot {};
inline bool httpsGet(const std::string&, const std::string&, std::string&, bool) { return false; }
#endif

inline bool splitUrl(const std::string& url, std::string& host, std::string& path) {
    if (url.rfind("https://", 0) != 0) return false;
    size_t s = url.find('/', 8);
    host = url.substr(8, s == std::string::npos ? std::string::npos : s - 8);
    path = s == std::string::npos ? "/" : url.substr(s);
    if (host.empty() || host.find('@') != std::string::npos || host.find(':') != std::string::npos) return false;
    auto ends = [&](const char* suf) { size_t n = std::char_traits<char>::length(suf); return host.size() > n && host.compare(host.size() - n, n, suf) == 0; };
    return ends(".dzcdn.net") || ends(".deezer.com") || ends(".mzstatic.com");      // only the services' own picture servers
}

inline bool sniff(const std::string& b, std::string& mime) {
    if (b.size() > 3 && (unsigned char)b[0] == 0xFF && (unsigned char)b[1] == 0xD8) { mime = "image/jpeg"; return true; }
    if (b.size() > 8 && b.compare(1, 3, "PNG") == 0) { mime = "image/png"; return true; }
    if (b.size() > 12 && b.compare(0, 4, "RIFF") == 0 && b.compare(8, 4, "WEBP") == 0) { mime = "image/webp"; return true; }
    return false;
}

inline bool fetchImage(const std::string& url, std::string& bytes, std::string& mime) {
    std::string host, path, body;
    if (!splitUrl(url, host, path) || !httpsGet(host, path, body, false)) return false;
    if (body.size() > (4u << 20) || !sniff(body, mime)) return false;
    bytes = std::move(body);
    return true;
}

// ---------------------------------------------------------------- the lookups
// Result: 1 found, 0 the service answered but has nothing, -1 the service could not be reached (do not remember that).
inline bool deezer(const std::string& kind, const std::string& q, J& root, bool& failed) {
    std::string body;
    if (!httpsGet("api.deezer.com", "/search/" + kind + "?limit=8&q=" + enc(q), body, true)) { failed = true; return false; }
    Parser p(body);
    if (!p.parse(root) || root.t != J::Obj || root.get("error")) { failed = true; return false; }
    return true;
}
inline bool itunes(const std::string& entity, const std::string& term, J& root, bool& failed) {
    std::string body;
    if (!httpsGet("itunes.apple.com", "/search?media=music&limit=8&entity=" + entity + "&term=" + enc(term), body, true)) { failed = true; return false; }
    Parser p(body);
    if (!p.parse(root) || root.t != J::Obj) { failed = true; return false; }
    return true;
}
inline std::string bigger(std::string u) {                           // iTunes gives a 100x100 link; the same link works at 500x500
    size_t k = u.find("100x100");
    if (k != std::string::npos) u.replace(k, 7, "500x500");
    return u;
}

inline int artistPhoto(const std::string& name, std::string& bytes, std::string& mime) {
    bool failed = false;
    J r;
    for (const auto& n : artistNames(name)) {
        if (!deezer("artist", n, r, failed)) continue;
        const J* d = r.get("data");
        if (d && d->t == J::Arr) for (const J& x : d->a) {
            if (norm(x.str("name")) != norm(n)) continue;                    // exact name only: a wrong face is worse than none
            std::string u = x.str("picture_big");
            if (u.empty() || u.find("/images/artist//") != std::string::npos) continue;      // Deezer's grey "no photo" picture
            if (fetchImage(u, bytes, mime)) return 1;
        }
    }
    return failed ? -1 : 0;
}

inline int albumCover(const std::string& artist, const std::string& album, std::string& bytes, std::string& mime) {
    bool failed = false;
    J r;
    const std::vector<std::string> names = artistNames(artist);
    auto fromDeezer = [&](const std::string& q) {
        if (!deezer("album", q, r, failed)) return false;
        const J* d = r.get("data");
        if (d && d->t == J::Arr) for (const J& x : d->a) {
            const J* ar = x.get("artist");
            if (!similar(x.str("title"), album) || !ar || !similarAny(ar->str("name"), names)) continue;
            std::string u = x.str("cover_big");
            if (!u.empty() && fetchImage(u, bytes, mime)) return true;
        }
        return false;
    };
    for (const auto& n : names) {
        if (fromDeezer("artist:\"" + noQuotes(n) + "\" album:\"" + noQuotes(album) + "\"")) return 1;
        if (fromDeezer(n + " " + album)) return 1;
    }
    for (const auto& n : names) {
        if (itunes("album", n + " " + album, r, failed)) {
            const J* d = r.get("results");
            if (d && d->t == J::Arr) for (const J& x : d->a) {
                if (!similar(x.str("collectionName"), album) || !similarAny(x.str("artistName"), names)) continue;
                std::string u = bigger(x.str("artworkUrl100"));
                if (!u.empty() && fetchImage(u, bytes, mime)) return 1;
            }
        }
    }
    // last tries: the album name alone (odd characters in the artist name can sink the combined search), with the artist checked on the answers
    { std::string plainAlbum = core(album).empty() ? album : album;
      if (fromDeezer(noQuotes(plainAlbum))) return 1;
      if (itunes("album", plainAlbum, r, failed)) {
          const J* d = r.get("results");
          if (d && d->t == J::Arr) for (const J& x : d->a) {
              if (!similar(x.str("collectionName"), album) || !similarAny(x.str("artistName"), names)) continue;
              std::string u = bigger(x.str("artworkUrl100"));
              if (!u.empty() && fetchImage(u, bytes, mime)) return 1;
          }
      } }
    return failed ? -1 : 0;
}

inline int songCover(const std::string& artist, const std::string& title, std::string& bytes, std::string& mime) {
    bool failed = false;
    J r;
    const std::vector<std::string> names = artistNames(artist);
    auto fromDeezer = [&](const std::string& q) {
        if (!deezer("track", q, r, failed)) return false;
        const J* d = r.get("data");
        if (d && d->t == J::Arr) for (const J& x : d->a) {
            const J* ar = x.get("artist"); const J* al = x.get("album");
            if (!similar(x.str("title"), title) || !ar || !al || !similarAny(ar->str("name"), names)) continue;
            std::string u = al->str("cover_big");
            if (!u.empty() && fetchImage(u, bytes, mime)) return true;
        }
        return false;
    };
    for (const auto& n : names) {
        if (fromDeezer("artist:\"" + noQuotes(n) + "\" track:\"" + noQuotes(title) + "\"")) return 1;
        if (fromDeezer(n + " " + title)) return 1;
    }
    for (const auto& n : names) {
        if (itunes("song", n + " " + title, r, failed)) {
            const J* d = r.get("results");
            if (d && d->t == J::Arr) for (const J& x : d->a) {
                if (!similar(x.str("trackName"), title) || !similarAny(x.str("artistName"), names)) continue;
                std::string u = bigger(x.str("artworkUrl100"));
                if (!u.empty() && fetchImage(u, bytes, mime)) return 1;
            }
        }
    }
    // last try: the title with its "(feat. ...)" / "[Remastered]" part removed, artist checked on the answers
    { std::string bare = title; size_t k = bare.find_first_of("(["); if (k != std::string::npos && k > 2) bare = bare.substr(0, k);
      if (!names.empty() && fromDeezer(names[0] + " " + noQuotes(bare))) return 1; }
    return failed ? -1 : 0;
}

// ---------------------------------------------------------------- lyrics (LRCLIB: free, no key, time-synced "LRC" text)
// synced = "[01:23.45] line" per line (may be empty), plain = the same words without times (may be empty).
inline std::string lrcNum(double d) { char b[32]; std::snprintf(b, sizeof b, "%.0f", d); return b; }
inline int lyricsFetch(const std::string& artist, const std::string& title, const std::string& album, double duration,
                       std::string& synced, std::string& plain) {
    bool failed = false;
    const std::vector<std::string> names = artistNames(artist);
    auto take = [&](const J& x) {
        const J* a = x.get("syncedLyrics"); const J* b = x.get("plainLyrics");
        std::string sy = a && a->t == J::Str ? a->s : std::string(), pl = b && b->t == J::Str ? b->s : std::string();
        if (sy.empty() && pl.empty()) return false;
        synced = sy; plain = pl;
        return true;
    };
    // 1) the exact lookup (needs artist, title, album and length), the best answer when the tags are good
    if (duration > 0 && !album.empty()) for (const auto& n : names) {
        std::string body;
        if (!httpsGet("lrclib.net", "/api/get?artist_name=" + enc(n) + "&track_name=" + enc(title) + "&album_name=" + enc(album) +
                                    "&duration=" + lrcNum(duration), body, true)) continue;
        Parser p(body); J r;
        if (p.parse(r) && r.t == J::Obj && take(r)) return 1;
    }
    // 2) a search; take the closest length, and prefer one with timings
    for (const auto& n : names) {
        std::string body;
        if (!httpsGet("lrclib.net", "/api/search?track_name=" + enc(title) + "&artist_name=" + enc(n), body, true)) { failed = true; continue; }
        Parser p(body); J r;
        if (!p.parse(r) || r.t != J::Arr) { failed = true; continue; }
        const J* best = nullptr; double bestScore = -1e9;
        for (const J& x : r.a) {
            if (!similar(x.str("trackName"), title) || !similarAny(x.str("artistName"), names)) continue;
            const J* sy = x.get("syncedLyrics"); const J* pl = x.get("plainLyrics");
            bool hasSync = sy && sy->t == J::Str && !sy->s.empty(), hasPlain = pl && pl->t == J::Str && !pl->s.empty();
            if (!hasSync && !hasPlain) continue;
            const J* d = x.get("duration");
            double gap = duration > 0 && d && d->t == J::Num ? std::abs(d->n - duration) : 0;
            if (duration > 0 && gap > 6) continue;                       // a different version of the song
            double score = (hasSync ? 100 : 0) - gap;
            if (score > bestScore) { bestScore = score; best = &x; }
        }
        if (best && take(*best)) return 1;
    }
    return failed ? -1 : 0;
}

// ---------------------------------------------------------------- the on/off switch and the disk cache
namespace fs = std::filesystem;

struct Store {
    std::mutex m;
    std::string dir, flag;
    std::atomic<bool> on{false};

    void init(const std::string& dataDir) {
        std::lock_guard<std::mutex> l(m);
        dir = (fs::path(dataDir) / "music_art").string();
        flag = (fs::path(dataDir) / "music_online.flag").string();
        std::error_code ec;
        fs::create_directories(dir, ec);
        // On by default: the flag file holds "1" (on) or "0" (the user switched it off). No file = never touched = on.
        bool want = true;
        if (fs::exists(flag, ec)) { std::ifstream f(flag); std::string v; std::getline(f, v); want = v != "0"; }
        on = kAvailable && want;
    }
    void setEnabled(bool v) {
        std::lock_guard<std::mutex> l(m);
        on = v && kAvailable;
        std::error_code ec;
        std::ofstream(flag, std::ios::trunc) << (v ? "1\n" : "0\n");
    }
    std::string file(const std::string& key) { return (fs::path(dir) / (std::to_string(std::hash<std::string>{}(key)) + ".img")).string(); }

    // 1 = picture loaded, 0 = remembered "nothing found", -1 = never looked up
    int load(const std::string& key, std::string& bytes, std::string& mime) {
        std::lock_guard<std::mutex> l(m);
        std::ifstream f(file(key), std::ios::binary);
        if (!f) return -1;
        std::string head;
        std::getline(f, head);
        if (head == "none") return 0;
        std::ostringstream ss; ss << f.rdbuf();
        bytes = ss.str(); mime = head;
        return bytes.empty() ? -1 : 1;
    }
    void save(const std::string& key, const std::string& mime, const std::string& bytes) {
        std::lock_guard<std::mutex> l(m);
        std::ofstream f(file(key), std::ios::binary | std::ios::trunc);
        if (!bytes.empty()) f << mime << "\n"; else f << "none\n";
        f.write(bytes.data(), (std::streamsize)bytes.size());
    }
    // Forget every remembered "nothing found" (pictures and lyrics), so a retry asks the services again.
    int forgetMisses() {
        std::lock_guard<std::mutex> l(m);
        std::error_code ec; int n = 0;
        if (dir.empty()) return 0;
        for (auto& e : fs::directory_iterator(dir, ec)) {
            std::string head;
            { std::ifstream f(e.path(), std::ios::binary); std::getline(f, head); }
            if (head == "none") { std::error_code e2; fs::remove(e.path(), e2); ++n; }
        }
        return n;
    }
    void clear() {                                                   // "till the next refresh"
        std::lock_guard<std::mutex> l(m);
        std::error_code ec;
        if (dir.empty()) return;
        fs::remove_all(dir, ec);
        fs::create_directories(dir, ec);
    }
};
inline Store& store() { static Store s; return s; }

// kind: "artist" | "album" | "song".
// Answers what is already kept on disk even when the online switch is off (nothing is sent anywhere for that), so a
// saved library keeps working with no internet. Returns 1 = picture in bytes / mime, 0 = nothing exists (remembered),
// -1 = could not be looked up (switch off, or the service could not be reached; tried again next time).
inline int lookupEx(const std::string& kind, const std::string& a, const std::string& b, std::string& bytes, std::string& mime) {
    Store& st = store();
    if (a.empty()) return 0;
    const std::string key = kind + "|" + norm(a) + "|" + norm(b);
    int c = st.load(key, bytes, mime);
    if (c == 1) return 1;
    if (c == 0) return 0;
    if (!st.on) return -1;
    Slot slot;
    int r = kind == "artist" ? artistPhoto(a, bytes, mime) : kind == "album" ? albumCover(a, b, bytes, mime) : songCover(a, b, bytes, mime);
    if (r == 1) { st.save(key, mime, bytes); return 1; }
    if (r == 0) st.save(key, "", "");                                // remember the miss, until the next refresh
    return r == 0 ? 0 : -1;
}
inline bool lookup(const std::string& kind, const std::string& a, const std::string& b, std::string& bytes, std::string& mime) {
    return lookupEx(kind, a, b, bytes, mime) == 1;
}

// Like lookupEx but NEVER touches the network and never waits for a lookup slot: it answers only from what is already
// on disk. Same codes: 1 = picture in bytes / mime, 0 = nothing exists (remembered), -1 = not looked up yet.
// The cover route uses this so a grid asking for hundreds of pictures cannot tie up the server's request threads.
inline int lookupCachedEx(const std::string& kind, const std::string& a, const std::string& b, std::string& bytes, std::string& mime) {
    if (a.empty()) return 0;
    const std::string key = kind + "|" + norm(a) + "|" + norm(b);
    int c = store().load(key, bytes, mime);
    return c == 1 ? 1 : c == 0 ? 0 : -1;
}

// Lyrics for one song; the answer (also "none") is kept like the pictures are, and served offline from then on.
// Same return codes as lookupEx.
inline int lyricsEx(const std::string& artist, const std::string& title, const std::string& album, double duration,
                    std::string& synced, std::string& plain) {
    Store& st = store();
    if (artist.empty() || title.empty()) return 0;
    const std::string key = "lyrics|" + norm(artist) + "|" + norm(title) + "|" + lrcNum(duration / 4);
    std::string bytes, mime;
    int c = st.load(key, bytes, mime);
    if (c == 0) return 0;
    if (c == 1 && mime == "lyrics") {
        size_t k = bytes.find('\x1f');
        synced = bytes.substr(0, k); plain = k == std::string::npos ? std::string() : bytes.substr(k + 1);
        return 1;
    }
    if (!st.on) return -1;
    Slot slot;
    int r = lyricsFetch(artist, title, album, duration, synced, plain);
    if (r == 1) { st.save(key, "lyrics", synced + "\x1f" + plain); return 1; }
    if (r == 0) st.save(key, "", "");
    return r == 0 ? 0 : -1;
}
inline bool lyrics(const std::string& artist, const std::string& title, const std::string& album, double duration,
                   std::string& synced, std::string& plain) {
    return lyricsEx(artist, title, album, duration, synced, plain) == 1;
}

} // namespace musiconline

#endif
