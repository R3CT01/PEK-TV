// ============================================================
// PEK plugin installer (header-only, no extra libraries).
//
// The web UI unpacks a plugin .zip itself and sends the files to
// POST /api/plugins/install. Everything that decides what ends up on
// disk is checked HERE, so a hand-made request gets no more than the
// UI does:
//   - the plugin id is a short, safe folder name, and not a bundled one
//   - every file path is relative, plain and stays inside the plugin folder
//   - only plain file types are accepted: JSON, CSS, images, fonts, text, and
//     Python (.py) for a plugin's optional backend. No .so, .dex, .html, .svg ...
//     A third-party backend.py is not trusted: hesper_guard.py only runs it if plugin.json
//     declares its permissions and it passes the guard's source scan, and then it can only
//     use the hosts it declared and its own data/ folder.
//   - setting PEK_ALLOW_PLUGIN_BACKEND=0 refuses .py files altogether (for example for a
//     store build that must not install code from files)
//   - size and file-count limits
//   - plugin.json and screen.py are required, and plugin.json must have a "flutter" entry. A plugin that only has
//     a ui.js (a JavaScript screen for the classic UI) is no longer installed, and no .js / .mjs file of any kind is
//     accepted in a plugin (server.cpp also refuses to serve .js from /plugins/).
// Nothing is written until every check passes, and an update swaps the old
// folder out only after the new one was written completely.
// ============================================================
#pragma once

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <utility>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

