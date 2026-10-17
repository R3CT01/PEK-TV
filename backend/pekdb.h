#ifndef PEKDB_H
#define PEKDB_H

// A thin wrapper over SQLite for PEK TV's media library and music library (replaces the old tab-separated cache files).
//   * One connection per database file. Every change is a transaction with SQLite's normal rollback journal and full
//     syncing, so a power cut on a TV box can never leave half a file. (WAL mode is deliberately not used: it needs
//     memory-mapped shared files, which Android's shared storage and some SD cards / network shares do not support.)
//   * A damaged file is moved aside (name.corrupt) and a fresh one is started: a library is only a cache of what is
//     on disk, so the worst case is one rescan.
//   * Everything is serialized through the SQLite connection itself (FULLMUTEX); callers that need several statements
//     to land together use Tx.
// No exceptions are thrown: every call reports failure through its return value and lastError().
#include <sqlite3.h>

#include <cstdint>
#include <filesystem>
#include <iostream>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

namespace pekdb {

class Db {
public:
    Db() = default;
    Db(const Db&) = delete;
    Db& operator=(const Db&) = delete;
    ~Db() { close(); }

    bool isOpen() const { return h_ != nullptr; }
    sqlite3* handle() const { return h_; }
    const std::string& path() const { return path_; }
    std::string lastError() const { return h_ ? std::string(sqlite3_errmsg(h_)) : std::string("database is not open"); }

    // Opens (creating if needed) the file. A file that is not a database, or is corrupt, is renamed to <path>.corrupt
    // and replaced by an empty one.
    bool open(const std::string& path) {
        close();
        path_ = path;
        if (openRaw() && healthy()) return configure();
        const bool damaged = h_ != nullptr;
        close();
        if (damaged || std::filesystem::exists(path)) {
            std::error_code ec;
            std::filesystem::remove(path + ".corrupt", ec);
            std::filesystem::rename(path, path + ".corrupt", ec);
            std::filesystem::remove(path + "-journal", ec);
            std::cout << "[Db] " << path << " was damaged; started a new one (old one kept as .corrupt)" << std::endl;
        }
        if (!openRaw()) return false;
        return configure();
    }

    void close() {
        if (h_) { sqlite3_close(h_); h_ = nullptr; }
    }

    bool exec(const std::string& sql) {
        if (!h_) return false;
        char* err = nullptr;
        const int rc = sqlite3_exec(h_, sql.c_str(), nullptr, nullptr, &err);
        if (rc != SQLITE_OK) {
            std::cout << "[Db] SQL failed: " << (err ? err : "?") << "  <" << sql.substr(0, 80) << ">" << std::endl;
            if (err) sqlite3_free(err);
            return false;
        }
        return true;
    }

    long long scalar(const std::string& sql, long long fallback = 0) {
        sqlite3_stmt* st = nullptr;
        if (!h_ || sqlite3_prepare_v2(h_, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) return fallback;
        long long v = fallback;
        if (sqlite3_step(st) == SQLITE_ROW) v = sqlite3_column_int64(st, 0);
        sqlite3_finalize(st);
        return v;
    }

    int userVersion() { return static_cast<int>(scalar("PRAGMA user_version")); }
    void setUserVersion(int v) { exec("PRAGMA user_version=" + std::to_string(v)); }

private:
    sqlite3* h_ = nullptr;
    std::string path_;

    bool openRaw() {
        const int rc = sqlite3_open_v2(path_.c_str(), &h_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr);
        if (rc != SQLITE_OK) {
            std::cout << "[Db] Cannot open " << path_ << ": " << lastError() << std::endl;
            close();
            return false;
        }
        sqlite3_busy_timeout(h_, 5000);
        return true;
    }
    // A read of the schema fails right away on a file that is not a database or is badly damaged.
    bool healthy() {
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(h_, "SELECT count(*) FROM sqlite_master", -1, &st, nullptr) != SQLITE_OK) return false;
        const int rc = sqlite3_step(st);
        sqlite3_finalize(st);
        return rc == SQLITE_ROW;
    }
    bool configure() {
        exec("PRAGMA temp_store=MEMORY");
        return true;
    }
};

// One prepared statement. Parameters are 1-based; columns 0-based.
class Stmt {
public:
    Stmt(Db& db, const std::string& sql) {
        if (!db.handle() || sqlite3_prepare_v2(db.handle(), sql.c_str(), -1, &st_, nullptr) != SQLITE_OK) {
            std::cout << "[Db] Cannot prepare: " << db.lastError() << "  <" << sql.substr(0, 80) << ">" << std::endl;
            st_ = nullptr;
        }
    }
    Stmt(const Stmt&) = delete;
    Stmt& operator=(const Stmt&) = delete;
    ~Stmt() { if (st_) sqlite3_finalize(st_); }

    bool ok() const { return st_ != nullptr; }
    Stmt& text(int i, const std::string& v) { if (st_) sqlite3_bind_text(st_, i, v.c_str(), static_cast<int>(v.size()), SQLITE_TRANSIENT); return *this; }
    Stmt& i64(int i, long long v) { if (st_) sqlite3_bind_int64(st_, i, v); return *this; }
    Stmt& real(int i, double v) { if (st_) sqlite3_bind_double(st_, i, v); return *this; }
    Stmt& null(int i) { if (st_) sqlite3_bind_null(st_, i); return *this; }

