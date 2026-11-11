#!/usr/bin/env bash
# Builds the engine (sender, receiver, ppkeygen) for Linux release builds,
# with OpenSSL inside it, so the Connect AppImage runs on distributions with
# a different OpenSSL, or none. OpenSSL is built from source, the same
# version as the Android engine (connect/android/engine/build-engine.sh),
# rather than the distribution's static library, which pulls in whatever
# extras that distribution enabled (zlib, jitterentropy, ...).
#
#   engine/build-linux.sh            # output: build/{sender/sender,receiver/receiver,engine/ppkeygen}
#
# Needs: a C/C++ compiler, cmake, make, perl, curl. Downloads are checked
# against OpenSSL's published SHA-256 and cached in $CACHE.
set -euo pipefail

OPENSSL_VERSION=3.5.9                    # LTS line; keep in step with Android
REPO=$(cd "$(dirname "$0")/.." && pwd)
CACHE=${CACHE:-$HOME/.cache/peerpayload}
PREFIX=$CACHE/openssl-$OPENSSL_VERSION-linux-x86_64
OUT=${OUT:-$REPO/build}

mkdir -p "$CACHE"

if [ ! -f "$PREFIX/lib/libcrypto.a" ]; then
  tgz=openssl-$OPENSSL_VERSION.tar.gz
  base=https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION

  if [ ! -f "$CACHE/$tgz" ]; then
    echo "== downloading OpenSSL $OPENSSL_VERSION"
    curl -fsSL -o "$CACHE/$tgz.part" "$base/$tgz"
    mv "$CACHE/$tgz.part" "$CACHE/$tgz"
  fi

  curl -fsSL -o "$CACHE/$tgz.sha256" "$base/$tgz.sha256"
  echo "$(cut -d' ' -f1 "$CACHE/$tgz.sha256")  $CACHE/$tgz" | sha256sum -c - >/dev/null
  echo "== OpenSSL $OPENSSL_VERSION checksum OK; building it (static)"

  work=$(mktemp -d)
  tar -xzf "$CACHE/$tgz" -C "$work" --strip-components=1
  (
    cd "$work"
    ./Configure linux-x86_64 no-shared no-tests no-docs no-apps no-module \
      --prefix="$PREFIX" --libdir=lib >/dev/null
    make -s -j"$(nproc)" >/dev/null
    make -s install_sw >/dev/null
  )
  rm -rf "$work"
fi

echo "== building the engine"
cmake -S "$REPO" -B "$OUT" -DCMAKE_BUILD_TYPE=Release \
  -DPEERPAYLOAD_STATIC_OPENSSL=ON -DOPENSSL_ROOT_DIR="$PREFIX" >/dev/null
cmake --build "$OUT" --parallel "$(nproc)" >/dev/null

for e in sender/sender receiver/receiver engine/ppkeygen; do
  if ldd "$OUT/$e" | grep -q "libssl\|libcrypto"; then
    echo "error: $e still links the system OpenSSL" >&2
    exit 1
  fi
done

echo "== done: $OUT/{sender/sender,receiver/receiver,engine/ppkeygen}, OpenSSL $OPENSSL_VERSION inside"
