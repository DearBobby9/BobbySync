# Repository Guidelines

## Project Structure & Module Organization
`extension/` contains the Chrome MV3 artifacts (`manifest.json`, `sw.js`, `popup.html`). `server/` hosts the Express sync API (`server.js`) and persists data under `data/store.json` (overridable via `DATA_DIR`). Helper tooling lives in `scripts/` (Cloudflare tunnel wrapper, smoke test). Docs live in `docs/`, and temporary assets should stay under `data/`.

## Build, Test, and Development Commands
- `npm install` — install server + tooling dependencies; rerun whenever `package.json` changes.
- `npm run dev:server` — start the local sync server on `PORT` (default 8080). Combine with `DATA_DIR=/tmp/bobbysync npm run dev:server` for isolated runs.
- `npm run test:local` — executes `scripts/smoke-local.js`, spinning up the server, pushing/pulling sample bookmark ops, and verifying snapshot round-trips.
- `./scripts/dev-tunnel.sh` — launches the server, then exposes it through `cloudflared tunnel --url http://127.0.0.1:$PORT`. Requires `cloudflared` on PATH and an optional `.env` describing `PORT`, `LOCAL_URL`, `CORS_ORIGIN`.

## Coding Style & Naming Conventions
JavaScript is written in CommonJS modules with 2-space indentation, semicolons, and `const`/`let` (never `var`). Use `camelCase` for functions and variables, `SCREAMING_SNAKE_CASE` for constants (`PUSH_ALARM`), and kebab-case for new scripts. Service worker logic mirrors Chrome APIs—keep async flows inside `run(...)` helpers and guard against concurrent syncs using the existing state flags.

## Testing Guidelines
Run `npm run test:local` before every commit; it boots a temporary server, drives push/pull flows, and fails fast if API contracts break. When adding new behaviors, extend `scripts/smoke-local.js` with deterministic scenarios named for the feature (e.g., “conflict-resolution”). For browser-side changes, exercise manual sync cycles using the extension popup (`extension/popup.html`) and record repro steps in your PR.

## Commit & Pull Request Guidelines
Use imperative, scope-prefixed summaries such as `server: cap pull limit` or `extension: harden bookmark index`. Keep the first line ≤72 characters, explain motivation in following paragraphs, and link issues as `Refs #123`. Every PR should include: a concise description, verification steps (commands run, screenshots of the popup if UI changed), and notes about config or manifest updates. Confirm `npm run test:local` and any manual extension checks succeed before requesting review.

## Security & Configuration Tips
Store secrets in `.env` only; never commit it. Always set `AUTH_TOKEN` when exposing the server over a tunnel, and mirror the chosen base URL inside `extension/defaultSettings.apiBase` plus `manifest.json` `host_permissions`. If you change CORS origins or tunnel domains, update both `scripts/dev-tunnel.sh` defaults and the extension settings UI.
