#include "server.h"
#include "playback.h"
#include "httplib.h"
#include <iostream>
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

namespace fs = std::filesystem;

namespace {

// Minimal JSON string escaping — titles/filenames can contain
// quotes or backslashes, and the rest of this file builds JSON via
// plain concatenation, so every dynamic string needs this before
// being interpolated.
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

    registerPlaybackRoutes(svr, scanner);   // /api/stream/<id>
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

    std::cout << "[Hesper Server] Local web UI & API online at http://localhost:" << port << std::endl;
    svr.listen("0.0.0.0", port);
}
