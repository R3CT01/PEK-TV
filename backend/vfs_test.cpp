// Dev test: g++ -std=c++17 -o /tmp/vfs_test vfs_test.cpp vfs.cpp && /tmp/vfs_test
// Exercises the pure URL helpers in vfs.cpp (no network, no filesystem): parseUrl, buildUrl,
// join, parent, urlEncode/urlDecode. These are what sources.tsv, the library cache and the
// /api/net/browse route all depend on, so a regression here is silent-corruption-of-paths, not
// a crash -- worth pinning down with tests.
#include "vfs.h"
#include <cstdio>
#include <string>
static int fails = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL line %d: %s\n", __LINE__, #c); ++fails; } } while (0)

int main() {
    // --- isRemote / knownScheme / hasShares -------------------------------------------------
    CHECK(vfs::isRemote("smb://host/share/folder"));
    CHECK(vfs::isRemote("davs://host:443/x"));
    CHECK(!vfs::isRemote("/local/folder"));
    CHECK(!vfs::isRemote("C:\\Users\\me"));
    CHECK(vfs::knownScheme("nfs") && vfs::knownScheme("upnp") && !vfs::knownScheme("http"));
    CHECK(vfs::hasShares("smb") && vfs::hasShares("nfs") && vfs::hasShares("upnp"));
    CHECK(!vfs::hasShares("ftp") && !vfs::hasShares("dav"));

    // --- parseUrl: SMB with a share and a nested path ----------------------------------------
    {
        vfs::Url u;
        CHECK(vfs::parseUrl("smb://nas.local/Movies/Action/Heat (1995)", u));
        CHECK(u.scheme == "smb" && u.host == "nas.local" && u.share == "Movies" && u.path == "Action/Heat (1995)");
    }
    // --- parseUrl: FTP with a port and no share (path starts right after the host) -----------
    {
        vfs::Url u;
        CHECK(vfs::parseUrl("ftp://media.example.com:2121/incoming/show", u));
        CHECK(u.scheme == "ftp" && u.host == "media.example.com:2121" && u.share.empty() && u.path == "incoming/show");
    }
    // --- parseUrl: host with no path at all ---------------------------------------------------
    {
        vfs::Url u;
        CHECK(vfs::parseUrl("smb://nas.local", u));
        CHECK(u.host == "nas.local" && u.share.empty() && u.path.empty());
    }
    // --- parseUrl: unknown scheme is refused --------------------------------------------------
    {
        vfs::Url u;
        CHECK(!vfs::parseUrl("http://example.com/x", u));
        CHECK(!vfs::parseUrl("not a url at all", u));
    }

    // --- buildUrl is the inverse of parseUrl (round-trip) -------------------------------------
    {
        vfs::Url u;
        vfs::parseUrl("smb://nas.local/Movies/Action/Heat (1995)", u);
        CHECK(vfs::buildUrl(u) == "smb://nas.local/Movies/Action/Heat (1995)");
    }
    {
        vfs::Url u;
        vfs::parseUrl("ftp://media.example.com:2121/incoming/show", u);
        CHECK(vfs::buildUrl(u) == "ftp://media.example.com:2121/incoming/show");
    }

    // --- join: building a child path from a directory URL -------------------------------------
    CHECK(vfs::join("smb://nas.local/Movies", "Heat (1995)") == "smb://nas.local/Movies/Heat (1995)");
    CHECK(vfs::join("smb://nas.local/Movies/", "Heat (1995)") == "smb://nas.local/Movies/Heat (1995)");  // trailing slash tolerated
    CHECK(vfs::join("smb://nas.local", "Movies") == "smb://nas.local/Movies");                            // share-less -> becomes the share

    // --- parent: one level up, "" once we are back at the top ---------------------------------
    CHECK(vfs::parent("smb://nas.local/Movies/Action/Heat (1995)") == "smb://nas.local/Movies/Action");
    CHECK(vfs::parent("smb://nas.local/Movies") == "smb://nas.local");
    CHECK(vfs::parent("smb://nas.local").empty());

    // --- urlEncode / urlDecode round-trip for a share-ish path segment ------------------------
    {
        std::string raw = "Kids & Family / Año 2024";
        std::string enc = vfs::urlEncode(raw);
        CHECK(enc.find(' ') == std::string::npos);     // no literal spaces or raw '&' once encoded
        CHECK(enc.find('&') == std::string::npos);
        CHECK(vfs::urlDecode(enc) == raw);
    }
    CHECK(vfs::urlDecode("%2Fsrv%2Fmedia") == "/srv/media");   // the NFS export example from the header comment

    std::printf(fails ? "%d FAILED\n" : "all vfs tests passed\n", fails);
    return fails ? 1 : 0;
}
