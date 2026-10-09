#include "server.h"
#include "playback.h"
#include "torrent_routes.h"
#include "discovery.h"
#include "vfs.h"
#include "httplib.h"
#include "plugin_install.h"
#include "skin_install.h"
#include <iostream>
#include <fstream>
#include <functional>
#include <vector>
#include <filesystem>
#include <cstdlib>
#include <thread>
#include <map>
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <atomic>
#include <chrono>
#include <random>
#include <mutex>

namespace fs = std::filesystem;

namespace {

// ---- Network exposure ------------------------------------------------------
// By default the server only answers this device (127.0.0.1). Other devices on the
// network can use it only if HESPER_BIND is set to an address such as 0.0.0.0, and
// then every request from another machine must carry a secret token
// (HESPER_TOKEN, or one generated and printed at startup).

bool isLoopbackAddr(const std::string& a) {
    return a == "127.0.0.1" || a == "::1" || a == "::ffff:127.0.0.1" || a.rfind("127.", 0) == 0;
}

// "127.0.0.1:8080" / "localhost" / "[::1]:8080" -> is the host part this device?
bool isLoopbackHostHeader(std::string h) {
    if (!h.empty() && h[0] == '[') {                       // [::1]:8080
        size_t end = h.find(']');
        if (end == std::string::npos) return false;
        h = h.substr(1, end - 1);
    } else {
        size_t colon = h.find(':');
        if (colon != std::string::npos) h = h.substr(0, colon);
    }
    for (auto& c : h) c = (char)std::tolower((unsigned char)c);
    return h == "localhost" || h == "::1" || h.rfind("127.", 0) == 0;
}

// Host part of an Origin header ("http://evil.example:80" -> "evil.example:80").
std::string originAuthority(const std::string& origin) {
    size_t scheme = origin.find("://");
    return scheme == std::string::npos ? origin : origin.substr(scheme + 3);
}

bool constantTimeEquals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i) diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0;
}

std::string cookieValue(const std::string& cookieHeader, const std::string& name) {
    size_t pos = 0;
    while (pos < cookieHeader.size()) {
        size_t end = cookieHeader.find(';', pos);
        if (end == std::string::npos) end = cookieHeader.size();
        std::string part = cookieHeader.substr(pos, end - pos);
        size_t b = part.find_first_not_of(' ');
        if (b != std::string::npos) part = part.substr(b);
        if (part.compare(0, name.size() + 1, name + "=") == 0) return part.substr(name.size() + 1);
        pos = end + 1;
    }
    return "";
}

std::string makeRandomToken() {
    std::random_device rd;
    static const char* hex = "0123456789abcdef";
    std::string t;
    for (int i = 0; i < 24; ++i) { unsigned v = rd() & 0xff; t += hex[v >> 4]; t += hex[v & 15]; }
    return t;
}


// Minimal JSON string escaping — titles/filenames can contain
// quotes or backslashes, and the rest of this file builds JSON via
// plain concatenation, so every dynamic string needs this before
// being interpolated.
// Host part of a network source: a name or IPv4/IPv6 literal, nothing that could
// smuggle in a path, a scheme or a shell character.
bool validNetHost(const std::string& h) {
    if (h.empty() || h.size() > 253) return false;
    for (unsigned char c : h) {
        if (!(std::isalnum(c) || c == '.' || c == '-' || c == '_' || c == ':')) return false;
    }
    return true;
}

std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

void appendUtf8(std::string& out, unsigned int cp) {
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
}

bool parseHex4(const std::string& s, size_t pos, unsigned int& out) {
    if (pos + 4 > s.size()) return false;
    out = 0;
    for (size_t i = pos; i < pos + 4; ++i) {
        char c = s[i];
        out <<= 4;
        if (c >= '0' && c <= '9') out |= static_cast<unsigned>(c - '0');
        else if (c >= 'a' && c <= 'f') out |= static_cast<unsigned>(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') out |= static_cast<unsigned>(c - 'A' + 10);
        else return false;
    }
    return true;
}

// Reads the first "key": "value" string, decoding JSON escapes
// (including \uXXXX, which TMDb uses for non-ASCII titles like "Pokémon").
std::string extractJsonString(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos);
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos);
    if (pos == std::string::npos) return "";
    size_t end = pos + 1;
    std::string out;
    while (end < json.size() && json[end] != '"') {
        if (json[end] == '\\' && end + 1 < json.size()) {
            char n = json[end + 1];
            if (n == 'u') {
                unsigned int cp = 0;
                if (parseHex4(json, end + 2, cp)) {
                    end += 6;
                    // Surrogate pair -> one code point.
                    if (cp >= 0xD800 && cp <= 0xDBFF && end + 1 < json.size() && json[end] == '\\' && json[end + 1] == 'u') {
                        unsigned int lo = 0;
                        if (parseHex4(json, end + 2, lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            end += 6;
                        }
                    }
                    appendUtf8(out, cp);
                    continue;
                }
            }
            out += (n == 'n' || n == 't' || n == 'r') ? ' ' : n;
            end += 2;
        } else {
            out += json[end];
            end += 1;
        }
    }
    return out;
}

// Lowercase letters/digits only, for comparing "The Office" to "the.office".
std::string normalizeName(const std::string& s) {
    std::string out;
    for (unsigned char c : s) if (std::isalnum(c)) out += static_cast<char>(std::tolower(c));
    return out;
}

// First "key": 123 number as text ("" if absent). Used for TMDb ids.
std::string extractJsonNumber(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos);
    if (pos == std::string::npos) return "";
    ++pos;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\n' || json[pos] == '\t')) ++pos;
    size_t end = pos;
    while (end < json.size() && std::isdigit((unsigned char)json[end])) ++end;
    return json.substr(pos, end - pos);
}

// ---- Intro / recap timestamps from a community database (IntroDB) ----------
// The page asks us (not the database) so the request leaves from the backend, and the
// answers are cached: one lookup per episode, one show -> IMDb id lookup per show.
constexpr const char* kIntroDbHost = "https://api.introdb.app";
constexpr long long kSkipHitTtlMs  = 7LL * 24 * 3600 * 1000;   // found: keep a week
constexpr long long kSkipMissTtlMs = 6LL * 3600 * 1000;        // not found / offline: retry in 6 h

struct SkipCacheEntry { std::string body; long long at = 0; bool found = false; };
std::mutex g_skip_mu;
std::map<std::string, SkipCacheEntry> g_skip_cache;       // "imdb|s|e" -> raw answer
std::map<std::string, std::string> g_imdb_by_show;       // normalized show name -> imdb id

// Rescan throttle: at most one manual rescan per 10 seconds, and
// never two at once. Enforced here so it can't be bypassed from the browser.
std::atomic<bool> g_rescan_running{false};
std::atomic<long long> g_last_rescan_ms{0};
constexpr long long kRescanCooldownMs = 10000;

long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// TMDb lookups go through our Cloudflare Worker, which holds the API key.
// Override with the TMDB_PROXY_URL env var if needed.
static std::string tmdbProxyUrl() {
    const char* env = std::getenv("TMDB_PROXY_URL");
    if (env && *env) return env;
    return "https://hesper-tmdb.aquariusibeats.workers.dev";
}

} // namespace

