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
# Network shares (SMB): discovery always works. To also browse and play files
# from shares, build with libsmb2 installed:  HESPER_SMB=1 bash dev.sh
# (needs libsmb2 headers + library; without it the app says "no SMB support").
#
# Needs (Termux): pkg install clang python openssl, and httplib.h in the
# source folder. For TMDb: export TMDB_API_KEY=your_key (before running).

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
    SMB_FLAGS=""
    SMB_SRC=""
    if [ "$HESPER_SMB" = "1" ]; then
        SMB_FLAGS="-DHESPER_SMB -DHESPER_SMB_SHARE_ENUM -lsmb2"
        SMB_SRC="vfs_smb.cpp"
    fi
    g++ -std=c++17 -O1 \
        -DCPPHTTPLIB_OPENSSL_SUPPORT \
        core.cpp server.cpp media_scanner.cpp playback.cpp discovery.cpp vfs.cpp $SMB_SRC \
        -o "$ROOT/bin/hesper" \
        $(python3-config --cflags --embed) \
        $(python3-config --ldflags --embed) \
        -lssl -lcrypto -lpthread $SMB_FLAGS
fi

# Android blocks executing files on shared storage (/storage/emulated/0,
# ~/storage/...), so run from a copy in Termux's home folder. The build
# output in bin/ is still the one that gets updated.
RUN_COPY="$HOME/.hesper_run"
cp "$ROOT/bin/hesper" "$RUN_COPY"
chmod +x "$RUN_COPY"

echo "==> Running (Ctrl+C to stop)"
"$RUN_COPY"
