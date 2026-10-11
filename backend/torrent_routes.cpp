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
#include <fstream>
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

std::string urlEnc(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string o;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += static_cast<char>(c);
        else { o += '%'; o += hex[c >> 4]; o += hex[c & 15]; }
    }
    return o;
}

std::string xmlUnescape(std::string s) {
    auto rep = [&](const std::string& a, const std::string& b) {
        size_t p = 0;
        while ((p = s.find(a, p)) != std::string::npos) { s.replace(p, a.size(), b); p += b.size(); }
    };
    rep("&lt;", "<"); rep("&gt;", ">"); rep("&quot;", "\""); rep("&apos;", "'"); rep("&amp;", "&");
    return s;
}

// First <tag>text</tag> inside block ("" when absent). Handles a CDATA wrapper.
std::string tagText(const std::string& block, const std::string& tag) {
    size_t a = block.find("<" + tag);
    while (a != std::string::npos) {
        size_t gt = block.find('>', a);
        if (gt == std::string::npos) return "";
        char next = block[a + tag.size() + 1];
        if (next == '>' || next == ' ' || next == '/' || next == '\t' || next == '\n' || next == '\r') {
            if (block[gt - 1] == '/') return "";
            size_t e = block.find("</" + tag + ">", gt);
            if (e == std::string::npos) return "";
            std::string t = block.substr(gt + 1, e - gt - 1);
            if (t.rfind("<![CDATA[", 0) == 0 && t.size() >= 12) t = t.substr(9, t.size() - 12);
            else t = xmlUnescape(t);
            return t;
        }
        a = block.find("<" + tag, a + 1);
    }
    return "";
}

// Value of an attribute inside one tag string like  <enclosure url="..." length="..."/>
std::string attrOf(const std::string& tagStr, const std::string& name) {
    size_t p = tagStr.find(" " + name + "=");
    if (p == std::string::npos) return "";
    p += name.size() + 2;
    if (p >= tagStr.size()) return "";
    char q = tagStr[p];
    if (q != '"' && q != '\'') return "";
    size_t e = tagStr.find(q, p + 1);
    if (e == std::string::npos) return "";
    return xmlUnescape(tagStr.substr(p + 1, e - p - 1));
}

// ---------------------------------------------------------------- provider settings

std::mutex g_cfgMx;
std::string g_dataDir = ".";
std::string g_provUrl, g_provKey;
bool g_cfgLoaded = false;

std::string cfgPath() { return g_dataDir + "/torrent.json"; }

std::string jsonStr(const std::string& body, const std::string& key) {
    size_t p = body.find("\"" + key + "\"");
    if (p == std::string::npos) return "";
    p = body.find('"', body.find(':', p));
    if (p == std::string::npos) return "";
    std::string o;
    for (size_t i = p + 1; i < body.size() && body[i] != '"'; i++) {
        if (body[i] == '\\' && i + 1 < body.size()) { i++; o += body[i]; }
        else o += body[i];
    }
    return o;
}

void loadCfg() {   // g_cfgMx held
    if (g_cfgLoaded) return;
    g_cfgLoaded = true;
    std::ifstream f(cfgPath());
    if (!f) return;
    std::stringstream ss; ss << f.rdbuf();
    g_provUrl = jsonStr(ss.str(), "url");
    g_provKey = jsonStr(ss.str(), "key");
}

void saveCfg() {   // g_cfgMx held
    std::ofstream f(cfgPath(), std::ios::trunc);
    f << "{\"url\": \"" << jesc(g_provUrl) << "\", \"key\": \"" << jesc(g_provKey) << "\"}\n";
}

// ---------------------------------------------------------------- search + ranking

struct Release {
    std::string title, link, magnet, hash;
    uint64_t size = 0;
    int seeders = 0, peers = 0;
    int quality = 0;       // 2160 / 1080 / 720 / 480 / 0 unknown
    int score = 0;
    bool pack = false;     // season pack
};

std::mutex g_linkMx;
std::set<std::string> g_knownLinks;      // http(s) links that came from a search result

int qualityOf(const std::string& t) {
    std::string s = lower(t);
    if (s.find("2160p") != std::string::npos || s.find("4k") != std::string::npos || s.find("uhd") != std::string::npos) return 2160;
    if (s.find("1080p") != std::string::npos) return 1080;
    if (s.find("720p") != std::string::npos) return 720;
    if (s.find("480p") != std::string::npos || s.find("dvdrip") != std::string::npos) return 480;
    return 0;
}

std::string normalize(const std::string& s) {
    std::string o;
    for (unsigned char c : s) o += std::isalnum(c) ? static_cast<char>(std::tolower(c)) : ' ';
    return o;
}

