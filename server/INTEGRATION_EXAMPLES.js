/**
 * WebSocket 消息处理 - 集成示例
 * 
 * 这个文件展示如何在现有的 ws/index.js 中集成新的优化功能
 * 可以参考本文件的代码片段进行修改
 */

const {
  storeUINodes,
  getUINodes,
  locateUIElement,
  processH264Frame,
  getCachedKeyframe,
  recordDeviceHeartbeat,
  recordDeviceReconnect,
  cleanupDeviceResources,
  getFrameTransferStats,
  updateNetworkQuality,
} = require('./deviceManagerEnhanced');

const { packWebFrame, packWebFrameH264, IMAGE_FORMAT } = require('./frameProtocol_v2');

// ===================== 增强的设备消息处理 =====================

/**
 * 处理设备发来的消息（增强版）
 * 这应该替换或扩展原有的 handleDeviceMessage 函数
 */
function handleDeviceMessageEnhanced(ws, raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  // 首先尝试解析二进制帧（新格式支持多种图像类型）
  const binaryFrame = parseWebFramePacket_Enhanced(buf);
  if (binaryFrame) {
    const currentDeviceId = binaryFrame.deviceId || ws.deviceId;
    if (!currentDeviceId) return;
    ws.deviceId = ws.deviceId || currentDeviceId;
    
    // 根据格式处理
    switch (binaryFrame.format) {
      case IMAGE_FORMAT.JPEG:
        queueDeviceFrameBroadcast(currentDeviceId, binaryFrame.imageData);
        recordDeviceHeartbeat(currentDeviceId, true);
        break;
        
      case IMAGE_FORMAT.WEBP:
        // WebP 帧处理
        const webpPacked = packWebFrame(currentDeviceId, binaryFrame.imageData, IMAGE_FORMAT.WEBP);
        broadcastToWeb(currentDeviceId, webpPacked);
        recordDeviceHeartbeat(currentDeviceId, true);
        break;
        
      case IMAGE_FORMAT.H264:
      case IMAGE_FORMAT.H264_TIMESTAMPED:
        // H.264 帧处理
        const { shouldSend, isKeyframe } = processH264Frame(
          currentDeviceId,
          binaryFrame.imageData,
          { timestamp: binaryFrame.timestamp, sequenceNum: binaryFrame.sequenceNum }
        );
        
        if (shouldSend) {
          const h264Packed = packWebFrameH264(currentDeviceId, binaryFrame.imageData, {
            timestamp: binaryFrame.timestamp,
            isKeyframe: isKeyframe,
            sequenceNum: binaryFrame.sequenceNum,
          });
          broadcastToWeb(currentDeviceId, h264Packed);
        }
        recordDeviceHeartbeat(currentDeviceId, true);
        break;
    }
    return;
  }

  // 解析 JSON 消息
  let msg;
  try {
    const rawStr = buf.toString('utf8');
    msg = JSON.parse(rawStr);
  } catch (error) {
    console.warn('[WS] invalid device message', error.message);
    return;
  }

  const currentDeviceId = msg.deviceId || msg.device_id || ws.deviceId;
  if (!currentDeviceId) return;

  switch (msg.type) {
    // ===== 设备注册 =====
    case 'register': {
      // ... 原有的注册逻辑 ...
      
      // 新增：初始化设备健康记录
      recordDeviceHeartbeat(currentDeviceId, true);
      break;
    }

    // ===== 处理 JPEG 帧 =====
    case 'frame': {
      const rawImage = msg.image || msg.img || msg.data;
      if (!rawImage) return;
      
      const frameData = typeof rawImage === 'string' 
        ? Buffer.from(rawImage, 'base64')
        : rawImage;
      
      queueDeviceFrameBroadcast(currentDeviceId, frameData);
      recordDeviceHeartbeat(currentDeviceId, true);
      
      // 计算延迟
      if (msg.timestamp) {
        const latency = Date.now() - msg.timestamp;
        updateNetworkQuality(currentDeviceId, latency);
      }
      break;
    }

    // ===== 处理 WebP 帧 =====
    case 'frame_webp': {
      const webpData = msg.data 
        ? (typeof msg.data === 'string' ? Buffer.from(msg.data, 'base64') : msg.data)
        : null;
      
      if (!webpData) return;
      
      const packed = packWebFrame(currentDeviceId, webpData, IMAGE_FORMAT.WEBP);
      broadcastToWeb(currentDeviceId, packed);
      recordDeviceHeartbeat(currentDeviceId, true);
      
      if (msg.timestamp) {
        const latency = Date.now() - msg.timestamp;
        updateNetworkQuality(currentDeviceId, latency);
      }
      break;
    }

    // ===== 处理 H.264 帧 =====
    case 'frame_h264': {
      const h264Data = msg.data
        ? (typeof msg.data === 'string' ? Buffer.from(msg.data, 'base64') : msg.data)
        : null;
      
      if (!h264Data) return;
      
      // 处理 H.264 帧并判断是否应该转发
      const { shouldSend, isKeyframe, analysis } = processH264Frame(
        currentDeviceId,
        h264Data,
        {
          timestamp: msg.timestamp,
          sequenceNum: msg.sequence,
        }
      );
      
      if (shouldSend) {
        const packed = packWebFrameH264(currentDeviceId, h264Data, {
          timestamp: msg.timestamp,
          isKeyframe: isKeyframe,
          sequenceNum: msg.sequence,
        });
        broadcastToWeb(currentDeviceId, packed);
      } else {
        console.log(`[H264 Adaptive Drop] Device: ${currentDeviceId}, Seq: ${msg.sequence}`);
      }
      
      recordDeviceHeartbeat(currentDeviceId, true);
      
      if (msg.timestamp) {
        const latency = Date.now() - msg.timestamp;
        updateNetworkQuality(currentDeviceId, latency);
      }
      break;
    }

    // ===== 处理 UI 节点数据 =====
    case 'ui_nodes': {
      const nodes = msg.nodes || msg.data;
      if (!Array.isArray(nodes)) break;
      
      storeUINodes(currentDeviceId, nodes, {
        packageName: msg.packageName,
        activityName: msg.activityName,
        timestamp: msg.timestamp || Date.now(),
      });
      
      // 通知所有连接的网页客户端 UI 已更新
      broadcastToWeb(currentDeviceId, {
        type: 'ui_updated',
        deviceId: currentDeviceId,
        timestamp: Date.now(),
        nodeCount: nodes.length,
      });
      
      console.log(`[UI Nodes] Device: ${currentDeviceId}, Nodes: ${nodes.length}`);
      break;
    }

    // ===== 报告设备状态 =====
    case 'status': {
      const health = msg.health || {};
      console.log(`[Device Status] ${currentDeviceId}: Battery=${health.battery}%, CPU Temp=${health.cpuTemp}°C`);
      recordDeviceHeartbeat(currentDeviceId, true);
      break;
    }

    // ===== 网络质量报告 =====
    case 'network_quality': {
      const quality = msg.quality || {};
      updateNetworkQuality(
        currentDeviceId,
        quality.latency || 0,
        quality.packetLoss || 0
      );
      console.log(`[Network] Device: ${currentDeviceId}, Latency: ${quality.latency}ms, Loss: ${(quality.packetLoss * 100).toFixed(2)}%`);
      break;
    }

    // ... 原有的其他 case 处理 ...

    default: {
      console.warn('[WS] unsupported device message type:', msg.type);
    }
  }
}

