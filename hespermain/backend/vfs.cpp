#include "vfs.h"
#include "vfs_backends.h"

#include <sys/stat.h>
#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>

namespace vfs {

namespace {
const char* const kSchemes[] = {"smb", "nfs", "ftp", "dav", "davs", "upnp"};

std::mutex g_mutex;
std::string g_file;
std::map<std::string, std::pair<std::string, std::string>> g_saved;     // "scheme://host" -> user, pass (on disk)
std::map<std::string, std::pair<std::string, std::string>> g_session;   // same, this run only

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

std::string credKey(const std::string& scheme, const std::string& host) {
    return lower(scheme) + "://" + lower(host);
}

// A field in the credentials file may not contain tab or newline.
std::string clean(const std::string& s) {
    std::string out;
    for (char c : s) if (c != '\t' && c != '\n' && c != '\r') out += c;
    return out;
}

void writeFileLocked() {
    if (g_file.empty()) return;
    std::ofstream out(g_file, std::ios::trunc);
    if (!out.is_open()) {
        std::cout << "[VFS] Could not write " << g_file << std::endl;
        return;
    }
    for (const auto& kv : g_saved) out << kv.first << '\t' << kv.second.first << '\t' << kv.second.second << '\n';
    out.close();
    chmod(g_file.c_str(), 0600);      // owner only (no effect on some Android storage, which is app-private anyway)
}

std::string schemeOf(const std::string& url) {
    size_t p = url.find("://");
    return p == std::string::npos ? "" : lower(url.substr(0, p));
}
} // namespace

bool knownScheme(const std::string& scheme) {
    for (const char* s : kSchemes) if (scheme == s) return true;
    return false;
}

bool isRemote(const std::string& path) {
    return knownScheme(schemeOf(path));
}

bool hasShares(const std::string& scheme) {
    return scheme == "smb" || scheme == "nfs" || scheme == "upnp";
}

std::string schemeLabel(const std::string& scheme) {
    if (scheme == "smb") return "SMB";
    if (scheme == "nfs") return "NFS";
    if (scheme == "ftp") return "FTP";
    if (scheme == "dav" || scheme == "davs") return "WebDAV";
    if (scheme == "upnp") return "DLNA";
    return scheme;
}

std::string urlEncode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += static_cast<char>(c);
        else { out += '%'; out += hex[c >> 4]; out += hex[c & 15]; }
    }
    return out;
}

std::string urlDecode(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size() &&
            std::isxdigit(static_cast<unsigned char>(s[i + 1])) && std::isxdigit(static_cast<unsigned char>(s[i + 2]))) {
            out += static_cast<char>(std::stoi(s.substr(i + 1, 2), nullptr, 16));
            i += 2;
        } else {
            out += s[i];
        }
    }
    return out;
}

bool parseUrl(const std::string& url, Url& out) {
    std::string scheme = schemeOf(url);
    if (!knownScheme(scheme)) return false;
    std::string rest = url.substr(scheme.size() + 3);
    size_t slash = rest.find('/');
    out = Url();
    out.scheme = scheme;
    out.host = rest.substr(0, slash);
    if (out.host.empty()) return false;
    if (slash == std::string::npos) return true;
    rest = rest.substr(slash + 1);

    std::string pathPart = rest;
    if (hasShares(scheme)) {
        size_t s2 = rest.find('/');
        out.share = rest.substr(0, s2);
        pathPart = (s2 == std::string::npos) ? "" : rest.substr(s2 + 1);
    }
    // Normalise: no trailing slash, no empty or ".." segments (a URL must
    // never be able to climb out of its share).
    std::vector<std::string> parts;
    std::stringstream ss(pathPart);
    std::string seg;
    while (std::getline(ss, seg, '/')) {
        if (seg.empty() || seg == ".") continue;
        if (seg == "..") return false;
        parts.push_back(seg);
    }
    for (size_t i = 0; i < parts.size(); ++i) out.path += (i ? "/" : "") + parts[i];
    if (urlDecode(out.share) == "..") return false;
    return true;
}

std::string buildUrl(const Url& u) {
    std::string s = u.scheme + "://" + u.host;
    if (!u.share.empty()) s += "/" + u.share;
    if (!u.path.empty()) s += "/" + u.path;
    return s;
}

