
---

# BobbySync — 自托管书签同步（MVP）

> Chrome/Chromium 系扩展（Manifest V3） + 个人电脑自托管服务
> 目标：可靠的基础同步，默认单人使用，先覆盖 Chrome/Atlas/Edge/Comet/豆包等 Chromium 阵营

---

## 1. 功能与范围（Scope）

**基础功能（MVP）**

* 监听本机书签变更（新增/删除/重命名/移动），生成**增量操作日志（ops）**并持久化到扩展本地缓存。
* 定时将增量 **push** 到自托管服务；另一端扩展周期性 **pull** 并在本地重放，完成双向同步。
* 首次安装/新设备冷启动：先拉取**全量快照**再拉增量，减少首同步时间。
* 支持 Atlas/Chrome/Edge 等 Chromium 浏览器（同一套 API）。书签读写基于 `chrome.bookmarks`。([Chrome for Developers][1])

**暂不包含**

* 团队多用户、共享权限。
* 完整冲突解决 UI（MVP 用 LWW 规则先过渡，见 §4）。
* 非 Chromium（Firefox/Safari）适配。

---

## 2. 总体架构

```
[浏览器扩展 (MV3 Service Worker)]
  ├─ 监听书签事件 → 累积 ops（storage.local）
  ├─ 定时 push（chrome.alarms） → POST /v1/push
  ├─ 定时 pull（chrome.alarms） ← GET  /v1/pull?after=v
  └─ 冷启动：GET /v1/snapshot → 重放 + 紧跟增量

[自托管服务（你的电脑）]
  ├─ Append-only 增量日志（version 递增）
  ├─ 周期性保存快照（压缩）
  └─ 简单鉴权（单用户长 token）；可放在 Cloudflare Tunnel/Tailscale 背后
```

* MV3 后台为**Service Worker**（事件驱动、非常驻），通过 `chrome.alarms` 定时触发同步任务。([Chrome for Developers][2])
* `chrome.storage.sync` 仅用于极少量跨设备状态（如位点），不可存书签大数据；配额约 **100KB 总/8KB 每项**。([Chrome for Developers][3])

---

## 3. 数据模型

**节点（统一 ID 空间）**

```json
{
  "uid": "uuidv4",              // 跨设备稳定 ID（不使用本地书签id）
  "type": "bookmark|folder",
  "title": "string",
  "url": "string|null",
  "parentUid": "uuidv4|null",
  "index": 0,
  "ctime": 1731300000,
  "mtime": 1731301234
}
```

**设备侧映射表**

```json
{ "uid": "localId" }  // 每台设备维护 uid ↔ 本地id 的双向映射
```

**增量操作（op）**

```json
{
  "op": "create|update|move|remove",
  "uid": "uuid",
  "parentUid": "uuid|null",
  "index": 0,
  "title": "string|null",
  "url": "string|null",
  "ts": 1731301245,
  "deviceId": "atlas-mbp",
  "opId": "uuid"  // 幂等去重
}
```

---

## 4. 同步与冲突

* **Push**：批量 POST `/v1/push`，服务端按 `version` 递增落盘。
* **Pull**：GET `/v1/pull?after=v&limit=1000`，直到追平 `latest`。
* **冷启动**：拉 `/v1/snapshot`（全量）→ 重放增量。
* **冲突策略（MVP）**：**LWW（Last-Write-Wins）**，即按 `ts`（同秒则按 `deviceId` 稳定比较）选择最终状态。发生 `move` 但父不存在时，回退到一个“Conflicts”文件夹以免丢失。
* **幂等**：客户端/服务端均对 `opId` 去重，保证断点续传安全。

---

## 5. 安全与网络

* **MVP 传输**：HTTPS（若使用 Cloudflare Tunnel 则自带 TLS）。**生产建议**尽快加 E2E（见 P1）。
* **自托管外网可达两法**

  * **Cloudflare Tunnel**：本机安装 `cloudflared`，无需开放入站端口即可暴露本地服务为公网 HTTPS。([Cloudflare Docs][4])
  * **Tailscale**：所有设备加入同一 tailnet，扩展直接访问服务器的 `100.x` 私网地址（MagicDNS 可用域名）。([tailscale.com][5])
* **Native Messaging（可选，仅本机）**：扩展可直连本地原生进程，无需 HTTP/CORS，适合“单机自用”。([Chrome for Developers][6])

---

## 6. 浏览器扩展（MVP）

**manifest.json**

