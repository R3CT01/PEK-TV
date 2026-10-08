// WebDAV and UPnP/DLNA backends. Both talk plain HTTP through httplib.
#include "vfs.h"
#include "vfs_backends.h"
#include "httplib.h"

#include <algorithm>
#include <cstring>
#include <ctime>
#include <map>
#include <mutex>
#include <sstream>

namespace vfs {

std::string xmlUnescape(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] != '&') { out += s[i]; continue; }
        size_t semi = s.find(';', i);
        if (semi == std::string::npos || semi - i > 10) { out += s[i]; continue; }
        std::string ent = s.substr(i + 1, semi - i - 1);
        if (ent == "lt") out += '<';
        else if (ent == "gt") out += '>';
        else if (ent == "amp") out += '&';
        else if (ent == "quot") out += '"';
        else if (ent == "apos") out += '\'';
        else if (!ent.empty() && ent[0] == '#') {
            long cp = 0;
            try { cp = ent.size() > 1 && (ent[1] == 'x' || ent[1] == 'X') ? std::stol(ent.substr(2), nullptr, 16) : std::stol(ent.substr(1)); }
            catch (...) { out += s[i]; continue; }
            if (cp < 0x80) out += static_cast<char>(cp);
            else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
            else if (cp < 0x10000) { out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
            else { out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
        } else { out += s[i]; continue; }
        i = semi;
    }
    return out;
}

