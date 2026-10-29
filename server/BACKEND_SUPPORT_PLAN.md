# 手机端优化需求 - 后台支持方案

> **文档性质**：设计稿 + 历史方案。  
> **生产实现状态**（2026-05-22）见下表；日常开发请以 [README.md](README.md)、[OPTIMIZATION.md](OPTIMIZATION.md) 为准。

## 实现状态总览

| 方向 | 状态 | 生产代码位置 |
|------|------|----------------|
| WebP / H.264 二进制帧 | ✅ 已上线 | `ws/frameProtocol.js`, `ws/deviceManager.js` |
| 多格式 `0xF1` format 字节 | ✅ 已上线 | 同上 |
| 浏览器 WebCodecs H.264 | ✅ 已上线 | `public/control.js`, `codec-client.js` |
| 上传策略 / pong 档位 | ✅ 已上线 | `ws/index.js` ping→pong, `applyDeviceUploadPolicy` |
| UI 节点转发 | ✅ 已上线 | `ui_nodes` → `device_ui_nodes` |
| Protobuf 信令 | ⬜ 未接入 | 无 `protobufjs` 依赖 |
| `deviceManagerEnhanced` 统计/健康 | 🟡 模块在库，未 require | `ws/deviceManagerEnhanced.js` |
| AI 元素定位 API | 🟡 模块在库，未挂路由 | `ai/elementLocator.js` |
| JSON `frame` Base64 | 🟡 兼容保留 | 建议逐步废弃 |

---

## 📋 概览
手机端与后台已完成 **WebP/H.264 二进制投屏** 与 **自适应档位** 的主线联调。下文保留原始需求与设计片段，供扩展 Protobuf、AI 定位时参考。

---

## 1️⃣ 传输优化：WebP + Protobuf

### 需求分析
- **WebP 支持**：替代 JPEG，降低 30-50% 带宽
- **Protobuf 支持**：二进制协议，相比 JSON 减少 70% 消息体积

### 后台需要的支持

#### A. WebP 图片转发支持
```javascript
// 当前: 二进制 JPEG 转发协议 (frameProtocol.js)
// 协议: [0xF1][deviceIdLen][deviceId][jpeg]

// 需要扩展为多格式支持:
const FORMAT_JPEG = 0x00;    // 现有
const FORMAT_WEBP = 0x01;    // 新增
const FORMAT_H264 = 0x02;    // H.264 码流

// 新协议格式:
// [0xF1][format:1byte][deviceIdLen:2bytes][deviceId][imageData]
```

**必要改动：**
1. 修改 `frameProtocol.js` 支持多格式标识
2. 浏览器端需要支持 WebP 解码（现代浏览器原生支持）
3. 控制面板显示格式提示（如 "WebP 0.5MB" vs "JPEG 1.2MB"）

#### B. Protobuf 消息协议支持
```javascript
// 需要安装依赖
npm install protobufjs

// 定义协议文件: ws/proto/control.proto
syntax = "proto3";

package control;

message ControlCommand {
  string type = 1;              // "click", "swipe", "input" 等
  int32 x = 2;                  // 坐标
  int32 y = 3;
  int32 x2 = 4;                 // 滑动终点
  int32 y2 = 5;
  string text = 6;              // 输入文本
  int32 duration = 7;           // 长按时长 ms
}

message DeviceFrame {
  string device_id = 1;
  bytes image_data = 2;         // WebP/H264 原始数据
  int32 width = 3;
  int32 height = 4;
  int32 format = 5;             // 0=JPEG, 1=WebP, 2=H264
  int64 timestamp = 6;
  int32 sequence = 7;           // 帧序号（用于丢包检测）
}
```

**后台需要：**
1. 装载 Protobuf 定义和编码/解码器
2. 兼容 JSON 和 Protobuf 两种消息格式
3. 自动检测消息格式并解析

