#ifndef VFS_H
#define VFS_H

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// Network file access for Hesper. A network location is written as an
//     smb://host/share/folder/sub
// URL everywhere (sources.tsv, the library cache, the API), so the scanner and
// the stream route can treat it like any other path string.
//
// Credentials are kept per host in a small file next to sources.tsv and are
// never part of the URL.
namespace vfs {

struct Entry {
    std::string name;
    bool is_dir = false;
    uint64_t size = 0;
    int64_t mtime = 0;
};

struct Error {
    bool auth = false;       // wrong / missing user name or password
    std::string msg;
};

struct Url {
    std::string host;
    std::string share;       // empty = the host itself (list its shares)
    std::string path;        // inside the share, '/' separated, no leading '/'
};

bool isRemote(const std::string& path);                 // starts with smb://
bool parseUrl(const std::string& url, Url& out);
std::string buildUrl(const Url& u);
std::string join(const std::string& dirUrl, const std::string& name);
std::string parent(const std::string& url);             // one level up ("" when already at the host)

// ---- credentials ----
void init(const std::string& credentialsFile);          // call once at startup
void setCredentials(const std::string& host, const std::string& user,
                    const std::string& pass, bool persist);
void persistCredentials(const std::string& host);       // saves what setCredentials(persist=false) kept
bool getCredentials(const std::string& host, std::string& user, std::string& pass);

// ---- connections ----
// One connected share. Not thread-safe: use one per thread / request.
class Share {
public:
    virtual ~Share() {}
    virtual bool list(const std::string& path, std::vector<Entry>& out, Error& err) = 0;
    // Opens a single file for reading (any previously open file is closed).
    virtual bool open(const std::string& path, Error& err) = 0;
    virtual uint64_t fileSize() = 0;
    // Returns the bytes read (0 = end of file), or -1 on error.
    virtual int64_t read(uint64_t offset, void* buf, size_t len) = 0;
};

bool smbAvailable();                                    // false when built without libsmb2
std::unique_ptr<Share> connectShare(const std::string& host, const std::string& share, Error& err);
bool listShares(const std::string& host, std::vector<std::string>& shares, Error& err);

} // namespace vfs

#endif
