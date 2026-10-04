#include "discovery.h"
#include "vfs_backends.h"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <thread>

namespace {

using Clock = std::chrono::steady_clock;

int msLeft(Clock::time_point deadline) {
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    return ms < 0 ? 0 : static_cast<int>(ms);
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

struct Iface {
    uint32_t ip;     // host byte order
    uint32_t mask;   // host byte order
};

std::string ipToString(uint32_t ip) {
    char buf[INET_ADDRSTRLEN];
    in_addr a;
    a.s_addr = htonl(ip);
    inet_ntop(AF_INET, &a, buf, sizeof buf);
    return buf;
}

bool stringToIp(const std::string& s, uint32_t& out) {
    in_addr a;
    if (inet_pton(AF_INET, s.c_str(), &a) != 1) return false;
    out = ntohl(a.s_addr);
    return true;
}

// The device's own IPv4 interfaces (up, not loopback).
std::vector<Iface> localInterfaces() {
    std::vector<Iface> out;
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) != 0) return out;
    for (ifaddrs* i = list; i; i = i->ifa_next) {
        if (!i->ifa_addr || !i->ifa_netmask) continue;
        if (i->ifa_addr->sa_family != AF_INET) continue;
        if (!(i->ifa_flags & IFF_UP) || (i->ifa_flags & IFF_LOOPBACK)) continue;
        Iface f;
        f.ip = ntohl(reinterpret_cast<sockaddr_in*>(i->ifa_addr)->sin_addr.s_addr);
        f.mask = ntohl(reinterpret_cast<sockaddr_in*>(i->ifa_netmask)->sin_addr.s_addr);
        // Skip link-local 169.254/16 (no DHCP) - nothing useful to scan there.
        if ((f.ip >> 16) == 0xA9FE) continue;
        out.push_back(f);
    }
    freeifaddrs(list);
    return out;
}

void setNonBlocking(int fd) {
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

// Tries a TCP connect to every address in parallel (at most 128 sockets at a
// time, so Android's default file-descriptor limit is never an issue).
std::vector<bool> connectBatch(const std::vector<std::string>& addrs, int port, int timeout_ms) {
    std::vector<bool> result(addrs.size(), false);
    const size_t kChunk = 128;
    for (size_t base = 0; base < addrs.size(); base += kChunk) {
        size_t end = std::min(addrs.size(), base + kChunk);
        std::vector<pollfd> pfds;
        std::vector<size_t> index;
        for (size_t i = base; i < end; ++i) {
            uint32_t ip;
            if (!stringToIp(addrs[i], ip)) continue;
            int fd = ::socket(AF_INET, SOCK_STREAM, 0);
            if (fd < 0) continue;
            setNonBlocking(fd);
            sockaddr_in sa;
            std::memset(&sa, 0, sizeof sa);
            sa.sin_family = AF_INET;
            sa.sin_port = htons(static_cast<uint16_t>(port));
            sa.sin_addr.s_addr = htonl(ip);
            int rc = ::connect(fd, reinterpret_cast<sockaddr*>(&sa), sizeof sa);
            if (rc == 0) {
                result[i] = true;
                ::close(fd);
            } else if (errno == EINPROGRESS) {
                pollfd p;
                p.fd = fd; p.events = POLLOUT; p.revents = 0;
                pfds.push_back(p);
                index.push_back(i);
            } else {
                ::close(fd);
            }
        }
        auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
        size_t pending = pfds.size();
        std::vector<bool> done(pfds.size(), false);
        while (pending > 0) {
            int left = msLeft(deadline);
            if (left <= 0) break;
            std::vector<pollfd> active;
            std::vector<size_t> map;
            for (size_t k = 0; k < pfds.size(); ++k) if (!done[k]) { active.push_back(pfds[k]); map.push_back(k); }
            int n = ::poll(active.data(), active.size(), left);
            if (n < 0) { if (errno == EINTR) continue; break; }
            if (n == 0) break;
            for (size_t a = 0; a < active.size(); ++a) {
                if (!active[a].revents) continue;
                size_t k = map[a];
                int err = 0;
                socklen_t len = sizeof err;
                getsockopt(pfds[k].fd, SOL_SOCKET, SO_ERROR, &err, &len);
                if (err == 0 && (active[a].revents & POLLOUT) && !(active[a].revents & (POLLERR | POLLHUP))) {
                    result[index[k]] = true;
                }
                done[k] = true;
                --pending;
            }
        }
        for (auto& p : pfds) ::close(p.fd);
    }
    return result;
}

// ---------------------------------------------------------------- DNS wire

void putU16(std::vector<uint8_t>& v, uint16_t x) { v.push_back(x >> 8); v.push_back(x & 0xFF); }

// Reads a (possibly compressed) DNS name starting at `pos`. On success `pos`
// moves past the name as stored at that spot and `name` holds the dotted form.
bool readName(const uint8_t* d, size_t len, size_t& pos, std::string& name) {
    name.clear();
    size_t p = pos;
    bool jumped = false;
    int hops = 0;
    size_t endPos = 0;
    while (true) {
        if (p >= len) return false;
        uint8_t c = d[p];
        if (c == 0) { ++p; break; }
        if ((c & 0xC0) == 0xC0) {
            if (p + 1 >= len) return false;
            size_t ptr = ((c & 0x3F) << 8) | d[p + 1];
            if (!jumped) { endPos = p + 2; jumped = true; }
            if (++hops > 20 || ptr >= len) return false;
            p = ptr;
            continue;
        }
        if (c & 0xC0) return false;          // reserved label types
        ++p;
        if (p + c > len) return false;
        if (!name.empty()) name += '.';
        name.append(reinterpret_cast<const char*>(d + p), c);
        p += c;
        if (name.size() > 255) return false;
    }
    pos = jumped ? endPos : p;
    return true;
}

uint16_t getU16(const uint8_t* d) { return static_cast<uint16_t>((d[0] << 8) | d[1]); }

std::string firstLabel(const std::string& fqdn) {
    size_t dot = fqdn.find('.');
    return dot == std::string::npos ? fqdn : fqdn.substr(0, dot);
}

// ---------------------------------------------------------------- state

std::mutex g_mutex;
std::atomic<bool> g_running{false};
std::vector<NetHost> g_results;

} // namespace