// Does the release name contain every word of the wanted title (in order, loosely)?
bool titleMatches(const std::string& release, const std::string& wanted) {
    std::string r = " " + normalize(release) + " ";
    std::istringstream ws(normalize(wanted));
    std::string w;
    size_t pos = 0;
    while (ws >> w) {
        size_t f = r.find(" " + w + " ", pos ? pos - 1 : 0);
        if (f == std::string::npos) return false;
        pos = f + w.size() + 1;
    }
    return true;
}

bool hasEpisodeTag(const std::string& name, int season, int episode, bool& isPack) {
    std::string n = lower(name);
    auto num = [](int v) { return std::to_string(v); };
    auto bounded = [&](const std::string& pat) {
        size_t p = 0;
        while ((p = n.find(pat, p)) != std::string::npos) {
            size_t e = p + pat.size();
            bool endOk = e >= n.size() || !std::isdigit(static_cast<unsigned char>(n[e]));
            bool startOk = p == 0 || !std::isdigit(static_cast<unsigned char>(n[p - 1]));
            if (endOk && startOk) return true;
            p++;
        }
        return false;
    };
    for (const char* pad : {"", "0"}) for (const char* pad2 : {"", "0"}) {
        std::string a = "s" + std::string(season < 10 ? pad : "") + num(season) + "e" + (episode < 10 ? pad2 : "") + num(episode);
        if (bounded(a)) { isPack = false; return true; }
        std::string b = std::string(pad) + num(season) + "x" + (episode < 10 ? pad2 : "") + num(episode);
        if (season >= 10 || *pad == 0) if (bounded(b)) { isPack = false; return true; }
    }
    // Season packs: "S02" with no episode marker, or "Season 2"
    for (const char* pad : {"", "0"}) {
        std::string s = "s" + std::string(season < 10 ? pad : "") + num(season);
        size_t p = n.find(s);
        while (p != std::string::npos) {
            size_t e = p + s.size();
            bool endOk = e >= n.size() || !std::isdigit(static_cast<unsigned char>(n[e]));
            bool noEp = !(e < n.size() && n[e] == 'e');
            bool startOk = p == 0 || !std::isalnum(static_cast<unsigned char>(n[p - 1]));
            if (endOk && noEp && startOk) { isPack = true; return true; }
            p = n.find(s, p + 1);
        }
    }
    if (n.find("season " + num(season)) != std::string::npos || n.find("season." + num(season)) != std::string::npos ||
        n.find("complete") != std::string::npos) { isPack = true; return false; }
    return false;
}

std::vector<Release> parseTorznab(const std::string& xml) {
    std::vector<Release> out;
    size_t p = 0;
    while ((p = xml.find("<item>", p)) != std::string::npos) {
        size_t e = xml.find("</item>", p);
        if (e == std::string::npos) break;
        std::string it = xml.substr(p, e - p);
        p = e + 7;
        Release r;
        r.title = tagText(it, "title");
        r.link = tagText(it, "link");
        std::string size = tagText(it, "size");
        if (!size.empty()) r.size = std::strtoull(size.c_str(), nullptr, 10);
        // <torznab:attr name="seeders" value="12"/> and friends
        size_t a = 0;
        while ((a = it.find("<torznab:attr", a)) != std::string::npos) {
            size_t g = it.find('>', a);
            if (g == std::string::npos) break;
            std::string tg = it.substr(a, g - a + 1);
            a = g + 1;
            std::string name = attrOf(tg, "name"), val = attrOf(tg, "value");
            if (name == "seeders") r.seeders = std::atoi(val.c_str());
            else if (name == "peers") r.peers = std::atoi(val.c_str());
            else if (name == "magneturl") r.magnet = val;
            else if (name == "infohash") r.hash = lower(val);
            else if (name == "size" && !r.size) r.size = std::strtoull(val.c_str(), nullptr, 10);
        }
        if (r.size == 0) {
            size_t en = it.find("<enclosure");
            if (en != std::string::npos) {
                size_t g = it.find('>', en);
                r.size = std::strtoull(attrOf(it.substr(en, g - en + 1), "length").c_str(), nullptr, 10);
            }
        }
        if (r.magnet.empty() && r.link.rfind("magnet:", 0) == 0) { r.magnet = r.link; r.link.clear(); }
        if (r.magnet.empty() && r.link.empty() && !r.hash.empty()) r.magnet = "magnet:?xt=urn:btih:" + r.hash + "&dn=" + urlEnc(r.title);
        if (!r.title.empty() && (!r.magnet.empty() || !r.link.empty())) out.push_back(r);
    }
    return out;
}

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
    if (!r) { err = "Could not reach the search provider (" + whyFailed(r) + ")"; return false; }
    code = r->status;
    if (r->body.size() > maxBytes) { err = "Response too large"; return false; }
    body = r->body;
    return true;
}