// Android: use the CA bundle shipped inside the app (SSL_CERT_FILE) for
// HTTPS to the TMDb proxy. No-op everywhere else.
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
static void applyTls(httplib::Client& c) {
    const char* f = std::getenv("SSL_CERT_FILE");
    if (f && *f) c.set_ca_cert_path(f, "");
}
#else
static void applyTls(httplib::Client&) {}
#endif

std::string HesperServer::resolveShowName(const std::string& guess) {
    if (guess.empty()) return "";

    httplib::Client client(tmdbProxyUrl());

    applyTls(client);
    client.set_connection_timeout(5);
    client.set_read_timeout(5);

    std::string query = "/search/tv?query=" + httplib::encode_uri(guess);
    auto res = client.Get(query.c_str());
    if (!res || res->status != 200) return "";

    size_t results_pos = res->body.find("\"results\"");
    std::string first_result = results_pos != std::string::npos ? res->body.substr(results_pos) : res->body;
    std::string name = extractJsonString(first_result, "name");
    if (name.empty()) return "";

    // Only trust a close match: "friends" -> "Friends" is fine, but an
    // unrelated top hit must not rename the show.
    std::string a = normalizeName(guess), b = normalizeName(name);
    if (a.empty() || b.empty()) return "";
    if (a.find(b) == std::string::npos && b.find(a) == std::string::npos) return "";
    return name;
}