namespace {
struct Service { const char* mdns; const char* protocol; int defaultPort; };
const Service kServices[] = {
    {"_smb._tcp", "smb", 445},
    {"_nfs._tcp", "nfs", 2049},
    {"_ftp._tcp", "ftp", 21},
    {"_webdav._tcp", "dav", 80},
    {"_webdavs._tcp", "davs", 443},
};
const Service* serviceForOwner(const std::string& owner) {
    for (const auto& s : kServices) if (owner.find(s.mdns) != std::string::npos) return &s;
    return nullptr;
}
int defaultPortFor(const std::string& protocol) {
    for (const auto& s : kServices) if (protocol == s.protocol) return s.defaultPort;
    return 0;
}
} // namespace

namespace discovery_detail {

std::string hostUrl(const std::string& protocol, const std::string& address, int port) {
    std::string u = protocol + "://" + address;
    if (port > 0 && port != defaultPortFor(protocol)) u += ":" + std::to_string(port);
    return u;
}

std::string parseSsdpLocation(const std::string& packet) {
    // Only answers that are (or claim to be) MediaServers.
    std::string low = lower(packet);
    if (low.find("mediaserver") == std::string::npos) return "";
    size_t p = low.find("location:");
    if (p == std::string::npos) return "";
    size_t e = packet.find_first_of("\r\n", p);
    std::string v = packet.substr(p + 9, e == std::string::npos ? std::string::npos : e - p - 9);
    size_t a = v.find_first_not_of(" \t");
    return a == std::string::npos ? "" : v.substr(a);
}

std::vector<uint8_t> buildMdnsQuery(const std::string& name, uint16_t qtype) {
    std::vector<uint8_t> q;
    putU16(q, 0);        // id
    putU16(q, 0);        // flags: standard query
    putU16(q, 1);        // one question
    putU16(q, 0); putU16(q, 0); putU16(q, 0);
    size_t start = 0;
    while (start <= name.size()) {
        size_t dot = name.find('.', start);
        std::string label = name.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
        if (!label.empty() && label.size() < 64) {
            q.push_back(static_cast<uint8_t>(label.size()));
            q.insert(q.end(), label.begin(), label.end());
        }
        if (dot == std::string::npos) break;
        start = dot + 1;
    }
    q.push_back(0);
    putU16(q, qtype);
    putU16(q, 1);        // class IN
    return q;
}

void MdnsAccumulator::feed(const uint8_t* d, size_t len) {
    if (!d || len < 12) return;
    uint16_t flags = getU16(d + 2);
    if (!(flags & 0x8000)) return;               // not a response
    size_t qd = getU16(d + 4);
    size_t rrs = static_cast<size_t>(getU16(d + 6)) + getU16(d + 8) + getU16(d + 10);
    size_t pos = 12;
    std::string name;
    for (size_t i = 0; i < qd; ++i) {
        if (!readName(d, len, pos, name)) return;
        if (pos + 4 > len) return;
        pos += 4;
    }
    for (size_t i = 0; i < rrs; ++i) {
        if (!readName(d, len, pos, name)) return;
        if (pos + 10 > len) return;
        uint16_t type = getU16(d + pos);
        uint16_t rdlen = getU16(d + pos + 8);
        pos += 10;
        if (pos + rdlen > len) return;
        size_t rdata = pos;
        std::string owner = lower(name);
        if (type == 12) {                         // PTR
            size_t p = rdata;
            std::string target;
            const Service* svc = serviceForOwner(owner);
            if (svc && readName(d, len, p, target)) {
                std::string key = lower(target);
                bool known = false;
                for (auto& e : instances_) if (e.fqdn == key) known = true;
                if (!known) instances_.push_back({key, firstLabel(target), svc->protocol});
            }
        } else if (type == 33 && rdlen >= 7) {    // SRV
            size_t p = rdata + 6;
            int port = getU16(d + rdata + 4);
            std::string target;
            if (readName(d, len, p, target)) {
                bool known = false;
                for (auto& e : srv_) if (e.instance == owner) { e.target = lower(target); e.port = port; known = true; }
                if (!known) srv_.push_back({owner, lower(target), port});
            }
        } else if (type == 1 && rdlen == 4) {     // A
            char buf[INET_ADDRSTRLEN];
            in_addr a;
            std::memcpy(&a, d + rdata, 4);
            inet_ntop(AF_INET, &a, buf, sizeof buf);
            bool known = false;
            for (auto& e : addr_) if (e.first == owner) known = true;
            if (!known) addr_.push_back({owner, buf});
        }
        pos += rdlen;
    }
}

std::vector<NetHost> MdnsAccumulator::hosts() const {
    std::vector<NetHost> out;
    for (const auto& inst : instances_) {
        const Srv* srv = nullptr;
        for (const auto& s : srv_) if (s.instance == inst.fqdn) srv = &s;
        if (!srv) continue;
        for (const auto& a : addr_) {
            if (a.first == srv->target) {
                NetHost h;
                h.name = inst.label;
                h.address = a.second;
                h.protocol = inst.protocol;
                h.port = srv->port ? srv->port : defaultPortFor(inst.protocol);
                h.url = hostUrl(h.protocol, h.address, h.port);
                h.via = "mdns";
                out.push_back(h);
                break;
            }
        }
    }
    return out;
}

std::vector<std::string> MdnsAccumulator::unresolvedTargets() const {
    std::vector<std::string> out;
    for (const auto& s : srv_) {
        bool have = false;
        for (const auto& a : addr_) if (a.first == s.target) have = true;
        if (!have && std::find(out.begin(), out.end(), s.target) == out.end()) out.push_back(s.target);
    }
    return out;
}

size_t parseMdnsResponse(const uint8_t* data, size_t len, std::vector<NetHost>& out) {
    MdnsAccumulator acc;
    acc.feed(data, len);
    auto found = acc.hosts();
    out.insert(out.end(), found.begin(), found.end());
    return found.size();
}

bool probeTcp(const std::string& addr, int port, int timeout_ms) {
    auto r = connectBatch({addr}, port, timeout_ms);
    return !r.empty() && r[0];
}

std::vector<std::string> scanSubnet24(const std::string& base, int port, int timeout_ms,
                                      const std::vector<std::string>& skip) {
    uint32_t ip;
    std::vector<std::string> hits;
    if (!stringToIp(base, ip)) return hits;
    uint32_t first = (ip & 0xFFFFFF00u) + 1, last = (ip & 0xFFFFFF00u) + 254;
    std::vector<std::string> targets;
    for (uint32_t a = first; a <= last; ++a) {
        std::string s = ipToString(a);
        if (std::find(skip.begin(), skip.end(), s) == skip.end()) targets.push_back(s);
    }
    auto r = connectBatch(targets, port, timeout_ms);
    for (size_t i = 0; i < targets.size(); ++i) if (r[i]) hits.push_back(targets[i]);
    return hits;
}

} // namespace discovery_detail

