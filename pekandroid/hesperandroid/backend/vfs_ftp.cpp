// FTP client for PEK's network folders. Plain POSIX sockets, no libraries.
// Lists with MLSD (falls back to LIST), reads with REST + RETR, passive mode only.
#include "vfs.h"
#include "vfs_backends.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <cstring>
#include <ctime>
#include <sstream>

namespace vfs {
namespace {

const int kConnectMs = 10000;
const int kReadMs = 20000;

int connectTcp(const std::string& host, int port, std::string& peerIp) {
    addrinfo hints;
    std::memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0 || !res) return -1;
    int fd = -1;
    for (addrinfo* a = res; a; a = a->ai_next) {
        fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (fd < 0) continue;
        int fl = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, fl | O_NONBLOCK);
        int rc = ::connect(fd, a->ai_addr, a->ai_addrlen);
        if (rc != 0 && errno == EINPROGRESS) {
            pollfd p;
            p.fd = fd; p.events = POLLOUT; p.revents = 0;
            if (::poll(&p, 1, kConnectMs) > 0) {
                int err = 0;
                socklen_t len = sizeof err;
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
                rc = err == 0 ? 0 : -1;
            } else rc = -1;
        }
        if (rc == 0) {
            char buf[INET6_ADDRSTRLEN] = {0};
            if (a->ai_family == AF_INET)
                inet_ntop(AF_INET, &reinterpret_cast<sockaddr_in*>(a->ai_addr)->sin_addr, buf, sizeof buf);
            else
                inet_ntop(AF_INET6, &reinterpret_cast<sockaddr_in6*>(a->ai_addr)->sin6_addr, buf, sizeof buf);
            peerIp = buf;
            fcntl(fd, F_SETFL, fl);                 // back to blocking; reads use poll() timeouts
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
            break;
        }
        ::close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

// recv with a timeout. Returns bytes, 0 on EOF, -1 on error / timeout.
ssize_t recvTimeout(int fd, void* buf, size_t len, int ms) {
    pollfd p;
    p.fd = fd; p.events = POLLIN; p.revents = 0;
    int n = ::poll(&p, 1, ms);
    if (n <= 0) return -1;
    return ::recv(fd, buf, len, 0);
}

bool sendAll(int fd, const std::string& s) {
    size_t off = 0;
    while (off < s.size()) {
        ssize_t n = ::send(fd, s.data() + off, s.size() - off, MSG_NOSIGNAL);
        if (n <= 0) return false;
        off += static_cast<size_t>(n);
    }
    return true;
}

int64_t parseMlsdTime(const std::string& v) {      // YYYYMMDDHHMMSS (UTC)
    if (v.size() < 14) return 0;
    tm t;
    std::memset(&t, 0, sizeof t);
    try {
        t.tm_year = std::stoi(v.substr(0, 4)) - 1900;
        t.tm_mon = std::stoi(v.substr(4, 2)) - 1;
        t.tm_mday = std::stoi(v.substr(6, 2));
        t.tm_hour = std::stoi(v.substr(8, 2));
        t.tm_min = std::stoi(v.substr(10, 2));
        t.tm_sec = std::stoi(v.substr(12, 2));
    } catch (...) { return 0; }
    return static_cast<int64_t>(timegm(&t));
}

std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

class FtpShare : public Share {
public:
    FtpShare(std::string host, int port, std::string user, std::string pass)
        : host_(std::move(host)), port_(port), user_(std::move(user)), pass_(std::move(pass)) {}
    ~FtpShare() override { closeAll(); }

    // Connects and logs in. On failure fills err.
    bool login(Error& err) {
        closeAll();
        std::string ip;
        ctrl_ = connectTcp(host_, port_, ip);
        if (ctrl_ < 0) { err.auth = false; err.msg = "Could not connect to " + host_; return false; }
        peer_ = ip;
        inbuf_.clear();
        int code = reply(nullptr);
        if (code != 220) { err.auth = false; err.msg = "FTP server did not greet us"; return false; }
        code = cmd("USER " + user_, nullptr);
        if (code == 331) code = cmd("PASS " + pass_, nullptr);
        if (code == 530 || code == 430 || code == 332) { err.auth = true; err.msg = "Wrong user name or password"; return false; }
        if (code != 230) { err.auth = false; err.msg = "FTP login failed"; return false; }
        cmd("TYPE I", nullptr);
        return true;
    }

