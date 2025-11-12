const PUSH_ALARM = "bobbysync.push";
const PULL_ALARM = "bobbysync.pull";
const SETTINGS_KEY = "bobbysyncSettings";
const DEFAULT_ROOT_ID = "1"; // Chrome bookmarks bar
const CONFLICT_FOLDER_TITLE = "BobbySync Conflicts";
const ROOT_UID_OVERRIDES = {
  "1": "root-bookmarks-bar",
  "2": "root-other-bookmarks",
  "3": "root-mobile-bookmarks"
};
const ROOT_UID_TO_LOCAL = Object.entries(ROOT_UID_OVERRIDES).reduce(
  (acc, [localId, uid]) => {
    acc[uid] = localId;
    return acc;
  },
  {}
);
const ROOT_LOCAL_IDS = new Set(Object.keys(ROOT_UID_OVERRIDES));

const defaultSettings = {
  apiBase: "http://127.0.0.1:8080/v1",
  authToken: "",
  pushIntervalMinutes: 1,
  pullIntervalMinutes: 1,
  pullPageSize: 200
};

const state = {
  initialized: false,
  settings: { ...defaultSettings },
  opQueue: [],
  lastVersion: 0,
  deviceId: null,
  bookmarkIndex: { localToUid: {}, uidToLocal: {} },
  conflictFolderLocalId: null,
  pushInFlight: false,
  pullInFlight: false,
  replayDepth: 0,
  snapshotHydrated: false
};

let initPromise = null;
let bookmarkIndexDirty = false;

function log(...args) {
  console.log("[BobbySync]", ...args);
}

function warn(...args) {
  console.warn("[BobbySync]", ...args);
}

function ensureInit() {
  if (!initPromise) {
    initPromise = initialize();
  }
  return initPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  run(ensureInit);
});

chrome.runtime.onStartup.addListener(() => {
  run(ensureInit);
});

self.addEventListener("activate", (event) => {
  event.waitUntil(ensureInit());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) {
    state.settings = {
      ...defaultSettings,
      ...(changes[SETTINGS_KEY].newValue || {})
    };
    run(configureAlarms);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUSH_ALARM) {
    run(async () => {
      await ensureInit();
      await pushOps();
    });
  }
  if (alarm.name === PULL_ALARM) {
    run(async () => {
      await ensureInit();
      await pullOps();
    });
  }
});

chrome.bookmarks.onCreated.addListener((id, node) => {
  run(async () => {
    await ensureInit();
    if (state.replayDepth > 0) return;
    await handleCreated(id, node);
  });
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  run(async () => {
    await ensureInit();
    if (state.replayDepth > 0) return;
    await handleChanged(id, changeInfo);
  });
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  run(async () => {
    await ensureInit();
    if (state.replayDepth > 0) return;
    await handleRemoved(id, removeInfo);
  });
});

chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  run(async () => {
    await ensureInit();
    if (state.replayDepth > 0) return;
    await handleMoved(id, moveInfo);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "push-now") {
    ensureInit()
      .then(() => pushOps())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "pull-now") {
    ensureInit()
      .then(() => pullOps())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "get-status") {
    ensureInit()
      .then(() => {
        sendResponse({
          ok: true,
          status: {
            queueSize: state.opQueue.length,
            lastVersion: state.lastVersion,
            deviceId: state.deviceId,
            settings: state.settings
          }
        });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function initialize() {
  if (state.initialized) return;
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get([
      "opQueue",
      "lastVersion",
      "bookmarkIndex",
      "deviceId",
      "conflictFolderLocalId"
    ])
  ]);

  state.settings = { ...defaultSettings, ...(syncData[SETTINGS_KEY] || {}) };
  state.opQueue = Array.isArray(localData.opQueue) ? localData.opQueue : [];
  state.lastVersion = Number(localData.lastVersion || 0);
  state.bookmarkIndex =
    localData.bookmarkIndex || { localToUid: {}, uidToLocal: {} };
  state.deviceId = localData.deviceId || crypto.randomUUID();
  state.conflictFolderLocalId = localData.conflictFolderLocalId || null;

  await chrome.storage.local.set({
    opQueue: state.opQueue,
    lastVersion: state.lastVersion,
    bookmarkIndex: state.bookmarkIndex,
    deviceId: state.deviceId,
    conflictFolderLocalId: state.conflictFolderLocalId
  });

  await bootstrapTree();
  await configureAlarms();
  if (!state.snapshotHydrated && state.lastVersion === 0) {
    await hydrateFromSnapshot();
  }
  state.initialized = true;
  log("ready", {
    deviceId: state.deviceId,
    queue: state.opQueue.length,
    lastVersion: state.lastVersion
  });
}

async function bootstrapTree() {
  const [root] = await chrome.bookmarks.getTree();
  if (!root) return;
  const stack = [...(root.children || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    ensureUid(node.id);
    if (Array.isArray(node.children)) {
      stack.push(...node.children);
    }
  }
  await persistBookmarkIndex();
}

async function configureAlarms() {
  await chrome.alarms.clear(PUSH_ALARM);
  await chrome.alarms.clear(PULL_ALARM);
  chrome.alarms.create(PUSH_ALARM, {
    periodInMinutes: Math.max(1, Number(state.settings.pushIntervalMinutes) || 1)
  });
  chrome.alarms.create(PULL_ALARM, {
    periodInMinutes: Math.max(1, Number(state.settings.pullIntervalMinutes) || 1)
  });
}

async function hydrateFromSnapshot() {
  try {
    const snapshot = await fetchSnapshot();
    if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.nodes)) {
      return;
    }
    log("hydrating from snapshot", snapshot.data.nodes.length);
    const pending = [...snapshot.data.nodes];
    const maxIterations = pending.length * 3;
    let iterations = 0;
    while (pending.length && iterations < maxIterations) {
      const node = pending.shift();
      const parentReady = !node.parentUid || lookupLocalId(node.parentUid);
      if (parentReady) {
        await applyOp({
          op: "create",
          uid: node.uid,
          parentUid: node.parentUid ?? null,
          index: node.index ?? null,
          title: node.title ?? null,
          url: node.url ?? null,
          type: node.type || (node.url ? "bookmark" : "folder"),
          deviceId: "snapshot",
          ts: node.mtime || Date.now()
        });
      } else {
        pending.push(node);
      }
      iterations += 1;
    }
    if (pending.length) {
      warn("snapshot fallback", pending.length);
    }
    for (const node of pending) {
      await applyOp({
        op: "create",
        uid: node.uid,
        parentUid: node.parentUid ?? null,
        index: node.index ?? null,
        title: node.title ?? null,
        url: node.url ?? null,
        type: node.type || (node.url ? "bookmark" : "folder"),
        deviceId: "snapshot",
        ts: node.mtime || Date.now()
      });
    }
    if (Number.isFinite(snapshot.version)) {
      state.lastVersion = snapshot.version;
      await chrome.storage.local.set({ lastVersion: state.lastVersion });
    }
    state.snapshotHydrated = true;
  } catch (err) {
    warn("snapshot hydrate failed", err);
  }
}

async function handleCreated(localId, node) {
  const uid = ensureUid(localId);
  const parentUid = node.parentId ? ensureUid(node.parentId) : null;
  const op = buildOp("create", {
    uid,
    parentUid,
    index: node.index,
    title: node.title,
    url: node.url,
    type: node.url ? "bookmark" : "folder"
  });
  await enqueueOp(op);
  await persistBookmarkIndex();
}

async function handleChanged(localId, changeInfo) {
  const uid = ensureUid(localId);
  const node = await getNode(localId);
  const parentUid = node?.parentId ? ensureUid(node.parentId) : null;
  const op = buildOp("update", {
    uid,
    parentUid,
    title: changeInfo.title ?? node?.title ?? null,
    url: changeInfo.url ?? node?.url ?? null,
    type: node?.url ? "bookmark" : "folder"
  });
  await enqueueOp(op);
}

async function handleRemoved(localId, removeInfo) {
  const uid = ensureUid(localId);
  const parentUid = removeInfo.parentId ? ensureUid(removeInfo.parentId) : null;
  const op = buildOp("remove", {
    uid,
    parentUid,
    title: removeInfo.node?.title ?? null,
    url: removeInfo.node?.url ?? null,
    type: removeInfo.node?.children ? "folder" : "bookmark"
  });
  dropTreeMapping(removeInfo.node || { id: localId, children: [] });
  await persistBookmarkIndex();
  await enqueueOp(op);
}

async function handleMoved(localId, moveInfo) {
  const uid = ensureUid(localId);
  const parentUid = moveInfo.parentId ? ensureUid(moveInfo.parentId) : null;
  const op = buildOp("move", {
    uid,
    parentUid,
    index: moveInfo.index
  });
  await enqueueOp(op);
}

function buildOp(kind, payload) {
  return {
    op: kind,
    uid: payload.uid,
    parentUid: payload.parentUid ?? null,
    index:
      typeof payload.index === "number" && Number.isFinite(payload.index)
        ? payload.index
        : null,
    title: payload.title ?? null,
    url: payload.url ?? null,
    type: payload.type || (payload.url ? "bookmark" : "folder"),
    ts: Date.now(),
    deviceId: state.deviceId,
    opId: crypto.randomUUID()
  };
}

async function enqueueOp(op) {
  state.opQueue.push(op);
  await chrome.storage.local.set({ opQueue: state.opQueue });
}

async function pushOps() {
  if (state.pushInFlight) return;
  if (!state.opQueue.length) return;
  state.pushInFlight = true;
  const batch = state.opQueue.slice();
  try {
    const res = await fetch(buildApiUrl("/push"), {
      method: "POST",
      headers: buildHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ after: state.lastVersion, ops: batch })
    });
    if (!res.ok) throw new Error(`push failed: ${res.status}`);
    const data = await res.json();
    state.opQueue.splice(0, batch.length);
    if (Number.isFinite(data.newVersion)) {
      state.lastVersion = data.newVersion;
    }
    await chrome.storage.local.set({
      opQueue: state.opQueue,
      lastVersion: state.lastVersion
    });
  } catch (err) {
    warn("push error", err);
  } finally {
    state.pushInFlight = false;
  }
}

