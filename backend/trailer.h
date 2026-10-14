// trailer.h - plays YouTube trailers without YouTube's embedded player.
//
//   GET /api/trailer?id=<11-char YouTube id>
//       -> {"ok":true,"video":"/api/trailer/stream?id=..&k=v","audio":"" | "/api/trailer/stream?id=..&k=a",
//           "hasAudio":true|false,"height":720}        (or {"ok":false,"error":".."})
//   GET /api/trailer/stream?id=..&k=v|a     a byte-range proxy of that stream, so the page can use a plain <video>.
//
// The look-up runs HERE, on the same connection as the video (a stream address only works for the IP that asked for it),
// and the page never talks to YouTube or googlevideo itself. www/plugin_sandbox.js falls back to the YouTube frame
// whenever this answers anything but ok:true, so nothing breaks if YouTube changes its answer. If it does, only the
// CLIENTS table below needs a new version number / user agent.
//
// Needs a build with CPPHTTPLIB_OPENSSL_SUPPORT (like the other routes that reach the internet). Register with
//   peektrailer::registerTrailerRoutes(svr);
#pragma once
#include "httplib.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace peektrailer {

// ---- a very small JSON reader (only what the player answer needs) ----
struct J {
    enum T { Null, Bool, Num, Str, Arr, Obj } t = Null;
    bool b = false; double n = 0; std::string s;
    std::vector<J> a; std::vector<std::pair<std::string, J>> o;
    const J* get(const std::string& k) const { for (auto& p : o) if (p.first == k) return &p.second; return nullptr; }
};
struct Parser {
    const std::string& x; size_t i = 0; int depth = 0;
    explicit Parser(const std::string& s) : x(s) {}
    void ws() { while (i < x.size() && (x[i] == ' ' || x[i] == '\n' || x[i] == '\r' || x[i] == '\t')) ++i; }
    bool str(std::string& out) {
        if (i >= x.size() || x[i] != '"') return false;
        ++i; out.clear();
        while (i < x.size() && x[i] != '"') {
            char c = x[i++];
            if (c == '\\' && i < x.size()) {
                char e = x[i++];
                switch (e) {
                    case 'n': out += '\n'; break; case 't': out += '\t'; break; case 'r': out += '\r'; break;
                    case 'b': out += '\b'; break; case 'f': out += '\f'; break;
                    case 'u': { if (i + 4 <= x.size()) { unsigned v = (unsigned)std::strtoul(x.substr(i, 4).c_str(), nullptr, 16); i += 4;
                                 if (v < 0x80) out += (char)v; else if (v < 0x800) { out += (char)(0xC0 | (v >> 6)); out += (char)(0x80 | (v & 63)); }
                                 else { out += (char)(0xE0 | (v >> 12)); out += (char)(0x80 | ((v >> 6) & 63)); out += (char)(0x80 | (v & 63)); } } break; }
                    default: out += e;
                }
            } else out += c;
        }
        if (i >= x.size()) return false;
        ++i; return true;
    }
    bool val(J& v) {
        if (++depth > 40) return false;
        struct G { int& d; ~G() { --d; } } g{depth};
        ws(); if (i >= x.size()) return false;
        char c = x[i];
        if (c == '{') {
            v.t = J::Obj; ++i; ws();
            if (i < x.size() && x[i] == '}') { ++i; return true; }
            while (true) {
                ws(); std::string k; if (!str(k)) return false; ws();
                if (i >= x.size() || x[i] != ':') return false;
                ++i;
                J c2; if (!val(c2)) return false; v.o.emplace_back(k, std::move(c2)); ws();
                if (i < x.size() && x[i] == ',') { ++i; continue; }
                if (i < x.size() && x[i] == '}') { ++i; return true; }
                return false;
            }
        }
        if (c == '[') {
            v.t = J::Arr; ++i; ws();
            if (i < x.size() && x[i] == ']') { ++i; return true; }
            while (true) {
                J c2; if (!val(c2)) return false; v.a.push_back(std::move(c2)); ws();
                if (i < x.size() && x[i] == ',') { ++i; continue; }
                if (i < x.size() && x[i] == ']') { ++i; return true; }
                return false;
            }
        }
        if (c == '"') { v.t = J::Str; return str(v.s); }
        if (x.compare(i, 4, "true") == 0) { v.t = J::Bool; v.b = true; i += 4; return true; }
        if (x.compare(i, 5, "false") == 0) { v.t = J::Bool; i += 5; return true; }
        if (x.compare(i, 4, "null") == 0) { i += 4; return true; }
        char* end = nullptr; v.n = std::strtod(x.c_str() + i, &end);
        if (end == x.c_str() + i) return false;
        v.t = J::Num; i = (size_t)(end - x.c_str()); return true;
    }
};

// ---- the clients YouTube answers without a login / proof-of-origin token (bump versions here if they stop working) ----
struct Client { const char* name; const char* version; const char* ua; const char* nameId; const char* extra; };
static const Client CLIENTS[] = {
    {"ANDROID_VR", "1.60.19", "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", "28",
     ",\"deviceMake\":\"Oculus\",\"deviceModel\":\"Quest 3\",\"osName\":\"Android\",\"osVersion\":\"12L\",\"androidSdkVersion\":32"},
    {"TVHTML5_SIMPLY_EMBEDDED_PLAYER", "2.0", "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15", "85", ""},
};