#### C. 带宽监测与自适应切换
```javascript
// deviceManager.js 新增
const formatStats = {
  jpeg: { bytes: 0, count: 0, avgSize: 0 },
  webp: { bytes: 0, count: 0, avgSize: 0 },
  h264: { bytes: 0, count: 0, avgSize: 0 },
};

// 根据网络状况推荐格式
function suggestImageFormat(deviceId) {
  const recent = getRecentFrameStats(deviceId);
  if (recent.latency > 500) return 'webp';      // 高延迟用 WebP
  if (recent.bandwidth < 1024*1024) return 'h264'; // <1Mbps 用 H264
  return 'jpeg';  // 默认 JPEG
}
```

---

## 2️⃣ 性能优化：H.264 硬编码

### 需求分析
- 手机 CPU 使用率降低 60-80%
- 相比 JPEG 更好的帧率稳定性

### 后台需要的支持

#### A. H.264 码流接收与转发
```javascript
// frameProtocol.js 新增
const H264_MAGIC = 0xF3;  // H264 码流起始标记

function parseH264Packet(buf) {
  const packet = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (packet.length < 4 || packet[0] !== H264_MAGIC) return null;
  
  const idLen = packet.readUInt16BE(1);
  const headerLen = 3 + idLen;
  const h264Data = packet.subarray(headerLen);
  
  return {
    deviceId: packet.toString('utf8', 3, headerLen),
    h264: h264Data,
    isKeyframe: (packet[3 + idLen] & 0x80) > 0, // 关键帧标志
    timestamp: packet.readUInt32BE(4 + idLen)    // 时间戳
  };
}
```

#### B. I 帧（关键帧）缓存
```javascript
// deviceManager.js 新增
const h264KeyframeCache = new Map(); // 存储最新的 I 帧

function cacheH264Keyframe(deviceId, h264Data) {
  h264KeyframeCache.set(deviceId, {
    data: h264Data,
    timestamp: Date.now()
  });
}

// 新连接客户端立即发送最新的 I 帧，加快首屏显示
function sendLatestKeyframe(deviceId, ws) {
  const cached = h264KeyframeCache.get(deviceId);
  if (cached && Date.now() - cached.timestamp < 5000) {
    ws.send(packH264Frame(deviceId, cached.data));
  }
}
```

#### C. 帧率控制与丢帧策略
```javascript
// 高延迟时主动丢弃 P 帧，只保留 I 帧
function filterH264Frames(deviceId, h264Data, isKeyframe) {
  const delay = getDeviceLatency(deviceId);
  
  if (!isKeyframe && delay > 300) {
    // 延迟高时，P 帧丢弃
    return null;
  }
  return h264Data;
}
```

#### D. 浏览器端 H.264 解码支持
```javascript
// 前端需要 MSE (Media Source Extensions) API
// 或集成 wasm 的 H.264 解码库
// 后台需要提供完整的 NAL 单元序列
```

**后台核心任务：**
1. 接收和缓存 H.264 码流
2. 检测关键帧并单独处理
3. 根据网络延迟动态丢帧
4. 发送给多个客户端时可以复用转发

---

## 3️⃣ 稳定性：进程保活 + AI 节点定位

### A. 进程保活机制

#### 1. 现有心跳机制
```javascript
// 已实现 (ws/index.js + 安卓 DeviceWebSocketClient)
// - 设备 ping: 每 10s；服务端 pong 带 captureProfile
// - 在线判定: 45s 无活动视为离线
// - 安卓重连: 指数退避，上限约 30s
```

**需要增强：**
```javascript
// 设备心跳日志与分析
const deviceHeartbeatStats = new Map();

function recordDeviceHeartbeat(deviceId, status) {
  let stats = deviceHeartbeatStats.get(deviceId) || {
    connected: 0,
    disconnected: 0,
    consecutiveFailures: 0,
    lastDisconnectReason: null,
    uptime: 0
  };
  
  if (status === 'online') {
    stats.connected++;
    stats.consecutiveFailures = 0;
  } else {
    stats.disconnected++;
    stats.consecutiveFailures++;
    stats.lastDisconnectReason = status; // 断连原因
  }
  
  deviceHeartbeatStats.set(deviceId, stats);
}

// 告警机制: 连续 3 次失败则告警
function checkDeviceHealth(deviceId) {
  const stats = deviceHeartbeatStats.get(deviceId);
  if (stats?.consecutiveFailures >= 3) {
    return { status: 'unhealthy', reason: stats.lastDisconnectReason };
  }
  return { status: 'healthy' };
}
```