// ---------------------------------------------------------------- user search sites (www/search_sites.js)
// The web side posts the list of search pages the user pasted into www/search_sites.js.
// Only those exact https templates can be fetched, and only through /api/torrent/site.
std::mutex g_sitesMx;
std::vector<std::string> g_sites;

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

bool siteUrlOk(const std::string& u) {
    return u.size() <= 400 && u.find("{q}") != std::string::npos && publicHttpsUrl(u);
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

std::string humanSize(uint64_t b) {
    char buf[32];
    if (b >= (1ull << 30)) snprintf(buf, sizeof buf, "%.1f GB", b / double(1ull << 30));
    else snprintf(buf, sizeof buf, "%.0f MB", b / double(1ull << 20));
    return buf;
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
    std::lock_guard<std::mutex> lk(g_cfgMx);
    g_dataDir = dir.empty() ? "." : dir;
    g_cfgLoaded = false;
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

    // CORS-free GET for plugin search pages (the sandbox tries the browser first, then this).
    svr.Get("/api/torrent/fetch", [](const httplib::Request& req, httplib::Response& res) {
        std::string url = req.get_param_value("url");
        if (!publicHttpsUrl(url)) { jsonErr(res, 400, "Not an allowed address"); return; }
        // A site is being searched, so a stream is probably next: start the torrent session now (DHT needs a
        // few seconds to find peers) instead of when the stream starts. Once per run, off this request's thread.
        static std::once_flag warmOnce;
        std::call_once(warmOnce, []() { std::thread([]() { torrent::warmUp(); }).detach(); });
        std::string body, err; int code = 0;
        if (!siteGet(url, body, code, 1000000, err)) { jsonErr(res, 502, err); return; }
        if (code != 200) { jsonErr(res, 502, "The site answered HTTP " + std::to_string(code)); return; }
        res.set_content(body, "text/plain; charset=utf-8");
    });

    // The sites the user pasted into www/search_sites.js (one https template per line, with {q}).
    svr.Post("/api/torrent/sites", [](const httplib::Request& req, httplib::Response& res) {
        std::string all = req.get_param_value("sites");
        std::vector<std::string> keep;
        int rejected = 0;
        std::istringstream in(all);
        std::string line;
        while (std::getline(in, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
            if (line.empty()) continue;
            if (siteUrlOk(line) && keep.size() < 20) keep.push_back(line); else rejected++;
        }
        { std::lock_guard<std::mutex> lk(g_sitesMx); g_sites = keep; }
        res.set_content("{\"count\": " + std::to_string(keep.size()) + ", \"rejected\": " + std::to_string(rejected) + "}", "application/json");
    });

    // Fetch search site number i for the words q and hand back the raw page / JSON.
    svr.Get("/api/torrent/site", [](const httplib::Request& req, httplib::Response& res) {
        int i = std::atoi(req.get_param_value("i").c_str());
        std::string q = req.get_param_value("q");
        if (q.empty() || q.size() > 200) { jsonErr(res, 400, "Missing search words"); return; }
        std::string tmpl;
        { std::lock_guard<std::mutex> lk(g_sitesMx);
          if (i < 0 || i >= static_cast<int>(g_sites.size())) { jsonErr(res, 404, "Unknown search site"); return; }
          tmpl = g_sites[i]; }
        size_t at = tmpl.find("{q}");
        std::string full = tmpl.substr(0, at) + urlEnc(q) + tmpl.substr(at + 3);
        std::string body, err; int code = 0;
        if (!siteGet(full, body, code, 3 * 1024 * 1024, err)) { jsonErr(res, 502, err); return; }
        if (code != 200) { jsonErr(res, 502, "The site answered HTTP " + std::to_string(code)); return; }
        res.set_content(body, "text/plain; charset=utf-8");
    });
    svr.Get("/api/torrent/info", [](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lk(g_cfgMx);
        loadCfg();
        res.set_content(std::string("{\"available\": ") + (torrent::available() ? "true" : "false") +
                        ", \"configured\": " + (g_provUrl.empty() ? "false" : "true") + "}", "application/json");
    });

    svr.Get("/api/torrent/settings", [](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lk(g_cfgMx);
        loadCfg();
        res.set_content("{\"url\": \"" + jesc(g_provUrl) + "\", \"hasKey\": " + (g_provKey.empty() ? "false" : "true") + "}",
                        "application/json");
    });

    svr.Post("/api/torrent/settings", [](const httplib::Request& req, httplib::Response& res) {
        std::string url = req.get_param_value("url");
        std::string key = req.get_param_value("key");
        Parts p;
        if (!url.empty() && !splitUrl(url, p)) { jsonErr(res, 400, "The address must start with http:// or https://"); return; }
        if (url.size() > 500 || key.size() > 200) { jsonErr(res, 400, "Too long"); return; }
        std::lock_guard<std::mutex> lk(g_cfgMx);
        loadCfg();
        g_provUrl = url;
        if (!key.empty()) g_provKey = key;
        if (url.empty()) g_provKey.clear();
        saveCfg();
        res.set_content("{\"ok\": true}", "application/json");
    });

    // Ranked releases for a movie or an episode from the user's own Torznab provider
    // (Jackett, Prowlarr, ...). PEK ships with no provider.
    svr.Get("/api/torrent/search", [](const httplib::Request& req, httplib::Response& res) {
        std::string url, key;
        {
            std::lock_guard<std::mutex> lk(g_cfgMx);
            loadCfg();
            url = g_provUrl; key = g_provKey;
        }
        if (url.empty()) { jsonErr(res, 412, "No search provider is set up (Settings > Torrents)"); return; }

        std::string kind = req.get_param_value("kind");
        std::string title = req.get_param_value(kind == "episode" ? "show" : "title");
        int year = std::atoi(req.get_param_value("year").c_str());
        int season = std::atoi(req.get_param_value("season").c_str());
        int episode = std::atoi(req.get_param_value("episode").c_str());
        if (title.empty() || title.size() > 200) { jsonErr(res, 400, "Missing title"); return; }
        bool isEp = kind == "episode" && season > 0 && episode > 0;

        std::string q = title;
        if (isEp) {
            char tag[16]; snprintf(tag, sizeof tag, " S%02dE%02d", season, episode);
            q += tag;
        } else if (year > 0) q += " " + std::to_string(year);

        std::string full = url;
        full += (full.find('?') == std::string::npos ? "?" : "&");
        full += "t=search&q=" + urlEnc(q) + "&limit=100";
        if (!key.empty() && full.find("apikey=") == std::string::npos) full += "&apikey=" + urlEnc(key);

        std::string body, err; int code = 0;
        if (!httpGet(full, body, code, 6 * 1024 * 1024, err)) { jsonErr(res, 502, err); return; }
        if (code == 401 || code == 403) { jsonErr(res, 502, "The search provider refused the API key"); return; }
        if (code != 200) { jsonErr(res, 502, "The search provider answered HTTP " + std::to_string(code)); return; }
        if (body.find("<error") != std::string::npos && body.find("<item>") == std::string::npos) {
            jsonErr(res, 502, "The search provider reported an error: " + attrOf(body.substr(body.find("<error")), "description"));
            return;
        }

        std::vector<Release> all = parseTorznab(body), keep;
        for (Release& r : all) {
            if (!titleMatches(r.title, title)) continue;
            bool pack = false;
            if (isEp) {
                bool tagged = hasEpisodeTag(r.title, season, episode, pack);
                if (!tagged && !pack) continue;
                r.pack = pack;
            } else if (year > 0) {
                std::string n = " " + normalize(r.title) + " ";
                bool yearOk = false;
                for (int y = year; y <= year + 1; y++) if (n.find(" " + std::to_string(y) + " ") != std::string::npos) yearOk = true;
                if (!yearOk) continue;
            }
            if (r.seeders <= 0) continue;                       // nobody to download from
            r.quality = qualityOf(r.title);
            int q1 = r.quality == 1080 ? 40 : r.quality == 2160 ? 30 : r.quality == 720 ? 25 : r.quality == 480 ? 5 : 0;
            int seedScore = std::min(r.seeders, 200) / 4;       // diminishing returns
            r.score = q1 + seedScore - (r.pack ? 15 : 0);
            std::string lt = lower(r.title);
            if (lt.find("cam") != std::string::npos && (lt.find("camrip") != std::string::npos || lt.find(".cam.") != std::string::npos || lt.find(" cam ") != std::string::npos)) continue;
            if (lt.find("hdts") != std::string::npos || lt.find("telesync") != std::string::npos) continue;
            keep.push_back(r);
        }
        std::sort(keep.begin(), keep.end(), [](const Release& a, const Release& b) { return a.score > b.score; });
        if (keep.size() > 25) keep.resize(25);

        std::ostringstream o;
        o << "{\"results\": [";
        for (size_t i = 0; i < keep.size(); i++) {
            const Release& r = keep[i];
            std::string source = !r.magnet.empty() ? r.magnet : r.link;
            if (r.magnet.empty()) { std::lock_guard<std::mutex> lk(g_linkMx); g_knownLinks.insert(r.link); }
            if (i) o << ",";
            o << "{\"title\": \"" << jesc(r.title) << "\", \"source\": \"" << jesc(source) << "\", \"size\": " << r.size
              << ", \"sizeText\": \"" << humanSize(r.size) << "\", \"seeders\": " << r.seeders
              << ", \"quality\": " << r.quality << ", \"pack\": " << (r.pack ? "true" : "false") << "}";
        }
        o << "]}";
        res.set_content(o.str(), "application/json");
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
            // A .torrent link is only fetched if a search result handed it out (no arbitrary URLs).
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
