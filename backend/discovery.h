#ifndef DISCOVERY_H
#define DISCOVERY_H

#include <string>
#include <vector>
#include <cstdint>

// Finds machines on the local network that share files - the same job Kodi's
// "Add network location" browser does. Finds SMB (Windows / NAS / Samba), NFS,
// FTP, WebDAV and UPnP/DLNA media servers. Three methods run together and their
// results are merged by protocol + address:
//   1. mDNS / Bonjour: asks the network "who offers _smb._tcp, _nfs._tcp,
//      _ftp._tcp, _webdav._tcp ...?". Gives friendly names (e.g. "MY-NAS") and
//      the only automatic way to find WebDAV. Needs multicast; on Android the
//      app must hold a WifiManager.MulticastLock while this runs
//      (see HesperAndroid.setMulticast).
//   2. SSDP: the UPnP/DLNA "who is a media server?" broadcast (also multicast).
//   3. Port scan: tries TCP 445 (SMB), 2049 (NFS) and 21 (FTP) on every address
//      of the device's own subnet(s). Works without multicast and finds hosts
//      that don't advertise.
// Plain POSIX sockets; the UPnP description fetch uses httplib (vfs_http.cpp).

struct NetHost {
    std::string name;      // friendly name when known, otherwise == address
    std::string address;   // dotted IPv4
    std::string protocol;  // smb, nfs, ftp, dav, davs, upnp
    int port = 0;
    std::string url;       // where to start browsing, e.g. smb://192.168.1.5
    std::string via;       // "mdns", "scan", "ssdp" or "mdns+scan"
};

// Blocking: returns after about timeout_ms. Never throws.
std::vector<NetHost> discoverHosts(int timeout_ms = 4000);

// Background runner used by the HTTP API (POST /api/discover starts it,
// GET /api/discover reads it). Only one run at a time.
class DiscoveryService {
public:
    // Returns false if a run is already in progress.
    bool start(int timeout_ms = 4000);
    bool isRunning() const;
    std::vector<NetHost> results();
};

// ---- exposed for tests ----
namespace discovery_detail {
// Collects DNS records from any number of mDNS response packets (a service's
// PTR / SRV / A records often arrive in separate packets) and joins them into
// finished hosts: instance name -> SRV target -> A address.
class MdnsAccumulator {
public:
    // Reads one packet. Malformed or truncated packets are ignored safely.
    void feed(const uint8_t* data, size_t len);
    // Hosts that have all three pieces (name, port, address). Safe to call repeatedly.
    std::vector<NetHost> hosts() const;
    // SRV targets seen but with no A record yet (to ask for explicitly).
    std::vector<std::string> unresolvedTargets() const;
private:
    struct Instance { std::string fqdn, label, protocol; };
    struct Srv { std::string instance, target; int port; };
    std::vector<Instance> instances_;
    std::vector<Srv> srv_;
    std::vector<std::pair<std::string, std::string>> addr_;        // host (lowercase) -> IPv4
};
// Convenience for one packet.
size_t parseMdnsResponse(const uint8_t* data, size_t len, std::vector<NetHost>& out);
// Builds an mDNS question for `name` (e.g. "_smb._tcp.local"); qtype 12 = PTR, 1 = A.
std::vector<uint8_t> buildMdnsQuery(const std::string& name, uint16_t qtype = 12);
// Pulls the LOCATION URL out of an SSDP reply ("" if it isn't a media-server reply).
std::string parseSsdpLocation(const std::string& packet);
// Start URL for a host: smb://1.2.3.4, ftp://1.2.3.4:2121, ...
std::string hostUrl(const std::string& protocol, const std::string& address, int port);
// True if a TCP connect to addr:port succeeds within timeout_ms.
bool probeTcp(const std::string& addr, int port, int timeout_ms);
// Scans every host address in a.b.c.0/24 around `base` (any address inside it)
// for an open `port`; returns the addresses that answered.
std::vector<std::string> scanSubnet24(const std::string& base, int port, int timeout_ms,
                                      const std::vector<std::string>& skip);
}

#endif