namespace {

// ---------------------------------------------------------------- tiny XML reader
// Enough for WebDAV multistatus and UPnP SOAP / DIDL-Lite: element lookup by
// local name (namespace prefixes ignored), attributes, text. Not a validating parser.

struct Elem {
    std::string attrs;   // text inside the opening tag after the name
    std::string inner;   // everything between open and close tag
};

std::string localName(const std::string& tag) {
    size_t c = tag.rfind(':');
    return c == std::string::npos ? tag : tag.substr(c + 1);
}

// Reads the tag starting at xml[pos] == '<'. Fills name (as written), isClose,
// selfClose, attrs and the index just after '>'. Returns false if malformed.
bool readTag(const std::string& xml, size_t pos, std::string& name, bool& isClose, bool& selfClose,
             std::string& attrs, size_t& after) {
    size_t end = pos + 1;
    char quote = 0;
    while (end < xml.size()) {
        char c = xml[end];
        if (quote) { if (c == quote) quote = 0; }
        else if (c == '"' || c == '\'') quote = c;
        else if (c == '>') break;
        ++end;
    }
    if (end >= xml.size()) return false;
    std::string body = xml.substr(pos + 1, end - pos - 1);
    after = end + 1;
    isClose = !body.empty() && body[0] == '/';
    if (isClose) body.erase(0, 1);
    selfClose = !body.empty() && body.back() == '/';
    if (selfClose) body.pop_back();
    size_t sp = body.find_first_of(" \t\r\n");
    name = body.substr(0, sp);
    attrs = sp == std::string::npos ? "" : body.substr(sp + 1);
    return !name.empty();
}

// All elements with this local name, outermost matches only.
std::vector<Elem> elements(const std::string& xml, const std::string& local) {
    std::vector<Elem> out;
    size_t pos = 0;
    while ((pos = xml.find('<', pos)) != std::string::npos) {
        if (xml.compare(pos, 4, "<!--") == 0) { size_t e = xml.find("-->", pos); if (e == std::string::npos) break; pos = e + 3; continue; }
        if (xml.compare(pos, 9, "<![CDATA[") == 0) { size_t e = xml.find("]]>", pos); if (e == std::string::npos) break; pos = e + 3; continue; }
        if (pos + 1 < xml.size() && (xml[pos + 1] == '?' || xml[pos + 1] == '!')) {
            size_t e = xml.find('>', pos);
            if (e == std::string::npos) break;
            pos = e + 1;
            continue;
        }
        std::string name, attrs;
        bool isClose, selfClose;
        size_t after;
        if (!readTag(xml, pos, name, isClose, selfClose, attrs, after)) break;
        if (!isClose && localName(name) == local) {
            Elem e;
            e.attrs = attrs;
            if (selfClose) { out.push_back(e); pos = after; continue; }
            const size_t openStart = after;     // first character after the opening tag
            int depth = 1;
            size_t scan = after;
            size_t innerEnd = std::string::npos;
            while (depth > 0) {
                size_t lt = xml.find('<', scan);
                if (lt == std::string::npos) break;
                std::string n2, a2;
                bool c2, s2;
                size_t af2;
                if (!readTag(xml, lt, n2, c2, s2, a2, af2)) break;
                if (localName(n2) == local && !s2) {
                    if (c2) { if (--depth == 0) { innerEnd = lt; after = af2; break; } }
                    else ++depth;
                }
                scan = af2;
            }
            if (innerEnd == std::string::npos) break;
            e.inner = xml.substr(openStart, innerEnd - openStart);
            out.push_back(e);
            pos = after;
            continue;
        }
        pos = after;
    }
    return out;
}

std::string firstText(const std::string& xml, const std::string& local) {
    auto v = elements(xml, local);
    return v.empty() ? "" : xmlUnescape(v[0].inner);
}

std::string attr(const std::string& attrs, const std::string& key) {
    size_t pos = 0;
    while ((pos = attrs.find(key, pos)) != std::string::npos) {
        bool startOk = pos == 0 || std::isspace(static_cast<unsigned char>(attrs[pos - 1]));
        size_t p = pos + key.size();
        while (p < attrs.size() && attrs[p] == ' ') ++p;
        if (startOk && p < attrs.size() && attrs[p] == '=') {
            ++p;
            while (p < attrs.size() && attrs[p] == ' ') ++p;
            if (p < attrs.size() && (attrs[p] == '"' || attrs[p] == '\'')) {
                char q = attrs[p];
                size_t e = attrs.find(q, p + 1);
                if (e != std::string::npos) return xmlUnescape(attrs.substr(p + 1, e - p - 1));
            }
        }
        pos += key.size();
    }
    return "";
}

std::string xmlEscape(const std::string& s) {
    std::string o;
    for (char c : s) {
        switch (c) {
            case '&': o += "&amp;"; break;
            case '<': o += "&lt;"; break;
            case '>': o += "&gt;"; break;
            case '"': o += "&quot;"; break;
            default: o += c;
        }
    }
    return o;
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

// Percent-encodes a path for use in an HTTP request line, keeping '/'.
std::string encodePath(const std::string& p) {
    std::string out;
    bool first = true;
    size_t start = 0;
    while (true) {
        size_t slash = p.find('/', start);
        std::string part = p.substr(start, slash == std::string::npos ? std::string::npos : slash - start);
        if (!first) out += '/';
        out += urlEncode(part);
        first = false;
        if (slash == std::string::npos) break;
        start = slash + 1;
    }
    return out;
}

// Splits http://host:port/path into origin ("http://host:port") and path.
bool splitHttpUrl(const std::string& url, std::string& origin, std::string& path) {
    size_t s = url.find("://");
    if (s == std::string::npos) return false;
    size_t slash = url.find('/', s + 3);
    origin = url.substr(0, slash);
    path = slash == std::string::npos ? "/" : url.substr(slash);
    return true;
}

void configure(httplib::Client& c) {
    c.set_connection_timeout(10, 0);
    c.set_read_timeout(30, 0);
    c.set_write_timeout(15, 0);
    c.set_follow_location(true);
    c.set_keep_alive(true);
}

// Range read shared by WebDAV and UPnP: returns bytes, 0 at end of file, -1 on error.
int64_t httpRangeRead(httplib::Client& c, const std::string& path, uint64_t size, uint64_t offset, void* buf, size_t len) {
    if (offset >= size && size > 0) return 0;
    if (len > 1024 * 1024) len = 1024 * 1024;
    uint64_t last = offset + len - 1;
    if (size > 0 && last >= size) last = size - 1;
    httplib::Headers h = {{"Range", "bytes=" + std::to_string(offset) + "-" + std::to_string(last)}};
    auto res = c.Get(path, h);
    if (!res) return -1;
    if (res->status == 416) return 0;
    if (res->status == 206) {
        size_t n = std::min(res->body.size(), len);
        std::memcpy(buf, res->body.data(), n);
        return static_cast<int64_t>(n);
    }
    if (res->status == 200 && offset == 0) {            // server ignored Range: usable only from the start
        size_t n = std::min(res->body.size(), len);
        std::memcpy(buf, res->body.data(), n);
        return static_cast<int64_t>(n);
    }
    return -1;
}

uint64_t headSize(httplib::Client& c, const std::string& path) {
    auto res = c.Head(path);
    if (res && res->status == 200) {
        auto it = res->headers.find("Content-Length");
        if (it != res->headers.end()) { try { return std::stoull(it->second); } catch (...) {} }
    }
    httplib::Headers h = {{"Range", "bytes=0-0"}};
    auto g = c.Get(path, h);
    if (g && g->status == 206) {
        auto it = g->headers.find("Content-Range");              // bytes 0-0/12345
        if (it != g->headers.end()) {
            size_t slash = it->second.rfind('/');
            if (slash != std::string::npos) { try { return std::stoull(it->second.substr(slash + 1)); } catch (...) {} }
        }
    }
    return 0;
}

// ================================================================ WebDAV

int64_t parseHttpDate(const std::string& s) {
    tm t;
    std::memset(&t, 0, sizeof t);
    if (!strptime(s.c_str(), "%a, %d %b %Y %H:%M:%S", &t)) return 0;
    return static_cast<int64_t>(timegm(&t));
}

class DavShare : public Share {
public:
    DavShare(const std::string& origin, const std::string& user, const std::string& pass)
        : cli_(origin) {
        configure(cli_);
        if (!user.empty()) cli_.set_basic_auth(user, pass);
    }

    // Early check that the server is reachable and the login works. Many servers keep
    // WebDAV in a sub-folder (Nextcloud: /remote.php/dav/files/<user>/), so the top "/"
    // answering 404 or an HTML page is normal and must not stop the connection: the
    // folder that is actually opened is listed afterwards and reports its own errors.
    bool probe(Error& err) {
        std::vector<Entry> tmp;
        if (list("", tmp, err)) return true;
        if (!err.auth && lastStatus_ != 0) return true;     // got an answer, just not WebDAV at "/"
        return false;                                       // unreachable, or a real 401/403
    }

    bool list(const std::string& path, std::vector<Entry>& out, Error& err) override {
        std::string reqPath = "/" + encodePath(path);
        if (reqPath.back() != '/') reqPath += '/';
        httplib::Request req;
        req.method = "PROPFIND";
        req.path = reqPath;
        req.set_header("Depth", "1");
        req.set_header("Content-Type", "application/xml; charset=utf-8");
        req.body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
                   "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>";
        auto res = cli_.send(req);
        lastStatus_ = res ? res->status : 0;
        if (!res) { err.auth = false; err.msg = "Could not reach the WebDAV server"; return false; }
        if (res->status == 401 || res->status == 403) { err.auth = true; err.msg = "Wrong user name or password"; return false; }
        if (res->status == 404) { err.auth = false; err.msg = "Folder not found"; return false; }
        if (res->status != 207) { err.auth = false; err.msg = "The server does not look like WebDAV (HTTP " + std::to_string(res->status) + ")"; return false; }

        std::string selfPath = urlDecode(reqPath);
        while (selfPath.size() > 1 && selfPath.back() == '/') selfPath.pop_back();
        for (const auto& r : elements(res->body, "response")) {
            std::string href = firstText(r.inner, "href");
            std::string hp = href;
            size_t scheme = hp.find("://");
            if (scheme != std::string::npos) { size_t sl = hp.find('/', scheme + 3); hp = sl == std::string::npos ? "/" : hp.substr(sl); }
            hp = urlDecode(hp);
            bool dir = !elements(r.inner, "collection").empty();
            while (hp.size() > 1 && hp.back() == '/') hp.pop_back();
            if (hp == selfPath) continue;
            size_t slash = hp.rfind('/');
            Entry e;
            e.name = slash == std::string::npos ? hp : hp.substr(slash + 1);
            if (e.name.empty()) continue;
            e.is_dir = dir;
            std::string len = firstText(r.inner, "getcontentlength");
            if (!len.empty()) { try { e.size = std::stoull(len); } catch (...) {} }
            e.mtime = parseHttpDate(firstText(r.inner, "getlastmodified"));
            out.push_back(std::move(e));
        }
        return true;
    }

    bool open(const std::string& path, Error& err) override {
        path_ = "/" + encodePath(path);
        size_ = headSize(cli_, path_);
        if (size_ == 0) { err.auth = false; err.msg = "File is missing or empty"; return false; }
        return true;
    }
    uint64_t fileSize() override { return size_; }
    int64_t read(uint64_t offset, void* buf, size_t len) override {
        return httpRangeRead(cli_, path_, size_, offset, buf, len);
    }

private:
    httplib::Client cli_;
    int lastStatus_ = 0;
    std::string path_;
    uint64_t size_ = 0;
};

// ================================================================ UPnP / DLNA

struct DidlItem {
    std::string name;       // what the library shows (title + extension for files)
    std::string id;
    bool container = false;
    std::string resUrl;
    uint64_t size = 0;
};

std::string extFromMime(const std::string& proto) {
    std::string p = lower(proto);
    if (p.find("matroska") != std::string::npos) return ".mkv";
    if (p.find("video/mp4") != std::string::npos) return ".mp4";
    if (p.find("quicktime") != std::string::npos) return ".mov";
    if (p.find("x-msvideo") != std::string::npos) return ".avi";
    if (p.find("webm") != std::string::npos) return ".webm";
    if (p.find("mp2t") != std::string::npos || p.find("mpeg-ts") != std::string::npos) return ".ts";
    if (p.find("x-ms-wmv") != std::string::npos) return ".wmv";
    if (p.find("video/mpeg") != std::string::npos) return ".mpg";
    return "";
}

bool hasVideoExt(const std::string& name) {
    static const char* exts[] = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".webm", ".flv", ".3gp", ".mpg"};
    std::string l = lower(name);
    for (const char* e : exts) {
        size_t n = std::strlen(e);
        if (l.size() >= n && l.compare(l.size() - n, n, e) == 0) return true;
    }
    return false;
}

std::string safeName(std::string s) {
    for (auto& c : s) if (c == '/' || c == '\\' || c == '\n' || c == '\r' || c == '\t') c = '-';
    return s;
}

class UpnpShare : public Share {
public:
    UpnpShare(const std::string& hostPort, const std::string& controlPath)
        : control_(controlPath), cli_("http://" + hostPort) { configure(cli_); }

