require("dotenv").config();
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const MAX_PULL_LIMIT = Number(process.env.MAX_PULL_LIMIT || 1000);
const BODY_LIMIT_MB = Number(process.env.BODY_LIMIT_MB || 5);
const MAX_LOG_OPS = Number(process.env.MAX_LOG_OPS || 50000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,OPTIONS,HEAD"
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const state = {
  version: 0,
  ops: [],
  snapshot: null,
  opLookup: new Set(),
};

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.get("authorization") || "";
  if (header === `Bearer ${AUTH_TOKEN}`) {
    return next();
  }
  res.status(401).json({ error: "unauthorized" });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: state.version, ops: state.ops.length });
});

app.get("/v1/pull", (req, res) => {
  const after = Number(req.query.after || 0);
  const limitRaw = Number(req.query.limit || MAX_PULL_LIMIT);
  const limit = Math.max(1, Math.min(limitRaw, MAX_PULL_LIMIT));
  const ops = state.ops.filter((op) => op.version > after).slice(0, limit);
  res.json({ ops, latest: state.version });
});

app.post("/v1/push", requireAuth, async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (!incoming.length) {
      return res.json({ ok: true, accepted: 0, newVersion: state.version });
    }
    let accepted = 0;
    for (const raw of incoming) {
      const op = normalizeOp(raw);
      if (!op) continue;
      if (op.opId && state.opLookup.has(op.opId)) continue;
      op.version = ++state.version;
      state.ops.push(op);
      if (op.opId) state.opLookup.add(op.opId);
      accepted += 1;
    }
    pruneOps();
    await persistState();
    res.json({ ok: true, accepted, newVersion: state.version });
  } catch (err) {
    next(err);
  }
});

app.get("/v1/snapshot", (_req, res) => {
  if (!state.snapshot) {
    return res.status(404).json({ error: "snapshot_not_found" });
  }
  res.json(state.snapshot);
});

app.put("/v1/snapshot", requireAuth, async (req, res, next) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "invalid_snapshot" });
    }
    const snapshotData =
      payload.data === null
        ? null
        : payload.data ?? payload.payload ?? payload.nodes ?? payload;
    const parsedVersion = Number(payload.version);
    state.snapshot = {
      version: Number.isFinite(parsedVersion) ? parsedVersion : state.version,
      takenAt: payload.takenAt || new Date().toISOString(),
      data: snapshotData,
    };
    await persistState();
    res.json({ ok: true, version: state.snapshot.version });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal_error" });
});

function normalizeOp(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.uid || !raw.op) return null;
  const opId = raw.opId || randomUUID();
  const idx = Number(raw.index);
  const safeIndex = Number.isFinite(idx) ? idx : null;
  return {
    op: String(raw.op),
    uid: String(raw.uid),
    parentUid: raw.parentUid ?? null,
    index: safeIndex,
    title: raw.title ?? null,
    url: raw.url ?? null,
    ts: raw.ts || Date.now(),
    deviceId: raw.deviceId || null,
    opId,
  };
}

function pruneOps() {
  const overflow = state.ops.length - MAX_LOG_OPS;
  if (overflow <= 0) return;
  const removed = state.ops.splice(0, overflow);
  for (const op of removed) {
    if (op.opId) state.opLookup.delete(op.opId);
  }
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadState() {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const disk = JSON.parse(raw);
    state.version = Number(disk.version || 0);
    state.ops = Array.isArray(disk.ops) ? disk.ops : [];
    state.snapshot = disk.snapshot || null;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // fall through with empty state
  }
  state.opLookup = new Set(
    state.ops.map((op) => op.opId).filter(Boolean)
  );
}

async function persistState() {
  const payload = JSON.stringify(
    {
      version: state.version,
      ops: state.ops,
      snapshot: state.snapshot,
    },
    null,
    2
  );
  await fs.writeFile(STORE_FILE, payload, "utf8");
}

async function start() {
  await ensureDataDir();
  await loadState();
  app.listen(PORT, () => {
    console.log(
      `BobbySync server listening on http://0.0.0.0:${PORT} (ops=${state.ops.length})`
    );
  });
}

start().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