namespace pek_plugins {

namespace fs = std::filesystem;

struct InFile {
    std::string path;   // relative to the plugin folder, "/" separated
    std::string data;
};

struct Outcome {
    bool ok = false;
    std::string error;      // plain-English reason when ok == false
    std::string id;
    size_t files = 0;
    size_t bytes = 0;
    bool replaced = false;  // an installed copy with this id already existed
};

// Limits
constexpr size_t kMaxFiles       = 200;
constexpr size_t kMaxFileBytes   = 2u * 1024 * 1024;
constexpr size_t kMaxTotalBytes  = 8u * 1024 * 1024;
constexpr size_t kMaxManifest    = 16u * 1024;
constexpr size_t kMaxPathLen     = 120;
constexpr size_t kMaxDepth       = 6;

// Plugins that ship with PEK. They can't be replaced or removed here (on Android
// the app also re-copies them from its assets on every launch).
inline bool isReservedId(const std::string& id) {
    return id == "weather" || id == "sample_scraper" || id == "sample_counter" || id == "tmdb-discover" || id == "skin-maker";
}

// The built-in plugins the PEK Store may update (an "official" install, see install() below). The two sample plugins are
// retired and are never updated.
inline bool isStockId(const std::string& id) {
    return id == "weather" || id == "tmdb-discover" || id == "skin-maker";
}

// PEK's built-in TMDb access (a proxy that holds PEK's key) is for official plugins only.
// A plugin installed from a .zip can't list it, so it can't borrow PEK's key.
inline const char* reservedHost() { return "hesper-tmdb.aquariusibeats.workers.dev"; }

// Python backends are accepted unless PEK_ALLOW_PLUGIN_BACKEND=0.
inline bool backendAllowed() {
    const char* v = std::getenv("PEK_ALLOW_PLUGIN_BACKEND");
    if (!v) v = std::getenv("HESPER_ALLOW_PLUGIN_BACKEND");   // old name, still honoured
    return !(v && std::string(v) == "0");
}

// hesper_guard.py refuses to run a .py file bigger than this, so catch it at install time.
constexpr size_t kMaxPythonBytes = 200u * 1024;

// 1-40 chars: a-z 0-9 _ -, starting with a letter or digit.
inline bool validId(const std::string& id) {
    if (id.empty() || id.size() > 40) return false;
    if (!std::isalnum(static_cast<unsigned char>(id[0])) || std::isupper(static_cast<unsigned char>(id[0]))) return false;
    for (unsigned char c : id) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

inline std::string lowerCopy(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

inline std::string extensionOf(const std::string& path) {
    const size_t slash = path.find_last_of('/');
    const std::string name = slash == std::string::npos ? path : path.substr(slash + 1);
    const size_t dot = name.find_last_of('.');
    return dot == std::string::npos ? std::string() : lowerCopy(name.substr(dot + 1));
}

inline bool allowedExtension(const std::string& ext) {
    static const std::set<std::string> ok = {
        "json", "css", "md", "txt",        // no "js": plugins are Python only
        "png", "jpg", "jpeg", "gif", "webp", "ico",
        "woff", "woff2", "ttf", "otf"
    };
    if (ok.count(ext)) return true;
    return ext == "py" && backendAllowed();
}

// Returns "" if the path is fine, otherwise the reason.
inline std::string checkRelativePath(const std::string& p) {
    if (p.empty()) return "a file has an empty name";
    if (p.size() > kMaxPathLen) return "a file path is too long: " + p.substr(0, 40) + "...";
    if (p[0] == '/') return "absolute paths are not allowed: " + p;
    size_t start = 0, depth = 0;
    while (start <= p.size()) {
        size_t end = p.find('/', start);
        if (end == std::string::npos) end = p.size();
        const std::string part = p.substr(start, end - start);
        if (part.empty()) return "bad path (empty folder name): " + p;
        if (part == "." || part == "..") return "bad path (. or ..): " + p;
        if (part[0] == '.') return "hidden files are not allowed: " + p;
        if (part.size() > 64) return "a file or folder name is too long in: " + p;
        if (part.back() == '.' || part.back() == ' ') return "bad file name: " + p;
        for (unsigned char c : part) {
            if (c < 0x20 || c == 0x7f || c == '\\' || c == ':' || c == '*' || c == '?' ||
                c == '"' || c == '<' || c == '>' || c == '|')
                return "bad character in file name: " + p;
        }
        if (++depth > kMaxDepth) return "folders are nested too deeply: " + p;
        if (end == p.size()) break;
        start = end + 1;
    }
    return "";
}

// Validates everything except the id. Returns "" if fine.
inline std::string checkFiles(const std::vector<InFile>& files, size_t& totalBytes, bool official = false) {
    totalBytes = 0;
    if (files.empty()) return "the plugin has no files";
    if (files.size() > kMaxFiles) return "too many files (limit " + std::to_string(kMaxFiles) + ")";
    std::set<std::string> seen;
    bool hasManifest = false, hasScreen = false, hasFlutterEntry = false, hasSkin = false;
    for (const auto& f : files) {
        std::string why = checkRelativePath(f.path);
        if (!why.empty()) return why;
        if (!seen.insert(lowerCopy(f.path)).second) return "the same file appears twice: " + f.path;
        if (f.data.size() > kMaxFileBytes) return f.path + " is too large (limit 2 MB per file)";
        totalBytes += f.data.size();
        if (totalBytes > kMaxTotalBytes) return "the plugin is too large (limit 8 MB in total)";

        const std::string ext = extensionOf(f.path);
        if (ext == "js" || ext == "mjs")
            return "plugins can't include JavaScript any more (" + f.path + "). PEK TV only installs plugins written in Python (screen.py)";
        if (!allowedExtension(ext)) {
            if (ext == "py")
                return "this build of PEK TV doesn't install plugins that include Python code (" + f.path + ")";
            return "file type not allowed in plugins: " + f.path;
        }
        if (ext == "py" && f.data.size() > kMaxPythonBytes)
            return f.path + " is too large for a plugin backend (limit 200 KB)";
        if (f.path == "plugin.json") {
            hasManifest = true;
            if (f.data.size() > kMaxManifest) return "plugin.json is too large";
            size_t a = 0;
            if (f.data.compare(0, 3, "\xEF\xBB\xBF") == 0) a = 3;            // UTF-8 BOM
            while (a < f.data.size() && std::isspace(static_cast<unsigned char>(f.data[a]))) ++a;
            if (a >= f.data.size() || f.data[a] != '{') return "plugin.json is not a JSON object";
            if (!official && lowerCopy(f.data).find(reservedHost()) != std::string::npos)
                return std::string(reservedHost()) + " is reserved for PEK's official plugins";
            hasFlutterEntry = lowerCopy(f.data).find("\"flutter\"") != std::string::npos;
        }
        if (f.path == "screen.py") hasScreen = true;   // the Flutter UI's Python screen
        if (f.path == "skin.json") hasSkin = true;
    }
    // A skin is not a plugin (and a zip that is both is refused by both installers).
    if (hasSkin && !hasManifest) return "this is a skin, not a plugin. Install it from Settings -> Skins.";
    if (hasSkin) return "this zip has both plugin.json and skin.json, so it is not clearly a plugin or a skin";
    if (!hasManifest) return "plugin.json is missing";
    if (!hasScreen) return "screen.py is missing. PEK TV only installs plugins with a Python screen for the Flutter UI";
    if (!hasFlutterEntry) return "plugin.json needs a \"flutter\" entry, for example \"flutter\": { \"screen\": \"screen.py\" }";
    return "";
}

inline std::mutex& installMutex() {
    static std::mutex m;
    return m;
}

// dryRun == true: run every check and report, write nothing.
// official == true: the app is installing a built-in plugin's update that it downloaded from the PEK Store's Official shelf.
// Only then may a built-in plugin (weather, tmdb-discover) be replaced and the reserved TMDb host be listed. Every other check
// (paths, file types, sizes, Python only, screen.py) still applies.
inline Outcome install(const std::string& pluginsDir, const std::string& id,
                       const std::vector<InFile>& files, bool dryRun, bool official = false) {
    Outcome out;
    out.id = id;
    if (!validId(id)) { out.error = "the plugin id must be 1-40 lowercase letters, digits, - or _"; return out; }
    if (isReservedId(id) && !(official && isStockId(id))) { out.error = "\"" + id + "\" is a built-in plugin and can't be replaced"; return out; }
    size_t total = 0;
    out.error = checkFiles(files, total, official && isStockId(id));
    if (!out.error.empty()) return out;
    out.files = files.size();
    out.bytes = total;

    std::error_code ec;
    const fs::path root(pluginsDir);
    const fs::path target = root / id;
    out.replaced = fs::is_directory(target, ec);
    if (dryRun) { out.ok = true; return out; }

    std::lock_guard<std::mutex> lock(installMutex());
    fs::create_directories(root, ec);
    if (ec) { out.error = "could not create the plugins folder"; return out; }

    // Hidden folders (leading '.') are ignored by the plugin list, so a half-finished
    // install is never shown or loaded.
    const fs::path staging = root / (".installing-" + id);
    const fs::path backup  = root / (".old-" + id);
    fs::remove_all(staging, ec);
    fs::remove_all(backup, ec);
    ec.clear();

    const std::string stagingNorm = staging.lexically_normal().string();
    try {
        fs::create_directories(staging);
        for (const auto& f : files) {
            const fs::path dest = (staging / f.path).lexically_normal();
            // belt and braces: checkRelativePath already rules this out
            if (dest.string().compare(0, stagingNorm.size(), stagingNorm) != 0)
                throw std::runtime_error("path escapes the plugin folder");
            fs::create_directories(dest.parent_path());
            std::ofstream o(dest, std::ios::binary | std::ios::trunc);
            if (!o) throw std::runtime_error("could not write " + f.path);
            o.write(f.data.data(), static_cast<std::streamsize>(f.data.size()));
            o.close();
            if (!o) throw std::runtime_error("could not write " + f.path);
        }
    } catch (const std::exception& e) {
        fs::remove_all(staging, ec);
        out.error = std::string("install failed: ") + e.what();
        return out;
    }

    // Swap in. If the plugin was installed before, keep its data/ folder.
    if (out.replaced) {
        fs::rename(target, backup, ec);
        if (ec) { fs::remove_all(staging, ec); out.error = "could not replace the installed copy"; return out; }
        const fs::path oldData = backup / "data";
        if (fs::is_directory(oldData, ec) && !fs::exists(staging / "data", ec)) {
            fs::rename(oldData, staging / "data", ec);
            ec.clear();
        }
    }
    fs::rename(staging, target, ec);
    if (ec) {
        std::error_code ec2;
        if (out.replaced) fs::rename(backup, target, ec2);     // put the old copy back
        fs::remove_all(staging, ec2);
        out.error = "could not finish the install";
        return out;
    }
    fs::remove_all(backup, ec);
    out.ok = true;
    return out;
}

// Removes an installed plugin. Built-in plugins can't be removed.
inline Outcome uninstall(const std::string& pluginsDir, const std::string& id) {
    Outcome out;
    out.id = id;
    if (!validId(id)) { out.error = "invalid plugin id"; return out; }
    if (isReservedId(id)) { out.error = "\"" + id + "\" is a built-in plugin and can't be removed"; return out; }
    std::lock_guard<std::mutex> lock(installMutex());
    std::error_code ec;
    const fs::path target = fs::path(pluginsDir) / id;
    if (!fs::is_directory(target, ec)) { out.error = "that plugin is not installed"; return out; }
    fs::remove_all(target, ec);
    if (ec) { out.error = "could not remove the plugin folder"; return out; }
    out.ok = true;
    return out;
}

// Lists the files of an installed plugin that a backup may carry: only plain, allowed file types,
// never hidden files, never __pycache__, never the plugin's own data/ folder (that is the plugin's
// private, device-specific data). Returns false when the plugin is not installed.
struct ListedFile {
    std::string path;
    size_t size = 0;
    long long mtime = 0;    // seconds on the file system's own clock: only ever compared with itself
    bool operator<(const ListedFile& o) const { return path < o.path; }
};

inline bool listFiles(const std::string& pluginsDir, const std::string& id,
                      std::vector<ListedFile>& out) {
    out.clear();
    if (!validId(id) || isReservedId(id)) return false;
    std::error_code ec;
    const fs::path base = fs::path(pluginsDir) / id;
    if (!fs::is_directory(base, ec)) return false;
    for (fs::recursive_directory_iterator it(base, fs::directory_options::skip_permission_denied, ec), end; !ec && it != end; it.increment(ec)) {
        if (!it->is_regular_file(ec)) continue;
        std::string rel = fs::relative(it->path(), base, ec).generic_string();
        if (ec || rel.empty()) { ec.clear(); continue; }
        if (rel.compare(0, 5, "data/") == 0) continue;
        if (rel.find("__pycache__") != std::string::npos) continue;
        if (!checkRelativePath(rel).empty()) continue;
        if (!allowedExtension(extensionOf(rel))) continue;
        const uintmax_t sz = it->file_size(ec);
        if (ec) { ec.clear(); continue; }
        ListedFile lf;
        lf.path = rel;
        lf.size = static_cast<size_t>(sz);
        const auto wt = fs::last_write_time(it->path(), ec);
        if (!ec) lf.mtime = static_cast<long long>(std::chrono::duration_cast<std::chrono::seconds>(wt.time_since_epoch()).count());
        ec.clear();
        out.push_back(lf);
        if (out.size() > kMaxFiles) break;
    }
    std::sort(out.begin(), out.end());
    return true;
}

// Reads one backed-up file. Same path rules as an install, so nothing outside the plugin folder
// (and nothing under data/) can be read through it.
inline bool readFile(const std::string& pluginsDir, const std::string& id, const std::string& rel, std::string& data) {
    if (!validId(id) || isReservedId(id)) return false;
    if (!checkRelativePath(rel).empty() || rel.compare(0, 5, "data/") == 0) return false;
    if (!allowedExtension(extensionOf(rel))) return false;
    std::error_code ec;
    const fs::path f = fs::path(pluginsDir) / id / rel;
    if (!fs::is_regular_file(f, ec) || fs::file_size(f, ec) > kMaxFileBytes) return false;
    std::ifstream in(f, std::ios::binary);
    if (!in) return false;
    data.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    return true;
}

}  // namespace pek_plugins