std::string join(const std::string& dirUrl, const std::string& name) {
    std::string d = dirUrl;
    while (!d.empty() && d.back() == '/') d.pop_back();
    return d + "/" + name;
}

std::string parent(const std::string& url) {
    Url u;
    if (!parseUrl(url, u)) return "";
    if (u.path.empty()) {
        if (u.share.empty()) return "";
        if (u.scheme == "upnp") return "";      // a media server has no list of shares above it
        u.share.clear();
        return buildUrl(u);
    }
    size_t slash = u.path.rfind('/');
    u.path = (slash == std::string::npos) ? "" : u.path.substr(0, slash);
    return buildUrl(u);
}

void init(const std::string& credentialsFile) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_file = credentialsFile;
    g_saved.clear();
    std::ifstream in(g_file);
    std::string line;
    while (std::getline(in, line)) {
        std::istringstream iss(line);
        std::string key, user, pass;
        if (std::getline(iss, key, '\t') && std::getline(iss, user, '\t')) {
            std::getline(iss, pass);
            if (key.find("://") != std::string::npos) g_saved[lower(key)] = {user, pass};
        }
    }
}

void setCredentials(const std::string& scheme, const std::string& host,
                    const std::string& user, const std::string& pass, bool persist) {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string k = credKey(scheme, host);
    g_session[k] = {clean(user), clean(pass)};
    if (persist) {
        g_saved[k] = g_session[k];
        writeFileLocked();
    }
}

void persistCredentials(const std::string& scheme, const std::string& host) {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string k = credKey(scheme, host);
    auto it = g_session.find(k);
    if (it == g_session.end()) return;
    g_saved[k] = it->second;
    writeFileLocked();
}

bool getCredentials(const std::string& scheme, const std::string& host, std::string& user, std::string& pass) {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string k = credKey(scheme, host);
    auto it = g_session.find(k);
    if (it != g_session.end()) { user = it->second.first; pass = it->second.second; return true; }
    auto saved = g_saved.find(k);
    if (saved != g_saved.end()) { user = saved->second.first; pass = saved->second.second; return true; }
    return false;
}

// ---------------------------------------------------------------- dispatch

#ifndef HESPER_SMB
std::unique_ptr<Share> smbConnect(const Url&, Error& err) {
    err.auth = false;
    err.msg = "This build of PEK has no SMB support.";
    return nullptr;
}
bool smbListShares(const Url&, std::vector<std::string>&, Error& err) {
    err.auth = false;
    err.msg = "This build of PEK has no SMB support.";
    return false;
}
#endif

#ifndef HESPER_NFS
std::unique_ptr<Share> nfsConnect(const Url&, Error& err) {
    err.auth = false;
    err.msg = "This build of PEK has no NFS support.";
    return nullptr;
}
bool nfsListShares(const Url&, std::vector<std::string>&, Error& err) {
    err.auth = false;
    err.msg = "This build of PEK has no NFS support.";
    return false;
}
#endif

bool available(const std::string& scheme) {
    if (scheme == "smb") {
#ifdef HESPER_SMB
        return true;
#else
        return false;
#endif
    }
    if (scheme == "nfs") {
#ifdef HESPER_NFS
        return true;
#else
        return false;
#endif
    }
    return knownScheme(scheme);
}

std::unique_ptr<Share> connect(const Url& u, Error& err) {
    if (hasShares(u.scheme) && u.share.empty()) {
        err.auth = false;
        err.msg = "Pick a share first.";
        return nullptr;
    }
    if (u.scheme == "smb") return smbConnect(u, err);
    if (u.scheme == "nfs") return nfsConnect(u, err);
    if (u.scheme == "ftp") return ftpConnect(u, err);
    if (u.scheme == "dav" || u.scheme == "davs") return davConnect(u, err);
    if (u.scheme == "upnp") return upnpConnect(u, err);
    err.auth = false;
    err.msg = "Unknown network type.";
    return nullptr;
}

bool listShares(const Url& u, std::vector<std::string>& shares, Error& err) {
    if (u.scheme == "smb") return smbListShares(u, shares, err);
    if (u.scheme == "nfs") return nfsListShares(u, shares, err);
    err.auth = false;
    err.msg = u.scheme == "upnp" ? "Choose the media server from the list of devices."
                                  : "This type of location has no list of shares.";
    return false;
}

} // namespace vfs
