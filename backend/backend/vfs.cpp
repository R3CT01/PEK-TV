#include "vfs.h"

#include <sys/stat.h>
#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>

namespace vfs {

namespace {
const std::string kScheme = "smb://";

std::mutex g_mutex;
std::string g_file;
std::map<std::string, std::pair<std::string, std::string>> g_saved;     // host -> user, pass (on disk)
std::map<std::string, std::pair<std::string, std::string>> g_session;   // host -> user, pass (this run)

std::string lowerHost(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
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
} // namespace

bool isRemote(const std::string& path) {
    return path.compare(0, kScheme.size(), kScheme) == 0;
}

bool parseUrl(const std::string& url, Url& out) {
    if (!isRemote(url)) return false;
    std::string rest = url.substr(kScheme.size());
    size_t slash = rest.find('/');
    out.host = rest.substr(0, slash);
    out.share.clear();
    out.path.clear();
    if (out.host.empty()) return false;
    if (slash == std::string::npos) return true;
    rest = rest.substr(slash + 1);
    size_t s2 = rest.find('/');
    out.share = rest.substr(0, s2);
    if (s2 != std::string::npos) out.path = rest.substr(s2 + 1);
    // Normalise: no trailing slash, no empty or ".." segments (a share URL must
    // never be able to climb out of its share).
    std::vector<std::string> parts;
    std::stringstream ss(out.path);
    std::string seg;
    while (std::getline(ss, seg, '/')) {
        if (seg.empty() || seg == ".") continue;
        if (seg == "..") return false;
        parts.push_back(seg);
    }
    out.path.clear();
    for (size_t i = 0; i < parts.size(); ++i) out.path += (i ? "/" : "") + parts[i];
    return true;
}

std::string buildUrl(const Url& u) {
    std::string s = kScheme + u.host;
    if (!u.share.empty()) {
        s += "/" + u.share;
        if (!u.path.empty()) s += "/" + u.path;
    }
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
    if (u.share.empty()) return "";
    if (u.path.empty()) { u.share.clear(); return buildUrl(u); }
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
        std::string host, user, pass;
        if (std::getline(iss, host, '\t') && std::getline(iss, user, '\t')) {
            std::getline(iss, pass);
            g_saved[lowerHost(host)] = {user, pass};
        }
    }
}

void setCredentials(const std::string& host, const std::string& user, const std::string& pass, bool persist) {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string h = lowerHost(host);
    g_session[h] = {clean(user), clean(pass)};
    if (persist) {
        g_saved[h] = g_session[h];
        writeFileLocked();
    }
}

void persistCredentials(const std::string& host) {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string h = lowerHost(host);
    auto it = g_session.find(h);
    if (it == g_session.end()) return;
    g_saved[h] = it->second;
    writeFileLocked();
}

bool getCredentials(const std::string& host, std::string& user, std::string& pass) {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string h = lowerHost(host);
    auto it = g_session.find(h);
    if (it != g_session.end()) { user = it->second.first; pass = it->second.second; return true; }
    auto saved = g_saved.find(h);
    if (saved != g_saved.end()) { user = saved->second.first; pass = saved->second.second; return true; }
    return false;
}

#ifndef HESPER_SMB
// Built without libsmb2: discovery still works, but connecting says why it can't.
bool smbAvailable() { return false; }

std::unique_ptr<Share> connectShare(const std::string&, const std::string&, Error& err) {
    err.auth = false;
    err.msg = "This build of Hesper has no SMB support.";
    return nullptr;
}

bool listShares(const std::string&, std::vector<std::string>&, Error& err) {
    err.auth = false;
    err.msg = "This build of Hesper has no SMB support.";
    return false;
}
#endif

} // namespace vfs
