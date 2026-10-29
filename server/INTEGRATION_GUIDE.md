# 后台优化功能 - 集成与使用指南

> **重要**：下列「增强模块」为**可选扩展**，默认生产路径**未**引用它们。  
> 已上线能力（WebP/H.264 帧、上传策略、UI 节点转发）见 [README.md](README.md)。  
> 仅在需要 AI 定位、H.264 关键帧缓存、心跳统计 API 时按本指南接入。

## 生产 vs 可选

| 模块 | 默认是否接入 |
|------|----------------|
| `frameProtocol.js` + `deviceManager.js` | ✅ 是 |
| `frameProtocol_v2.js` | ❌ 与前者重复，勿双引 |
| `deviceManagerEnhanced.js` | ❌ |
| `ai/elementLocator.js` | ❌ |
| Protobuf | ❌ |

---

## 📚 文件清单

可选新增/增强文件：

```
ws/
  ├── frameProtocol_v2.js          ✨ 增强的多格式图像协议
  ├── h264Processor.js             ✨ H.264 处理模块
  ├── deviceManagerEnhanced.js     ✨ 设备管理器增强
  └── proto/
      └── messages.proto           ✨ Protobuf 定义

ai/
  └── elementLocator.js            ✨ AI 元素定位模块

BACKEND_SUPPORT_PLAN.md             📖 完整的需求与方案文档
INTEGRATION_GUIDE.md                📖 本文件
```

---

## 🔧 快速开始

### 1. 安装依赖

```bash
# Protobuf 支持
npm install protobufjs

# AI 和相似度计算（可选，已在代码中实现基础版本）
npm install sentence-transformers  # 如果使用高级 embedding

# 其他
npm install md5
```

### 2. 编译 Protobuf 定义

```bash
# 使用 protoc 编译器
protoc --js_out=import_style=commonjs,binary:./ws/proto \
       ws/proto/messages.proto

# 或使用 protobufjs
npx pbjs -t static-module -w commonjs -o ws/proto/messages_pb.js ws/proto/messages.proto
npx pbts -o ws/proto/messages_pb.d.ts ws/proto/messages_pb.js
```

### 3. 在 deviceManager.js 中集成新功能

```javascript
// 在文件顶部添加导入
const {
  storeUINodes,
  getUINodes,
  locateUIElement,
  processH264Frame,
  getCachedKeyframe,
  recordDeviceHeartbeat,
  getDeviceHealth,
  cleanupDeviceResources,
  getFrameTransferStats,
  updateNetworkQuality,
} = require('./deviceManagerEnhanced');

// 然后在相应位置调用这些函数（见下文使用示例）
```

---

## 🎯 核心使用示例

### 场景 1：接收 H.264 帧并自适应处理

```javascript
// 在 ws/index.js 的 handleDeviceMessage 中

case "frame_h264": {
  const deviceId = msg.deviceId || ws.deviceId;
  if (!deviceId) return;
  
  const h264Data = msg.data || Buffer.from(msg.h264, 'base64');
  
  // 处理 H.264 帧
  const { shouldSend, isKeyframe, analysis } = processH264Frame(
    deviceId,
    h264Data,
    {
      timestamp: msg.timestamp,
      sequenceNum: msg.sequence,
    }
  );
  
  if (shouldSend) {
    // 打包为网页格式并转发
    const packed = packWebFrameH264(deviceId, h264Data, {
      timestamp: msg.timestamp,
      isKeyframe: isKeyframe,
      sequenceNum: msg.sequence,
    });
    
    broadcastToWeb(deviceId, packed);
  } else {
    console.log(`[H264] 设备 ${deviceId} 帧被自适应丢弃`);
  }
  break;
}
```

### 场景 2：处理 WebP 图像

```javascript
case "frame_webp": {
  const deviceId = msg.deviceId || ws.deviceId;
  if (!deviceId) return;
  
  const webpData = msg.data || Buffer.from(msg.webp, 'base64');
  
  // 打包为网页格式
  const packed = packWebFrame(
    deviceId,
    webpData,
    IMAGE_FORMAT.WEBP
  );
  
  broadcastToWeb(deviceId, packed);
  
  // 更新统计
  updateFrameStats(deviceId, 'webp', webpData.length);
  break;
}
```

### 场景 3：存储和定位 UI 节点

```javascript
case "ui_nodes": {
  const deviceId = msg.deviceId || ws.deviceId;
  if (!deviceId) return;
  
  // 存储 UI 树
  storeUINodes(deviceId, msg.nodes, {
    packageName: msg.packageName,
    activityName: msg.activityName,
    timestamp: msg.timestamp,
  });
  
  // 向网页通知 UI 已更新
  broadcastToWeb(deviceId, {
    type: "ui_updated",
    deviceId,
    timestamp: Date.now(),
  });
  
  break;
}
```

### 场景 4：AI 元素定位（从网页端触发）