struct Pick { std::string video, audio, ua; double vTotal = 0, aTotal = 0; bool combined = false; int height = 0; std::chrono::steady_clock::time_point at; };
inline std::mutex& mx() { static std::mutex m; return m; }
inline std::map<std::string, Pick>& cache() { static std::map<std::string, Pick> c; return c; }

inline bool validId(const std::string& id) {
    if (id.size() != 11) return false;
    for (unsigned char c : id) if (!(std::isalnum(c) || c == '_' || c == '-')) return false;
    return true;
}

#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
inline void caBundle(httplib::SSLClient& c) {
    const char* f = std::getenv("SSL_CERT_FILE"); const char* d = std::getenv("SSL_CERT_DIR");
    bool hf = f && *f, hd = d && *d;
    if (hf || hd) c.set_ca_cert_path(hf ? f : "", hd ? d : "");
}

inline bool splitHttps(const std::string& url, std::string& host, std::string& path) {
    if (url.rfind("https://", 0) != 0) return false;
    size_t s = url.find('/', 8);
    host = url.substr(8, s == std::string::npos ? std::string::npos : s - 8);
    path = s == std::string::npos ? "/" : url.substr(s);
    if (host.empty() || host.find('@') != std::string::npos || host.find(':') != std::string::npos) return false;
    // only YouTube's own video servers
    auto ends = [&](const char* suf) { size_t n = std::strlen(suf); return host.size() > n && host.compare(host.size() - n, n, suf) == 0; };
    return ends(".googlevideo.com") || ends(".youtube.com");
}

inline bool queryPlayer(const std::string& id, const Client& cl, Pick& out) {
    httplib::SSLClient cli("www.youtube.com", 443);
    caBundle(cli);
    cli.set_connection_timeout(8); cli.set_read_timeout(15);
    std::string body = std::string("{\"videoId\":\"") + id + "\",\"contentCheckOk\":true,\"racyCheckOk\":true,\"context\":{\"client\":{\"clientName\":\"" +
        cl.name + "\",\"clientVersion\":\"" + cl.version + "\",\"hl\":\"en\",\"gl\":\"US\"" + cl.extra + "}";
    if (std::string(cl.name).rfind("TVHTML5", 0) == 0) body += ",\"thirdParty\":{\"embedUrl\":\"https://www.youtube.com/watch?v=" + id + "\"}";
    body += "}}";
    httplib::Headers h = {{"User-Agent", cl.ua}, {"X-YouTube-Client-Name", cl.nameId}, {"X-YouTube-Client-Version", cl.version},
                          {"Origin", "https://www.youtube.com"}, {"Accept-Language", "en-US,en;q=0.9"}};
    auto r = cli.Post("/youtubei/v1/player?prettyPrint=false", h, body, "application/json");
    if (!r || r->status != 200) return false;
    J root; Parser p(r->body);
    if (!p.val(root) || root.t != J::Obj) return false;
    const J* ps = root.get("playabilityStatus"); const J* st = ps ? ps->get("status") : nullptr;
    if (!st || st->s != "OK") return false;
    const J* sd = root.get("streamingData"); if (!sd) return false;

    auto num = [](const J* v) { if (!v) return 0.0; if (v->t == J::Num) return v->n; if (v->t == J::Str) return std::atof(v->s.c_str()); return 0.0; };
    auto text = [](const J* v) { return (v && v->t == J::Str) ? v->s : std::string(); };
    int bestC = 0; std::string cUrl; double cTot = 0;               // video+audio in one file
    int bestV = 0; std::string vUrl; double vTot = 0;               // picture only
    double bestA = 0; std::string aUrl; double aTot = 0;            // sound only
    auto scan = [&](const J* arr, bool adaptive) {
        if (!arr || arr->t != J::Arr) return;
        for (const J& f : arr->a) {
            std::string url = text(f.get("url")), mime = text(f.get("mimeType"));
            if (url.empty() || (mime.rfind("video/mp4", 0) != 0 && mime.rfind("audio/mp4", 0) != 0)) continue;   // direct MP4 / M4A only
            int hgt = (int)num(f.get("height")); double len = num(f.get("contentLength"));
            if (mime.rfind("audio/", 0) == 0) { double br = num(f.get("bitrate")); if (br > bestA) { bestA = br; aUrl = url; aTot = len; } continue; }
            if (hgt > 1080) continue;
            if (!adaptive && f.get("audioQuality")) { if (hgt > bestC && hgt <= 720) { bestC = hgt; cUrl = url; cTot = len; } }
            else if (adaptive && mime.find("avc1") != std::string::npos) { if (hgt > bestV) { bestV = hgt; vUrl = url; vTot = len; } }
        }
    };
    scan(sd->get("formats"), false); scan(sd->get("adaptiveFormats"), true);
    out.ua = cl.ua;
    if (!vUrl.empty() && bestV >= 720 && !aUrl.empty() && bestV > bestC) {          // sharper: picture + sound as two streams
        out.video = vUrl; out.vTotal = vTot; out.audio = aUrl; out.aTotal = aTot; out.height = bestV; out.combined = false; return true;
    }
    if (!cUrl.empty()) { out.video = cUrl; out.vTotal = cTot; out.height = bestC; out.combined = true; return true; }
    if (!vUrl.empty()) { out.video = vUrl; out.vTotal = vTot; out.audio = aUrl; out.aTotal = aTot; out.height = bestV; out.combined = false; return true; }
    return false;
}