#### 2. 增强重连策略
```javascript
// 后台需要追踪重连
const deviceReconnectLog = new Map();

function trackReconnect(deviceId, previousConnection) {
  const log = deviceReconnectLog.get(deviceId) || [];
  log.push({
    previousConnectionDuration: Date.now() - previousConnection.startTime,
    disconnectTime: Date.now(),
    reason: previousConnection.closeCode,
    attempt: 0
  });
  
  // 只保留最近 100 次重连记录
  deviceReconnectLog.set(deviceId, log.slice(-100));
}

// API 端点：查询设备重连历史
app.get('/api/devices/:id/reconnect-history', (req, res) => {
  const deviceId = req.params.id;
  const log = deviceReconnectLog.get(deviceId) || [];
  res.json({ deviceId, reconnects: log });
});
```

### B. AI 辅助节点定位

#### 1. UI 节点数据收集与存储
```javascript
// 在 deviceManager.js 新增

const uiNodeCache = new Map(); // 缓存最新的 UI 树

function storeUINodes(deviceId, uiNodes) {
  uiNodeCache.set(deviceId, {
    data: uiNodes,
    timestamp: Date.now(),
    checksum: md5(JSON.stringify(uiNodes)) // 用于检测变化
  });
}

function getUINodes(deviceId) {
  const cached = uiNodeCache.get(deviceId);
  return cached?.data || null;
}

// 单设备 UI 变化追踪
const uiNodeHistory = new Map();

function recordUINodeChange(deviceId, newNodes) {
  const old = uiNodeCache.get(deviceId);
  
  if (old?.checksum !== md5(JSON.stringify(newNodes))) {
    let history = uiNodeHistory.get(deviceId) || [];
    history.push({
      timestamp: Date.now(),
      checksum: md5(JSON.stringify(newNodes)),
      diff: computeDiff(old?.data, newNodes)  // 差异部分
    });
    
    // 只保留最近 50 次变化
    uiNodeHistory.set(deviceId, history.slice(-50));
  }
}
```

#### 2. API 端点：获取 UI 节点与 AI 辅助定位
```javascript
// routes/devices.js 新增

// GET /api/devices/:id/ui-nodes
// 获取最新的 UI 树
router.get('/:id/ui-nodes', (req, res) => {
  const deviceId = req.params.id;
  const nodes = getUINodes(deviceId);
  
  if (!nodes) {
    return res.status(404).json({ error: 'UI nodes not available' });
  }
  
  res.json({
    deviceId,
    timestamp: Date.now(),
    nodes
  });
});

// POST /api/devices/:id/ai-locate
// AI 辅助元素定位
router.post('/:id/ai-locate', express.json(), (req, res) => {
  const deviceId = req.params.id;
  const { query, uiContext } = req.body; // query: 查找目标 (如 "确定按钮")
  
  const nodes = getUINodes(deviceId) || uiContext;
  
  // 调用 AI 模型进行匹配
  const result = aiLocateElement(query, nodes);
  
  res.json({
    deviceId,
    query,
    matches: result.candidates.map(c => ({
      nodeId: c.id,
      text: c.text,
      bounds: c.bounds,
      confidence: c.confidence
    }))
  });
});

// GET /api/devices/:id/ui-history
// 获取 UI 变化历史（用于检测页面转换）
router.get('/:id/ui-history', (req, res) => {
  const deviceId = req.params.id;
  const history = uiNodeHistory.get(deviceId) || [];
  
  res.json({
    deviceId,
    changes: history.slice(-20)
  });
});
```