```javascript
// 在 handleWebMessage 中，新增 AI 定位请求处理

if (msg.type === "ai_locate") {
  const deviceId = msg.deviceId;
  const query = msg.query;  // 如 "确定按钮"
  
  const results = locateUIElement(deviceId, query, {
    minConfidence: 0.5,
    maxResults: 5,
  });
  
  // 向网页返回结果
  ws.send(JSON.stringify({
    type: "ai_locate_response",
    deviceId,
    query,
    matches: results,
    timestamp: Date.now(),
  }));
  
  return;
}
```

### 场景 5：设备健康检查

```javascript
// 在心跳处理中

ws.on("pong", () => {
  const deviceId = ws.deviceId;
  if (deviceId) {
    recordDeviceHeartbeat(deviceId, true);
  }
  ws.isAlive = true;
});

// 超时检测
if (!ws.isAlive) {
  const deviceId = ws.deviceId;
  if (deviceId) {
    recordDeviceHeartbeat(deviceId, false);
    recordDeviceReconnect(deviceId, {
      disconnectReason: 'ping_timeout',
      duration: Date.now() - (ws.connectedAt || Date.now()),
    });
  }
  ws.terminate();
}
```

### 场景 6：实时网络质量监测

```javascript
// 根据帧接收延迟更新网络质量

function calculateLatency(frameTimestamp) {
  return Date.now() - frameTimestamp;
}

function onFrameReceived(deviceId, timestamp) {
  const latency = calculateLatency(timestamp);
  
  // 基于延迟和最近的丢帧情况估算丢包率
  const stats = getFrameTransferStats(deviceId) || { droppedFrames: 0, totalFrames: 1 };
  const packetLoss = stats.droppedFrames / (stats.totalFrames + 1);
  
  // 更新网络质量
  updateNetworkQuality(deviceId, latency, packetLoss);
  
  // 自动调整采集速率建议
  const recommendation = suggestCaptureProfile(deviceId);
  console.log(`[Network] 设备 ${deviceId}: 延迟 ${latency}ms, 丢包 ${(packetLoss*100).toFixed(2)}%, 建议: ${recommendation}`);
}
```

---

## 📡 WebSocket 消息协议扩展

### 设备端 -> 后台：多格式图像帧

#### 方案 A：使用新的二进制协议

```
[0xF1][format:1byte][deviceIdLen:2bytes][deviceId][imageData]

format:
  0x00 = JPEG
  0x01 = WebP
  0x02 = H.264
  0x03 = H.264 with timestamp
```

#### 方案 B：JSON 包装（兼容旧代码）

```json
{
  "type": "frame",
  "deviceId": "device123",
  "format": "h264",
  "data": "base64 encoded",
  "timestamp": 1234567890,
  "sequence": 42,
  "isKeyframe": true
}
```

### 设备端 -> 后台：UI 节点数据

```json
{
  "type": "ui_nodes",
  "deviceId": "device123",
  "packageName": "com.example.app",
  "activityName": "MainActivity",
  "timestamp": 1234567890,
  "nodes": [
    {
      "nodeId": 1,
      "text": "确定",
      "resourceId": "android:id/button1",
      "className": "android.widget.Button",
      "left": 100,
      "top": 200,
      "right": 300,
      "bottom": 250,
      "clickable": true
    }
  ]
}
```

### 网页端 -> 后台：AI 元素定位请求

```json
{
  "type": "ai_locate",
  "deviceId": "device123",
  "query": "确定按钮"
}
```

### 后台 -> 网页端：AI 元素定位响应

```json
{
  "type": "ai_locate_response",
  "deviceId": "device123",
  "query": "确定按钮",
  "matches": [
    {
      "nodeId": 1,
      "text": "确定",
      "bounds": {
        "left": 100,
        "top": 200,
        "right": 300,
        "bottom": 250
      },
      "confidence": 0.95,
      "reason": "精确文本匹配"
    }
  ]
}
```

---

## 📊 新增 API 端点

### 1. 获取 UI 节点信息

```http
GET /api/devices/{deviceId}/ui-nodes

响应:
{
  "deviceId": "device123",
  "packageName": "com.example.app",
  "activityName": "MainActivity",
  "timestamp": 1234567890,
  "nodes": [...]
}
```

### 2. AI 元素定位

```http
POST /api/devices/{deviceId}/ai-locate

请求体:
{
  "query": "确定按钮",
  "minConfidence": 0.5
}

响应:
{
  "deviceId": "device123",
  "query": "确定按钮",
  "matches": [...]
}
```

### 3. UI 变化历史

```http
GET /api/devices/{deviceId}/ui-history

响应:
{
  "deviceId": "device123",
  "changes": [
    {
      "timestamp": 1234567890,
      "packageName": "com.example.app",
      "activityName": "MainActivity",
      "addedCount": 5,
      "removedCount": 2
    }
  ]
}
```

### 4. 帧传输统计