namespace {

// mDNS: ask on every interface, listen until the deadline.
std::vector<NetHost> runMdns(const std::vector<Iface>& ifaces, int timeout_ms) {
    using namespace discovery_detail;
    std::vector<NetHost> none;
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return none;
    sockaddr_in me;
    std::memset(&me, 0, sizeof me);
    me.sin_family = AF_INET;
    me.sin_addr.s_addr = htonl(INADDR_ANY);
    me.sin_port = 0;
    if (::bind(fd, reinterpret_cast<sockaddr*>(&me), sizeof me) != 0) { ::close(fd); return none; }
    unsigned char ttl = 255;
    setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl);

    sockaddr_in group;
    std::memset(&group, 0, sizeof group);
    group.sin_family = AF_INET;
    group.sin_port = htons(5353);
    inet_pton(AF_INET, "224.0.0.251", &group.sin_addr);

    auto sendAll = [&](const std::vector<uint8_t>& q) {
        for (const auto& f : ifaces) {
            in_addr ifa;
            ifa.s_addr = htonl(f.ip);
            setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &ifa, sizeof ifa);
            ::sendto(fd, q.data(), q.size(), 0, reinterpret_cast<sockaddr*>(&group), sizeof group);
        }
    };

    MdnsAccumulator acc;
    auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
    const int resendAt[] = {0, 1000, 2200};
    auto started = Clock::now();
    size_t nextSend = 0;
    std::set<std::string> asked;
    uint8_t buf[9000];
    while (true) {
        int left = msLeft(deadline);
        if (left <= 0) break;
        int sinceStart = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started).count());
        if (nextSend < 3 && sinceStart >= resendAt[nextSend]) {
            for (const auto& svc : kServices) sendAll(buildMdnsQuery(std::string(svc.mdns) + ".local", 12));
            for (const auto& t : acc.unresolvedTargets()) {
                if (asked.insert(t).second) sendAll(buildMdnsQuery(t, 1));
            }
            ++nextSend;
        }
        int wait = std::min(left, 200);
        pollfd p;
        p.fd = fd; p.events = POLLIN; p.revents = 0;
        int n = ::poll(&p, 1, wait);
        if (n > 0 && (p.revents & POLLIN)) {
            ssize_t got = ::recv(fd, buf, sizeof buf, 0);
            if (got > 0) {
                acc.feed(buf, static_cast<size_t>(got));
                for (const auto& t : acc.unresolvedTargets()) {
                    if (asked.insert(t).second) sendAll(buildMdnsQuery(t, 1));
                }
            }
        }
    }
    ::close(fd);
    return acc.hosts();
}

} // namespace

