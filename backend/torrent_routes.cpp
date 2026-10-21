#include "torrent_routes.h"

#include <thread>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>
#include "torrent.h"
#include "range_stream.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <mutex>
#include <set>
#include <sstream>

namespace {

// ---------------------------------------------------------------- small helpers

std::string jesc(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += static_cast<char>(c);
        }
    }
    return o;
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

void jsonErr(httplib::Response& res, int status, const std::string& msg) {
    res.status = status;
    res.set_content("{\"error\": \"" + jesc(msg) + "\"}", "application/json");
}

// ---------------------------------------------------------------- state

std::string g_dataDir = ".";

// .torrent links a plugin vouched for (POST /api/torrent/allow). Only these may be downloaded by /start.
std::mutex g_linkMx;
std::set<std::string> g_knownLinks;

struct Parts { std::string scheme, host, path; int port = 0; };

bool splitUrl(const std::string& url, Parts& o) {
    size_t s = url.find("://");
    if (s == std::string::npos) return false;
    o.scheme = lower(url.substr(0, s));
    if (o.scheme != "http" && o.scheme != "https") return false;
    size_t hs = s + 3, pe = url.find('/', hs);
    std::string hostport = url.substr(hs, pe == std::string::npos ? std::string::npos : pe - hs);
    o.path = pe == std::string::npos ? "/" : url.substr(pe);
    size_t colon = hostport.rfind(':');
    if (colon != std::string::npos && hostport.find(']') == std::string::npos) {
        o.host = hostport.substr(0, colon);
        o.port = std::atoi(hostport.substr(colon + 1).c_str());
    } else {
        o.host = hostport;
        o.port = o.scheme == "https" ? 443 : 80;
    }
    return !o.host.empty() && o.port > 0;
}

// Android has no CA store OpenSSL can find on its own: use the bundle shipped inside the app
// (SSL_CERT_FILE) and the system store (SSL_CERT_DIR) the way the TMDb proxy client does.
// No-op where those variables are not set (desktop builds keep OpenSSL's defaults).
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
void applyCaBundle(httplib::SSLClient& c) {
    const char* f = std::getenv("SSL_CERT_FILE");
    const char* d = std::getenv("SSL_CERT_DIR");
    bool hasF = f && *f, hasD = d && *d;
    if (hasF || hasD) c.set_ca_cert_path(hasF ? f : "", hasD ? d : "");
}
#endif

// A short reason for a failed request ("SSL server verification failed", "Connection"...), so the
// plugin can show something more useful than a bare 502.
std::string whyFailed(const httplib::Result& r) {
    return httplib::to_string(r.error());
}

// GET url (+ extra query) and return the body. status code written to `code`.
bool httpGet(const std::string& url, std::string& body, int& code, size_t maxBytes, std::string& err) {
    Parts u;
    if (!splitUrl(url, u)) { err = "Bad address"; return false; }
    httplib::Result r(nullptr, httplib::Error::Unknown);
    auto run = [&](auto& cli) {
        cli.set_connection_timeout(8);
        cli.set_read_timeout(20);
        cli.set_follow_location(true);
        r = cli.Get(u.path);
    };
    if (u.scheme == "https") {
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
        httplib::SSLClient cli(u.host, u.port);
        applyCaBundle(cli);
        run(cli);
#else
        err = "This build has no HTTPS support"; return false;
#endif
    } else {
        httplib::Client cli(u.host, u.port);
        run(cli);
    }
    if (!r) { err = "Could not download the .torrent file (" + whyFailed(r) + ")"; return false; }
    code = r->status;
    if (r->body.size() > maxBytes) { err = "Response too large"; return false; }
    body = r->body;
    return true;
}


// ---------------------------------------------------------------- web helpers

// https + a real host name (no bare IPs, localhost or LAN-style names).
bool publicHttpsUrl(const std::string& u) {
    if (u.size() > 2000 || u.rfind("https://", 0) != 0) return false;
    Parts p;
    if (!splitUrl(u, p)) return false;
    std::string h = lower(p.host);
    if (h.empty() || h == "localhost") return false;
    bool numeric = true;
    for (unsigned char c : h) if (!(std::isdigit(c) || c == '.' || c == ':' || c == '[' || c == ']')) numeric = false;
    if (numeric) return false;
    auto endsWith = [&](const char* suf) { size_t n = std::strlen(suf); return h.size() > n && h.compare(h.size() - n, n, suf) == 0; };
    if (endsWith(".local") || endsWith(".lan") || endsWith(".internal") || endsWith(".home")) return false;
    return h.find('.') != std::string::npos;
}

