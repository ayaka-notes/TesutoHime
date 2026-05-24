#!/bin/sh
# Download the clangd WebAssembly binary used by the in-browser language
# server. We host it on a GitHub Release of this repo rather than
# checking it into git, because (a) at ~120 MB it busts GitHub's 100 MB
# per-file hard limit, and (b) public forks can't push new LFS objects.
#
# Usage:
#   scripts/fetch-clangd.sh [dest-path]
#
# Env overrides:
#   CLANGD_WASM_URL     download URL (defaults to the ayaka-notes release)
#   CLANGD_WASM_SHA256  if set, validates the download
#
# Idempotent: noop if the destination already exists.
set -e

DEST=${1:-web/static/lib/clangd/clangd.wasm}
URL=${CLANGD_WASM_URL:-https://github.com/ayaka-notes/TesutoHime/releases/download/assets-v1/clangd.wasm}
SHA256=${CLANGD_WASM_SHA256:-0d71e7a7f8e6dd369cb2a0b22cc4016d649f370e5b905adb6092536deb0ee019}

if [ -f "$DEST" ]; then
    echo "[fetch-clangd] $DEST already exists, skipping download."
    exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "[fetch-clangd] downloading from $URL ..."
curl -fSL --retry 3 -o "$DEST.tmp" "$URL"

if [ -n "$SHA256" ]; then
    echo "$SHA256  $DEST.tmp" | sha256sum -c -
fi
mv "$DEST.tmp" "$DEST"
echo "[fetch-clangd] saved to $DEST ($(wc -c < "$DEST") bytes)"