```json
{
  "manifest_version": 3,
  "name": "BobbySync",
  "version": "0.1.0",
  "permissions": ["bookmarks", "storage", "alarms"],
  "host_permissions": ["https://your-tunnel.example/*", "http://127.0.0.1:8080/*"],
  "background": { "service_worker": "sw.js" },
  "action": { "default_popup": "popup.html" }
}
```

**sw.js（核心逻辑骨架，伪码）**

```js
const API = "https://your-tunnel.example/v1";
const state = { lastVersion: 0, queue: [] };

chrome.runtime.onInstalled.addListener(init);
chrome.alarms.create("push", { periodInMinutes: 1 });
chrome.alarms.create("pull", { periodInMinutes: 1 });

chrome.bookmarks.onCreated.addListener((id, node) => enqueue("create", node));
chrome.bookmarks.onRemoved.addListener((id, info) => enqueue("remove", {id}));
chrome.bookmarks.onChanged.addListener((id, ch) => enqueue("update", {id, ...ch}));
chrome.bookmarks.onMoved.addListener((id, mv) => enqueue("move", {id, ...mv}));

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "push") await pushOps();
  if (a.name === "pull") await pullOps();
});

async function init(){ state.lastVersion = (await loadKV("lastVersion"))||0; }
function enqueue(kind, payload){ state.queue.push(toOp(kind, payload)); saveKV("queue", state.queue); }

async function pushOps(){
  const batch = state.queue.splice(0); if (!batch.length) return;
  const r = await fetch(`${API}/push`, { method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ after: state.lastVersion, ops: batch }) });
  const { newVersion } = await r.json(); state.lastVersion = newVersion;
  await saveKV("lastVersion", state.lastVersion);
}

async function pullOps(){
  let changed = false;
  while(true){
    const r = await fetch(`${API}/pull?after=${state.lastVersion}`);
    const { ops, latest } = await r.json(); if (!ops.length){ break; }
    for(const op of ops) await applyOp(op); // 使用 chrome.bookmarks.* 重放
    state.lastVersion = latest; changed = true;
  }
  if(changed) await saveKV("lastVersion", state.lastVersion);
}
```

> 关键点：
>
> * 书签读写与事件监听用 `chrome.bookmarks`。([Chrome for Developers][1])
> * 后台为 **Service Worker**，需用 `alarms` 定时唤醒处理任务。([Chrome for Developers][2])
> * `storage.sync` 仅存 `lastVersion` 等小状态（配额有限）。([Chrome for Developers][3])

---

## 7. 自托管服务（MVP）

**接口定义**

* `POST /v1/push` → `{after, ops[]}` 追加到日志；返回 `{newVersion}`
* `GET  /v1/pull?after=v&limit=1000` → `{ops[], latest}`
* `GET  /v1/snapshot` → 返回最近快照（可 gzip）
* `PUT  /v1/snapshot` → 上传快照（后续 P1 用）

**极简 Node/Express 原型（20 行骨架）**

```js
import express from "express"; import fs from "fs";
const app = express(); app.use(express.json({limit:"5mb"}));
let version = 0; const log = []; // 内存日志，落盘请用 SQLite/LevelDB

app.post("/v1/push", (req,res)=>{ const {after, ops=[]} = req.body||{};
  for(const op of ops){ log.push({ ...op, version: ++version }); }
  res.json({ ok:true, newVersion: version });
});

app.get("/v1/pull", (req,res)=>{ const after = +req.query.after||0;
  const ops = log.filter(x=>x.version>after).slice(0,1000);
  const latest = version; res.json({ ops, latest });
});

app.listen(8080, ()=>console.log("srv: http://127.0.0.1:8080"));
```

**外网可达（任选其一）**

* Cloudflare Tunnel：安装并认证 `cloudflared`，将 `http://127.0.0.1:8080` 暴露为：https 地址（零入站端口）。([Cloudflare Docs][4])
* Tailscale：设备加入同一 tailnet，直接用 `100.x` 私网地址访问服务。([tailscale.com][5])

---

## 8. 配置与部署

1. **启动自托管服务**

```bash
node server.js
# 若用 Cloudflare Tunnel（临时验证）
cloudflared tunnel --url http://127.0.0.1:8080
```

> Cloudflare 文档提供受管隧道的持久配置与面板步骤。([Cloudflare Docs][7])

2. **加载扩展（开发者模式）**

* 打开扩展管理 → 加载已解压扩展 → 选择包含 `manifest.json` 的目录。
* 在 `manifest.json` 的 `host_permissions` 中填入你的 https 隧道域名或 Tailscale 地址。
* 验证：在任一设备新增书签，观察另一台设备是否出现同名书签。