async function pullOps() {
  if (state.pullInFlight) return;
  state.pullInFlight = true;
  try {
    const pageSize = Math.max(
      50,
      Number(state.settings.pullPageSize) || defaultSettings.pullPageSize
    );
    while (true) {
      const res = await fetch(
        buildApiUrl(
          `/pull?after=${state.lastVersion}&limit=${pageSize}`
        ),
        { headers: buildHeaders() }
      );
      if (!res.ok) throw new Error(`pull failed: ${res.status}`);
      const data = await res.json();
      const ops = Array.isArray(data.ops) ? data.ops : [];
      if (!ops.length) {
        if (Number.isFinite(data.latest)) {
          state.lastVersion = data.latest;
          await chrome.storage.local.set({ lastVersion: state.lastVersion });
        }
        break;
      }
      for (const op of ops) {
        await applyOp(op);
      }
      if (Number.isFinite(data.latest)) {
        state.lastVersion = data.latest;
        await chrome.storage.local.set({ lastVersion: state.lastVersion });
      }
      if (ops.length < pageSize) {
        break;
      }
    }
  } catch (err) {
    warn("pull error", err);
  } finally {
    state.pullInFlight = false;
  }
}

async function applyOp(op) {
  if (!op || typeof op !== "object") return;
  if (!op.uid || !op.op) return;
  if (op.deviceId && op.deviceId === state.deviceId) return;
  await withReplay(async () => {
    switch (op.op) {
      case "create":
        await applyCreate(op);
        break;
      case "update":
        await applyUpdate(op);
        break;
      case "move":
        await applyMove(op);
        break;
      case "remove":
        await applyRemove(op);
        break;
      default:
        break;
    }
  });
}

async function applyCreate(op) {
  const localId = lookupLocalId(op.uid);
  const isFolder = op.type === "folder" || !op.url;
  const parentId = await resolveParentLocalId(op.parentUid);
  if (localId) {
    await maybeUpdateNode(localId, op, isFolder);
    await maybeMove(localId, parentId, op.index);
    return;
  }
  const payload = {
    parentId,
    title: op.title || ""
  };
  if (!isFolder && op.url) {
    payload.url = op.url;
  }
  if (Number.isFinite(op.index)) {
    payload.index = op.index;
  }
  try {
    const created = await chrome.bookmarks.create(payload);
    setMapping(created.id, op.uid);
    await persistBookmarkIndex();
  } catch (err) {
    warn("create failed", err);
  }
}

async function applyUpdate(op) {
  const localId = lookupLocalId(op.uid);
  if (!localId) return;
  await maybeUpdateNode(localId, op, op.type === "folder" || !op.url);
}

async function applyMove(op) {
  const localId = lookupLocalId(op.uid);
  if (!localId) return;
  const parentId = await resolveParentLocalId(op.parentUid);
  await maybeMove(localId, parentId, op.index);
}

async function applyRemove(op) {
  const localId = lookupLocalId(op.uid);
  if (!localId) return;
  try {
    const node = await getNode(localId);
    if (!node) return;
    if (node.url) {
      await chrome.bookmarks.remove(localId);
    } else {
      await chrome.bookmarks.removeTree(localId);
    }
    dropTreeMapping(node);
    await persistBookmarkIndex();
  } catch (err) {
    warn("remove failed", err);
  }
}

async function maybeUpdateNode(localId, op, isFolder) {
  const changes = {};
  if (typeof op.title === "string") changes.title = op.title;
  if (!isFolder && typeof op.url === "string") {
    changes.url = op.url;
  }
  if (Object.keys(changes).length) {
    try {
      await chrome.bookmarks.update(localId, changes);
    } catch (err) {
      warn("update failed", err);
    }
  }
}