namespace {

// UPnP/DLNA media servers: SSDP search, then read each device description.
std::vector<NetHost> runSsdp(const std::vector<Iface>& ifaces, int timeout_ms) {
    std::vector<NetHost> out;
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return out;
    sockaddr_in me;
    std::memset(&me, 0, sizeof me);
    me.sin_family = AF_INET;
    me.sin_addr.s_addr = htonl(INADDR_ANY);
    if (::bind(fd, reinterpret_cast<sockaddr*>(&me), sizeof me) != 0) { ::close(fd); return out; }
    unsigned char ttl = 4;
    setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl);

    sockaddr_in group;
    std::memset(&group, 0, sizeof group);
    group.sin_family = AF_INET;
    group.sin_port = htons(1900);
    inet_pton(AF_INET, "239.255.255.250", &group.sin_addr);
    const std::string search =
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n"
        "ST: urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n";

    std::set<std::string> locations;
    auto deadline = Clock::now() + std::chrono::milliseconds(std::min(timeout_ms, 3000));
    auto lastSend = Clock::now() - std::chrono::seconds(10);
    char buf[2048];
    while (true) {
        int left = msLeft(deadline);
        if (left <= 0) break;
        if (Clock::now() - lastSend > std::chrono::milliseconds(1200)) {
            for (const auto& f : ifaces) {
                in_addr ifa;
                ifa.s_addr = htonl(f.ip);
                setsockopt(fd, IPPROTO_IP, IP_MULTICAST_IF, &ifa, sizeof ifa);
                ::sendto(fd, search.data(), search.size(), 0, reinterpret_cast<sockaddr*>(&group), sizeof group);
            }
            lastSend = Clock::now();
        }
        pollfd p;
        p.fd = fd; p.events = POLLIN; p.revents = 0;
        if (::poll(&p, 1, std::min(left, 200)) > 0 && (p.revents & POLLIN)) {
            ssize_t n = ::recv(fd, buf, sizeof buf - 1, 0);
            if (n > 0) {
                std::string loc = discovery_detail::parseSsdpLocation(std::string(buf, static_cast<size_t>(n)));
                if (!loc.empty()) locations.insert(loc);
            }
        }
    }
    ::close(fd);

