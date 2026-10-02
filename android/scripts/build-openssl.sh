#!/usr/bin/env bash
# Builds static OpenSSL 3 for Android (run by GitHub Actions, not on the phone).
# Output: android/openssl/<abi>/{include,lib/libssl.a,lib/libcrypto.a}
set -euo pipefail

OPENSSL_VER=3.0.15
API=21
NDK="${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:?NDK not found}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"          # .../android
OUT="$ROOT/openssl"
WORK="$(mktemp -d)"

export ANDROID_NDK_ROOT="$NDK"
export PATH="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"

curl -fsSL "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VER}/openssl-${OPENSSL_VER}.tar.gz" \
  -o "$WORK/openssl.tar.gz"

build_one() {   # $1 = openssl target, $2 = android abi name
  local target="$1" abi="$2"
  mkdir -p "$WORK/$abi" && tar xzf "$WORK/openssl.tar.gz" -C "$WORK/$abi" --strip-components=1
  ( cd "$WORK/$abi"
    ./Configure "$target" -D__ANDROID_API__=$API no-shared no-tests \
      --prefix="$OUT/$abi" --openssldir="$OUT/$abi/ssl" --libdir=lib
    make -j"$(nproc)" build_libs
    make install_dev )
}

build_one android-arm   armeabi-v7a
build_one android-arm64 arm64-v8a

ls -R "$OUT" | head -30