// Same as httpGet, but sends browser-like headers (many sites refuse bare clients).
bool siteGet(const std::string& url, std::string& body, int& code, size_t maxBytes, std::string& err) {
    Parts u;
    if (!splitUrl(url, u)) { err = "Bad address"; return false; }
    httplib::Headers hdrs = {
        {"User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"},
        {"Accept", "text/html,application/json;q=0.9,*/*;q=0.8"},
        {"Accept-Language", "en-US,en;q=0.9"}};
    httplib::Result r(nullptr, httplib::Error::Unknown);
    auto run = [&](auto& cli) {
        cli.set_connection_timeout(8);
        cli.set_read_timeout(15);
        cli.set_follow_location(true);
        r = cli.Get(u.path, hdrs);
    };
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
    httplib::SSLClient cli(u.host, u.port);
    applyCaBundle(cli);
    run(cli);
#else
    err = "This build has no HTTPS support"; return false;
#endif
    if (!r) { err = "Could not reach the site (" + whyFailed(r) + ")"; return false; }
    code = r->status;
    if (r->body.size() > maxBytes) { err = "Response too large"; return false; }
    body = r->body;
    return true;
}

// ---------------------------------------------------------------- stream plumbing

bool validHash(const std::string& h) {
    if (h.size() < 40 || h.size() > 64) return false;
    return std::all_of(h.begin(), h.end(), [](unsigned char c) { return std::isxdigit(c); });
}

bool clientGone(void* ctx) { return !static_cast<httplib::DataSink*>(ctx)->is_writable(); }

std::string mimeFor(const std::string& name) {
    std::string n = lower(name);
    auto ends = [&](const char* e) { size_t l = std::strlen(e); return n.size() >= l && n.compare(n.size() - l, l, e) == 0; };
    if (ends(".mkv")) return "video/x-matroska";
    if (ends(".mp4") || ends(".m4v")) return "video/mp4";
    if (ends(".mov")) return "video/quicktime";
    if (ends(".webm")) return "video/webm";
    if (ends(".avi")) return "video/x-msvideo";
    if (ends(".ts")) return "video/mp2t";
    return "application/octet-stream";
}

std::string statusJson(const std::string& hash, const torrent::Status& s) {
    std::ostringstream o;
    o << "{\"hash\": \"" << hash << "\", \"state\": \"" << s.state << "\", \"ready\": " << (s.ready ? "true" : "false")
      << ", \"name\": \"" << jesc(s.name) << "\", \"file\": \"" << jesc(s.file_name) << "\""
      << ", \"error\": \"" << jesc(s.error) << "\", \"peers\": " << s.peers << ", \"seeds\": " << s.seeds
      << ", \"downKBps\": " << s.down_kbps << ", \"upKBps\": " << s.up_kbps
      << ", \"fileProgress\": " << s.file_progress << ", \"bufferProgress\": " << s.buffer_progress
      << ", \"fileSize\": " << s.file_size;
    if (!s.have_map.empty()) {
        o << ", \"have\": [";
        for (size_t i = 0; i < s.have_map.size(); ++i) o << (i ? "," : "") << static_cast<int>(s.have_map[i]);
        o << "]";
    }
    o << "}";
    return o.str();
}

}  // namespace

void setTorrentDataDir(const std::string& dir) {
    g_dataDir = dir.empty() ? "." : dir;
    torrent::setDataDir(g_dataDir);
}