    bool probe(Error& err) {
        std::vector<DidlItem> items;
        return browse("0", items, err);
    }

    bool list(const std::string& path, std::vector<Entry>& out, Error& err) override {
        std::string id;
        if (!resolveContainer(path, id, err)) return false;
        std::vector<DidlItem> items;
        if (!browse(id, items, err)) return false;
        for (const auto& it : items) {
            Entry e;
            e.name = it.name;
            e.is_dir = it.container;
            e.size = it.size;
            out.push_back(std::move(e));
        }
        return true;
    }

    bool open(const std::string& path, Error& err) override {
        size_t slash = path.rfind('/');
        std::string parentPath = slash == std::string::npos ? "" : path.substr(0, slash);
        std::string name = slash == std::string::npos ? path : path.substr(slash + 1);
        std::string id;
        if (!resolveContainer(parentPath, id, err)) return false;
        std::vector<DidlItem> items;
        if (!browse(id, items, err)) return false;
        for (const auto& it : items) {
            if (it.container || it.name != name || it.resUrl.empty()) continue;
            std::string origin, rpath;
            if (!splitHttpUrl(it.resUrl, origin, rpath)) continue;
            media_.reset(new httplib::Client(origin));
            configure(*media_);
            mediaPath_ = rpath;
            size_ = it.size ? it.size : headSize(*media_, rpath);
            if (size_ == 0) { err.auth = false; err.msg = "Could not read the file size"; return false; }
            return true;
        }
        err.auth = false;
        err.msg = "File is missing";
        return false;
    }
    uint64_t fileSize() override { return size_; }
    int64_t read(uint64_t offset, void* buf, size_t len) override {
        if (!media_) return -1;
        return httpRangeRead(*media_, mediaPath_, size_, offset, buf, len);
    }

private:
    bool resolveContainer(const std::string& path, std::string& id, Error& err) {
        id = "0";
        std::stringstream ss(path);
        std::string seg;
        std::string soFar;
        while (std::getline(ss, seg, '/')) {
            if (seg.empty()) continue;
            soFar += (soFar.empty() ? "" : "/") + seg;
            auto cached = idCache_.find(soFar);
            if (cached != idCache_.end()) { id = cached->second; continue; }
            std::vector<DidlItem> items;
            if (!browse(id, items, err)) return false;
            bool found = false;
            for (const auto& it : items) {
                if (it.container && it.name == seg) { id = it.id; found = true; break; }
            }
            if (!found) { err.auth = false; err.msg = "Folder not found"; return false; }
            idCache_[soFar] = id;
        }
        return true;
    }