    // true = a row is ready to read
    bool step() { return st_ && sqlite3_step(st_) == SQLITE_ROW; }
    // Runs a statement that returns no rows. true = it worked.
    bool run() {
        if (!st_) return false;
        const int rc = sqlite3_step(st_);
        return rc == SQLITE_DONE || rc == SQLITE_ROW;
    }
    void reset() { if (st_) { sqlite3_reset(st_); sqlite3_clear_bindings(st_); } }

    std::string str(int c) const {
        if (!st_) return std::string();
        const unsigned char* p = sqlite3_column_text(st_, c);
        return p ? std::string(reinterpret_cast<const char*>(p), static_cast<size_t>(sqlite3_column_bytes(st_, c))) : std::string();
    }
    long long num(int c) const { return st_ ? sqlite3_column_int64(st_, c) : 0; }
    double dbl(int c) const { return st_ ? sqlite3_column_double(st_, c) : 0.0; }

private:
    sqlite3_stmt* st_ = nullptr;
};

// BEGIN IMMEDIATE ... COMMIT. Leaving scope without commit() rolls back.
class Tx {
public:
    explicit Tx(Db& db) : db_(db) { open_ = db_.exec("BEGIN IMMEDIATE"); }
    Tx(const Tx&) = delete;
    Tx& operator=(const Tx&) = delete;
    ~Tx() { if (open_) db_.exec("ROLLBACK"); }
    bool ok() const { return open_; }
    bool commit() {
        if (!open_) return false;
        open_ = false;
        return db_.exec("COMMIT");
    }
private:
    Db& db_;
    bool open_ = false;
};

// ---- text folding for search: lower-case, accents removed ("Beyoncé" -> "beyonce"), punctuation -> single spaces ----
// Works on UTF-8. Letters outside the Latin range (Cyrillic, Greek, CJK...) are kept and only lower-cased where that is
// a simple ASCII / Latin-1 / Cyrillic / Greek rule.
inline std::string fold(const std::string& in) {
    static const char* const kLatin1 =   // U+00C0..U+00FF
        "aaaaaaaceeeeiiiidnooooo/ouuuuyts"      // C0-DF (capitals map the same as small ones)
        "aaaaaaaceeeeiiiidnooooo/ouuuuyty";     // E0-FF
    static const char* const kExtA =     // U+0100..U+017F
        "aaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiiiiijjkkkllllllllllnnnnnnnnnoooooooorrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzs";
    std::string out;
    out.reserve(in.size());
    bool space = true;                     // swallow leading separators
    auto push = [&](char c) { out += c; space = false; };
    auto sep = [&]() { if (!space) { out += ' '; space = true; } };
    for (size_t i = 0; i < in.size();) {
        const unsigned char c = static_cast<unsigned char>(in[i]);
        if (c < 0x80) {
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) push(static_cast<char>(c));
            else if (c >= 'A' && c <= 'Z') push(static_cast<char>(c - 'A' + 'a'));
            else if (c == '\'') { /* "don't" -> "dont" */ }
            else sep();
            ++i;
            continue;
        }
        unsigned cp = 0;
        int len = 1;
        if ((c & 0xE0) == 0xC0 && i + 1 < in.size()) { cp = ((c & 0x1Fu) << 6) | (static_cast<unsigned char>(in[i + 1]) & 0x3Fu); len = 2; }
        else if ((c & 0xF0) == 0xE0 && i + 2 < in.size()) {
            cp = ((c & 0x0Fu) << 12) | ((static_cast<unsigned char>(in[i + 1]) & 0x3Fu) << 6) | (static_cast<unsigned char>(in[i + 2]) & 0x3Fu);
            len = 3;
        } else if ((c & 0xF8) == 0xF0 && i + 3 < in.size()) { len = 4; cp = 0x10000; }
        if (cp >= 0xC0 && cp <= 0xFF) {
            const char b = kLatin1[cp - 0xC0];
            if (b == '/') sep(); else if (cp == 0xDF) { push('s'); push('s'); } else push(b);
        } else if (cp >= 0x100 && cp <= 0x17F) {
            push(kExtA[cp - 0x100]);
        } else if (cp >= 0x410 && cp <= 0x42F) {            // Cyrillic capitals -> small
            const unsigned lc = cp + 0x20;
            out += static_cast<char>(0xC0 | (lc >> 6)); out += static_cast<char>(0x80 | (lc & 0x3F)); space = false;
        } else if (cp >= 0x391 && cp <= 0x3A9) {            // Greek capitals -> small
            const unsigned lc = cp + 0x20;
            out += static_cast<char>(0xC0 | (lc >> 6)); out += static_cast<char>(0x80 | (lc & 0x3F)); space = false;
        } else if (cp == 0x2019 || cp == 0x2018) {          // curly apostrophes
        } else if (cp >= 0x2000 && cp <= 0x206F) {          // general punctuation, dashes
            sep();
        } else {
            out.append(in, i, static_cast<size_t>(len)); space = false;
        }
        i += static_cast<size_t>(len);
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

// Splits a folded string into words.
inline std::vector<std::string> words(const std::string& folded) {
    std::vector<std::string> w;
    size_t i = 0;
    while (i < folded.size()) {
        size_t j = folded.find(' ', i);
        if (j == std::string::npos) j = folded.size();
        if (j > i) w.push_back(folded.substr(i, j - i));
        i = j + 1;
    }
    return w;
}

// Escapes % _ \ for a LIKE ... ESCAPE '\' pattern.
inline std::string likeEscape(const std::string& s) {
    std::string o;
    for (char c : s) { if (c == '%' || c == '_' || c == '\\') o += '\\'; o += c; }
    return o;
}

}  // namespace pekdb

#endif