    bool list(const std::string& path, std::vector<Entry>& out, Error& err) override {
        std::string full = "/" + path;
        std::string data;
        int rc = fetchListing("MLSD " + full, data);
        bool mlsd = rc == 226 || rc == 250;
        if (!mlsd) {
            data.clear();
            rc = fetchListing("LIST " + full, data);
            if (rc != 226 && rc != 250) {
                err.auth = false;
                err.msg = rc == 550 ? "Folder not found" : "Could not list the folder";
                return false;
            }
        }
        std::stringstream ss(data);
        std::string line;
        while (std::getline(ss, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
            if (line.empty()) continue;
            Entry e;
            if (mlsd ? parseMlsd(line, e) : parseList(line, e)) out.push_back(std::move(e));
        }
        return true;
    }

    bool open(const std::string& path, Error& err) override {
        closeData();
        file_ = "/" + path;
        std::string text;
        int code = cmd("SIZE " + file_, &text);
        if (code != 213) { err.auth = false; err.msg = code == 550 ? "File is missing" : "Could not read the file size"; return false; }
        try { size_ = std::stoull(text); } catch (...) { size_ = 0; }
        pos_ = 0;
        return true;
    }

    uint64_t fileSize() override { return size_; }

    int64_t read(uint64_t offset, void* buf, size_t len) override {
        if (offset >= size_) return 0;
        if (data_ < 0 || offset != pos_) {
            // (Re)start the transfer at the wanted offset. A fresh control
            // connection avoids any leftover replies from an aborted transfer.
            Error e;
            if (!login(e)) return -1;
            if (!startRetr(offset)) return -1;
        }
        ssize_t n = recvTimeout(data_, buf, len, kReadMs);
        if (n < 0) { closeData(); return -1; }
        pos_ += static_cast<uint64_t>(n);
        if (n == 0) closeData();
        return n;
    }

private:
    // ---- control channel ----
    // Reads one (possibly multi-line) reply; returns its code, or -1.
    int reply(std::string* text) {
        std::string first;
        int code = -1;
        bool multi = false;
        while (true) {
            size_t nl;
            while ((nl = inbuf_.find('\n')) == std::string::npos) {
                char buf[1024];
                ssize_t n = recvTimeout(ctrl_, buf, sizeof buf, kReadMs);
                if (n <= 0) return -1;
                inbuf_.append(buf, static_cast<size_t>(n));
            }
            std::string line = inbuf_.substr(0, nl);
            inbuf_.erase(0, nl + 1);
            while (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.size() >= 3 && std::isdigit(static_cast<unsigned char>(line[0])) &&
                std::isdigit(static_cast<unsigned char>(line[1])) && std::isdigit(static_cast<unsigned char>(line[2]))) {
                if (code < 0) {
                    code = std::stoi(line.substr(0, 3));
                    first = line.size() > 4 ? line.substr(4) : "";
                    multi = line.size() > 3 && line[3] == '-';
                    if (!multi) break;
                    continue;
                }
                if (std::stoi(line.substr(0, 3)) == code && (line.size() == 3 || line[3] == ' ')) break;
            }
        }
        if (text) *text = first;
        return code;
    }

    int cmd(const std::string& c, std::string* text) {
        if (ctrl_ < 0 || !sendAll(ctrl_, c + "\r\n")) return -1;
        return reply(text);
    }

    // ---- data channel ----
    int openPassive() {
        std::string text;
        int code = cmd("EPSV", &text);
        int port = 0;
        if (code == 229) {                                   // (|||port|)
            size_t a = text.find("|||");
            if (a != std::string::npos) port = std::atoi(text.c_str() + a + 3);
        } else {
            code = cmd("PASV", &text);                       // (h1,h2,h3,h4,p1,p2)
            if (code != 227) return -1;
            size_t a = text.find('(');
            int v[6];
            if (a == std::string::npos ||
                std::sscanf(text.c_str() + a, "(%d,%d,%d,%d,%d,%d)", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return -1;
            port = v[4] * 256 + v[5];
        }
        if (port <= 0 || port > 65535) return -1;
        std::string ip;
        return connectTcp(peer_, port, ip);                  // always the control host, never the address inside the reply
    }

    int fetchListing(const std::string& command, std::string& out) {
        int d = openPassive();
        if (d < 0) return -1;
        int code = cmd(command, nullptr);
        if (code != 150 && code != 125) { ::close(d); return code; }
        char buf[4096];
        ssize_t n;
        while ((n = recvTimeout(d, buf, sizeof buf, kReadMs)) > 0) out.append(buf, static_cast<size_t>(n));
        ::close(d);
        return reply(nullptr);
    }

    bool startRetr(uint64_t offset) {
        int d = openPassive();
        if (d < 0) return false;
        if (offset > 0) {
            int c = cmd("REST " + std::to_string(offset), nullptr);
            if (c != 350) { ::close(d); return false; }
        }
        int c = cmd("RETR " + file_, nullptr);
        if (c != 150 && c != 125) { ::close(d); return false; }
        data_ = d;
        pos_ = offset;
        return true;
    }

    void closeData() {
        if (data_ >= 0) { ::close(data_); data_ = -1; }
    }
    void closeAll() {
        closeData();
        if (ctrl_ >= 0) { ::close(ctrl_); ctrl_ = -1; }
    }

    // ---- listing formats ----
    static bool parseMlsd(const std::string& line, Entry& e) {
        size_t sp = line.find(' ');
        if (sp == std::string::npos) return false;
        e.name = line.substr(sp + 1);
        std::string facts = line.substr(0, sp);
        std::string type;
        std::stringstream ss(facts);
        std::string f;
        while (std::getline(ss, f, ';')) {
            size_t eq = f.find('=');
            if (eq == std::string::npos) continue;
            std::string k = lower(f.substr(0, eq)), v = f.substr(eq + 1);
            if (k == "type") type = lower(v);
            else if (k == "size") { try { e.size = std::stoull(v); } catch (...) {} }
            else if (k == "modify") e.mtime = parseMlsdTime(v);
        }
        if (type == "cdir" || type == "pdir") return false;
        e.is_dir = type == "dir";
        return !e.name.empty() && e.name != "." && e.name != "..";
    }

    static bool parseList(const std::string& line, Entry& e) {
        if (line.compare(0, 5, "total") == 0) return false;
        // Unix:  drwxr-xr-x 2 owner group 4096 Jan  1 12:00 name
        if (line.size() > 10 && (line[0] == 'd' || line[0] == '-' || line[0] == 'l')) {
            size_t pos = 0;
            for (int field = 0; field < 8; ++field) {
                while (pos < line.size() && line[pos] == ' ') ++pos;
                size_t start = pos;
                while (pos < line.size() && line[pos] != ' ') ++pos;
                if (field == 4) { try { e.size = std::stoull(line.substr(start, pos - start)); } catch (...) {} }
            }
            while (pos < line.size() && line[pos] == ' ') ++pos;
            e.name = line.substr(pos);
            size_t arrow = e.name.find(" -> ");
            if (line[0] == 'l' && arrow != std::string::npos) return false;   // skip symlinks (loop safety)
            e.is_dir = line[0] == 'd';
            return !e.name.empty() && e.name != "." && e.name != "..";
        }
        // DOS / IIS:  01-02-20  10:30AM       <DIR>          name   or   ... 1234 name
        std::istringstream iss(line);
        std::string date, time, kind;
        if (iss >> date >> time >> kind) {
            std::string rest;
            std::getline(iss, rest);
            size_t p = rest.find_first_not_of(' ');
            e.name = p == std::string::npos ? "" : rest.substr(p);
            e.is_dir = kind == "<DIR>";
            if (!e.is_dir) { try { e.size = std::stoull(kind); } catch (...) { return false; } }
            return !e.name.empty() && e.name != "." && e.name != "..";
        }
        return false;
    }

    std::string host_;
    int port_;
    std::string user_, pass_;
    std::string peer_;
    int ctrl_ = -1;
    int data_ = -1;
    std::string inbuf_;
    std::string file_;
    uint64_t size_ = 0;
    uint64_t pos_ = 0;
};

} // namespace

std::unique_ptr<Share> ftpConnect(const Url& u, Error& err) {
    std::string host = u.host;
    int port = 21;
    size_t colon = host.rfind(':');
    if (colon != std::string::npos && host.find(':') == colon) {      // host:port (not an IPv6 literal)
        port = std::atoi(host.c_str() + colon + 1);
        host = host.substr(0, colon);
    }
    std::string user, pass;
    if (!getCredentials("ftp", u.host, user, pass) || user.empty()) { user = "anonymous"; pass = "hesper@localhost"; }
    std::unique_ptr<FtpShare> s(new FtpShare(host, port, user, pass));
    if (!s->login(err)) return nullptr;
    return std::unique_ptr<Share>(s.release());
}

} // namespace vfs
