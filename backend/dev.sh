#!/data/data/com.termux/files/usr/bin/bash
# Dev helper: builds Hesper into your project root's bin/ folder, then
# runs it. Nothing is installed system-wide.
#   bash dev.sh         build, then run  (use "bash" — files on shared
#                       storage can't be made executable)
#   ./dev.sh --run      skip the build, just run the last binary
#
# Root folder = the nearest folder (this one or a parent) that already
# contains a bin/ folder; if none exists, bin/ is created next to this script.
#
# Network folders: discovery, FTP, WebDAV and DLNA/UPnP always work (no extra
# libraries). SMB (libsmb2) and NFS (libnfs) are AUTO-DETECTED: if their
# headers are installed they are built in, otherwise skipped with a note, so
# the same script behaves the same on Termux, Linux and Windows (MSYS2/WSL).
# Override with HESPER_SMB=0|1 and HESPER_NFS=0|1 (1 = required, 0 = skip).
# SMB share listing is only enabled when libsmb2 still ships its old
# DCE/RPC headers; newer libsmb2 lacks them and share listing is skipped.
#
# Needs (Termux): pkg install clang python openssl, and httplib.h in the
# source folder. For TMDb: export TMDB_API_KEY=your_key (before running).
#
# Search sites: this version adds /api/torrent/sites, /site, /allow and /fetch (torrent_routes.cpp).
# They fetch pages over HTTPS, so OpenSSL is REQUIRED (checked below). After editing
# www/search_sites.js or a plugin's site list you only need to restart; rebuild only when .cpp files change.

set -e
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SRC_DIR"

ROOT="$SRC_DIR"
d="$SRC_DIR"
while [ "$d" != "/" ]; do
    if [ -d "$d/bin" ]; then ROOT="$d"; break; fi
    d="$(dirname "$d")"
done
mkdir -p "$ROOT/bin"

if [ "$1" != "--run" ]; then
    echo "==> Building to $ROOT/bin/hesper ..."
    # Preflight: fail early with a clear message instead of a wall of compiler errors.
    [ -f httplib.h ] || { echo "!! httplib.h is missing from $SRC_DIR"; exit 1; }
    command -v python3-config >/dev/null 2>&1 || { echo "!! python3-config not found (pkg install python)"; exit 1; }
    echo "#include <openssl/ssl.h>" | g++ -x c++ -fsyntax-only - >/dev/null 2>&1 || { echo "!! OpenSSL headers not found (pkg install openssl). Search sites need HTTPS."; exit 1; }
    SMB_FLAGS=""
    SMB_SRC=""

    # has_header <header>: does the compiler find it?
    has_header() { echo "#include <$1>" | g++ -x c++ -fsyntax-only - >/dev/null 2>&1; }

    want_smb="${HESPER_SMB:-auto}"
    if [ "$want_smb" = "auto" ]; then
        if has_header smb2/libsmb2.h; then want_smb=1; else want_smb=0; echo "==> SMB: libsmb2 not found, building without SMB"; fi
    fi
    if [ "$want_smb" = "1" ]; then
        SMB_FLAGS="$SMB_FLAGS -DHESPER_SMB -lsmb2"
        SMB_SRC="$SMB_SRC vfs_smb.cpp"
        if has_header smb2/libsmb2-dcerpc-srvsvc.h; then
            SMB_FLAGS="$SMB_FLAGS -DHESPER_SMB_SHARE_ENUM"
            echo "==> SMB: on (with share listing)"
        else
            echo "==> SMB: on (share listing off: libsmb2 has no DCE/RPC headers)"
        fi
    fi

    want_nfs="${HESPER_NFS:-auto}"
    if [ "$want_nfs" = "auto" ]; then
        if has_header nfsc/libnfs.h; then want_nfs=1; else want_nfs=0; echo "==> NFS: libnfs not found, building without NFS"; fi
    fi
    if [ "$want_nfs" = "1" ]; then
        SMB_FLAGS="$SMB_FLAGS -DHESPER_NFS -lnfs"
        SMB_SRC="$SMB_SRC vfs_nfs.cpp"
        echo "==> NFS: on"
    fi
    # Torrent streaming (libtorrent-rasterbar): AUTO-DETECTED like SMB/NFS. HESPER_TORRENT=0|1 overrides.
    # Without it the release search still works; only playing a torrent reports "not built in".
    TORRENT_FLAGS=""
    want_torrent="${HESPER_TORRENT:-auto}"
    if [ "$want_torrent" = "auto" ]; then
        if has_header libtorrent/session.hpp; then want_torrent=1; else want_torrent=0; echo "==> Torrents: libtorrent not found, building without torrent playback"; fi
    fi
    if [ "$want_torrent" = "1" ]; then
        TORRENT_FLAGS="-DHESPER_TORRENT $(pkg-config --cflags --libs libtorrent-rasterbar 2>/dev/null || echo -ltorrent-rasterbar)"
        echo "==> Torrents: on"
    fi
    g++ -std=c++17 -O1 \
        -DCPPHTTPLIB_OPENSSL_SUPPORT \
        core.cpp server.cpp media_scanner.cpp playback.cpp discovery.cpp vfs.cpp vfs_ftp.cpp vfs_http.cpp torrent.cpp torrent_routes.cpp $SMB_SRC \
        -o "$ROOT/bin/hesper" \
        $(python3-config --cflags --embed) \
        $(python3-config --ldflags --embed) \
        -lssl -lcrypto -lpthread $SMB_FLAGS $TORRENT_FLAGS
fi

# Android blocks executing files on shared storage (/storage/emulated/0,
# ~/storage/...), so run from a copy in Termux's home folder. The build
# output in bin/ is still the one that gets updated.
RUN_COPY="$HOME/.hesper_run"
cp "$ROOT/bin/hesper" "$RUN_COPY"
chmod +x "$RUN_COPY"

echo "==> Search sites: edit www/search_sites.js (restart to apply)"
echo "==> Running (Ctrl+C to stop)"
"$RUN_COPY"
