#pragma once
// ============================================================
// Automatic subtitle look-up
//
// The app does not talk to OpenSubtitles itself: one shared account lives in the cloud worker
// (cloud/worker.js: /v1/subs/search and /v1/subs/get), so nobody needs their own key. This file is the
// local half: it forwards the page's requests to the worker and keeps the downloaded text so the player
// (mpv, or the <video> element) can load it from this device.
//
//   POST /api/subtitles/search   title, [year], [season], [episode], [lang], [file]
//        -> {"ok":true,"results":[{id,name,lang,downloads,hi,ai,trusted,score}, ...]}   best first
//   POST /api/subtitles/fetch    id
//        -> {"ok":true,"url":"/api/subtitles/cache/<id>.srt"}
//   GET  /api/subtitles/cache/<id>.srt      the subtitle as UTF-8 SubRip text
//
// The worker's address is the PEK_SUBS_URL environment variable, default the sync worker.
// Downloaded subtitles are kept in memory only (a few at a time), so no storage permission is needed.
// ============================================================

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cctype>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "httplib.h"

namespace peksubs {

// ---------------- a small JSON reader (the answers are small and well formed) ----------------

struct J {
    enum Type { Null, Bool, Num, Str, Arr, Obj } t = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<J> a;
    std::vector<std::pair<std::string, J>> o;

    const J* get(const std::string& k) const {
        if (t != Obj) return nullptr;
        for (const auto& kv : o) if (kv.first == k) return &kv.second;
        return nullptr;
    }
    std::string str(const std::string& k, const std::string& def = "") const {
        const J* v = get(k);
        if (!v) return def;
        if (v->t == Str) return v->s;
        if (v->t == Num) { std::ostringstream os; os << static_cast<long long>(v->n); return os.str(); }
        return def;
    }
    double num(const std::string& k, double def = 0) const {
        const J* v = get(k);
        return (v && v->t == Num) ? v->n : def;
    }
    bool flag(const std::string& k) const {
        const J* v = get(k);
        return v && v->t == Bool && v->b;
    }
};

class Parser {
public:
    explicit Parser(const std::string& text) : p_(text.c_str()), end_(text.c_str() + text.size()) {}
    bool parse(J& out) { ws(); if (!value(out, 0)) return false; ws(); return true; }

private:
    const char* p_;
    const char* end_;

    void ws() { while (p_ < end_ && (*p_ == ' ' || *p_ == '\n' || *p_ == '\r' || *p_ == '\t')) ++p_; }

