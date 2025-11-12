#!/usr/bin/env node
const { mkdtemp, rm } = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { setTimeout: delay } = require("timers/promises");

const ROOT = path.join(__dirname, "..");
const PORT = 48080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/v1`;

let server;

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "bobbysync-smoke-"));
  try {
    server = spawn("node", ["server/server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        AUTH_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    server.stdout.on("data", (chunk) => {
      process.stdout.write(`[server] ${chunk}`);
    });
    server.stderr.on("data", (chunk) => {
      process.stderr.write(`[server-err] ${chunk}`);
    });

    await waitForServerReady();
    await runScenario();
    console.log("\n✅ Local smoke test passed. Server + API behave as expected.\n");
  } finally {
    await shutdown(server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForServerReady() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error("Server exited before becoming ready");
    }
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch (_) {
      // ignore until timeout
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for server");
}

async function runScenario() {
  const deviceA = "chrome-profile-A";
  const deviceB = "chrome-profile-B";
  const folderUid = randomUUID();
  const bookmarkUid = randomUUID();

  await pushOps(deviceA, [
    {
      op: "create",
      uid: folderUid,
      parentUid: null,
      title: "Smoke Folder",
      type: "folder",
      index: 0,
    },
    {
      op: "create",
      uid: bookmarkUid,
      parentUid: folderUid,
      title: "BobbySync Docs",
      url: "https://example.com",
      type: "bookmark",
      index: 0,
    },
  ]);

  const pullB = await pullSince(0, 10);
  assert(pullB.ops.length === 2, "Device B should see two ops from A");
  assert(pullB.latest >= 2, "Version should advance after Device A push");

  await pushOps(deviceB, [
    {
      op: "update",
      uid: bookmarkUid,
      parentUid: folderUid,
      title: "BobbySync Docs v2",
      url: "https://example.com/v2",
      type: "bookmark",
    },
  ]);

  const pullA = await pullSince(2, 10);
  assert(pullA.ops.length === 1, "Device A should see one op from B");
  assert(pullA.ops[0].uid === bookmarkUid, "Update should target the bookmark uid");

  await roundTripSnapshot(folderUid, bookmarkUid);
}

async function pushOps(deviceId, ops) {
  const enriched = ops.map((op) => ({
    ...op,
    deviceId,
    opId: randomUUID(),
    ts: Date.now(),
  }));
  const res = await fetch(`${API}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ after: 0, ops: enriched }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Push failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function pullSince(after, limit) {
  const res = await fetch(`${API}/pull?after=${after}&limit=${limit || 100}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pull failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function roundTripSnapshot(folderUid, bookmarkUid) {
  const payload = {
    version: 99,
    takenAt: new Date().toISOString(),
    data: {
      nodes: [
        {
          uid: folderUid,
          parentUid: null,
          title: "Smoke Folder",
          type: "folder",
          index: 0,
        },
        {
          uid: bookmarkUid,
          parentUid: folderUid,
          title: "BobbySync Docs v2",
          url: "https://example.com/v2",
          type: "bookmark",
          index: 0,
        },
      ],
    },
  };

  const put = await fetch(`${API}/snapshot`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!put.ok) {
    const text = await put.text();
    throw new Error(`Snapshot PUT failed (${put.status}): ${text}`);
  }

  const get = await fetch(`${API}/snapshot`);
  if (!get.ok) {
    const text = await get.text();
    throw new Error(`Snapshot GET failed (${get.status}): ${text}`);
  }
  const snapshot = await get.json();
  assert(snapshot.data?.nodes?.length === 2, "Snapshot should echo stored nodes");
}

async function shutdown(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill();
  await delay(250);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((err) => {
  console.error("❌ Local smoke test failed:", err);
  process.exit(1);
});