void HesperServer::start(int port, const std::string& www_dir, const std::string& plugins_dir,
                           const std::string& skins_dir,
                           std::function<std::vector<std::string>()> get_plugins,
                           MediaScanner* scanner) {
    httplib::Server svr;

    // ---- Who may talk to this server -------------------------------------
    const char* bindEnv = std::getenv("HESPER_BIND");
    const std::string bindAddr = (bindEnv && *bindEnv) ? bindEnv : "127.0.0.1";
    const bool remoteOpen = !isLoopbackAddr(bindAddr);
    std::string token;
    if (remoteOpen) {
        const char* t = std::getenv("HESPER_TOKEN");
        token = (t && *t) ? t : makeRandomToken();
        std::cout << "[Hesper Server] REMOTE ACCESS IS ON (" << bindAddr << "). Other devices must open "
                  << "http://<this-device-ip>:" << port << "/?token=" << token << std::endl;
    }

    // Browser-based attacks on a local server: a web page you visit can ask your own
    // device to do things (CSRF) or point a hostile name at 127.0.0.1 (DNS rebinding).
    // So: when bound locally, only accept loopback Host headers; and never accept a
    // state-changing request whose Origin is a different site.
    svr.set_pre_routing_handler([remoteOpen, token](const httplib::Request& req, httplib::Response& res) {
        const bool fromLoopback = isLoopbackAddr(req.remote_addr);

        if (!remoteOpen && !isLoopbackHostHeader(req.get_header_value("Host"))) {
            res.status = 403;
            res.set_content("{\"error\": \"Forbidden host\"}", "application/json");
            return httplib::Server::HandlerResponse::Handled;
        }

        if (req.method != "GET" && req.method != "HEAD" && req.method != "OPTIONS") {
            const std::string origin = req.get_header_value("Origin");
            if (!origin.empty() && originAuthority(origin) != req.get_header_value("Host")) {
                res.status = 403;
                res.set_content("{\"error\": \"Cross-site request blocked\"}", "application/json");
                return httplib::Server::HandlerResponse::Handled;
            }
        }

        if (remoteOpen && !fromLoopback) {
            const std::string viaHeader = req.get_header_value("X-Hesper-Token");
            const std::string viaCookie = cookieValue(req.get_header_value("Cookie"), "hesper_token");
            if (constantTimeEquals(viaHeader, token) || constantTimeEquals(viaCookie, token))
                return httplib::Server::HandlerResponse::Unhandled;

            // First visit with ?token=...: remember it in a cookie, then drop it from the URL.
            if (req.has_param("token") && constantTimeEquals(req.get_param_value("token"), token)) {
                res.set_header("Set-Cookie", "hesper_token=" + token + "; Path=/; HttpOnly; SameSite=Strict");
                res.set_redirect(req.path.empty() ? "/" : req.path);
                return httplib::Server::HandlerResponse::Handled;
            }
            res.status = 401;
            res.set_content("{\"error\": \"Access token required\"}", "application/json");
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // Plugin .zip uploads (POST /api/plugins/install); plugin_install.h caps a plugin at 8 MB.
    svr.set_payload_max_length(12 * 1024 * 1024);

    svr.set_default_headers({
        {"X-Content-Type-Options", "nosniff"},
        {"X-Frame-Options", "DENY"},
        {"Referrer-Policy", "no-referrer"}
    });

    registerPlaybackRoutes(svr, scanner);   // /api/stream/<id>
    registerTorrentRoutes(svr);             // /api/torrent/* (search, start, stream)
    // 1a. Serve plugin folders (ui.js / backend.js) at /plugins — registered
    //     before the catch-all below so it's matched directly, without
    //     needing to fail against www_dir first.
    svr.set_mount_point("/plugins", plugins_dir);

    // 1b. Serve your JavaScript UI frontend files from the www folder
    auto ret = svr.set_mount_point("/", www_dir);
    if (!ret) {
        std::cout << "[Hesper Server Warning] Directory '" << www_dir << "' not found. Running API only." << std::endl;
    }

    // 2. Create the JSON API endpoint that feeds live data to your JS frontend framework
    svr.Get("/api/status", [get_plugins](const httplib::Request& req, httplib::Response& res) {
        std::vector<std::string> plugins = get_plugins();
        
        // Build JSON response dynamically from C++ backend data
        std::string json_response = "{\"status\": \"online\", \"backend\": \"media_core\", \"plugins\": [";
        
        for (size_t i = 0; i < plugins.size(); ++i) {
            json_response += "{\"id\": \"" + jsonEscape(plugins[i]) + "\", \"name\": \"" + jsonEscape(plugins[i]) + "\", \"enabled\": true}";
            if (i + 1 < plugins.size()) {
                json_response += ",";
            }
        }
        
        json_response += "]}";

        res.set_content(json_response, "application/json");
    });

    // 2b. Skins: each subfolder of skins_dir holds skin.json (+ optional
    //     skin.css). Files are served at /skins/<id>/..., and /api/skins
    //     lists the folders that have a skin.json. The frontend reads each
    //     manifest itself, so no JSON parsing is needed here.
    svr.set_mount_point("/skins", skins_dir);
    svr.Get("/api/skins", [skins_dir](const httplib::Request& req, httplib::Response& res) {
        std::string json_response = "{\"skins\": [";
        bool first = true;
        try {
            if (fs::exists(skins_dir) && fs::is_directory(skins_dir)) {
                for (const auto& entry : fs::directory_iterator(skins_dir)) {
                    if (!entry.is_directory()) continue;
                    std::string id = entry.path().filename().string();
                    if (id.empty() || id[0] == '.') continue;
                    // Only plain names (letters, digits, - and _) so an id can never escape the folder.
                    bool safe = true;
                    for (unsigned char c : id) {
                        if (!(std::isalnum(c) || c == '-' || c == '_')) { safe = false; break; }
                    }
                    if (!safe || !fs::exists(entry.path() / "skin.json")) continue;
                    if (!first) json_response += ",";
                    json_response += "{\"id\": \"" + jsonEscape(id) + "\"}";
                    first = false;
                }
            }
        } catch (const std::exception&) {
            res.set_content("{\"error\": \"Could not read skins directory\"}", "application/json");
            return;
        }
        json_response += "]}";
        res.set_content(json_response, "application/json");
    });

    // 3. UI plugin discovery: each subfolder of plugins_dir is one plugin
    //    (ui.js for its frontend, optionally backend.py for its Python
    //    backend — the C++ core runs backend.py directly, see
    //    runFolderPlugins() in core.cpp). This is the same folder the
    //    legacy loose-file Python scrapers live in; loose .py files are
    //    ignored here, and subfolders are ignored by that scanner, so
    //    both can share it.
    //    The frontend fetches this list, then loads each plugin's ui.js
    //    (served via the /plugins mount above) to read its app_name.
    svr.Get("/api/plugins", [plugins_dir](const httplib::Request& req, httplib::Response& res) {
        std::string json_response = "{\"plugins\": [";
        bool first = true;

        try {
            if (fs::exists(plugins_dir) && fs::is_directory(plugins_dir)) {
                for (const auto& entry : fs::directory_iterator(plugins_dir)) {
                    if (!entry.is_directory()) continue;

                    std::string folder_name = entry.path().filename().string();
                    
                    // Skip Python caches and hidden folders
                    if (folder_name.empty() || folder_name == "__pycache__" || folder_name[0] == '.') continue;

                    bool has_backend = fs::exists(entry.path() / "backend.py");

                    if (!first) json_response += ",";
                    json_response += "{\"folder\": \"" + jsonEscape(folder_name) + "\", \"hasBackend\": " +
                                      (has_backend ? "true" : "false") + "}";
                    first = false;
                }
            }
        } catch (const std::exception&) {
            res.set_content("{\"error\": \"Could not read plugins directory\"}", "application/json");
            return;
        }

        json_response += "]}";
        res.set_content(json_response, "application/json");
    });

    // 3b. Install / remove a plugin. The web UI unpacks the .zip itself and sends each
    //     file as a "path" text field + a "file" part (same order). All checking and
    //     writing is done by hesper_plugins:: (plugin_install.h). "dry=1" only checks.
    auto outcomeJson = [](const hesper_plugins::Outcome& o) {
        std::string err;
        for (unsigned char c : o.error) err += (c < 0x20 ? '?' : static_cast<char>(c));
        return std::string("{\"ok\": ") + (o.ok ? "true" : "false") +
               ", \"id\": \"" + jsonEscape(o.id) + "\"" +
               ", \"files\": " + std::to_string(o.files) +
               ", \"bytes\": " + std::to_string(o.bytes) +
               ", \"replaced\": " + (o.replaced ? "true" : "false") +
               ", \"error\": \"" + jsonEscape(err) + "\"}";
    };

    svr.Post("/api/plugins/install", [plugins_dir, outcomeJson](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.form.get_field("id");
        const bool dry = req.form.get_field("dry") == "1";
        const auto paths = req.form.get_fields("path");
        const auto parts = req.form.get_files("file");
        hesper_plugins::Outcome out;
        out.id = id;
        if (paths.size() != parts.size()) {
            out.error = "the upload was incomplete";
        } else {
            std::vector<hesper_plugins::InFile> files;
            files.reserve(parts.size());
            for (size_t i = 0; i < parts.size(); ++i) files.push_back({paths[i], parts[i].content});
            out = hesper_plugins::install(plugins_dir, id, files, dry);
        }
        res.status = out.ok ? 200 : 400;
        res.set_content(outcomeJson(out), "application/json");
    });

    // 3b-1. Install / remove a skin. Same upload shape as a plugin; all checking and writing
    //       is done by hesper_skins:: (skin_install.h). A plugin zip is refused here and a skin
    //       zip is refused by the plugin installer.
    svr.Post("/api/skins/install", [skins_dir, outcomeJson](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.form.get_field("id");
        const bool dry = req.form.get_field("dry") == "1";
        const auto paths = req.form.get_fields("path");
        const auto parts = req.form.get_files("file");
        hesper_plugins::Outcome out;
        out.id = id;
        if (paths.size() != parts.size()) {
            out.error = "the upload was incomplete";
        } else {
            std::vector<hesper_plugins::InFile> files;
            files.reserve(parts.size());
            for (size_t i = 0; i < parts.size(); ++i) files.push_back({paths[i], parts[i].content});
            out = hesper_skins::install(skins_dir, id, files, dry);
        }
        res.status = out.ok ? 200 : 400;
        res.set_content(outcomeJson(out), "application/json");
    });

    svr.Post("/api/skins/uninstall", [skins_dir, outcomeJson](const httplib::Request& req, httplib::Response& res) {
        const hesper_plugins::Outcome out = hesper_skins::uninstall(skins_dir, req.form.get_field("id"));
        res.status = out.ok ? 200 : 400;
        res.set_content(outcomeJson(out), "application/json");
    });

    // 3b-2. Plugin backup: list an installed plugin's files, and read one of them. Used by the app to
    //       back plugins up to Hesper Cloud. plugin_install.h only lets through plain allowed files
    //       (never data/, hidden files or built-in plugins).
    svr.Get("/api/plugins/files", [plugins_dir](const httplib::Request& req, httplib::Response& res) {
        std::vector<hesper_plugins::ListedFile> files;
        const std::string id = req.get_param_value("id");
        if (!hesper_plugins::listFiles(plugins_dir, id, files)) {
            res.status = 404;
            res.set_content("{\"ok\": false, \"error\": \"not installed\"}", "application/json");
            return;
        }
        std::string j = "{\"ok\": true, \"files\": [";
        for (size_t i = 0; i < files.size(); ++i) {
            if (i) j += ",";
            j += "{\"path\": \"" + jsonEscape(files[i].path) + "\", \"size\": " + std::to_string(files[i].size) +
                 ", \"mtime\": " + std::to_string(files[i].mtime) + "}";
        }
        j += "]}";
        res.set_content(j, "application/json");
    });

    svr.Get("/api/plugins/file", [plugins_dir](const httplib::Request& req, httplib::Response& res) {
        std::string data;
        if (!hesper_plugins::readFile(plugins_dir, req.get_param_value("id"), req.get_param_value("path"), data)) {
            res.status = 404;
            res.set_content("{\"ok\": false, \"error\": \"not found\"}", "application/json");
            return;
        }
        res.set_content(data, "application/octet-stream");
    });

    svr.Post("/api/plugins/uninstall", [plugins_dir, outcomeJson](const httplib::Request& req, httplib::Response& res) {
        const hesper_plugins::Outcome out = hesper_plugins::uninstall(plugins_dir, req.form.get_field("id"));
        res.status = out.ok ? 200 : 400;
        res.set_content(outcomeJson(out), "application/json");
    });

    // 3c. In-app file picker for plugin .zip files. Hesper draws its own picker because TV
    //     boxes have no system one. These two routes can only (1) list folders and .zip files
    //     and (2) read ONE .zip of at most 8 MB, on this device or on a network share
    //     (smb://, nfs://, ftp://, dav://). Nothing else can be read through them.
    static constexpr uint64_t kZipPickMax = 8u * 1024 * 1024;
    auto isZipName = [](const std::string& n) {
        if (n.size() < 5) return false;
        std::string t = n.substr(n.size() - 4);
        for (auto& c : t) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return t == ".zip";
    };
    auto localRoot = []() -> std::string {
        std::error_code ec;
        if (fs::is_directory("/storage/emulated/0", ec)) return "/storage/emulated/0";
        const char* h = std::getenv("HOME");
        if (h && *h && fs::is_directory(h, ec)) return h;
        return "/";
    };

    svr.Post("/api/plugins/browse", [isZipName, localRoot](const httplib::Request& req, httplib::Response& res) {
        auto fail = [&res](const std::string& msg, bool auth) {
            res.set_content("{\"ok\": false, \"auth\": " + std::string(auth ? "true" : "false") +
                            ", \"error\": \"" + jsonEscape(msg) + "\"}", "application/json");
        };
        struct Item { std::string name, path; bool dir; uint64_t size; };
        std::vector<Item> items;
        std::string path = req.get_param_value("path");
        std::string shown, parent;

        if (vfs::isRemote(path)) {
            vfs::Url u;
            if (!vfs::parseUrl(path, u) || !validNetHost(u.host)) { fail("That is not a valid network address.", false); return; }
            if (req.has_param("user")) {
                vfs::setCredentials(u.scheme, u.host, req.get_param_value("user"), req.get_param_value("pass"), false);
            }
            vfs::Error err;
            if (vfs::hasShares(u.scheme) && u.share.empty()) {
                std::vector<std::string> shares;
                if (!vfs::listShares(u, shares, err)) { fail(err.msg, err.auth); return; }
                for (const auto& sh : shares) {
                    vfs::Url su = u;
                    su.share = u.scheme == "smb" ? sh : vfs::urlEncode(sh);
                    items.push_back({sh, vfs::buildUrl(su), true, 0});
                }
                shown = vfs::buildUrl(u);
            } else {
                auto conn = vfs::connect(u, err);
                if (!conn) { fail(err.msg, err.auth); return; }
                std::vector<vfs::Entry> list;
                if (!conn->list(u.path, list, err)) { fail(err.msg, err.auth); return; }
                shown = vfs::buildUrl(u);
                parent = vfs::parent(shown);
                for (const auto& e : list) {
                    if (e.name.empty() || e.name[0] == '.') continue;
                    if (e.is_dir) items.push_back({e.name, vfs::join(shown, e.name), true, 0});
                    else if (isZipName(e.name) && e.size <= kZipPickMax) items.push_back({e.name, vfs::join(shown, e.name), false, e.size});
                }
            }
        } else {
            if (path.empty() || path == "@local") path = localRoot();
            if (path[0] != '/' || path.find("..") != std::string::npos) { fail("That folder isn't available.", false); return; }
            std::error_code ec;
            const fs::path dir(path);
            if (!fs::is_directory(dir, ec)) { fail("That folder isn't available.", false); return; }
            fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
            if (ec) { fail("Hesper isn't allowed to open this folder on this device. Try a network folder instead.", false); return; }
            for (; it != fs::directory_iterator(); it.increment(ec)) {
                if (ec) break;
                const std::string name = it->path().filename().string();
                if (name.empty() || name[0] == '.') continue;
                std::error_code e2;
                if (it->is_directory(e2)) {
                    items.push_back({name, it->path().string(), true, 0});
                } else if (it->is_regular_file(e2) && isZipName(name)) {
                    const uint64_t sz = it->file_size(e2);
                    if (!e2 && sz <= kZipPickMax) items.push_back({name, it->path().string(), false, sz});
                }
                if (items.size() >= 1000) break;
            }
            shown = dir.string();
            parent = (dir.has_parent_path() && dir.parent_path() != dir) ? dir.parent_path().string() : "";
        }

        auto lower = [](std::string t) { for (auto& c : t) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return t; };
        std::sort(items.begin(), items.end(), [&lower](const Item& a, const Item& b) {
            if (a.dir != b.dir) return a.dir;
            return lower(a.name) < lower(b.name);
        });
        std::string json = "{\"ok\": true, \"path\": \"" + jsonEscape(shown) + "\", \"parent\": \"" + jsonEscape(parent) + "\", \"entries\": [";
        for (size_t i = 0; i < items.size(); ++i) {
            json += "{\"name\": \"" + jsonEscape(items[i].name) + "\", \"path\": \"" + jsonEscape(items[i].path) +
                    "\", \"dir\": " + (items[i].dir ? "true" : "false") + ", \"size\": " + std::to_string(items[i].size) + "}";
            if (i + 1 < items.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    svr.Post("/api/plugins/fetch", [isZipName](const httplib::Request& req, httplib::Response& res) {
        auto fail = [&res](const std::string& msg) {
            res.status = 400;
            res.set_content("{\"ok\": false, \"error\": \"" + jsonEscape(msg) + "\"}", "application/json");
        };
        const std::string path = req.get_param_value("path");
        if (!isZipName(path)) { fail("Only .zip files can be installed as plugins."); return; }
        std::string data;

        if (vfs::isRemote(path)) {
            vfs::Url u;
            vfs::Error err;
            if (!vfs::parseUrl(path, u) || !validNetHost(u.host) || (vfs::hasShares(u.scheme) && u.share.empty())) {
                fail("That is not a valid network address."); return;
            }
            auto conn = vfs::connect(u, err);
            if (!conn) { fail(err.msg.empty() ? "Could not connect to that device." : err.msg); return; }
            if (!conn->open(u.path, err)) { fail(err.msg.empty() ? "Could not open that file." : err.msg); return; }
            const uint64_t size = conn->fileSize();
            if (size == 0 || size > kZipPickMax) { fail("That file is too large to be a plugin (limit 8 MB)."); return; }
            data.resize(static_cast<size_t>(size));
            uint64_t off = 0;
            while (off < size) {
                const int64_t n = conn->read(off, &data[static_cast<size_t>(off)], static_cast<size_t>(std::min<uint64_t>(size - off, 64 * 1024)));
                if (n <= 0) break;
                off += static_cast<uint64_t>(n);
            }
            if (off != size) { fail("The file could not be read completely."); return; }
        } else {
            if (path[0] != '/' || path.find("..") != std::string::npos) { fail("That file isn't available."); return; }
            std::error_code ec;
            const fs::path p(path);
            if (!fs::is_regular_file(p, ec)) { fail("That file isn't available."); return; }
            const uint64_t size = fs::file_size(p, ec);
            if (ec || size == 0 || size > kZipPickMax) { fail("That file is too large to be a plugin (limit 8 MB)."); return; }
            std::ifstream in(p, std::ios::binary);
            if (!in) { fail("Hesper isn't allowed to open that file."); return; }
            data.resize(static_cast<size_t>(size));
            in.read(&data[0], static_cast<std::streamsize>(size));
            if (static_cast<uint64_t>(in.gcount()) != size) { fail("The file could not be read completely."); return; }
        }
        if (data.size() < 4 || data[0] != 'P' || data[1] != 'K') { fail("That is not a valid .zip file."); return; }
        res.set_content(data, "application/zip");
    });

    // 4. Movies — flat list, classified from embedded container tags
    //    first, then the filename/folder fallback (see MediaScanner).
    svr.Get("/api/movies", [scanner](const httplib::Request& req, httplib::Response& res) {
        auto movies = scanner->getMovies();
        std::string json = "{\"movies\": [";
        for (size_t i = 0; i < movies.size(); ++i) {
            const auto& m = movies[i];
            json += "{\"id\": \"" + m.id + "\", \"title\": \"" + jsonEscape(m.title) +
                    "\", \"year\": " + std::to_string(m.year) +
                    ", \"filename\": \"" + jsonEscape(m.filename) + "\"}";
            if (i + 1 < movies.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // 5. TV shows — one entry per show (matched case-insensitively, so
    //    "friends" and "Friends" are one show), each with its seasons in
    //    order and each season's episodes in order. The frontend renders
    //    this as show folder -> season folder -> episode list.
    svr.Get("/api/shows", [scanner](const httplib::Request& req, httplib::Response& res) {
        auto episodes = scanner->getEpisodes();

        struct ShowGroup {
            std::string title;                                   // display spelling (first one seen)
            std::map<int, std::vector<MediaEntry>> seasons;      // season -> episodes
            size_t total = 0;
        };
        std::map<std::string, ShowGroup> grouped;                // lowercase title -> group
        for (const auto& e : episodes) {
            std::string key;
            for (unsigned char c : e.show_title) key += static_cast<char>(std::tolower(c));
            auto& g = grouped[key];
            if (g.title.empty()) g.title = e.show_title;
            g.seasons[e.season].push_back(e);
            g.total++;
        }

        std::string json = "{\"shows\": [";
        bool first_show = true;
        for (auto& [key, g] : grouped) {
            if (!first_show) json += ",";
            first_show = false;
            json += "{\"showTitle\": \"" + jsonEscape(g.title) + "\", \"episodeCount\": " +
                    std::to_string(g.total) + ", \"seasons\": [";
            bool first_season = true;
            for (auto& [season, eps] : g.seasons) {
                std::sort(eps.begin(), eps.end(), [](const MediaEntry& a, const MediaEntry& b) {
                    return a.episode != b.episode ? a.episode < b.episode : a.filename < b.filename;
                });
                if (!first_season) json += ",";
                first_season = false;
                json += "{\"season\": " + std::to_string(season) + ", \"episodes\": [";
                for (size_t i = 0; i < eps.size(); ++i) {
                    const auto& e = eps[i];
                    json += "{\"id\": \"" + e.id + "\", \"season\": " + std::to_string(e.season) +
                            ", \"episode\": " + std::to_string(e.episode) +
                            ", \"filename\": \"" + jsonEscape(e.filename) + "\"}";
                    if (i + 1 < eps.size()) json += ",";
                }
                json += "]}";
            }
            json += "]}";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // 5b. Duplicate finder (read-only): groups the same movie, the same
    //     episode, or byte-size-identical files that appear more than once.
    //     "wasted" = everything in a group except its largest file, i.e.
    //     what you could free by keeping just one copy.
    svr.Get("/api/duplicates", [scanner](const httplib::Request& req, httplib::Response& res) {
        auto movies = scanner->getMovies();
        auto episodes = scanner->getEpisodes();
        auto unknown = scanner->getUnclassified();

        struct Group {
            std::string kind;     // "movie" | "episode" | "size"
            std::string label;
            std::vector<MediaEntry> files;
            uint64_t wasted = 0;
        };
        std::vector<Group> groups;
        std::map<std::string, size_t> groupOf;   // entry id -> index of the name-based group it is in

        auto finish = [&](Group& g) {
            std::sort(g.files.begin(), g.files.end(), [](const MediaEntry& a, const MediaEntry& b) {
                return a.size_bytes != b.size_bytes ? a.size_bytes > b.size_bytes : a.path < b.path;
            });
            uint64_t total = 0;
            for (const auto& f : g.files) total += f.size_bytes;
            g.wasted = total - g.files.front().size_bytes;
        };

        // Same movie: normalized title + year.
        std::map<std::string, std::vector<MediaEntry>> byMovie;
        for (const auto& m : movies) {
            std::string t = normalizeName(m.title);
            if (t.empty()) continue;
            byMovie[t + "|" + std::to_string(m.year)].push_back(m);
        }
        for (auto& [key, files] : byMovie) {
            if (files.size() < 2) continue;
            Group g;
            g.kind = "movie";
            g.label = files.front().title + (files.front().year ? " (" + std::to_string(files.front().year) + ")" : "");
            g.files = files;
            finish(g);
            for (const auto& f : g.files) groupOf[f.id] = groups.size();
            groups.push_back(std::move(g));
        }

        // Same episode: normalized show + season + episode (skips unparsed numbers).
        std::map<std::string, std::vector<MediaEntry>> byEpisode;
        for (const auto& e : episodes) {
            std::string t = normalizeName(e.show_title);
            if (t.empty() || e.episode <= 0) continue;
            byEpisode[t + "|" + std::to_string(e.season) + "|" + std::to_string(e.episode)].push_back(e);
        }
        for (auto& [key, files] : byEpisode) {
            if (files.size() < 2) continue;
            char tag[32];
            std::snprintf(tag, sizeof(tag), " S%02dE%02d", files.front().season, files.front().episode);
            Group g;
            g.kind = "episode";
            g.label = files.front().show_title + tag;
            g.files = files;
            finish(g);
            for (const auto& f : g.files) groupOf[f.id] = groups.size();
            groups.push_back(std::move(g));
        }

        // Same size (>= 1 MB) under different names, e.g. one file copied to two folders.
        // Skipped when every file in the size group is already in one name-based group.
        std::map<uint64_t, std::vector<MediaEntry>> bySize;
        for (const auto* list : {&movies, &episodes, &unknown}) {
            for (const auto& f : *list) {
                if (f.size_bytes >= 1024 * 1024) bySize[f.size_bytes].push_back(f);
            }
        }
        for (auto& [size, files] : bySize) {
            if (files.size() < 2) continue;
            bool allSame = true;
            auto first = groupOf.find(files.front().id);
            for (const auto& f : files) {
                auto it = groupOf.find(f.id);
                if (first == groupOf.end() || it == groupOf.end() || it->second != first->second) { allSame = false; break; }
            }
            if (allSame) continue;
            Group g;
            g.kind = "size";
            g.label = "Identical file size";
            g.files = files;
            finish(g);
            groups.push_back(std::move(g));
        }

        std::sort(groups.begin(), groups.end(), [](const Group& a, const Group& b) { return a.wasted > b.wasted; });

        uint64_t wasted_total = 0;
        std::string json = "{\"groups\": [";
        for (size_t gi = 0; gi < groups.size(); ++gi) {
            const auto& g = groups[gi];
            wasted_total += g.wasted;
            json += "{\"kind\": \"" + g.kind + "\", \"label\": \"" + jsonEscape(g.label) +
                    "\", \"wasted\": " + std::to_string(g.wasted) + ", \"files\": [";
            for (size_t i = 0; i < g.files.size(); ++i) {
                const auto& f = g.files[i];
                json += "{\"id\": \"" + f.id + "\", \"filename\": \"" + jsonEscape(f.filename) +
                        "\", \"path\": \"" + jsonEscape(f.path) + "\", \"size\": " + std::to_string(f.size_bytes) + "}";
                if (i + 1 < g.files.size()) json += ",";
            }
            json += "]}";
            if (gi + 1 < groups.size()) json += ",";
        }
        json += "], \"wastedTotal\": " + std::to_string(wasted_total) + "}";
        res.set_content(json, "application/json");
    });

    // 6. On-tap movie detail: only fires when the user actually opens
    //    a movie card, not during the scan — keeps the bulk scan
    //    network-free (see MediaScanner) while still getting a poster
    //    and synopsis for whatever the user is currently looking at.
    //    Goes through the Cloudflare Worker proxy (no key needed here); needs cpp-httplib
    //    built with CPPHTTPLIB_OPENSSL_SUPPORT (TMDb is HTTPS-only).
    svr.Get("/api/movie-details", [scanner](const httplib::Request& req, httplib::Response& res) {
        std::string id = req.get_param_value("id");
        MediaEntry entry;
        if (!scanner->findById(id, entry) || entry.kind != MediaKind::Movie) {
            res.status = 404;
            res.set_content("{\"error\": \"Movie not found\"}", "application/json");
            return;
        }

        httplib::Client client(tmdbProxyUrl());

        applyTls(client);
        client.set_connection_timeout(5);
        client.set_read_timeout(5);

        std::string query = "/search/movie?query=" + httplib::encode_uri(entry.title);
        if (entry.year > 0) query += "&year=" + std::to_string(entry.year);

        auto tmdb_res = client.Get(query.c_str());
        if (!tmdb_res || tmdb_res->status != 200) {
            res.status = 502;
            res.set_content("{\"error\": \"TMDb lookup failed\"}", "application/json");
            return;
        }

        // Grab the first result block only — good enough without a
        // real JSON parser, same "top result" heuristic used
        // elsewhere in this project.
        std::string body = tmdb_res->body;
        size_t results_pos = body.find("\"results\"");
        std::string first_result = results_pos != std::string::npos ? body.substr(results_pos) : body;

        std::string overview = extractJsonString(first_result, "overview");
        std::string poster_path = extractJsonString(first_result, "poster_path");
        std::string poster_url = poster_path.empty() ? "" : ("https://image.tmdb.org/t/p/w342" + poster_path);

        std::string json = "{\"id\": \"" + entry.id + "\", \"title\": \"" + jsonEscape(entry.title) +
                            "\", \"year\": " + std::to_string(entry.year) +
                            ", \"overview\": \"" + jsonEscape(overview) +
                            "\", \"poster\": \"" + jsonEscape(poster_url) + "\"}";
        res.set_content(json, "application/json");
    });

    // 6b. TV show bio (poster + synopsis) — fires only when the user opens a show.
    svr.Get("/api/show-details", [](const httplib::Request& req, httplib::Response& res) {
        std::string title = req.get_param_value("title");
        if (title.empty()) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing title\"}", "application/json");
            return;
        }
        httplib::Client client(tmdbProxyUrl());
        applyTls(client);
        client.set_connection_timeout(5);
        client.set_read_timeout(5);
        auto tmdb_res = client.Get(("/search/tv?query=" + httplib::encode_uri(title)).c_str());
        if (!tmdb_res || tmdb_res->status != 200) {
            res.status = 502;
            res.set_content("{\"error\": \"TMDb lookup failed\"}", "application/json");
            return;
        }
        const std::string& body = tmdb_res->body;
        size_t results_pos = body.find("\"results\"");
        std::string first_result = results_pos != std::string::npos ? body.substr(results_pos) : body;
        std::string overview = extractJsonString(first_result, "overview");
        std::string poster_path = extractJsonString(first_result, "poster_path");
        std::string poster_url = poster_path.empty() ? "" : ("https://image.tmdb.org/t/p/w342" + poster_path);
        std::string json = "{\"title\": \"" + jsonEscape(title) +
                            "\", \"overview\": \"" + jsonEscape(overview) +
                            "\", \"poster\": \"" + jsonEscape(poster_url) + "\"}";
        res.set_content(json, "application/json");
    });

    // 6c. Episode bio (title + synopsis + still image). The Worker does the
    //     show lookup and episode fetch and returns a trimmed object.
    svr.Get("/api/episode-details", [](const httplib::Request& req, httplib::Response& res) {
        std::string show = req.get_param_value("show");
        std::string season = req.get_param_value("season");
        std::string episode = req.get_param_value("episode");
        if (show.empty() || season.empty() || episode.empty()) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing show, season or episode\"}", "application/json");
            return;
        }
        httplib::Client client(tmdbProxyUrl());
        applyTls(client);
        client.set_connection_timeout(5);
        client.set_read_timeout(8);
        std::string q = "/episode?query=" + httplib::encode_uri(show) +
                        "&season=" + httplib::encode_uri(season) +
                        "&episode=" + httplib::encode_uri(episode);
        auto tmdb_res = client.Get(q.c_str());
        if (!tmdb_res || tmdb_res->status != 200) {
            res.status = 502;
            res.set_content("{\"error\": \"TMDb lookup failed\"}", "application/json");
            return;
        }
        const std::string& body = tmdb_res->body;
        std::string name = extractJsonString(body, "name");
        std::string overview = extractJsonString(body, "overview");
        std::string still = extractJsonString(body, "still_path");
        std::string still_url = still.empty() ? "" : ("https://image.tmdb.org/t/p/w300" + still);
        std::string json = "{\"name\": \"" + jsonEscape(name) +
                            "\", \"overview\": \"" + jsonEscape(overview) +
                            "\", \"still\": \"" + jsonEscape(still_url) + "\"}";
        res.set_content(json, "application/json");
    });

    // 6d. Intro / recap times for one episode, so the player can offer Skip Intro / Skip Recap
    //     without anyone marking them. Show name -> TMDb id -> IMDb id -> IntroDB.
    //     Always answers 200 with {"found": bool, ...}; the raw database answer is passed on
    //     in "data" and the page picks the intro / recap out of it.
    svr.Get("/api/skip-segments", [](const httplib::Request& req, httplib::Response& res) {
        auto reply = [&](bool found, const std::string& imdb, const std::string& data) {
            std::string out = std::string("{\"found\": ") + (found ? "true" : "false") +
                              ", \"imdb\": \"" + jsonEscape(imdb) + "\"" +
                              (data.empty() ? "" : ", \"data\": " + data) + "}";
            res.set_header("Cache-Control", "no-store");
            res.set_content(out, "application/json");
        };
        std::string show = req.get_param_value("show");
        int season  = std::atoi(req.get_param_value("season").c_str());
        int episode = std::atoi(req.get_param_value("episode").c_str());
        if (show.empty() || season < 0 || episode <= 0) {
            res.status = 400;
            res.set_content("{\"error\": \"Missing show, season or episode\"}", "application/json");
            return;
        }

        // 1) IMDb id for the show (cached per show for the life of the app).
        const std::string showKey = normalizeName(show);
        std::string imdb;
        { std::lock_guard<std::mutex> lk(g_skip_mu); auto it = g_imdb_by_show.find(showKey); if (it != g_imdb_by_show.end()) imdb = it->second; }
        if (imdb.empty()) {
            httplib::Client tm(tmdbProxyUrl());
            applyTls(tm);
            tm.set_connection_timeout(5);
            tm.set_read_timeout(6);
            auto s1 = tm.Get(("/search/tv?query=" + httplib::encode_uri(show)).c_str());
            if (!s1 || s1->status != 200) { reply(false, "", ""); return; }
            size_t rp = s1->body.find("\"results\"");
            std::string tvId = extractJsonNumber(rp != std::string::npos ? s1->body.substr(rp) : s1->body, "id");
            if (tvId.empty()) { reply(false, "", ""); return; }
            auto s2 = tm.Get(("/tv/" + tvId + "?append_to_response=external_ids").c_str());
            if (!s2 || s2->status != 200) { reply(false, "", ""); return; }
            imdb = extractJsonString(s2->body, "imdb_id");
            if (imdb.empty()) { reply(false, "", ""); return; }
            std::lock_guard<std::mutex> lk(g_skip_mu);
            g_imdb_by_show[showKey] = imdb;
        }

        // 2) The episode's segments (cached; misses expire sooner so a new submission shows up).
        const std::string key = imdb + "|" + std::to_string(season) + "|" + std::to_string(episode);
        const long long now = nowMs();
        {
            std::lock_guard<std::mutex> lk(g_skip_mu);
            auto it = g_skip_cache.find(key);
            if (it != g_skip_cache.end() && now - it->second.at < (it->second.found ? kSkipHitTtlMs : kSkipMissTtlMs)) {
                reply(it->second.found, imdb, it->second.body);
                return;
            }
        }
        httplib::Client db(kIntroDbHost);
        applyTls(db);
        db.set_connection_timeout(5);
        db.set_read_timeout(6);
        db.set_follow_location(true);
        auto r = db.Get(("/segments?imdb_id=" + httplib::encode_uri(imdb) + "&season=" + std::to_string(season) +
                         "&episode=" + std::to_string(episode)).c_str());
        bool ok = r && r->status == 200 && !r->body.empty() && (r->body[0] == '{' || r->body[0] == '[');
        if (!r || (r->status != 200 && r->status != 404)) { reply(false, imdb, ""); return; }   // offline / rate limited: do not cache
        std::string body = ok ? r->body : "";
        {
            std::lock_guard<std::mutex> lk(g_skip_mu);
            if (g_skip_cache.size() > 500) g_skip_cache.clear();
            g_skip_cache[key] = SkipCacheEntry{body, now, ok};
        }
        reply(ok, imdb, body);
    });

    // 7. Manually trigger a rescan (e.g. a "Refresh Library" button).
    //    Runs in the background so the request returns immediately.
    svr.Post("/api/rescan", [scanner](const httplib::Request& req, httplib::Response& res) {
        long long now = nowMs();
        long long last = g_last_rescan_ms.load();
        if (last != 0 && now - last < kRescanCooldownMs) {
            long long wait_s = (kRescanCooldownMs - (now - last) + 999) / 1000;
            res.status = 429;
            res.set_header("Retry-After", std::to_string(wait_s));
            res.set_content("{\"error\": \"Too soon\", \"retry_after\": " + std::to_string(wait_s) + "}", "application/json");
            return;
        }
        bool expected = false;
        if (!g_rescan_running.compare_exchange_strong(expected, true)) {
            res.set_content("{\"status\": \"already scanning\"}", "application/json");
            return;
        }
        g_last_rescan_ms.store(now);
        std::thread([scanner]() {
            scanner->scan();
            g_rescan_running.store(false);
        }).detach();
        res.set_content("{\"status\": \"rescan started\"}", "application/json");
    });

    // 7b. Lets the UI wait for a manual rescan to finish before reloading.
    svr.Get("/api/scan-status", [](const httplib::Request& req, httplib::Response& res) {
        res.set_content(std::string("{\"scanning\": ") + (g_rescan_running.load() ? "true" : "false") + "}", "application/json");
    });

    // 8. Directory picker: lists subfolders of ?path=..., or a default
    //    root if no path is given / the path is invalid. Powers the
    //    "Add Source" folder-browsing UI — never touches files.
    svr.Get("/api/browse", [](const httplib::Request& req, httplib::Response& res) {
        std::string path = req.has_param("path")
            ? req.get_param_value("path")
            : "/storage/emulated/0";

        std::vector<std::string> dirs;
        if (!MediaScanner::listSubdirectories(path, dirs)) {
            path = "/storage/emulated/0"; // invalid path — fall back rather than error, so the picker never gets stuck
            MediaScanner::listSubdirectories(path, dirs);
        }

        fs::path current(path);
        std::string parent = current.has_parent_path() ? current.parent_path().string() : path;

        std::string json = "{\"path\": \"" + jsonEscape(path) + "\", \"parent\": \"" + jsonEscape(parent) + "\", \"directories\": [";
        for (size_t i = 0; i < dirs.size(); ++i) {
            fs::path d(dirs[i]);
            json += "{\"name\": \"" + jsonEscape(d.filename().string()) + "\", \"path\": \"" + jsonEscape(dirs[i]) + "\"}";
            if (i + 1 < dirs.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // 8b. Network sources (SMB, NFS, FTP, WebDAV, DLNA). Discovery runs in the
    //     background; the UI starts it with POST, then polls GET until
    //     "scanning" is false.
    static DiscoveryService discovery;
    svr.Post("/api/discover", [](const httplib::Request&, httplib::Response& res) {
        bool started = discovery.start(4000);
        res.set_content(std::string("{\"status\": \"") + (started ? "started" : "running") + "\"}", "application/json");
    });
    svr.Get("/api/discover", [](const httplib::Request&, httplib::Response& res) {
        auto hosts = discovery.results();
        std::string missing;
        for (const char* sch : {"smb", "nfs"}) {
            if (!vfs::available(sch)) missing += std::string(missing.empty() ? "" : ",") + "\"" + sch + "\"";
        }
        std::string json = std::string("{\"scanning\": ") + (discovery.isRunning() ? "true" : "false") +
                           ", \"unsupported\": [" + missing + "], \"hosts\": [";
        for (size_t i = 0; i < hosts.size(); ++i) {
            json += "{\"name\": \"" + jsonEscape(hosts[i].name) + "\", \"address\": \"" + jsonEscape(hosts[i].address) +
                    "\", \"protocol\": \"" + jsonEscape(hosts[i].protocol) + "\", \"label\": \"" +
                    jsonEscape(vfs::schemeLabel(hosts[i].protocol)) + "\", \"url\": \"" + jsonEscape(hosts[i].url) +
                    "\", \"via\": \"" + jsonEscape(hosts[i].via) + "\"}";
            if (i + 1 < hosts.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // Folder picker for a network location, given as a URL (smb://, nfs://, ftp://,
    // dav://, davs://, upnp://). A host with shares and no share chosen lists its
    // shares; otherwise the sub-folders of the location. Optional user/pass are
    // kept for that host (in memory) so the following calls reuse them.
    svr.Post("/api/net/browse", [](const httplib::Request& req, httplib::Response& res) {
        auto fail = [&res](const std::string& msg, bool auth, bool canTypeShare) {
            res.set_content("{\"ok\": false, \"auth\": " + std::string(auth ? "true" : "false") +
                            ", \"canTypeShare\": " + (canTypeShare ? "true" : "false") +
                            ", \"error\": \"" + jsonEscape(msg) + "\"}", "application/json");
        };
        vfs::Url u;
        if (!vfs::parseUrl(req.get_param_value("url"), u) || !validNetHost(u.host)) {
            fail("That is not a valid network address.", false, false);
            return;
        }
        if (req.has_param("user")) {
            vfs::setCredentials(u.scheme, u.host, req.get_param_value("user"), req.get_param_value("pass"), false);
        }
        vfs::Error err;

        if (vfs::hasShares(u.scheme) && u.share.empty()) {
            std::vector<std::string> shares;
            if (!vfs::listShares(u, shares, err)) {
                fail(err.msg, err.auth, u.scheme == "smb" || u.scheme == "nfs");
                return;
            }
            std::sort(shares.begin(), shares.end());
            std::string base = vfs::buildUrl(u);
            std::string json = "{\"ok\": true, \"scheme\": \"" + jsonEscape(u.scheme) + "\", \"path\": \"" + jsonEscape(base) +
                               "\", \"parent\": \"\", \"addable\": false, \"shares\": [";
            for (size_t i = 0; i < shares.size(); ++i) {
                vfs::Url su = u;
                su.share = u.scheme == "smb" ? shares[i] : vfs::urlEncode(shares[i]);
                json += "{\"name\": \"" + jsonEscape(shares[i]) + "\", \"path\": \"" + jsonEscape(vfs::buildUrl(su)) + "\"}";
                if (i + 1 < shares.size()) json += ",";
            }
            json += "], \"directories\": []}";
            res.set_content(json, "application/json");
            return;
        }

        auto conn = vfs::connect(u, err);
        if (!conn) { fail(err.msg, err.auth, false); return; }
        std::vector<vfs::Entry> list;
        if (!conn->list(u.path, list, err)) { fail(err.msg, err.auth, false); return; }
        std::vector<vfs::Entry> dirs;
        for (const auto& e : list) if (e.is_dir && !e.name.empty() && e.name[0] != '.') dirs.push_back(e);
        std::sort(dirs.begin(), dirs.end(), [](const vfs::Entry& a, const vfs::Entry& b) { return a.name < b.name; });

        std::string url = vfs::buildUrl(u);
        std::string json = "{\"ok\": true, \"scheme\": \"" + jsonEscape(u.scheme) + "\", \"path\": \"" + jsonEscape(url) +
                           "\", \"parent\": \"" + jsonEscape(vfs::parent(url)) + "\", \"addable\": true, \"shares\": [], \"directories\": [";
        for (size_t i = 0; i < dirs.size(); ++i) {
            json += "{\"name\": \"" + jsonEscape(dirs[i].name) + "\", \"path\": \"" +
                    jsonEscape(vfs::join(url, dirs[i].name)) + "\"}";
            if (i + 1 < dirs.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // 9. Confirmed media source folders — what the folder picker has
    //    added. Movies/TV/Unknown are all classified per-file via
    //    ffprobe regardless of which source folder they live in, so
    //    sources carry no "content type" — just a path.
    svr.Get("/api/sources", [scanner](const httplib::Request& req, httplib::Response& res) {
        auto dirs = scanner->getMediaDirs();
        std::string json = "{\"sources\": [";
        for (size_t i = 0; i < dirs.size(); ++i) {
            json += "\"" + jsonEscape(dirs[i]) + "\"";
            if (i + 1 < dirs.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    // Confirm a folder picked in the browser UI as a source, then
    // kick off a background scan so it's reflected without a restart.
    svr.Post("/api/sources", [scanner](const httplib::Request& req, httplib::Response& res) {
        std::string path = req.get_param_value("path");
        if (vfs::isRemote(path)) {
            vfs::Url u;
            if (!vfs::parseUrl(path, u) || (vfs::hasShares(u.scheme) && u.share.empty()) || !validNetHost(u.host)) {
                res.status = 400;
                res.set_content("{\"status\": \"error\", \"message\": \"Invalid network folder\"}", "application/json");
                return;
            }
            if (req.has_param("user")) {
                vfs::setCredentials(u.scheme, u.host, req.get_param_value("user"), req.get_param_value("pass"), false);
            }
            // Prove the folder can be opened before saving it, so a typo or a wrong
            // password is reported now rather than as an empty library later.
            vfs::Error err;
            auto conn = vfs::connect(u, err);
            std::vector<vfs::Entry> probe;
            if (!conn || !conn->list(u.path, probe, err)) {
                res.status = 400;
                res.set_content("{\"status\": \"error\", \"auth\": " + std::string(err.auth ? "true" : "false") +
                                ", \"message\": \"" + jsonEscape(err.msg) + "\"}", "application/json");
                return;
            }
            if (!scanner->addMediaDir(vfs::buildUrl(u))) {
                res.status = 400;
                res.set_content("{\"status\": \"error\", \"message\": \"Invalid network folder\"}", "application/json");
                return;
            }
            vfs::persistCredentials(u.scheme, u.host);
            std::thread([scanner]() { scanner->scan(); }).detach();
            res.set_content("{\"status\": \"ok\"}", "application/json");
            return;
        }
        if (scanner->addMediaDir(path)) {
            std::thread([scanner]() { scanner->scan(); }).detach();
            res.set_content("{\"status\": \"ok\"}", "application/json");
        } else {
            res.status = 400;
            res.set_content("{\"status\": \"error\", \"message\": \"Invalid directory\"}", "application/json");
        }
    });

    svr.Delete("/api/sources", [scanner](const httplib::Request& req, httplib::Response& res) {
        std::string path = req.get_param_value("path");
        scanner->removeMediaDir(path);
        res.set_content("{\"status\": \"ok\"}", "application/json");
    });

    // 10. Files that didn't match Movie or Episode via embedded
    //     container tags — the "Unknown" category.
    svr.Get("/api/unknown", [scanner](const httplib::Request& req, httplib::Response& res) {
        auto files = scanner->getUnclassified();
        std::string json = "{\"files\": [";
        for (size_t i = 0; i < files.size(); ++i) {
            const auto& f = files[i];
            json += "{\"id\": \"" + f.id + "\", \"filename\": \"" + jsonEscape(f.filename) +
                    "\", \"path\": \"" + jsonEscape(f.path) + "\"}";
            if (i + 1 < files.size()) json += ",";
        }
        json += "]}";
        res.set_content(json, "application/json");
    });

    std::cout << "[Hesper Server] Web UI & API online at http://" << (remoteOpen ? bindAddr : std::string("127.0.0.1")) << ":" << port << std::endl;
    svr.listen(bindAddr, port);
}