    static void putUtf8(std::string& o, unsigned cp) {
        if (cp < 0x80) o += static_cast<char>(cp);
        else if (cp < 0x800) { o += static_cast<char>(0xC0 | (cp >> 6)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { o += static_cast<char>(0xE0 | (cp >> 12)); o += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
        else { o += static_cast<char>(0xF0 | (cp >> 18)); o += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); o += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
    }

    bool hex4(unsigned& v) {
        if (end_ - p_ < 4) return false;
        v = 0;
        for (int i = 0; i < 4; ++i) {
            char c = *p_++;
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
            else return false;
        }
        return true;
    }

    bool string(std::string& out) {
        if (p_ >= end_ || *p_ != '"') return false;
        ++p_;
        while (p_ < end_) {
            char c = *p_++;
            if (c == '"') return true;
            if (c != '\\') { out += c; continue; }
            if (p_ >= end_) return false;
            char e = *p_++;
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp;
                    if (!hex4(cp)) return false;
                    if (cp >= 0xD800 && cp < 0xDC00 && end_ - p_ >= 6 && p_[0] == '\\' && p_[1] == 'u') {
                        p_ += 2;
                        unsigned lo;
                        if (!hex4(lo)) return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    putUtf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
        return false;
    }

    bool value(J& v, int depth) {
        if (depth > 40 || p_ >= end_) return false;
        char c = *p_;
        if (c == '{') {
            ++p_; v.t = J::Obj; ws();
            if (p_ < end_ && *p_ == '}') { ++p_; return true; }
            for (;;) {
                ws();
                std::string k;
                if (!string(k)) return false;
                ws();
                if (p_ >= end_ || *p_++ != ':') return false;
                ws();
                J child;
                if (!value(child, depth + 1)) return false;
                v.o.emplace_back(std::move(k), std::move(child));
                ws();
                if (p_ >= end_) return false;
                if (*p_ == ',') { ++p_; continue; }
                if (*p_ == '}') { ++p_; return true; }
                return false;
            }
        }
        if (c == '[') {
            ++p_; v.t = J::Arr; ws();
            if (p_ < end_ && *p_ == ']') { ++p_; return true; }
            for (;;) {
                ws();
                J child;
                if (!value(child, depth + 1)) return false;
                v.a.push_back(std::move(child));
                ws();
                if (p_ >= end_) return false;
                if (*p_ == ',') { ++p_; continue; }
                if (*p_ == ']') { ++p_; return true; }
                return false;
            }
        }
        if (c == '"') { v.t = J::Str; return string(v.s); }
        if (end_ - p_ >= 4 && std::string(p_, 4) == "true") { p_ += 4; v.t = J::Bool; v.b = true; return true; }
        if (end_ - p_ >= 5 && std::string(p_, 5) == "false") { p_ += 5; v.t = J::Bool; v.b = false; return true; }
        if (end_ - p_ >= 4 && std::string(p_, 4) == "null") { p_ += 4; v.t = J::Null; return true; }
        char* e = nullptr;
        double d = std::strtod(p_, &e);
        if (e == p_) return false;
        p_ = e; v.t = J::Num; v.n = d;
        return true;
    }
};

inline bool parseJson(const std::string& text, J& out) { Parser p(text); return p.parse(out); }

// ---------------- helpers ----------------

inline std::string jesc(const std::string& s) {
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
                if (c < 0x20) o += ' ';
                else o += static_cast<char>(c);
        }
    }
    return o;
}

inline void fail(httplib::Response& res, int status, const std::string& msg) {
    res.status = status;
    res.set_header("Cache-Control", "no-store");
    res.set_content("{\"ok\": false, \"error\": \"" + jesc(msg) + "\"}", "application/json");
}

inline std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

// Words of a release name / title, lower case (used to rank candidates against the playing file).
inline std::set<std::string> words(const std::string& s) {
    std::set<std::string> out;
    std::string cur;
    for (unsigned char ch : s) {
        if (std::isalnum(ch)) cur += static_cast<char>(std::tolower(ch));
        else { if (cur.size() > 1) out.insert(cur); cur.clear(); }
    }
    if (cur.size() > 1) out.insert(cur);
    return out;
}

#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
inline void applyCa(httplib::SSLClient& c) {
    const char* f = std::getenv("SSL_CERT_FILE");
    const char* d = std::getenv("SSL_CERT_DIR");
    bool hasF = f && *f, hasD = d && *d;
    if (hasF || hasD) c.set_ca_cert_path(hasF ? f : "", hasD ? d : "");
}

// Where the shared subtitle service lives: https://host[:port]
inline bool workerHost(std::string& host, int& port) {
    const char* env = std::getenv("PEK_SUBS_URL");
    std::string u = (env && *env) ? env : "https://pek-sync.aquariusibeats.workers.dev";
    const std::string pre = "https://";
    if (u.compare(0, pre.size(), pre) != 0) return false;
    u = u.substr(pre.size());
    while (!u.empty() && u.back() == '/') u.pop_back();
    port = 443;
    size_t colon = u.find(':');
    if (colon != std::string::npos) { port = std::atoi(u.c_str() + colon + 1); u = u.substr(0, colon); }
    if (u.empty() || port <= 0 || port > 65535) return false;
    for (unsigned char c : u) if (!(std::isalnum(c) || c == '.' || c == '-')) return false;
    host = u;
    return true;
}

// POST a small JSON body to the worker. Returns false (and fills msg) when it cannot be reached.
inline bool workerPost(const std::string& path, const std::string& body, int& status, std::string& answer, std::string& msg) {
    std::string host; int port;
    if (!workerHost(host, port)) { msg = "The subtitle service address is not valid."; return false; }
    httplib::SSLClient cli(host, port);
    applyCa(cli);
    cli.set_connection_timeout(8);
    cli.set_read_timeout(25);
    cli.set_follow_location(true);
    auto r = cli.Post(path, httplib::Headers{{"User-Agent", "PEK-TV-subtitles"}, {"Accept", "application/json"}}, body, "application/json");
    if (!r) { msg = "Couldn't reach the subtitle service (" + httplib::to_string(r.error()) + ")."; return false; }
    status = r->status;
    answer = r->body;
    return true;
}
#endif  // CPPHTTPLIB_OPENSSL_SUPPORT

// ---------------- text: make it UTF-8 SubRip ----------------

inline bool validUtf8(const std::string& s) {
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        size_t len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        if (!len || i + len > n) return false;
        for (size_t k = 1; k < len; ++k) if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80) return false;
        i += len;
    }
    return true;
}

// Old subtitle files are often Windows-1252. 0x80-0x9F differ from Latin-1; the rest map straight.
inline std::string fromCp1252(const std::string& s) {
    static const unsigned short hi[32] = {
        0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
        0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178};
    std::string o;
    o.reserve(s.size() + s.size() / 8);
    for (unsigned char c : s) {
        unsigned cp = c;
        if (c >= 0x80 && c < 0xA0) cp = hi[c - 0x80];
        if (cp < 0x80) o += static_cast<char>(cp);
        else if (cp < 0x800) { o += static_cast<char>(0xC0 | (cp >> 6)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
        else { o += static_cast<char>(0xE0 | (cp >> 12)); o += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); o += static_cast<char>(0x80 | (cp & 0x3F)); }
    }
    return o;
}

inline std::string normalizeSubtitle(std::string s) {
    if (s.size() >= 3 && static_cast<unsigned char>(s[0]) == 0xEF && static_cast<unsigned char>(s[1]) == 0xBB && static_cast<unsigned char>(s[2]) == 0xBF) s.erase(0, 3);
    if (!validUtf8(s)) s = fromCp1252(s);
    return s;
}

// A few subtitles at a time, in memory.
inline std::mutex& cacheMu() { static std::mutex m; return m; }
inline std::map<std::string, std::string>& cacheMap() { static std::map<std::string, std::string> m; return m; }
inline std::deque<std::string>& cacheOrder() { static std::deque<std::string> d; return d; }
inline void cachePut(const std::string& id, const std::string& text) {
    std::lock_guard<std::mutex> lk(cacheMu());
    if (!cacheMap().count(id)) cacheOrder().push_back(id);
    cacheMap()[id] = text;
    while (cacheOrder().size() > 12) { cacheMap().erase(cacheOrder().front()); cacheOrder().pop_front(); }
}
inline bool cacheGet(const std::string& id, std::string& out) {
    std::lock_guard<std::mutex> lk(cacheMu());
    auto it = cacheMap().find(id);
    if (it == cacheMap().end()) return false;
    out = it->second;
    return true;
}

inline void registerSubtitleRoutes(httplib::Server& svr) {
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
    svr.Post("/api/subtitles/search", [](const httplib::Request& req, httplib::Response& res) {
        std::string title = req.get_param_value("title");
        if (title.empty() || title.size() > 200) { fail(res, 400, "No title to search for."); return; }
        std::string body = "{\"title\":\"" + jesc(title) + "\"";
        for (const char* k : {"year", "season", "episode"}) body += std::string(",\"") + k + "\":" + std::to_string(std::atoi(req.get_param_value(k).c_str()));
        body += ",\"lang\":\"" + jesc(req.get_param_value("lang").substr(0, 40)) + "\"";
        body += ",\"file\":\"" + jesc(req.get_param_value("file").substr(0, 300)) + "\"}";

        int status = 0; std::string answer, msg;
        if (!workerPost("/v1/subs/search", body, status, answer, msg)) { fail(res, 502, msg); return; }
        J j;
        if (!parseJson(answer, j)) { fail(res, 502, "The subtitle service sent an answer that could not be read."); return; }
        if (status != 200 || j.t != J::Obj || j.flag("ok") == false) {
            std::string e = j.str("error");
            fail(res, status >= 400 ? status : 502, e.empty() ? "The subtitle service answered HTTP " + std::to_string(status) + "." : e);
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content(answer, "application/json");     // already in the shape the page wants
    });

    svr.Post("/api/subtitles/fetch", [](const httplib::Request& req, httplib::Response& res) {
        std::string id = req.get_param_value("id");
        if (id.empty() || id.size() > 12 || !std::all_of(id.begin(), id.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) {
            fail(res, 400, "Bad subtitle id.");
            return;
        }
        std::string have;
        if (!cacheGet(id, have)) {                       // not on this device yet: ask the service (free if anyone fetched it before)
            int status = 0; std::string answer, msg;
            if (!workerPost("/v1/subs/get", "{\"id\":\"" + id + "\"}", status, answer, msg)) { fail(res, 502, msg); return; }
            J j;
            if (!parseJson(answer, j)) { fail(res, 502, "The subtitle service sent an answer that could not be read."); return; }
            std::string text = j.str("text");
            if (status != 200 || !j.flag("ok") || text.empty()) {
                std::string e = j.str("error");
                fail(res, status >= 400 ? status : 502, e.empty() ? "Couldn't get that subtitle." : e);
                return;
            }
            if (text.size() > 3 * 1024 * 1024) { fail(res, 502, "That subtitle file is too large."); return; }
            cachePut(id, normalizeSubtitle(text));
        }
        res.set_header("Cache-Control", "no-store");
        res.set_content("{\"ok\": true, \"url\": \"/api/subtitles/cache/" + id + ".srt\"}", "application/json");
    });

    svr.Get(R"(/api/subtitles/cache/(\d{1,12})\.srt)", [](const httplib::Request& req, httplib::Response& res) {
        std::string text;
        if (!cacheGet(req.matches[1].str(), text)) { res.status = 404; res.set_content("not found", "text/plain"); return; }
        res.set_header("Cache-Control", "no-store");
        res.set_content(text, "application/x-subrip; charset=utf-8");
    });
#else
    svr.Post("/api/subtitles/search", [](const httplib::Request&, httplib::Response& res) {
        res.status = 501;
        res.set_content("{\"ok\": false, \"error\": \"This build has no HTTPS support, so it can't look up subtitles.\"}", "application/json");
    });
#endif
}

}  // namespace peksubs