    std::set<std::string> seen;
    for (const auto& loc : locations) {
        std::string name, hostPort, control;
        if (!vfs::upnpDescribe(loc, name, hostPort, control)) continue;
        std::string ip = hostPort.substr(0, hostPort.rfind(':'));
        if (!seen.insert(hostPort + control).second) continue;
        NetHost h;
        h.name = name;
        h.address = ip;
        h.protocol = "upnp";
        size_t colon = hostPort.rfind(':');
        h.port = colon == std::string::npos ? 80 : std::atoi(hostPort.c_str() + colon + 1);
        h.url = "upnp://" + hostPort + "/" + vfs::urlEncode(control);
        h.via = "ssdp";
        out.push_back(h);
    }
    return out;
}

} // namespace

std::vector<NetHost> discoverHosts(int timeout_ms) {
    std::vector<NetHost> merged;
    try {
        auto ifaces = localInterfaces();
        if (ifaces.empty()) return merged;

        std::vector<NetHost> mdns, ssdp;
        std::thread mdnsThread([&]() { mdns = runMdns(ifaces, timeout_ms); });
        std::thread ssdpThread([&]() { ssdp = runSsdp(ifaces, timeout_ms); });

        std::vector<std::string> own;
        for (const auto& f : ifaces) own.push_back(ipToString(f.ip));
        // protocol, address -> found by scan
        std::vector<std::pair<std::string, std::string>> open;
        const struct { const char* protocol; int port; } scanPorts[] = {{"smb", 445}, {"nfs", 2049}, {"ftp", 21}};
        std::set<std::string> scanned;
        for (const auto& f : ifaces) {
            uint32_t net24 = f.ip & 0xFFFFFF00u;
            // Scan the device's own /24 (or the real subnet if it is narrower).
            uint32_t lo = std::max(f.ip & f.mask, net24);
            uint32_t hi = std::min((f.ip & f.mask) | ~f.mask, net24 + 255);
            std::vector<std::string> targets;
            for (uint32_t a = lo + 1; a < hi; ++a) {
                std::string s = ipToString(a);
                if (std::find(own.begin(), own.end(), s) != own.end()) continue;
                if (!scanned.insert(s).second) continue;
                targets.push_back(s);
            }
            for (const auto& sp : scanPorts) {
                auto r = connectBatch(targets, sp.port, 800);
                for (size_t i = 0; i < targets.size(); ++i) if (r[i]) open.push_back({sp.protocol, targets[i]});
            }
        }
        mdnsThread.join();
        ssdpThread.join();

        std::map<std::string, NetHost> byKey;          // "protocol|address[|url]"
        for (const auto& h : mdns) byKey[h.protocol + "|" + h.address] = h;
        for (const auto& pa : open) {
            std::string key = pa.first + "|" + pa.second;
            auto it = byKey.find(key);
            if (it != byKey.end()) {
                it->second.via = "mdns+scan";
            } else {
                NetHost h;
                h.name = pa.second;
                h.address = pa.second;
                h.protocol = pa.first;
                h.port = defaultPortFor(pa.first);
                h.url = discovery_detail::hostUrl(h.protocol, h.address, h.port);
                h.via = "scan";
                byKey[key] = h;
            }
        }
        for (const auto& h : ssdp) byKey["upnp|" + h.address + "|" + h.url] = h;

        for (auto& kv : byKey) {
            // An mDNS answer for a host that doesn't actually accept connections
            // (e.g. a stale cache entry) is dropped.
            if (kv.second.via == "mdns" && !discovery_detail::probeTcp(kv.second.address, kv.second.port, 800)) continue;
            merged.push_back(kv.second);
        }
        std::sort(merged.begin(), merged.end(), [](const NetHost& a, const NetHost& b) {
            if (lower(a.name) != lower(b.name)) return lower(a.name) < lower(b.name);
            return a.protocol < b.protocol;
        });
    } catch (const std::exception& e) {
        std::cout << "[Discovery] failed: " << e.what() << std::endl;
    }
    return merged;
}

bool DiscoveryService::start(int timeout_ms) {
    bool expected = false;
    if (!g_running.compare_exchange_strong(expected, true)) return false;
    std::thread([timeout_ms]() {
        auto found = discoverHosts(timeout_ms);
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_results = std::move(found);
        }
        g_running.store(false);
    }).detach();
    return true;
}

bool DiscoveryService::isRunning() const { return g_running.load(); }

std::vector<NetHost> DiscoveryService::results() {
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_results;
}
