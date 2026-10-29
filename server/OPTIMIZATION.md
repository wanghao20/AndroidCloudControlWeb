# 后台优化路线图

> 基于 2026-05 代码审查。生产路径以 `ws/index.js` + `ws/deviceManager.js` + `ws/frameProtocol.js` 为准。

---

## 已实现（生产代码）

| 能力 | 位置 |
|------|------|
| ✅ 多格式二进制帧 JPEG/WebP/H.264 | `frameProtocol.js` |
| ✅ 设备注册、用户绑定、设备数上限 | `ws/index.js`, `usersStore.js` |
| ✅ 帧合并、过大帧丢弃、无观众停采 | `deviceManager.js` |
| ✅ 列表缩略图 sharp、按用户限流 | `thumbnailEncoder.js` |
| ✅ 控制页 H.264 / WebP 协商 | `public/codec-client.js`, `control.js` |
| ✅ UI 节点转发 | `ui_nodes` → `device_ui_nodes` |
| ✅ HTTP + HTTPS 双端口 | `app.js` |
| ✅ JWT + admin token | `middleware/auth.js`, `ws/index.js` |
| ✅ 上传策略指令 | `setCaptureProfile`, `pauseCapture`, `preferWebp`, … |

---

## 可选模块（仓库内有，未接入主路径）

| 模块 | 说明 | 接入方式 |
|------|------|----------|
| `deviceManagerEnhanced.js` | UI 缓存、H.264 统计、健康检查 | 见 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) |
| `frameProtocol_v2.js` | 与 `frameProtocol.js` 功能重叠 | 合并或删除其一，避免双维护 |
| `ai/elementLocator.js` | 文本相似度定位 | 需 API + 前端调用 |
| `INTEGRATION_EXAMPLES.js` | 示例代码 | 勿直接 require 到 `app.js` |
| Protobuf | `ws/proto/` 若存在 | 未列入 `package.json`，未启用 |

---

## 建议优化（按优先级）

### P0 — 运维与安全

| 项 | 建议 |
|----|------|
| ⬜ 生产密钥 | 强制 `.env`，禁止默认 `device-token` |
| ⬜ 速率限制 | 登录、上传、WS 连接 per-IP 限流 |
| ⬜ 进程管理 | `pm2` / systemd，日志轮转 |
| 🟡 README 与代码同步 | 已完成本轮文档整理 |

### P1 — 性能与可扩展

| 项 | 现状 | 建议 |
|----|------|------|
| 🟡 JSON 旧帧 `type:frame` | 仍支持 Base64 | 监控占比，逐步废弃 |
| ⬜ 接入 `deviceManagerEnhanced` | 关键帧缓存、帧统计 API | 合并到 `deviceManager.js` 或显式开关 |
| ⬜ 数据库 | 用户/备注全 JSON 文件 | 设备量大时迁 SQLite/Postgres |
| ⬜ 水平扩展 | 单进程内存 Map | Redis 存设备会话 + Sticky WS |
| ✅ `control.js` 模块化 | `public/control/` + `st` 对象 | `device.html` 使用 `type="module"` |

### P2 — 功能

| 项 | 建议 |
|----|------|
| ⬜ AI 定位 REST | `POST /api/device/:id/ai-locate` + 控制页按钮 |
| ⬜ 帧统计面板 | `GET /api/stats` 暴露 `serverStats` |
| ⬜ WebSocket 鉴权刷新 | JWT 快过期时服务端 push 刷新提示 |
| ⬜ 操作审计日志 | 控制指令写文件或 DB |

### P3 — 协议

| 项 | 建议 |
|----|------|
| ⬜ Protobuf | 仅当控制频率极高时评估；保持 JSON 兼容层 |
| ⬜ 统一 `control` 字段 | 文档中 `action` vs `type` 与安卓 `type` 对齐（REST 已用 type） |

---

## 性能参考（内网控制页）

| 路径 | 服务端 CPU | 带宽 |
|------|------------|------|
| 二进制 WebP/H.264 直通 | 极低（转发） | 取决于设备编码 |
| 列表缩略图 sharp | 中（周期性） | 单设备 &lt; ~48KB/次 |
| JSON Base64 frame | 高 | 不推荐 |

---

## 与被控端对齐检查清单

- [x] `0xF1` format 字节与安卓一致
- [x] `pong.captureProfile` 与 `CaptureProfile` 名称一致
- [x] `control.command.type` 与 `ControlExecutor` 一致
- [ ] Protobuf（双方均未默认启用）
- [ ] AI 定位（后台模块未挂路由）
