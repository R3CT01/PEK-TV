#!/data/data/com.termux/files/usr/bin/bash
# Dev helper: builds PEK into your project root's bin/ folder, then
# runs it. Nothing is installed system-wide.
#   bash dev.sh         build, then run  (use "bash" — files on shared
#                       storage can't be made executable)
#   ./dev.sh --run      skip the build, just run the last binary
#
# Root folder = the nearest folder (this one or a parent) that already
# contains a bin/ folder; if none exists, bin/ is created next to this script.
#
# Network folders: discovery, FTP, WebDAV and DLNA/UPnP always work (no extra
# libraries). SMB and NFS need their libraries installed, then opt in:
#   PEK_SMB=1 bash dev.sh      (needs libsmb2)
#   PEK_NFS=1 bash dev.sh      (needs libnfs)
#   PEK_SMB=1 PEK_NFS=1 bash dev.sh   (both)
# Without them the app says "no SMB support" / "no NFS support" for those types.
#
# Needs (Termux): pkg install clang python openssl sqlite, and httplib.h in the
# source folder. For TMDb: export TMDB_API_KEY=your_key (before running).
#
# Search sites: this version adds /api/torrent/sites, /site, /allow and /fetch (torrent_routes.cpp).
# They fetch pages over HTTPS, so OpenSSL is REQUIRED (checked below). The search sites themselves are set in the
# app (Settings); rebuild only when .cpp files change.

set -e
# old HESPER_* switches still work
[ -z "$PEK_SMB" ] && PEK_SMB="$HESPER_SMB"
[ -z "$PEK_NFS" ] && PEK_NFS="$HESPER_NFS"
[ -z "$PEK_TORRENT" ] && PEK_TORRENT="$HESPER_TORRENT"
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
    echo "==> Building to $ROOT/bin/pek ..."
    [ -f httplib.h ] || { echo "!! httplib.h is missing from $SRC_DIR"; exit 1; }
    command -v python3-config >/dev/null 2>&1 || { echo "!! python3-config not found (pkg install python)"; exit 1; }
    echo "#include <openssl/ssl.h>" | g++ -x c++ -fsyntax-only - >/dev/null 2>&1 || { echo "!! OpenSSL headers not found (pkg install openssl). Search sites need HTTPS."; exit 1; }
    echo "#include <sqlite3.h>" | g++ -x c++ -fsyntax-only - >/dev/null 2>&1 || { echo "!! SQLite headers not found (pkg install sqlite). The library and music databases need it."; exit 1; }
    SMB_FLAGS=""
    SMB_SRC=""
    if [ "$PEK_SMB" = "1" ]; then
        SMB_FLAGS="$SMB_FLAGS -DPEK_SMB -DPEK_SMB_SHARE_ENUM -lsmb2"
        SMB_SRC="$SMB_SRC vfs_smb.cpp"
    fi
    if [ "$PEK_NFS" = "1" ]; then
        SMB_FLAGS="$SMB_FLAGS -DPEK_NFS -lnfs"
        SMB_SRC="$SMB_SRC vfs_nfs.cpp"
    fi
    # Torrent playback (needs libtorrent-rasterbar installed): PEK_TORRENT=1 bash dev.sh
    TORRENT_FLAGS=""
    if [ "$PEK_TORRENT" = "1" ]; then
        TORRENT_FLAGS="-DPEK_TORRENT $(pkg-config --cflags --libs libtorrent-rasterbar 2>/dev/null || echo -ltorrent-rasterbar)"
    fi
    g++ -std=c++17 -O1 \
        -DCPPHTTPLIB_OPENSSL_SUPPORT \
        core.cpp server.cpp media_scanner.cpp playback.cpp music.cpp music_tags.cpp discovery.cpp vfs.cpp vfs_ftp.cpp vfs_http.cpp torrent.cpp torrent_routes.cpp $SMB_SRC \
        -o "$ROOT/bin/pek" \
        $(python3-config --cflags --embed) \
        $(python3-config --ldflags --embed) \
        -lssl -lcrypto -lsqlite3 -lpthread $SMB_FLAGS $TORRENT_FLAGS
fi

# Android blocks executing files on shared storage (/storage/emulated/0,
# ~/storage/...), so run from a copy in Termux's home folder. The build
# output in bin/ is still the one that gets updated.
RUN_COPY="$HOME/.pek_run"
cp "$ROOT/bin/pek" "$RUN_COPY"
chmod +x "$RUN_COPY"

echo "==> Running (Ctrl+C to stop)"
"$RUN_COPY"