void registerTorrentRoutes(httplib::Server& svr) {


    // Plugin support (called by plugin_sandbox.js, never by plugin code itself):
    // a plugin that listed a release host in plugin.json may play a .torrent link from that host.
    // The sandbox checks the manifest; this only accepts https links with a real host name.
    svr.Post("/api/torrent/allow", [](const httplib::Request& req, httplib::Response& res) {
        std::string url = req.get_param_value("url");
        if (!publicHttpsUrl(url)) { jsonErr(res, 400, "Not an allowed release link"); return; }
        { std::lock_guard<std::mutex> lk(g_linkMx);
          if (g_knownLinks.size() > 5000) g_knownLinks.clear();
          g_knownLinks.insert(url); }
        res.set_content("{\"ok\": true}", "application/json");
    });

    // CORS-free GET of a public https page for a plugin that has the torrent permission (the sandbox tries the
    // browser first, then this, and only for hosts the plugin listed under "network" in plugin.json).
    svr.Get("/api/torrent/fetch", [](const httplib::Request& req, httplib::Response& res) {
        std::string url = req.get_param_value("url");
        if (!publicHttpsUrl(url)) { jsonErr(res, 400, "Not an allowed address"); return; }
        // A plugin is looking something up, so a stream is probably next: start the torrent session now (DHT needs a
        // few seconds to find peers) instead of when the stream starts. Once per run, off this request's thread.
        static std::once_flag warmOnce;
        std::call_once(warmOnce, []() { std::thread([]() { torrent::warmUp(); }).detach(); });
        std::string body, err; int code = 0;
        if (!siteGet(url, body, code, 1000000, err)) { jsonErr(res, 502, err); return; }
        if (code != 200) { jsonErr(res, 502, "The site answered HTTP " + std::to_string(code)); return; }
        res.set_content(body, "text/plain; charset=utf-8");
    });

    svr.Get("/api/torrent/info", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(std::string("{\"available\": ") + (torrent::available() ? "true" : "false") + "}", "application/json");
    });

    svr.Post("/api/torrent/start", [](const httplib::Request& req, httplib::Response& res) {
        if (!torrent::available()) { jsonErr(res, 501, "Torrent playback is not built into this PEK TV"); return; }
        std::string source = req.get_param_value("source");
        int season = std::atoi(req.get_param_value("season").c_str());
        int episode = std::atoi(req.get_param_value("episode").c_str());
        if (source.empty() || source.size() > 4000) { jsonErr(res, 400, "Missing source"); return; }

        std::string err, hash;
        if (source.rfind("magnet:?", 0) == 0) {
            hash = torrent::add(source, season, episode, err);
        } else {
            // A .torrent link is only fetched if a plugin vouched for it via /api/torrent/allow (no arbitrary URLs).
            { std::lock_guard<std::mutex> lk(g_linkMx); if (!g_knownLinks.count(source)) { jsonErr(res, 400, "Unknown release"); return; } }
            std::string body; int code = 0;
            if (!httpGet(source, body, code, 8 * 1024 * 1024, err) || code != 200) {
                jsonErr(res, 502, err.empty() ? "Could not download the .torrent file" : err); return;
            }
            if (body.rfind("magnet:?", 0) == 0) hash = torrent::add(body, season, episode, err);
            else hash = torrent::addFile(body, season, episode, err);
        }
        if (hash.empty()) { jsonErr(res, 502, err.empty() ? "Could not start the torrent" : err); return; }
        res.set_content("{\"hash\": \"" + hash + "\"}", "application/json");
    });

    svr.Get("/api/torrent/diag", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(torrent::diagnostics(), "text/plain; charset=utf-8");
    });

    svr.Get(R"(/api/torrent/([0-9A-Fa-f]+)/status)", [](const httplib::Request& req, httplib::Response& res) {
        std::string hash = lower(req.matches[1].str());
        torrent::Status s;
        if (!validHash(hash) || !torrent::status(hash, s, req.has_param("map"))) { jsonErr(res, 404, "Unknown torrent"); return; }
        res.set_content(statusJson(hash, s), "application/json");
    });

    svr.Post(R"(/api/torrent/([0-9A-Fa-f]+)/stop)", [](const httplib::Request& req, httplib::Response& res) {
        std::string hash = lower(req.matches[1].str());
        if (validHash(hash)) torrent::remove(hash);
        res.set_content("{\"ok\": true}", "application/json");
    });

    svr.Get(R"(/api/torrent/([0-9A-Fa-f]+)/stream)", [](const httplib::Request& req, httplib::Response& res) {
        std::string hash = lower(req.matches[1].str());
        torrent::Status s;
        if (!validHash(hash) || !torrent::status(hash, s)) { jsonErr(res, 404, "Unknown torrent"); return; }
        if (s.state == "error") { jsonErr(res, 502, s.error); return; }
        if (s.state == "metadata" || s.file_index < 0) { jsonErr(res, 409, "Still fetching the file list"); return; }

        // 32-bit builds: a file this big cannot be described by httplib's own (32-bit) range code, so the
        // stream is served with 64-bit ranges instead (see range_stream.h).
        if (rangestream::needsOwnRanges(s.file_size)) {
            rangestream::serve(req, res, s.file_size, mimeFor(s.file_name),
                [hash](uint64_t off, char* buf, size_t len, httplib::DataSink& sink) -> int64_t {
                    return torrent::read(hash, off, buf, len, clientGone, &sink);
                });
            return;
        }

        res.set_header("Accept-Ranges", "bytes");
        res.set_content_provider(
            static_cast<size_t>(s.file_size), mimeFor(s.file_name),
            [hash](size_t offset, size_t length, httplib::DataSink& sink) {
                std::vector<char> buf(std::min<size_t>(length, 256 * 1024));
                int64_t n = torrent::read(hash, offset, buf.data(), buf.size(), clientGone, &sink);
                if (n <= 0) return false;
                return sink.write(buf.data(), static_cast<size_t>(n));
            });
    });
}