// ===================== 增强的网页消息处理 =====================

/**
 * 处理网页发来的消息（增强版）
 * 这应该扩展原有的 handleWebMessage 函数
 */
function handleWebMessageEnhanced(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (error) {
    console.warn('[WS] invalid web message', error.message);
    return;
  }

  // ... 原有的消息处理 ...

  // ===== AI 元素定位请求 =====
  if (msg.type === 'ai_locate') {
    const deviceId = msg.deviceId;
    const query = msg.query;  // 如 "确定按钮"
    const minConfidence = msg.minConfidence || 0.5;
    
    if (!deviceId || !query) {
      ws.send(JSON.stringify({ type: 'error', message: 'missing deviceId or query' }));
      return;
    }
    
    const results = locateUIElement(deviceId, query, {
      minConfidence: minConfidence,
      maxResults: 5,
    });
    
    ws.send(JSON.stringify({
      type: 'ai_locate_response',
      deviceId,
      query,
      matches: results,
      timestamp: Date.now(),
    }));
    return;
  }

  // ===== 获取 UI 节点数据 =====
  if (msg.type === 'get_ui_nodes') {
    const deviceId = msg.deviceId;
    if (!deviceId) {
      ws.send(JSON.stringify({ type: 'error', message: 'missing deviceId' }));
      return;
    }
    
    const uiData = getUINodes(deviceId);
    if (!uiData) {
      ws.send(JSON.stringify({
        type: 'ui_nodes_response',
        deviceId,
        nodes: null,
        error: 'No UI data available',
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'ui_nodes_response',
        deviceId,
        ...uiData,
      }));
    }
    return;
  }

  // ===== 获取帧传输统计 =====
  if (msg.type === 'get_frame_stats') {
    const deviceId = msg.deviceId;
    if (!deviceId) {
      ws.send(JSON.stringify({ type: 'error', message: 'missing deviceId' }));
      return;
    }
    
    const stats = getFrameTransferStats(deviceId);
    ws.send(JSON.stringify({
      type: 'frame_stats_response',
      deviceId,
      stats: stats || {},
    }));
    return;
  }

  // ... 原有的其他消息处理 ...

  ws.send(JSON.stringify({ type: 'error', message: 'unsupported web message type' }));
}