    bool browse(const std::string& objectId, std::vector<DidlItem>& out, Error& err) {
        const int kPage = 200;
        int start = 0;
        for (int guard = 0; guard < 500; ++guard) {
            std::string body =
                "<?xml version=\"1.0\"?>"
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">"
                "<s:Body><u:Browse xmlns:u=\"urn:schemas-upnp-org:service:ContentDirectory:1\">"
                "<ObjectID>" + xmlEscape(objectId) + "</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>"
                "<Filter>*</Filter><StartingIndex>" + std::to_string(start) + "</StartingIndex>"
                "<RequestedCount>" + std::to_string(kPage) + "</RequestedCount><SortCriteria></SortCriteria>"
                "</u:Browse></s:Body></s:Envelope>";
            httplib::Headers h = {{"SOAPACTION", "\"urn:schemas-upnp-org:service:ContentDirectory:1#Browse\""}};
            auto res = cli_.Post(control_, h, body, "text/xml; charset=\"utf-8\"");
            if (!res) { err.auth = false; err.msg = "Could not reach the media server"; return false; }
            if (res->status != 200) { err.auth = false; err.msg = "The media server refused the request (HTTP " + std::to_string(res->status) + ")"; return false; }
            std::string didl = firstText(res->body, "Result");
            int returned = 0, total = 0;
            try { returned = std::stoi(firstText(res->body, "NumberReturned")); } catch (...) {}
            try { total = std::stoi(firstText(res->body, "TotalMatches")); } catch (...) {}
            parseDidl(didl, out);
            start += returned;
            if (returned == 0 || (total > 0 && start >= total)) break;
        }
        return true;
    }