inline bool resolve(const std::string& id, Pick& out) {
    {
        std::lock_guard<std::mutex> lk(mx());
        auto it = cache().find(id);
        if (it != cache().end() && std::chrono::steady_clock::now() - it->second.at < std::chrono::minutes(40)) { out = it->second; return true; }
    }
    for (const Client& cl : CLIENTS) {
        Pick p;
        try { if (!queryPlayer(id, cl, p)) continue; } catch (...) { continue; }
        p.at = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lk(mx());
        if (cache().size() > 80) cache().clear();
        cache()[id] = p; out = p; return true;
    }
    return false;
}
#endif

inline void registerTrailerRoutes(httplib::Server& svr) {
    svr.Get("/api/trailer", [](const httplib::Request& req, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        const std::string id = req.get_param_value("id");
        if (!validId(id)) { res.status = 400; res.set_content("{\"ok\":false,\"error\":\"bad id\"}", "application/json"); return; }
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
        Pick p;
        if (!resolve(id, p)) { res.status = 502; res.set_content("{\"ok\":false,\"error\":\"no direct stream\"}", "application/json"); return; }
        std::string base = "/api/trailer/stream?id=" + id + "&k=";
        res.set_content("{\"ok\":true,\"video\":\"" + base + "v\",\"audio\":\"" + (p.audio.empty() || p.combined ? "" : base + "a") +
                        "\",\"hasAudio\":" + (p.combined ? "true" : "false") + ",\"height\":" + std::to_string(p.height) + "}", "application/json");
#else
        res.status = 501; res.set_content("{\"ok\":false,\"error\":\"no https in this build\"}", "application/json");
#endif
    });

    svr.Get("/api/trailer/stream", [](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.get_param_value("id"), k = req.get_param_value("k");
        if (!validId(id) || (k != "v" && k != "a")) { res.status = 400; return; }
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
        Pick p;
        if (!resolve(id, p)) { res.status = 502; return; }
        const std::string url = k == "v" ? p.video : p.audio; double total = k == "v" ? p.vTotal : p.aTotal;
        std::string host, path;
        if (url.empty() || !splitHttps(url, host, path)) { res.status = 502; return; }
        // The player asks for "bytes=a-" or "bytes=a-b": answer with at most 2 MB at a time, it asks again for the rest.
        long long a = 0, b = -1; const std::string rg = req.get_header_value("Range");
        if (rg.rfind("bytes=", 0) == 0) { a = std::atoll(rg.c_str() + 6); size_t d = rg.find('-'); if (d != std::string::npos && d + 1 < rg.size()) b = std::atoll(rg.c_str() + d + 1); }
        const long long CH = 2 * 1024 * 1024;
        if (b < 0 || b - a + 1 > CH) b = a + CH - 1;
        if (total > 0 && b >= (long long)total) b = (long long)total - 1;
        httplib::SSLClient cli(host, 443); caBundle(cli);
        cli.set_connection_timeout(8); cli.set_read_timeout(20); cli.set_follow_location(true);
        httplib::Headers h = {{"User-Agent", p.ua}, {"Range", "bytes=" + std::to_string(a) + "-" + std::to_string(b)}};
        auto r = cli.Get(path, h);
        if (!r || (r->status != 200 && r->status != 206)) { std::lock_guard<std::mutex> lk(mx()); cache().erase(id); res.status = 502; return; }
        long long got = (long long)r->body.size();
        if (r->status == 200) {                                            // the server ignored the range: cut it ourselves
            if (a >= got) { res.status = 416; return; }
            total = (double)got; long long e = std::min<long long>(b, got - 1);
            res.set_content(r->body.substr((size_t)a, (size_t)(e - a + 1)), k == "v" ? "video/mp4" : "audio/mp4"); b = e;
        } else {
            std::string cr = r->get_header_value("Content-Range"); size_t sl = cr.find('/');
            if (sl != std::string::npos) total = (double)std::atoll(cr.c_str() + sl + 1);
            b = a + got - 1;
            res.set_content(r->body, k == "v" ? "video/mp4" : "audio/mp4");
        }
        res.status = 206;
        res.set_header("Accept-Ranges", "bytes");
        res.set_header("Content-Range", "bytes " + std::to_string(a) + "-" + std::to_string(b) + "/" + std::to_string((long long)total));
        res.set_header("Cache-Control", "no-store");
#else
        res.status = 501;
#endif
    });
}

}  // namespace peektrailer