```http
GET /api/devices/{deviceId}/frame-stats

响应:
{
  "jpeg": { "count": 100, "avgBytes": 50000, "totalBytes": 5000000 },
  "webp": { "count": 50, "avgBytes": 25000, "totalBytes": 1250000 },
  "h264": { "count": 200, "avgBytes": 5000, "totalBytes": 1000000, "keyframes": 20 },
  "totalFrames": 350,
  "droppedFrames": 10
}
```

### 5. 设备健康状态

```http
GET /api/devices/{deviceId}/health

响应:
{
  "status": "healthy",
  "successRate": 99.5,
  "online": 199,
  "offline": 1,
  "consecutiveFailures": 0,
  "lastHeartbeatAt": 1234567890
}
```

### 6. 重连历史

```http
GET /api/devices/{deviceId}/reconnect-history

响应:
{
  "deviceId": "device123",
  "reconnects": [
    {
      "timestamp": 1234567890,
      "disconnectReason": "ping_timeout",
      "duration": 5000
    }
  ]
}
```

---

## 🚀 分阶段部署建议

### 第一阶段：基础集成（1-2 周）

- [ ] 集成 `frameProtocol_v2.js`
- [ ] 支持 WebP 格式接收与转发
- [ ] 修改前端 control.js 支持 WebP 解码
- [ ] 添加帧传输统计 API

**预期收益：**
- 图像传输体积 -30%
- 网页端加载速度 +20%

### 第二阶段：H.264 支持（2-3 周）

- [ ] 集成 `h264Processor.js`
- [ ] 实现关键帧缓存机制
- [ ] 自适应丢帧算法
- [ ] 前端 H.264 解码库集成（使用 MSE API）

**预期收益：**
- 设备端 CPU 占用 -60%
- 传输体积 -75%（相比 JPEG）
- 帧率稳定性 +40%

### 第三阶段：AI 与稳定性（2-3 周）

- [ ] 集成 `elementLocator.js`
- [ ] 实现 UI 节点缓存与存储
- [ ] 增强设备健康检查机制
- [ ] 添加重连日志与诊断工具

**预期收益：**
- 自动化控制准确率 +30%
- 稳定性提升与快速诊断

---

## 🧪 测试检查清单

### 协议兼容性测试
- [ ] 旧 JPEG 协议仍可正常工作
- [ ] WebP 数据正确解析
- [ ] H.264 关键帧正确识别
- [ ] 格式自动检测准确

### 性能测试
- [ ] WebP 压缩率验证（目标 30-50%）
- [ ] H.264 CPU 占用测试（目标 -60%）
- [ ] 关键帧缓存命中率（目标 >95%）
- [ ] 自适应丢帧准确性

### 功能测试
- [ ] UI 节点正确存储与检索
- [ ] AI 元素定位准确度（目标 >90%）
- [ ] UI 变化检测敏感性
- [ ] 设备健康检查告警

### 压力测试
- [ ] 同时 100+ 设备连接
- [ ] 高频率帧接收（30fps+）
- [ ] 内存泄漏检测
- [ ] 缓存淘汰策略验证

---

## 📝 常见问题

### Q1: WebP 在哪些浏览器上支持？
**A:** 现代浏览器（Chrome、Firefox、Edge）都支持。IE 和旧版本需要 polyfill。建议同时发送 JPEG 作为 fallback。

### Q2: H.264 是否需要许可证？
**A:** 部署在公网需要确认授权情况。内网或测试环境可自由使用。

### Q3: UI 节点数据体积很大怎么办？
**A:** 可以使用 Protobuf 编码（体积 -70%）或增量上报（只发送变化的节点）。

### Q4: AI 定位准确度不够怎么办？
**A:** 
1. 增加更多训练数据
2. 集成专业的 embedding 模型（如 sentence-transformers）
3. 添加上下文信息（父节点、兄弟节点）
4. 使用视觉识别（OCR）辅助

### Q5: 如何处理网络不稳定情况？
**A:** 系统已实现：
- 自适应丢帧（优先保留关键帧）
- 网络质量监测与告警
- 自动重连机制
- 关键帧快速恢复

---

## 📚 参考资源

- **H.264 标准**: https://en.wikipedia.org/wiki/Advanced_Video_Coding
- **WebP 格式**: https://en.wikipedia.org/wiki/WebP
- **Protobuf**: https://developers.google.com/protocol-buffers
- **MSE API**: https://www.w3.org/TR/media-source/
- **UI 自动化**: https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo

---

## 🎓 深入学习

阅读本项目提供的其他文档：

1. **BACKEND_SUPPORT_PLAN.md** - 完整的需求分析与方案设计
2. **frameProtocol_v2.js** - 详细的多格式协议实现
3. **h264Processor.js** - H.264 帧处理详解
4. **elementLocator.js** - AI 定位算法实现
5. **deviceManagerEnhanced.js** - 设备管理器增强功能

---

**最后更新**: 2026-05-22  
**维护者**: Cloud Control Team  
**状态**: 主线已生产就绪；本指南描述的可选模块需自行接入
