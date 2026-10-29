# 手机端优化路线图

> 基于 2026-05 代码审查。✅ 已实现 · 🟡 部分实现 · ⬜ 建议后续做

---

## 已实现（无需重复开发）

| 项 | 说明 |
|----|------|
| ✅ WebP 二进制投屏 | `0xF1` + `format=0x01`，与 `server/ws/frameProtocol.js` 对齐 |
| ✅ H.264 硬编 | HTTPS + 浏览器 WebCodecs；控制档约 320px 宽 |
| ✅ 多采集档位 | `thumb/low/medium/smooth/high`，服务端 `pong` + `setCaptureProfile` |
| ✅ 静止帧跳过 / 发送队列合并 | `ScreenCaptureService` + `DeviceWebSocketClient` |
| ✅ 单线程 WS 发送 | 避免并发 `send` 断连 |
| ✅ UI 节点 + 截图 | `fetchUiNodes` 含 JPEG Base64 与节点树 |
| ✅ 屏幕旋转上报 | `display_update` |

---

## 建议优化（按优先级）

### P0 — 稳定性与带宽

| 项 | 现状 | 建议 |
|----|------|------|
| 🟡 旧版 Base64 `frame` | 仍保留 `LEGACY_*` 路径供极老控制台 | 确认无客户端依赖后删除，统一二进制 |
| ⬜ 心跳与在线判定对齐 | 客户端 10s ping，后台 45s 离线 | 文档已统一；可考虑 ping 带 `rtt` 供服务端统计 |
| ✅ WS 连接异常不上报远程 | `DeviceWebSocketClient.onError` 仅本地日志 | 已移除 `CrashReporter.report` |
| ⬜ WS 使用 `wss` 证书校验 | 自签/内网可能关闭校验 | 生产配置网络安全配置 + 固定域名 |

### P1 — 性能

| 项 | 建议 |
|----|------|
| ⬜ **Protobuf 控制信令** | 仅控制 JSON 体积大时收益明显；需与后台同步 `.proto` |
| ⬜ **ImageReader 缓冲复用** | 高帧率下减少 GC；在 `ScreenCaptureService` 压测后改 |
| ⬜ **无障碍双 Service** | `MyAccessibilityService` / `NoGesture` 二选一或合并配置，减维护成本 |
| ⬜ **Room 规则云同步** | 本地规则与后台脚本任务联动（若产品需要） |

### P2 — 体验与可观测性

| 项 | 建议 |
|----|------|
| ⬜ **StreamDiag 开关** | 设置页增加「投屏诊断」导出最近 N 条日志 |
| ⬜ **fetchUiNodes 超时** | 大图 + 深树时加总超时与节点数上限，防 ANR |
| ⬜ **热更新断点续传** | 弱网大 APK 使用 `DownloadManager` 已有；可加 MD5 校验失败重试提示 |
| ⬜ **多用户/多设备** | 同一 APK 切换账号时明确断开旧 WS |

### P3 — 安全

| 项 | 建议 |
|----|------|
| ⬜ Token 存储 | `EncryptedSharedPreferences` 存设备 Token |
| ⬜ 日志脱敏 | `CrashReporter` / 悬浮日志避免打印完整 Token |

---

## 与后台协作项

| 后台能力 | 手机端对应 |
|----------|------------|
| `pong.captureProfile` | `ScreenCaptureService.onServerCaptureProfileSuggestion` |
| `preferWebp` / `allowH264` | `ControlExecutor` → `setForceWebpCapture` |
| `pauseCapture` / `resumeCapture` | 无人观看时停采 |
| `device_ui_nodes` 广播 | `fetchUiNodes` 上行 |
| 二进制帧 V2 | `DeviceWebSocketClient.FORMAT_*` |

未接入：`deviceManagerEnhanced`（AI 定位、H.264 增强统计）— 见后台 [INTEGRATION_GUIDE.md](../../nodejs/cloudControlWeb/server/INTEGRATION_GUIDE.md)。

---

## 性能参考目标（内网 HTTPS 控制页）

| 档位 | 目标帧率 | 单帧量级 |
|------|----------|----------|
| high (H.264) | ~15 fps | 数 KB～数十 KB |
| smooth (WebP) | ~8–15 fps | &lt; 10 KB（公网 HTTP 更小） |
| thumb | 约 12s/帧 | 列表缩略图 |

实际以 `StreamDiag` 与服务端 `GET /api/stats`（若启用）为准。