    static void parseDidl(const std::string& didl, std::vector<DidlItem>& out) {
        for (const auto& c : elements(didl, "container")) {
            DidlItem it;
            it.container = true;
            it.id = attr(c.attrs, "id");
            it.name = safeName(firstText(c.inner, "title"));
            if (!it.id.empty() && !it.name.empty()) out.push_back(std::move(it));
        }
        for (const auto& i : elements(didl, "item")) {
            DidlItem it;
            it.id = attr(i.attrs, "id");
            std::string title = safeName(firstText(i.inner, "title"));
            // Prefer a video resource when the server lists several.
            std::string bestUrl, bestProto, bestSize;
            for (const auto& r : elements(i.inner, "res")) {
                std::string proto = attr(r.attrs, "protocolInfo");
                std::string url = xmlUnescape(r.inner);
                bool video = lower(proto).find("video") != std::string::npos;
                if (bestUrl.empty() || (video && lower(bestProto).find("video") == std::string::npos)) {
                    bestUrl = url; bestProto = proto; bestSize = attr(r.attrs, "size");
                }
            }
            if (bestUrl.empty() || title.empty()) continue;
            if (lower(bestProto).find("video") == std::string::npos) continue;   // library is video only
            it.resUrl = bestUrl;
            try { it.size = bestSize.empty() ? 0 : std::stoull(bestSize); } catch (...) {}
            std::string ext;
            std::string origin, rpath;
            if (splitHttpUrl(bestUrl, origin, rpath)) {
                size_t q = rpath.find('?');
                if (q != std::string::npos) rpath.resize(q);
                size_t dot = rpath.rfind('.');
                if (dot != std::string::npos && rpath.size() - dot <= 6 && rpath.find('/', dot) == std::string::npos) ext = lower(rpath.substr(dot));
            }
            if (!hasVideoExt(ext)) ext = extFromMime(bestProto);
            it.name = hasVideoExt(title) || ext.empty() ? title : title + ext;
            out.push_back(std::move(it));
        }
    }

