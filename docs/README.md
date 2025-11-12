# BobbySync MVP

BobbySync consists of a Manifest V3 browser extension that watches local bookmark changes plus a tiny Express server that stores ops/snapshots. This repo gives you a runnable skeleton to plug into the architecture from `todo.md`.

## Contents

| Path | Purpose |
| --- | --- |
| `extension/` | MV3 background service worker + popup to monitor status and edit API/token. |
| `server/server.js` | Append-only log server with `/v1/push`, `/v1/pull`, `/v1/snapshot` (GET/PUT) and JSON persistence. |
| `scripts/dev-tunnel.sh` | Convenience launcher that boots the server then exposes it through Cloudflare Tunnel. |
| `.env.example` | Server environment knobs (port, auth token, CORS, log limits). |

## Prerequisites

* Node.js 18+ (for `crypto.randomUUID` and top-level async/await in the extension worker).
* Chrome/Edge/Arc/Atlas etc. to load the MV3 extension.
* Optional: `cloudflared` (or Tailscale) if you need the server to be reachable from other devices.

## Bootstrap the server (local-only MVP)

```bash
cp .env.example .env            # edit AUTH_TOKEN / PORT / DATA_DIR
npm install                     # installs express + dotenv
npm run dev:server              # starts http://127.0.0.1:8080
```

Environment variables (`.env`) map 1:1 to `server/server.js` options:

* `PORT` – listen port (default 8080).
* `AUTH_TOKEN` – bearer token checked on mutating routes; leave empty for local dev.
* `DATA_DIR` – folder where `store.json` lives.
* `CORS_ORIGIN` – value returned in `Access-Control-Allow-Origin` (e.g. your tunnel domain).
* `BODY_LIMIT_MB`, `MAX_PULL_LIMIT`, `MAX_LOG_OPS` – tune payload sizes.

The server keeps every op in `data/store.json`, de-dupes by `opId`, caps logs to `MAX_LOG_OPS`, and supports idempotent snapshots.

## One-click smoke test

`npm run test:local`

The script inside `scripts/smoke-local.js` spins up the server on a random localhost port with a temporary data directory, simulates two devices pushing/pulling bookmark ops plus a snapshot round-trip, and tears everything down. It is a fast sanity check before you start wiring real browsers.

## (Optional) Cloudflare Tunnel helper

`scripts/dev-tunnel.sh` loads `.env` (if present), exports `CORS_ORIGIN`, starts `server/server.js`, and finally runs `cloudflared tunnel --url http://127.0.0.1:<PORT>`. Usage:

```bash
LOCAL_URL=http://127.0.0.1:8080 \
CORS_ORIGIN=https://your-tunnel.example \
scripts/dev-tunnel.sh --hostname your-tunnel.example
```

Stop with `Ctrl+C` and the script will cleanly kill the Node server. Skip this section if you only need on-device sync.

## Load the extension

1. Open `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick the `extension/` folder.
2. Click the toolbar icon → fill in your API base (`https://your-tunnel.example/v1`) and optional bearer token in the popup.
3. The popup can trigger manual push/pull and shows queue length, last applied version, and device ID.

The background worker:

* Listens to `chrome.bookmarks.*` events, assigns deterministic `uid`s, batches ops in `chrome.storage.local`, and push/pulls every minute via `chrome.alarms`.
* Replays pulled ops with LWW semantics. When parents are missing it drops items inside an auto-created `BobbySync Conflicts` folder instead of discarding them.
* On a cold start (`lastVersion === 0`) it attempts to hydrate from `/v1/snapshot` before consuming incremental ops.

## Ops + API quick reference

* `POST /v1/push` – `{ after, ops[] }` → `{ ok, newVersion }`.
* `GET  /v1/pull?after=<v>&limit=<n>` – `{ ops[], latest }`.
* `GET  /v1/snapshot` – `{ version, data }`. The extension expects `data.nodes` to be an array of `{ uid, parentUid, title, url, index, type }` sorted parents-first.
* `PUT  /v1/snapshot` – accepts any JSON payload and stores it verbatim, tagging it with `takenAt` + `version`.

## Manual self-test (P0)

1. Run the server (or `scripts/dev-tunnel.sh`) and load the extension on Device A.
2. Set API/token via the popup, wait ~1 minute for the first pull cycle.
3. Add/rename/move/delete bookmarks on Device A → watch the popup queue shrink after push.
4. Load extension on Device B pointing at the same API, then trigger *Pull* manually once; Device B should recreate the ops within seconds.
5. Disconnect Device A, make changes, reconnect → push should resume without duplicates because every op carries `opId` + `deviceId`.

## Next steps

* Wire up WebCrypto-based E2E (encrypt ops/snapshots before hitting the server).
* Persist snapshots using compressed files (e.g., daily) and expose `PUT /v1/snapshot` in the extension for scheduled uploads.
* Add richer health surfaces (options page, diagnostics, badge counts) and Firefox/Safari ports when needed.
