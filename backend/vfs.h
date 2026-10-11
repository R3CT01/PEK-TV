#ifndef VFS_H
#define VFS_H

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

// Network file access for PEK. A network location is a URL everywhere
// (sources.tsv, the library cache, the API), so the scanner and the stream
// route treat it like any other path string:
//
//   smb://host/share/folder          Windows / NAS / Samba shares
//   nfs://host/<export>/folder       NFS (export is percent-encoded, e.g. %2Fsrv%2Fmedia)
//   ftp://host[:port]/folder         FTP
//   dav://host[:port]/folder         WebDAV over http   (davs:// = https)
//   upnp://host:port/<ctl>/Title/Title   UPnP / DLNA media server (ctl = percent-encoded ContentDirectory path)
//
// Logins are kept per scheme+host in a small file next to sources.tsv and are
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
    std::string scheme = "smb";
    std::string host;        // may include :port
    std::string share;       // smb share / nfs export / upnp control path; empty for ftp and dav
    std::string path;        // inside the share, '/' separated, no leading '/'
};

bool isRemote(const std::string& path);                 // starts with a known network scheme
bool knownScheme(const std::string& scheme);
bool hasShares(const std::string& scheme);              // smb, nfs, upnp: the first path segment is a "share"
bool parseUrl(const std::string& url, Url& out);
std::string buildUrl(const Url& u);
std::string join(const std::string& dirUrl, const std::string& name);
std::string parent(const std::string& url);             // one level up ("" when already at the top)
std::string urlEncode(const std::string& s);            // for a share / export segment
std::string urlDecode(const std::string& s);
std::string schemeLabel(const std::string& scheme);     // "SMB", "FTP", ...

// ---- credentials (per scheme + host) ----
void init(const std::string& credentialsFile);          // call once at startup
void setCredentials(const std::string& scheme, const std::string& host,
                    const std::string& user, const std::string& pass, bool persist);
void persistCredentials(const std::string& scheme, const std::string& host);
bool getCredentials(const std::string& scheme, const std::string& host,
                    std::string& user, std::string& pass);

// ---- connections ----
// One connected location. Not thread-safe: use one per thread / request.
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

// False when this build left the protocol out (e.g. no libsmb2 / libnfs).
bool available(const std::string& scheme);

// Connects to u (needs u.share for smb / nfs / upnp).
std::unique_ptr<Share> connect(const Url& u, Error& err);

// Names of the shares / exports a host offers (smb, nfs). Names are plain text.
bool listShares(const Url& u, std::vector<std::string>& shares, Error& err);

} // namespace vfs

#endif
