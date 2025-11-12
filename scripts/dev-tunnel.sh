#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

PORT=${PORT:-8080}
LOCAL_URL=${LOCAL_URL:-http://127.0.0.1:${PORT}}
CORS_ORIGIN=${CORS_ORIGIN:-*}

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required. Install from https://developers.cloudflare.com/cloudflare-one/" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Dependencies missing. Run 'npm install' in $ROOT_DIR" >&2
  exit 1
fi

echo "[BobbySync] Allowing CORS origin: $CORS_ORIGIN"
echo "[BobbySync] Starting local server on port $PORT"
PORT=$PORT CORS_ORIGIN=$CORS_ORIGIN node "$ROOT_DIR/server/server.js" &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

sleep 1

echo "[BobbySync] Exposing $LOCAL_URL via Cloudflare Tunnel"
cloudflared tunnel --url "$LOCAL_URL" "$@"
