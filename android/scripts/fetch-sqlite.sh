#!/usr/bin/env bash
# Downloads the SQLite "amalgamation" (one C file) that PEK TV's library and music databases are built on.
# Output: android/sqlite/sqlite3.c and sqlite3.h   (run by GitHub Actions; run it once by hand for a local Android Studio build)
# Optional:
#   SQLITE_SHA3_256=<hash from https://www.sqlite.org/download.html>  refuse a download that differs
#   SQLITE_URL=<address of a sqlite-amalgamation-*.zip>                use a mirror, or a local file:// copy
set -euo pipefail

SQLITE_YEAR=2024
SQLITE_VER=3450100        # SQLite 3.45.1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # .../android
OUT="$ROOT/sqlite"
URL="${SQLITE_URL:-https://www.sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_VER}.zip}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Already there AND real (a cache restore can hand back empty/truncated files)? Then nothing to do.
if [ -s "$OUT/sqlite3.c" ] && grep -q '#define SQLITE_VERSION ' "$OUT/sqlite3.h" 2>/dev/null \
   && grep -q 'sqlite3_open_v2' "$OUT/sqlite3.c" 2>/dev/null; then
  echo "SQLite already in $OUT"; exit 0
fi
rm -rf "$OUT"

echo "Downloading $URL"
# Try the chosen URL, then the bare sqlite.org host as a fallback.
ALT="https://sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_VER}.zip"
curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "$URL" -o "$WORK/sqlite.zip" \
  || { echo "Primary download failed, trying $ALT"; curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "$ALT" -o "$WORK/sqlite.zip"; } \
  || { echo "::error::Could not download SQLite from $URL (set SQLITE_URL to a mirror, or put sqlite3.c and sqlite3.h into $OUT yourself)"; exit 1; }
if [ -n "${SQLITE_SHA3_256:-}" ]; then
  got="$(python3 -c "import hashlib,sys;print(hashlib.sha3_256(open(sys.argv[1],'rb').read()).hexdigest())" "$WORK/sqlite.zip")"
  [ "$got" = "$SQLITE_SHA3_256" ] || { echo "::error::SQLite download does not match SQLITE_SHA3_256 (got $got)"; exit 1; }
fi
mkdir -p "$OUT"
# '*/' = whatever the folder inside the zip is called
unzip -q -j -o "$WORK/sqlite.zip" '*/sqlite3.c' '*/sqlite3.h' -d "$OUT" \
  || { echo "::error::The download did not contain sqlite3.c and sqlite3.h"; exit 1; }
[ -s "$OUT/sqlite3.c" ] && [ -s "$OUT/sqlite3.h" ] || { echo "::error::sqlite3.c / sqlite3.h are empty"; exit 1; }
echo "SQLite unpacked into $OUT ($(grep -m1 '#define SQLITE_VERSION ' "$OUT/sqlite3.h" || echo version unknown))"