// ===================== 新增的 REST API 端点 =====================

/**
 * 在 app.js 或 routes/devices.js 中添加这些端点
 */

const express = require('express');
const router = express.Router();

// GET /api/devices/:id/ui-nodes
router.get('/:id/ui-nodes', (req, res) => {
  const deviceId = req.params.id;
  const uiData = getUINodes(deviceId);
  
  if (!uiData) {
    return res.status(404).json({ error: 'UI nodes not available' });
  }
  
  res.json({
    deviceId,
    ...uiData,
  });
});

// POST /api/devices/:id/ai-locate
router.post('/:id/ai-locate', express.json(), (req, res) => {
  const deviceId = req.params.id;
  const { query, minConfidence = 0.5 } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'missing query' });
  }
  
  const results = locateUIElement(deviceId, query, {
    minConfidence,
    maxResults: 5,
  });
  
  res.json({
    deviceId,
    query,
    matches: results,
    timestamp: Date.now(),
  });
});

// GET /api/devices/:id/frame-stats
router.get('/:id/frame-stats', (req, res) => {
  const deviceId = req.params.id;
  const stats = getFrameTransferStats(deviceId);
  
  res.json({
    deviceId,
    stats: stats || {},
  });
});

// ===================== 辅助函数 =====

/**
 * 增强的二进制帧解析（支持多格式）
 */
function parseWebFramePacket_Enhanced(buf) {
  // 使用 frameProtocol_v2.js 的函数
  const protocol = require('./frameProtocol_v2');
  return protocol.parseDeviceFramePacket(buf);
}

/**
 * 计算网络延迟（基于时间戳）
 */
function calculateLatency(timestamp) {
  if (!timestamp) return 0;
  return Date.now() - timestamp;
}

/**
 * 推荐采集格式（基于网络质量）
 */
function suggestImageFormat(deviceId) {
  const stats = getFrameTransferStats(deviceId);
  if (!stats) return 'jpeg';
  
  // 简单的启发式规则
  if (stats.h264 && stats.h264.count > 10) {
    return 'h264';  // 优先使用 H.264
  }
  if (stats.webp && stats.webp.count > 10) {
    return 'webp';  // 次选 WebP
  }
  return 'jpeg';  // 默认 JPEG
}

module.exports = {
  handleDeviceMessageEnhanced,
  handleWebMessageEnhanced,
  router,
  calculateLatency,
  suggestImageFormat,
};