async function maybeMove(localId, parentId, index) {
  try {
    const [node] = await chrome.bookmarks.get(localId);
    if (!node) return;
    const needsParent = parentId && node.parentId !== parentId;
    const needsIndex =
      typeof index === "number" && Number.isFinite(index) && node.index !== index;
    if (!needsParent && !needsIndex) return;
    const movePayload = {};
    if (parentId) movePayload.parentId = parentId;
    if (needsIndex) movePayload.index = index;
    await chrome.bookmarks.move(localId, movePayload);
  } catch (err) {
    warn("move failed", err);
  }
}

async function resolveParentLocalId(parentUid) {
  if (!parentUid) return DEFAULT_ROOT_ID;
  const local = lookupLocalId(parentUid);
  if (local) return local;
  return ensureConflictFolder();
}

async function ensureConflictFolder() {
  if (state.conflictFolderLocalId) {
    try {
      const nodes = await chrome.bookmarks.get(state.conflictFolderLocalId);
      if (nodes?.length) return state.conflictFolderLocalId;
    } catch (_) {
      // continue
    }
  }
  const folder = await chrome.bookmarks.create({
    parentId: DEFAULT_ROOT_ID,
    title: CONFLICT_FOLDER_TITLE
  });
  state.conflictFolderLocalId = folder.id;
  await chrome.storage.local.set({ conflictFolderLocalId: folder.id });
  return folder.id;
}

function ensureUid(localId) {
  if (!localId) return null;
  const key = String(localId);
  if (ROOT_UID_OVERRIDES[key]) {
    const fixed = ROOT_UID_OVERRIDES[key];
    if (state.bookmarkIndex.uidToLocal[fixed] !== key) {
      state.bookmarkIndex.uidToLocal[fixed] = key;
      state.bookmarkIndex.localToUid[key] = fixed;
      bookmarkIndexDirty = true;
    }
    return fixed;
  }
  let uid = state.bookmarkIndex.localToUid[key];
  if (uid) return uid;
  uid = crypto.randomUUID();
  setMapping(key, uid);
  return uid;
}

function lookupLocalId(uid) {
  if (!uid) return null;
  if (state.bookmarkIndex.uidToLocal[uid]) {
    return state.bookmarkIndex.uidToLocal[uid];
  }
  if (ROOT_UID_TO_LOCAL[uid]) {
    return ROOT_UID_TO_LOCAL[uid];
  }
  return null;
}

function setMapping(localId, uid) {
  const key = String(localId);
  state.bookmarkIndex.localToUid[key] = uid;
  state.bookmarkIndex.uidToLocal[uid] = key;
  bookmarkIndexDirty = true;
}

function removeMappingByLocal(localId) {
  const key = String(localId);
  if (ROOT_LOCAL_IDS.has(key)) return;
  const uid = state.bookmarkIndex.localToUid[key];
  if (!uid) return;
  delete state.bookmarkIndex.localToUid[key];
  delete state.bookmarkIndex.uidToLocal[uid];
  bookmarkIndexDirty = true;
}

function dropTreeMapping(node) {
  if (!node) return;
  removeMappingByLocal(node.id);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      dropTreeMapping(child);
    }
  }
}

async function persistBookmarkIndex() {
  if (!bookmarkIndexDirty) return;
  bookmarkIndexDirty = false;
  await chrome.storage.local.set({ bookmarkIndex: state.bookmarkIndex });
}

async function getNode(localId) {
  try {
    const nodes = await chrome.bookmarks.get(localId);
    return nodes?.[0] || null;
  } catch (err) {
    return null;
  }
}

function buildApiUrl(path) {
  const base = (state.settings.apiBase || defaultSettings.apiBase).replace(
    /\/+$/,
    ""
  );
  return `${base}${path}`;
}

function buildHeaders(extra) {
  const headers = new Headers(extra || {});
  if (state.settings.authToken) {
    headers.set("Authorization", `Bearer ${state.settings.authToken}`);
  }
  return headers;
}

async function fetchSnapshot() {
  try {
    const res = await fetch(buildApiUrl("/snapshot"), {
      headers: buildHeaders()
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    warn("snapshot fetch error", err);
    return null;
  }
}

async function withReplay(fn) {
  state.replayDepth += 1;
  try {
    await fn();
  } finally {
    state.replayDepth -= 1;
  }
}

function run(task) {
  Promise.resolve()
    .then(task)
    .catch((err) => warn("task failed", err));
}
