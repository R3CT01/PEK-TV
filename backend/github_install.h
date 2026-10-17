// ============================================================
// Install a plugin or a skin from GitHub: the download half (header-only).
//
//   POST /api/plugins/github-zip   owner=<user>  repo=<name>  url=<release or source zip link>
//
// The web side (www/github_install.js) asks api.github.com which release to use and then asks this
// route to fetch the zip, because release downloads are not reliably readable from a web view.
// What comes back is only the zip's bytes: it then goes through exactly the same checks as a .zip
// the person picked themselves (the server's safety checks, the permissions screen, a confirm).
//
// What this route will fetch is deliberately narrow, so it cannot be used to reach anything else:
//   https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.zip     a release file
//   https://api.github.com/repos/<owner>/<repo>/zipball/<ref>                the source of a tag
// and <owner>/<repo> in the link must match the owner and repo that were asked for.
//
// PEK_ALLOW_GITHUB=0 switches the whole feature off (for a build that must not install code
// from the internet, e.g. a store build). Needs a build with CPPHTTPLIB_OPENSSL_SUPPORT.
// ============================================================
#pragma once

#include <cstdlib>
#include <cctype>
#include <cstring>
#include <string>
#include <vector>

#include "httplib.h"

namespace pekgithub {

constexpr uint64_t kMaxZipBytes = 10u * 1024 * 1024;   // plugin_install.h caps a plugin at 8 MB unpacked

inline bool nameOk(const std::string& s, size_t maxLen, bool allowDotUnderscore) {
    if (s.empty() || s.size() > maxLen || s == "." || s == "..") return false;
    for (unsigned char c : s) {
        bool ok = std::isalnum(c) || c == '-' || (allowDotUnderscore && (c == '.' || c == '_'));
        if (!ok) return false;
    }
    return true;
}

// tag / ref / file name segments: no slash, no "..", a short safe character set (% allows an encoded tag).
inline bool segOk(const std::string& s) {
    if (s.empty() || s.size() > 200 || s == "." || s == ".." || s.find("..") != std::string::npos) return false;
    for (unsigned char c : s) {
        bool ok = std::isalnum(c) || c == '-' || c == '.' || c == '_' || c == '+' || c == '%' || c == '~';
        if (!ok) return false;
    }
    return true;
}

inline std::string lowerStr(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

inline bool endsWithZip(const std::string& s) {
    std::string l = lowerStr(s);
    return l.size() > 4 && l.compare(l.size() - 4, 4, ".zip") == 0;
}

// Splits "a/b/c" into parts. Rejects empty parts, so "a//b" and a trailing slash are refused.
inline bool splitPath(const std::string& p, std::vector<std::string>& out) {
    out.clear();
    size_t i = 0;
    while (i <= p.size()) {
        size_t j = p.find('/', i);
        if (j == std::string::npos) j = p.size();
        std::string part = p.substr(i, j - i);
        if (part.empty()) return false;
        out.push_back(part);
        i = j + 1;
        if (j == p.size()) break;
    }
    return true;
}

// Returns true when `url` is one of the two allowed shapes for this owner/repo. Fills host and path.
inline bool allowedUrl(const std::string& url, const std::string& owner, const std::string& repo,
                       std::string& host, std::string& path) {
    if (url.size() > 500 || url.find('?') != std::string::npos || url.find('#') != std::string::npos) return false;
    const std::string gh = "https://github.com/", api = "https://api.github.com/";
    std::vector<std::string> parts;
    if (url.rfind(gh, 0) == 0) {
        // <owner>/<repo>/releases/download/<tag>/<file>.zip
        if (!splitPath(url.substr(gh.size()), parts) || parts.size() != 6) return false;
        if (lowerStr(parts[0]) != lowerStr(owner) || lowerStr(parts[1]) != lowerStr(repo)) return false;
        if (parts[2] != "releases" || parts[3] != "download") return false;
        if (!segOk(parts[4]) || !segOk(parts[5]) || !endsWithZip(parts[5])) return false;
        host = "github.com";
        path = url.substr(std::string("https://github.com").size());
        return true;
    }
    if (url.rfind(api, 0) == 0) {
        // repos/<owner>/<repo>/zipball/<ref>
        if (!splitPath(url.substr(api.size()), parts) || parts.size() != 5) return false;
        if (parts[0] != "repos") return false;
        if (lowerStr(parts[1]) != lowerStr(owner) || lowerStr(parts[2]) != lowerStr(repo)) return false;
        if (parts[3] != "zipball" || !segOk(parts[4])) return false;
        host = "api.github.com";
        path = url.substr(std::string("https://api.github.com").size());
        return true;
    }
    return false;
}

inline void jsonError(httplib::Response& res, int status, const std::string& msg) {
    std::string esc;
    for (char c : msg) {
        if (c == '"' || c == '\\') { esc += '\\'; esc += c; }
        else if (static_cast<unsigned char>(c) < 0x20) esc += ' ';
        else esc += c;
    }
    res.status = status;
    res.set_content("{\"ok\": false, \"error\": \"" + esc + "\"}", "application/json");
}

#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
// Android has no CA store OpenSSL can find on its own: use the bundle shipped inside the app
// (SSL_CERT_FILE) and the system store (SSL_CERT_DIR), the same way the other HTTPS clients do.
inline void applyCa(httplib::SSLClient& c) {
    const char* f = std::getenv("SSL_CERT_FILE");
    const char* d = std::getenv("SSL_CERT_DIR");
    bool hasF = f && *f, hasD = d && *d;
    if (hasF || hasD) c.set_ca_cert_path(hasF ? f : "", hasD ? d : "");
}
#endif

inline void registerGithubRoutes(httplib::Server& svr) {
    svr.Post("/api/plugins/github-zip", [](const httplib::Request& req, httplib::Response& res) {
        const char* allow = std::getenv("PEK_ALLOW_GITHUB");
        if (!allow) allow = std::getenv("HESPER_ALLOW_GITHUB");   // old name, still honoured
        if (allow && std::string(allow) == "0") {
            jsonError(res, 403, "Installing from GitHub is turned off in this build.");
            return;
        }
        std::string owner = req.get_param_value("owner");
        std::string repo = req.get_param_value("repo");
        std::string url = req.get_param_value("url");
        if (!nameOk(owner, 39, false) || !nameOk(repo, 100, true)) {
            jsonError(res, 400, "That is not a valid GitHub owner/repo.");
            return;
        }
        std::string host, path;
        if (!allowedUrl(url, owner, repo, host, path)) {
            jsonError(res, 400, "That is not a download link for this repository.");
            return;
        }
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
        httplib::SSLClient cli(host, 443);
        applyCa(cli);
        cli.set_connection_timeout(10);
        cli.set_read_timeout(30);
        cli.set_follow_location(true);
        httplib::Headers hdrs = {
            {"User-Agent", "PEK-TV-plugin-installer"},
            {"Accept", "application/octet-stream, application/zip, */*"}};
        // Stop as soon as the download is too big to be a plugin, instead of reading it all.
        auto progress = [](uint64_t current, uint64_t total) {
            return current <= kMaxZipBytes && total <= kMaxZipBytes;
        };
        auto r = cli.Get(path, hdrs, progress);
        if (!r) {
            if (r.error() == httplib::Error::Canceled) jsonError(res, 413, "That file is too large to be a plugin or skin (limit 8 MB).");
            else jsonError(res, 502, "Couldn't reach GitHub (" + httplib::to_string(r.error()) + ").");
            return;
        }
        if (r->status == 404) { jsonError(res, 404, "GitHub could not find that file."); return; }
        if (r->status == 403 || r->status == 429) { jsonError(res, 429, "GitHub is limiting requests from this connection. Try again in a few minutes."); return; }
        if (r->status != 200) { jsonError(res, 502, "GitHub answered HTTP " + std::to_string(r->status) + "."); return; }
        if (r->body.size() > kMaxZipBytes) { jsonError(res, 413, "That file is too large to be a plugin or skin (limit 8 MB)."); return; }
        res.set_content(r->body, "application/zip");
#else
        jsonError(res, 501, "This build has no HTTPS support, so it can't install from GitHub.");
#endif
    });
}

}  // namespace pekgithub
