// ============================================================
// PEK skin installer (header-only, reuses the plugin installer's helpers).
//
// A skin is a .zip with skin.json (name, author, description, version, tokens) and,
// optionally, skin.css plus images and fonts. The web UI unpacks the zip itself and
// sends the files to POST /api/skins/install. Everything that decides what ends up on
// disk is checked HERE, so a hand-made request gets no more than the UI does:
//   - the skin id is a short, safe folder name, and not a bundled skin
//   - every file path is relative, plain and stays inside the skin folder
//   - only data files are accepted: JSON, CSS, images, fonts, text. Never code
//     (.js, .py, .html, .svg ...), so a skin can restyle PEK but never run anything
//   - skin.css may not @import anything or load anything from the network, and may not
//     use backslash escapes (they could hide those rules)
//   - a plugin is not a skin: plugin.json, ui.js and backend.py are refused here, and the
//     plugin installer (plugin_install.h) refuses a zip that has skin.json
//   - size and file-count limits
// Nothing is written until every check passes, and an update swaps the old folder out
// only after the new one was written completely.
// ============================================================
#pragma once

#include "plugin_install.h"

namespace pek_skins {

namespace fs = std::filesystem;
using pek_plugins::InFile;
using pek_plugins::Outcome;

constexpr size_t kMaxFiles      = 60;
constexpr size_t kMaxFileBytes  = 2u * 1024 * 1024;
constexpr size_t kMaxTotalBytes = 6u * 1024 * 1024;
constexpr size_t kMaxManifest   = 16u * 1024;

// Skins that ship with PEK (kept in step with skin_installer.js).
inline bool isReservedId(const std::string& id) {
    return id == "default" || id == "green" || id == "neon";
}

inline bool allowedExtension(const std::string& ext) {
    static const std::set<std::string> ok = {
        "json", "css", "md", "txt",
        "png", "jpg", "jpeg", "gif", "webp", "ico",
        "woff", "woff2", "ttf", "otf"
    };
    return ok.count(ext) > 0;
}

// Returns "" if the stylesheet is fine, otherwise the reason.
inline std::string checkCss(const std::string& path, const std::string& css) {
    const std::string c = pek_plugins::lowerCopy(css);
    if (c.find('\\') != std::string::npos)
        return path + " uses a backslash escape, which skins can't use";
    static const char* banned[] = { "@import", "expression(", "javascript:", "-moz-binding", "behavior:", "<script", "</style" };
    for (const char* b : banned)
        if (c.find(b) != std::string::npos)
            return path + " uses something skins can't use (" + b + ")";
    size_t pos = 0;
    while ((pos = c.find("url(", pos)) != std::string::npos) {
        const size_t end = c.find(')', pos + 4);
        if (end == std::string::npos) return path + " has an unfinished url()";
        std::string arg = c.substr(pos + 4, end - pos - 4);
        pos = end;
        size_t a = 0, b = arg.size();
        while (a < b && (std::isspace(static_cast<unsigned char>(arg[a])) || arg[a] == '"' || arg[a] == '\'')) ++a;
        while (b > a && (std::isspace(static_cast<unsigned char>(arg[b - 1])) || arg[b - 1] == '"' || arg[b - 1] == '\'')) --b;
        arg = arg.substr(a, b - a);
        if (arg.empty() || arg[0] == '#') continue;
        if (arg.compare(0, 11, "data:image/") == 0 || arg.compare(0, 10, "data:font/") == 0 ||
            arg.compare(0, 21, "data:application/font") == 0 || arg.compare(0, 23, "data:application/x-font") == 0) continue;
        if (arg.find(':') != std::string::npos || arg.compare(0, 2, "//") == 0)
            return path + " loads something from outside the skin (" + arg.substr(0, 40) + ")";
        if (arg[0] == '/' || arg.find("..") != std::string::npos)
            return path + " points outside the skin folder (" + arg.substr(0, 40) + ")";
    }
    return "";
}

// Validates everything except the id. Returns "" if fine.
inline std::string checkFiles(const std::vector<InFile>& files, size_t& totalBytes) {
    totalBytes = 0;
    if (files.empty()) return "the skin has no files";
    if (files.size() > kMaxFiles) return "too many files (limit " + std::to_string(kMaxFiles) + ")";
    std::set<std::string> seen;
    bool hasManifest = false;
    for (const auto& f : files) {
        std::string why = pek_plugins::checkRelativePath(f.path);
        if (!why.empty()) return why;
        if (!seen.insert(pek_plugins::lowerCopy(f.path)).second) return "the same file appears twice: " + f.path;
        if (f.data.size() > kMaxFileBytes) return f.path + " is too large (limit 2 MB per file)";
        totalBytes += f.data.size();
        if (totalBytes > kMaxTotalBytes) return "the skin is too large (limit 6 MB in total)";

        // A plugin is not a skin.
        if (f.path == "plugin.json" || f.path == "ui.js" || f.path == "backend.py")
            return "this is a plugin, not a skin. Install it from Settings -> Plugins.";

        const std::string ext = pek_plugins::extensionOf(f.path);
        if (ext == "js" || ext == "py") return "skins can't contain code: " + f.path;
        if (!allowedExtension(ext)) return "file type not allowed in skins: " + f.path;

        if (f.path == "skin.json") {
            hasManifest = true;
            if (f.data.size() > kMaxManifest) return "skin.json is too large";
            size_t a = 0;
            if (f.data.compare(0, 3, "\xEF\xBB\xBF") == 0) a = 3;            // UTF-8 BOM
            while (a < f.data.size() && std::isspace(static_cast<unsigned char>(f.data[a]))) ++a;
            if (a >= f.data.size() || f.data[a] != '{') return "skin.json is not a JSON object";
            if (f.data.find("\"name\"") == std::string::npos) return "skin.json needs a \"name\"";
            if (pek_plugins::lowerCopy(f.data).find("url(") != std::string::npos)
                return "skin.json can't use url(). Put images in skin.css, and use a plain gradient for bgImage.";
        }
        if (ext == "css") {
            why = checkCss(f.path, f.data);
            if (!why.empty()) return why;
        }
    }
    if (!hasManifest) return "skin.json is missing";
    return "";
}

// dryRun == true: run every check and report, write nothing.
inline Outcome install(const std::string& skinsDir, const std::string& id,
                       const std::vector<InFile>& files, bool dryRun) {
    Outcome out;
    out.id = id;
    if (!pek_plugins::validId(id)) { out.error = "the skin id must be 1-40 lowercase letters, digits, - or _"; return out; }
    if (isReservedId(id)) { out.error = "\"" + id + "\" is a built-in skin and can't be replaced"; return out; }
    size_t total = 0;
    out.error = pek_skins::checkFiles(files, total);
    if (!out.error.empty()) return out;
    out.files = files.size();
    out.bytes = total;

    std::error_code ec;
    const fs::path root(skinsDir);
    const fs::path target = root / id;
    out.replaced = fs::is_directory(target, ec);
    if (dryRun) { out.ok = true; return out; }

    std::lock_guard<std::mutex> lock(pek_plugins::installMutex());
    fs::create_directories(root, ec);
    if (ec) { out.error = "could not create the skins folder"; return out; }

    // Hidden folders (leading '.') are ignored by the skin list, so a half-finished
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
            if (dest.string().compare(0, stagingNorm.size(), stagingNorm) != 0)
                throw std::runtime_error("path escapes the skin folder");
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

    if (out.replaced) {
        fs::rename(target, backup, ec);
        if (ec) { fs::remove_all(staging, ec); out.error = "could not replace the installed copy"; return out; }
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

// Removes an installed skin. Bundled skins can't be removed, and only a folder that really
// is a skin (has skin.json) is touched.
inline Outcome uninstall(const std::string& skinsDir, const std::string& id) {
    Outcome out;
    out.id = id;
    if (!pek_plugins::validId(id)) { out.error = "invalid skin id"; return out; }
    if (isReservedId(id)) { out.error = "\"" + id + "\" is a built-in skin and can't be removed"; return out; }
    std::lock_guard<std::mutex> lock(pek_plugins::installMutex());
    std::error_code ec;
    const fs::path target = fs::path(skinsDir) / id;
    if (!fs::is_directory(target, ec) || !fs::is_regular_file(target / "skin.json", ec)) {
        out.error = "that skin is not installed";
        return out;
    }
    fs::remove_all(target, ec);
    if (ec) { out.error = "could not remove the skin folder"; return out; }
    out.ok = true;
    return out;
}

} // namespace pek_skins
