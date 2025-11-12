#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"
OUT_ZIP="$DIST_DIR/bobbysync-extension.zip"

if ! command -v zip >/dev/null 2>&1; then
  echo "[BobbySync] 'zip' command not found. Install unzip/zip utilities first." >&2
  exit 1
fi

if [[ ! -d "$EXT_DIR" ]]; then
  echo "[BobbySync] extension directory not found at $EXT_DIR" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
tmp_dir=$(mktemp -d)

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

rsync -a --delete --exclude=".DS_Store" "$EXT_DIR/" "$tmp_dir/extension/"

(
  cd "$tmp_dir/extension"
  zip -r "$OUT_ZIP" . >/dev/null
)

echo "[BobbySync] Packed extension to $OUT_ZIP"