    std::string control_;
    httplib::Client cli_;
    std::unique_ptr<httplib::Client> media_;
    std::string mediaPath_;
    uint64_t size_ = 0;
    std::map<std::string, std::string> idCache_;
};

} // namespace

std::unique_ptr<Share> davConnect(const Url& u, Error& err) {
    std::string user, pass;
    getCredentials(u.scheme, u.host, user, pass);
    std::string origin = (u.scheme == "davs" ? "https://" : "http://") + u.host;
#ifndef CPPHTTPLIB_OPENSSL_SUPPORT
    if (u.scheme == "davs") {
        err.auth = false;
        err.msg = "This build of Hesper has no HTTPS support, so davs:// cannot be used.";
        return nullptr;
    }
#endif
    std::unique_ptr<DavShare> s(new DavShare(origin, user, pass));
    if (!s->probe(err)) return nullptr;
    return std::unique_ptr<Share>(s.release());
}

std::unique_ptr<Share> upnpConnect(const Url& u, Error& err) {
    std::unique_ptr<UpnpShare> s(new UpnpShare(u.host, urlDecode(u.share)));
    if (!s->probe(err)) return nullptr;
    return std::unique_ptr<Share>(s.release());
}

bool upnpDescribe(const std::string& locationUrl, std::string& friendlyName,
                  std::string& hostPort, std::string& controlPath) {
    std::string origin, path;
    if (locationUrl.compare(0, 7, "http://") != 0 || !splitHttpUrl(locationUrl, origin, path)) return false;
    hostPort = origin.substr(7);
    httplib::Client cli(origin);
    cli.set_connection_timeout(3, 0);
    cli.set_read_timeout(4, 0);
    auto res = cli.Get(path);
    if (!res || res->status != 200) return false;
    friendlyName = firstText(res->body, "friendlyName");
    for (const auto& s : elements(res->body, "service")) {
        if (firstText(s.inner, "serviceType").find("ContentDirectory") == std::string::npos) continue;
        std::string ctl = firstText(s.inner, "controlURL");
        if (ctl.empty()) continue;
        std::string o2, p2;
        if (ctl.compare(0, 7, "http://") == 0 && splitHttpUrl(ctl, o2, p2)) { hostPort = o2.substr(7); ctl = p2; }
        if (ctl[0] != '/') ctl = "/" + ctl;
        controlPath = ctl;
        if (friendlyName.empty()) friendlyName = hostPort;
        return true;
    }
    return false;
}

} // namespace vfs
