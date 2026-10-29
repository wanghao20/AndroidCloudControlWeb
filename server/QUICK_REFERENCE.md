# 快速参考

> 生产代码：`ws/frameProtocol.js`（非 `frameProtocol_v2.js`）。可选增强见 [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md)。

---

## 需求 ↔ 实现对照

| 需求 | 状态 | 位置 |
|------|------|------|
| WebP / H.264 二进制 | ✅ | `frameProtocol.js`, `deviceManager.js` |
| 列表缩略图 | ✅ | `thumbnailEncoder.js`, `setCaptureProfile: thumb` |
| 控制页低延迟转发 | ✅ | `WEB_CONTROL_REALTIME_MS`, 帧合并 |
| H.264 浏览器解码 | ✅ HTTPS | `control.js` + WebCodecs |
| Protobuf | ⬜ | 未安装依赖 |
| AI 定位 | 🟡 | `ai/elementLocator.js` 未挂 API |
| 心跳增强 / 健康 API | 🟡 | `deviceManagerEnhanced.js` |

---

## WebSocket 速查

### 设备连接

```
ws(s)://host/ws?clientType=device&token=DEVICE_TOKEN&username=账号
```

| 上行 type | 说明 |
|-----------|------|
| `register` | 首次注册 |
| `ping` | 10s 心跳，可带 `captureProfile` |
| `ui_nodes` | 节点树（可含截图 Base64） |
| `display_update` | 分辨率/旋转 |
| 二进制 `0xF1` | 画面（首选） |
| `frame` | JSON Base64（旧） |

| 下行 type | 说明 |
|-----------|------|
| `registered` / `error` | 注册结果 |
| `pong` | `captureProfile` 档位建议 |
| `control` | `{ command: { type, ... } }` |
| `download` | 文件 URL |

### 浏览器连接

```
ws(s)://host/ws?clientType=web&token=JWT&deviceId=可选
```

| 下行 type | 说明 |
|-----------|------|
| `device_list` | 全量设备 |
| `device_frame` | 画面（JSON 或二进制） |
| `device_ui_nodes` | UI 树 |
| `device_ping` | 心跳广播（含档位） |

---

## 二进制帧

```
设备 0xF1: [F1][format][idLen:2][deviceId][data]
网页 0xF2: [F2][format][idLen:2][deviceId][data]
```

| format | 值 |
|--------|-----|
| JPEG | 0x00 |
| WebP | 0x01 |
| H.264 | 0x02 |
| H.264+TS | 0x03 |

```javascript
const { parseDeviceFramePacket, packWebFrame, IMAGE_FORMAT } = require("./frameProtocol");
const frame = parseDeviceFramePacket(buffer);
```

---

## 控制指令 type（与安卓一致）

`click`, `longClick`, `swipe`, `input`, `back`, `home`, `recents`,  
`fetchUiNodes`, `setCaptureProfile`, `pauseCapture`, `resumeCapture`,  
`preferWebp`, `forceWebp`, `allowH264`, `preferH264`, `setCaptureSpeed`

---

## REST 常用

| 方法 | 路径 |
|------|------|
| POST | `/api/auth/login` |
| GET | `/api/devices` |
| POST | `/api/control` |
| POST | `/api/upload` |
| GET | `/api/health` |

鉴权：`Authorization: Bearer <JWT>` 或头 `x-admin-token`。

---

## 环境变量

`PORT`, `HTTPS_PORT`, `DEVICE_TOKEN`, `ADMIN_*`, `JWT_SECRET`, `SSL_*`

---

## 文档

| 文件 | 用途 |
|------|------|
| [README.md](README.md) | 总览 |
| [OPTIMIZATION.md](OPTIMIZATION.md) | 待办优化 |
| [BACKEND_SUPPORT_PLAN.md](BACKEND_SUPPORT_PLAN.md) | 设计稿 + 勾选状态 |
| [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) | 可选模块接入 |
| [docs/DEPLOYMENT_HTTPS.md](docs/DEPLOYMENT_HTTPS.md) | 生产部署 |

**最后更新**: 2026-05-22
