# AndroidAccessibilityExample（群控被控端）

基于 Android 无障碍服务（`AccessibilityService`）与 `MediaProjection` 投屏的群控被控端。语言为 **Kotlin**，目标是小体积、低带宽、可远程操控。

**配套后台**：`cloudControlWeb/server`（Node.js）  
**技术协议**：见 [TECHNICAL_ARCH.md](./TECHNICAL_ARCH.md)  
**优化路线图**：见 [OPTIMIZATION.md](./OPTIMIZATION.md)

---

## 核心能力（当前已实现）

| 模块 | 说明 |
|------|------|
| **投屏** | WebP 二进制帧（默认）、HTTPS 下 H.264 硬编（`MediaCodec`）、兼容旧版 Base64 JSON `frame` |
| **自适应画质** | 档位 `thumb` / `low` / `medium` / `smooth` / `high`；跟随服务端 `pong.captureProfile`；本机按发送延迟升降档 |
| **远程控制** | 点击、长按、滑动、输入、返回/Home/最近任务、`fetchUiNodes`（节点树 + 截图） |
| **上传策略** | 服务端 `pauseCapture` / `setCaptureProfile` / `preferWebp` / `allowH264` 等指令联动 |
| **保活与重连** | 10s 心跳、指数退避重连、单线程 WS 发送队列、帧合并（积压只发最新帧） |
| **自动化** | `MainFunction` 脚本、系统授权弹窗自动点选、音量键紧急停脚本 |
| **热更新** | 连接成功后检查版本，语义化版本号比对，`DownloadManager` + `FileProvider` 安装 |

---

## 技术栈

- Kotlin 1.9、Room（本地规则）、Java-WebSocket、Retrofit 2
- `MyAccessibilityService` + `ScreenCaptureService`（前台 `mediaProjection`）
- `MyContentProvider` 跨进程配置；`MyUtils` 管理服务器地址、Token、账号

---

## 配置与启动

1. **设置页**：服务器 IP、端口（默认 `3000`）、设备 Token、后台登录账号（WS `username` 须与账号一致）。
2. **权限**：无障碍、悬浮窗、录屏授权、忽略电池优化（建议）。
3. **启动**：首页开启任务 → 同意录屏 → 自动 `wss://` 或 `ws://` 连接并注册。

**生产环境**：控制页 H.264 需 HTTPS；公网 HTTP 请用 WebP/「流畅」档，详见后台 [docs/DEPLOYMENT_HTTPS.md](../../nodejs/cloudControlWeb/server/docs/DEPLOYMENT_HTTPS.md)。

---

## 控制指令示例

```json
{ "type": "click", "x": 500, "y": 1000 }
{ "type": "input", "text": "Hello" }
{ "type": "fetchUiNodes" }
{ "type": "setCaptureProfile", "profile": "high" }
```

WebSocket 上实际包在 `control.command` 内，字段与上表 `type` 一致；完整列表见 [TECHNICAL_ARCH.md](./TECHNICAL_ARCH.md)。

---

## 关键源码

| 文件 | 作用 |
|------|------|
| `myfunction/ScreenCaptureService.kt` | 采集、WebP/H.264 编码、档位与自适应 |
| `myfunction/DeviceWebSocketClient.kt` | WS 连接、二进制帧发送、心跳 |
| `myfunction/ControlExecutor.kt` | 指令执行 |
| `myfunction/CaptureProfile.kt` | 档位定义 |
| `myfunction/ScreenH264Encoder.kt` | H.264 硬编 |
| `myfunction/MyAccessibilityService.kt` | 无障碍入口 |

---

## 文档索引

- [TECHNICAL_ARCH.md](./TECHNICAL_ARCH.md) — 架构图、二进制帧协议、上下行消息
- [OPTIMIZATION.md](./OPTIMIZATION.md) — 待优化项与优先级
- 后台 [README](../../nodejs/cloudControlWeb/server/README.md) — API、部署、控制台说明