---

## 9. 质量保障

**验收标准（Definition of Done）**

* 双端新建/删除/重命名/移动，在 1–2 分钟内完成同步重放。
* 网络断开后恢复，之前的增量可继续推送且无重复执行（`opId` 幂等）。
* 新设备首次安装：能从快照+增量在 5 分钟内重建 >2k 条书签库。

**测试清单**

* 深层文件夹（>5 层）、中文/emoji 标题、同 URL 多标题、批量操作（>200 ops）。
* 关机/断网/重启浏览器后重试；服务端重启后版本号一致性。
* 回滚：保留上一个快照，手动还原并重放增量验证一致性。

---

## 10. 路线图（优先级）

**P0（当前文档覆盖）**

* 扩展：事件监听→本地队列→定时 push/pull→本地重放。
* 服务：append-only 日志 + 拉取接口；可选快照下载。
* 打通 Cloudflare Tunnel 或 Tailscale 私网。

**P1（推荐下一步）**

* **端到端加密（E2E）**：扩展用 WebCrypto `AES‑GCM` 在本地加密快照/增量，服务端仅存密文；首设备生成主密钥，次设备用口令/二维码导入。
* 冲突更优处理：保留“冲突文件夹”与 UI 提示。
* 快照压缩与自动化（每 N 次增量/每天一次）。

**P2（扩展与生态）**

* Native Messaging 通道（单机场景零 CORS）。([Chrome for Developers][6])
* Firefox/Safari 适配（WebExtensions API 接口名基本同源，但需分别测试）。
* 健康工具：死链检查、UTM/追踪参数清理、重复合并。

---

## 11. 设计依据（关键文档）

* `chrome.bookmarks`：书签增删改查与事件。([Chrome for Developers][1])
* `storage.sync`：仅适合小配置（约 100KB 总/8KB 每项）。([Chrome for Developers][3])
* MV3 **Service Worker** 生命周期与迁移指南。([Chrome for Developers][2])
* `chrome.alarms` 定时唤醒后台任务。([Chrome for Developers][8])
* **Native Messaging**（扩展 ↔ 本地进程）。([Chrome for Developers][6])
* **Cloudflare Tunnel** / **Tailscale** 自托管出网通道。([Cloudflare Docs][4])

---

## 12. 可复核步骤（5 分钟自测）

1. 本机起服务（`node server.js`）并用 `cloudflared tunnel --url http://127.0.0.1:8080` 暴露为公网 HTTPS；拿到域名。([Cloudflare Docs][4])
2. 在两台设备加载扩展，`manifest.json` 中填入上一步域名。
3. 设备A：添加 3 条书签、改名 1 条、移动 1 条；等待 1–2 分钟。
4. 设备B：应看到 5 个操作均复现；再在B删 1 条，A 侧应同步删除。
5. 断网并新增书签 → 恢复网络 → 应能继续 push，且不会重复创建（检查 `opId` 幂等）。

---

### 附：最小交付清单（给 Codex）

* `extension/manifest.json`、`extension/sw.js`、`extension/popup.html`（可选）
* `server/server.js`（Express骨架）
* `docs/README.md`（即本文）
* `scripts/dev-tunnel.sh`（Cloudflare Tunnel 一键脚本，含 CORS 允许头）
* `.env.example`（TOKEN、API 基址）

---

这份 README 覆盖了**基础功能**的完整设计与落地路径，工程上先跑通 P0 即可获得稳定可用的「自托管书签同步」。后续如需要，我可以把上述骨架扩展成**完整可运行的代码模板**并补充端到端加密与快照压缩策略。

[1]: https://developer.chrome.com/docs/extensions/reference/api/bookmarks?utm_source=chatgpt.com "chrome.bookmarks | API - Chrome for Developers"
[2]: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle?utm_source=chatgpt.com "The extension service worker lifecycle - Chrome for Developers"
[3]: https://developer.chrome.com/docs/extensions/reference/api/storage?utm_source=chatgpt.com "chrome.storage | API - Chrome for Developers"
[4]: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/?utm_source=chatgpt.com "Set up your first tunnel · Cloudflare One docs"
[5]: https://tailscale.com/kb?utm_source=chatgpt.com "Docs"
[6]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging?utm_source=chatgpt.com "Native messaging - Chrome for Developers"
[7]: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/?utm_source=chatgpt.com "Create a tunnel (dashboard) - Cloudflare One"
[8]: https://developer.chrome.com/docs/extensions/reference/api/alarms?utm_source=chatgpt.com "chrome.alarms | API - Chrome for Developers"
