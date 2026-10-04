#ifndef DISCOVERY_H
#define DISCOVERY_H

#include <string>
#include <vector>
#include <cstdint>

// Finds machines on the local network that offer SMB (Windows / NAS / Samba)
// file shares - the same job Kodi's "Add network location" browser does.
//
// Two methods run together and their results are merged by IP address:
//   1. mDNS / Bonjour: asks the network "who offers _smb._tcp?". Gives friendly
//      names (e.g. "MY-NAS"). Needs multicast; on Android the app must hold a
//      WifiManager.MulticastLock while this runs (see HesperAndroid.setMulticast).
//   2. Port scan: tries TCP port 445 on every address of the device's own
//      subnet(s). Works without multicast, finds hosts that don't advertise.
// Pure POSIX sockets, no extra libraries.

struct NetHost {
    std::string name;      // friendly name when known, otherwise == address
    std::string address;   // dotted IPv4
    std::string via;       // "mdns", "scan" or "mdns+scan"
};

// Blocking: returns after about timeout_ms. Never throws.
std::vector<NetHost> discoverSmbHosts(int timeout_ms = 4000);

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
    // Hosts that have all three pieces. Safe to call repeatedly.
    std::vector<NetHost> hosts() const;
    // SRV targets seen but with no A record yet (to ask for explicitly).
    std::vector<std::string> unresolvedTargets() const;
private:
    struct Impl;
    std::vector<std::pair<std::string, std::string>> instances_;   // fqdn, display label
    std::vector<std::pair<std::string, std::string>> srv_;         // instance fqdn -> target host
    std::vector<std::pair<std::string, std::string>> addr_;        // host (lowercase) -> IPv4
    friend struct Impl;
};
// Convenience for one packet.
size_t parseMdnsResponse(const uint8_t* data, size_t len, std::vector<NetHost>& out);
// Builds an mDNS question for `name` (e.g. "_smb._tcp.local"); qtype 12 = PTR, 1 = A.
std::vector<uint8_t> buildMdnsQuery(const std::string& name, uint16_t qtype = 12);
// True if a TCP connect to addr:port succeeds within timeout_ms.
bool probeTcp(const std::string& addr, int port, int timeout_ms);
// Scans every host address in a.b.c.0/24 around `base` (any address inside it)
// for an open `port`; returns the addresses that answered.
std::vector<std::string> scanSubnet24(const std::string& base, int port, int timeout_ms,
                                      const std::vector<std::string>& skip);
}

#endif