#### 3. AI 模型集成
```javascript
// 新文件: ai/elementLocator.js

const tf = require('@tensorflow/tfjs');
// 或使用远程 AI 服务

function aiLocateElement(query, uiNodes) {
  // 将 UI 树转换为向量表示
  const nodeVectors = encodeUINodes(uiNodes);
  
  // 编码查询文本
  const queryVector = encodeText(query);
  
  // 计算相似度
  const candidates = nodeVectors.map((vec, idx) => ({
    id: uiNodes[idx].id,
    text: uiNodes[idx].text,
    bounds: uiNodes[idx].bounds,
    similarity: cosineSimilarity(queryVector, vec)
  }))
  .filter(c => c.similarity > 0.6)
  .sort((a, b) => b.similarity - a.similarity)
  .slice(0, 5);
  
  return { candidates };
}

function encodeUINodes(nodes) {
  // 使用预训练的 embedding 模型（如 sentence-transformers）
  // 或对文本内容进行 TF-IDF 编码
  return nodes.map(node => encodeNodeFeatures(node));
}
```

#### 4. 前端 WebSocket 消息支持
```javascript
// 需要手机端支持向后台上报 UI 节点

// 在 handleDeviceMessage 中新增:
case "ui_nodes": {
  const deviceId = msg.deviceId || msg.device_id || ws.deviceId;
  storeUINodes(deviceId, msg.nodes);
  recordUINodeChange(deviceId, msg.nodes);
  
  // 实时通知浏览器有新的 UI 数据
  broadcastToWeb(deviceId, { type: "ui_updated", timestamp: Date.now() });
  break;
}
```

---

## 📦 完整的后台实现清单

### 阶段 1：传输优化（优先级：高）
- [x] 扩展 frameProtocol.js 支持多格式标识
- [ ] 集成 protobufjs，定义 .proto 文件
- [x] 添加格式自动检测与转发逻辑
- [x] 修改前端 control.js 支持 WebP 解码；H.264 WebCodecs（HTTPS）
- [ ] 实现带宽监测与格式建议机制（主路径未接入）

### 阶段 2：性能优化（优先级：高）
- [x] 实现 H.264 码流接收与转发
- [ ] 添加关键帧缓存机制（deviceManagerEnhanced 可选）
- [ ] 实现自适应丢帧策略（增强模块内，未默认启用）
- [x] 前端集成 H.264 解码（WebCodecs）
- [ ] 性能基准测试报告归档

### 阶段 3：稳定性增强（优先级：中）
- [x] 基础心跳与 45s 在线判定
- [ ] 增强心跳统计与告警机制
- [ ] 实现重连历史追踪
- [ ] 添加设备健康检查 API
- [ ] 实现 UI 节点缓存与存储（当前仅实时广播）
- [ ] 集成 AI 元素定位模型（elementLocator 未挂路由）
- [ ] 添加 UI 变化历史追踪

---

## 🔧 核心改动文件清单

```
ws/
  frameProtocol.js          ← 扩展多格式支持
  deviceManager.js          ← 添加缓存、统计、AI
  index.js                  ← WebSocket 消息处理
  proto/
    control.proto          ← 新增
    device.proto           ← 新增

ai/
  elementLocator.js         ← 新增 AI 定位模块

routes/
  devices.js               ← 新增 API 端点

package.json               ← 新增依赖
  protobufjs
  @tensorflow/tfjs
  (可选) sentence-transformers 或其他 embedding 库
```

---

## 🚀 部署建议

### 依赖安装
```bash
npm install protobufjs         # Protobuf 支持
npm install @tensorflow/tfjs   # AI 模型（可选，使用本地或 API）
npm install md5                # 哈希校验
```

### 性能指标目标
| 指标 | JPEG | WebP | H.264 |
|------|------|------|-------|
| 平均包体积 | 1.2 MB | 0.6 MB | 0.3 MB |
| 带宽节省 | 基准 | -50% | -75% |
| 延迟 | 200ms | 150ms | 100ms |
| 后台 CPU | 低 | 低 | 极低 |

---

## 📝 注意事项

1. **向后兼容性**：新格式支持需要兼容旧的 JPEG 协议
2. **浏览器兼容**：WebP 在 IE 上不支持，需要 fallback
3. **H.264 授权**：确认服务器部署的 H.264 编解码是否需要授权
4. **AI 模型选择**：
   - 本地模型：快速但占用资源
   - 云 API：需要网络延迟，但通用性强
5. **隐私考量**：UI 节点数据包含用户界面内容，需要审慎处理

