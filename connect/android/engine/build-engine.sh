#!/usr/bin/env bash
# Builds the PeerPayload transfer engine (engine/, as libpeerpayload.so with
# its C API) for Android, with OpenSSL linked in statically. Runs on Linux;
# from Windows, through Docker:
#
#   docker run --rm -v "<repo>:/src" -v pp-android-cache:/cache \
#     debian:bookworm bash /src/connect/android/engine/build-engine.sh
#
# Output: connect/android/app/src/main/jniLibs/<abi>/libpeerpayload.so
# (git-ignored; rerun this after engine or JNI changes). Downloads (NDK, OpenSSL)
# are verified against published checksums and cached in /cache.
set -euo pipefail

NDK_VERSION=r27c
NDK_ZIP=android-ndk-${NDK_VERSION}-linux.zip
NDK_SHA1=090e8083a715fdb1a3e402d0763c388abb03fb4e  # from Google's repository2-3.xml
OPENSSL_VERSION=3.5.9                               # LTS line
API=26                                              # Android 8.0, the app's minSdk
ABIS=(arm64-v8a x86_64)                             # phones; emulator

SRC=${SRC:-/src}
CACHE=${CACHE:-/cache}
OUT=$SRC/connect/android/app/src/main/jniLibs
WORK=/tmp/pp-android

declare -A OPENSSL_TARGET=([arm64-v8a]=android-arm64 [x86_64]=android-x86_64)

if ! command -v cmake >/dev/null || ! command -v perl >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl unzip make perl cmake ninja-build >/dev/null
fi

mkdir -p "$CACHE" "$WORK" "$OUT"

# Download with retries, continuing a partial file instead of restarting.
fetch() {
  local out=$1 url=$2 try
  for try in 1 2 3 4 5 6 7 8; do
    curl -fsSL --http1.1 --retry 5 --retry-all-errors -C - -o "$out" "$url" && return 0
    echo "   download interrupted (try $try), continuing"
    sleep 5
  done
  return 1
}

# --- NDK ---------------------------------------------------------------
if [ ! -d "$CACHE/android-ndk-$NDK_VERSION" ]; then
  echo "== downloading NDK $NDK_VERSION"
  # ~700 MB: HTTP/1.1, resumed across dropped connections.
  fetch "$CACHE/$NDK_ZIP" "https://dl.google.com/android/repository/$NDK_ZIP"
  echo "$NDK_SHA1  $CACHE/$NDK_ZIP" | sha1sum -c -
  unzip -q "$CACHE/$NDK_ZIP" -d "$CACHE"
  rm "$CACHE/$NDK_ZIP"
fi
export ANDROID_NDK_ROOT=$CACHE/android-ndk-$NDK_VERSION
TOOLCHAIN=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64

# --- OpenSSL source ------------------------------------------------------
OSSL_TGZ=openssl-$OPENSSL_VERSION.tar.gz
if [ ! -f "$CACHE/$OSSL_TGZ" ]; then
  echo "== downloading OpenSSL $OPENSSL_VERSION"
  base=https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION
  fetch "$CACHE/$OSSL_TGZ" "$base/$OSSL_TGZ"
  fetch "$CACHE/$OSSL_TGZ.sha256" "$base/$OSSL_TGZ.sha256"
  echo "$(cut -d' ' -f1 "$CACHE/$OSSL_TGZ.sha256")  $CACHE/$OSSL_TGZ" | sha256sum -c -
fi

for abi in "${ABIS[@]}"; do
  prefix=$CACHE/openssl-$OPENSSL_VERSION-$abi

  # --- OpenSSL, static, per ABI -----------------------------------------
  if [ ! -f "$prefix/lib/libssl.a" ]; then
    echo "== OpenSSL for $abi"
    rm -rf "$WORK/openssl-$abi"
    mkdir -p "$WORK/openssl-$abi"
    tar -xzf "$CACHE/$OSSL_TGZ" -C "$WORK/openssl-$abi" --strip-components=1
    (
      cd "$WORK/openssl-$abi"
      PATH=$TOOLCHAIN/bin:$PATH ./Configure "${OPENSSL_TARGET[$abi]}" -D__ANDROID_API__=$API \
        no-shared no-tests no-docs no-apps no-module --prefix="$prefix" --libdir=lib >/dev/null
      PATH=$TOOLCHAIN/bin:$PATH make -j"$(nproc)" >/dev/null
      make install_sw >/dev/null
    )
  fi

  # --- the engine ---------------------------------------------------------
  echo "== engine for $abi"
  build=$WORK/engine-$abi
  cmake -S "$SRC" -B "$build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-$API -DANDROID_STL=c++_static \
    -DCMAKE_FIND_ROOT_PATH="$prefix" \
    -DOPENSSL_ROOT_DIR="$prefix" -DOPENSSL_USE_STATIC_LIBS=TRUE \
    -DPEERPAYLOAD_JNI_SOURCES="$SRC/connect/android/engine/jni/pp_jni.cpp" >/dev/null
  cmake --build "$build" --target peerpayload

  mkdir -p "$OUT/$abi"
  "$TOOLCHAIN/bin/llvm-strip" --strip-unneeded -o "$OUT/$abi/libpeerpayload.so" "$build/engine/libpeerpayload.so"
  echo "   -> $(du -h "$OUT/$abi/libpeerpayload.so" | cut -f1) $OUT/$abi/libpeerpayload.so"
done

echo "== done"
