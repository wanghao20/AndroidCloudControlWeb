/**
 * deviceManager 增强扩展
 * 
 * 整合以下功能：
 * 1. 多格式图像支持（JPEG/WebP/H.264）
 * 2. H.264 关键帧缓存
 * 3. 自适应丢帧
 * 4. UI 节点存储与 AI 定位
 * 5. 设备健康检查
 * 
 * 这是对原有 deviceManager.js 的增强，应该集成到主文件中
 */

const {
  KeyframeCache,
  AdaptiveFrameDropper,
  H264SequenceTracker,
  analyzeH264,
  hasKeyframe,
} = require('./h264Processor');

const { ElementLocator, UIChangeDetector } = require('../ai/elementLocator');

const crypto = require('crypto');

// ===================== 全局增强数据结构 =====================

/**
 * H.264 关键帧缓存（全局）
 */
const h264KeyframeCache = new KeyframeCache(5000); // 5 秒过期

/**
 * 自适应帧丢弃控制（全局）
 */
const adaptiveFrameDropper = new AdaptiveFrameDropper();

/**
 * H.264 序列号追踪（全局）
 */
const h264SequenceTracker = new H264SequenceTracker();

/**
 * UI 节点缓存（设备 -> UI 树）
 */
const uiNodeCache = new Map();

/**
 * UI 节点变化历史
 */
const uiNodeHistory = new Map();

/**
 * UI 变化检测器
 */
const uiChangeDetectors = new Map();

/**
 * 设备心跳与连接统计
 */
const deviceHealthStats = new Map();

/**
 * 设备重连日志
 */
const deviceReconnectLog = new Map();

/**
 * 帧传输统计（按格式）
 */
const frameTransferStats = new Map();

/**
 * 连接质量指标
 */
const connectionQuality = new Map();

/**
 * AI 元素定位器（全局单例）
 */
const elementLocator = new ElementLocator();

// ===================== UI 节点管理 =====================

/**
 * 存储设备的 UI 树
 * @param {string} deviceId
 * @param {Array} uiNodes UI 节点数组
 * @param {Object} metadata { packageName, activityName, timestamp }
 */
function storeUINodes(deviceId, uiNodes, metadata = {}) {
  const timestamp = metadata.timestamp || Date.now();
  
  uiNodeCache.set(deviceId, {
    nodes: uiNodes,
    packageName: metadata.packageName || '',
    activityName: metadata.activityName || '',
    timestamp,
    checksum: computeUITreeChecksum(uiNodes),
  });
  
  // 追踪变化
  const detector = uiChangeDetectors.get(deviceId) || new UIChangeDetector();
  const change = detector.detectChange(uiNodes);
  uiChangeDetectors.set(deviceId, detector);
  
  // 记录变化历史
  let history = uiNodeHistory.get(deviceId) || [];
  if (change.changed) {
    history.push({
      timestamp,
      packageName: metadata.packageName || '',
      activityName: metadata.activityName || '',
      addedCount: change.addedNodes?.length || 0,
      removedCount: change.removedNodes?.length || 0,
    });
    
    // 仅保留最近 100 条历史
    if (history.length > 100) {
      history = history.slice(-100);
    }
    uiNodeHistory.set(deviceId, history);
  }
}

/**
 * 计算 UI 树的校验和
 * @param {Array} nodes
 * @returns {string}
 */
function computeUITreeChecksum(nodes) {
  const serialized = JSON.stringify(nodes);
  return crypto.createHash('md5').update(serialized).digest('hex');
}

/**
 * 获取设备的 UI 树
 * @param {string} deviceId
 * @returns {Object|null}
 */
function getUINodes(deviceId) {
  const cached = uiNodeCache.get(deviceId);
  if (!cached) return null;
  
  return {
    nodes: cached.nodes,
    packageName: cached.packageName,
    activityName: cached.activityName,
    timestamp: cached.timestamp,
  };
}

/**
 * 获取 UI 变化历史
 * @param {string} deviceId
 * @returns {Array}
 */
function getUIChangeHistory(deviceId) {
  return uiNodeHistory.get(deviceId) || [];
}

// ===================== AI 元素定位 =====================

/**
 * 定位 UI 元素
 * @param {string} deviceId
 * @param {string} query 查询文本，如 "确定按钮"
 * @param {Object} options { minConfidence, maxResults }
 * @returns {Array} 匹配结果
 */
function locateUIElement(deviceId, query, options = {}) {
  const uiData = uiNodeCache.get(deviceId);
  if (!uiData) {
    return [];
  }
  
  const nodes = uiData.nodes || [];
  return elementLocator.locate(query, nodes, {
    minConfidence: options.minConfidence || 0.5,
    maxResults: options.maxResults || 5,
  });
}

/**
 * 批量定位多个 UI 元素
 * @param {string} deviceId
 * @param {Array<string>} queries
 * @returns {Object}
 */
function locateUIElementsBatch(deviceId, queries) {
  const uiData = uiNodeCache.get(deviceId);
  if (!uiData) {
    return {};
  }
  
  const nodes = uiData.nodes || [];
  return elementLocator.locateBatch(queries, nodes);
}

/**
 * 根据屏幕坐标定位节点
 * @param {string} deviceId
 * @param {number} x
 * @param {number} y
 * @returns {Array}
 */
function locateUIElementByPoint(deviceId, x, y) {
  const uiData = uiNodeCache.get(deviceId);
  if (!uiData) {
    return [];
  }
  
  const nodes = uiData.nodes || [];
  return elementLocator.locateByPoint(x, y, nodes);
}

// ===================== H.264 处理 =====================

/**
 * 处理 H.264 帧数据
 * @param {string} deviceId
 * @param {Buffer} h264Data
 * @param {Object} metadata { timestamp, sequenceNum }
 * @returns {Object} { shouldSend, analysis }
 */
function processH264Frame(deviceId, h264Data, metadata = {}) {
  const analysis = analyzeH264(h264Data);
  const isKeyframe = hasKeyframe(h264Data);
  
  // 缓存关键帧
  if (isKeyframe) {
    h264KeyframeCache.set(deviceId, h264Data);
  }
  
  // 更新序列号追踪
  if (metadata.sequenceNum !== undefined) {
    const tracking = h264SequenceTracker.track(deviceId, metadata.sequenceNum);
    if (tracking.missed > 0) {
      console.warn(`[H264] 设备 ${deviceId} 检测到丢帧: ${tracking.missed} 帧`);
    }
  }
  
  // 自适应丢帧决策
  const shouldSend = !adaptiveFrameDropper.shouldDrop(deviceId, isKeyframe);
  
  if (isKeyframe) {
    updateFrameStats(deviceId, 'h264', h264Data.length, true);
  } else {
    updateFrameStats(deviceId, 'h264', h264Data.length, false);
  }
  
  return {
    shouldSend,
    isKeyframe,
    analysis,
    cachedKeyframe: isKeyframe,
  };
}

/**
 * 获取设备的最近关键帧
 * @param {string} deviceId
 * @returns {Buffer|null}
 */
function getCachedKeyframe(deviceId) {
  return h264KeyframeCache.get(deviceId);
}

/**
 * 更新设备的网络质量指标（用于自适应控制）
 * @param {string} deviceId
 * @param {number} latencyMs
 * @param {number} packetLoss
 */
function updateNetworkQuality(deviceId, latencyMs, packetLoss = 0) {
  adaptiveFrameDropper.updateStats(deviceId, latencyMs, packetLoss);
  
  connectionQuality.set(deviceId, {
    latencyMs,
    packetLoss,
    timestamp: Date.now(),
  });
}

// ===================== 帧统计 =====================

/**
 * 更新帧传输统计
 * @param {string} deviceId
 * @param {string} format 'jpeg' | 'webp' | 'h264'
 * @param {number} bytes 字节大小
 * @param {boolean} isKeyframe
 */
function updateFrameStats(deviceId, format, bytes, isKeyframe = false) {
  let stats = frameTransferStats.get(deviceId) || {
    jpeg: { count: 0, bytes: 0 },
    webp: { count: 0, bytes: 0 },
    h264: { count: 0, bytes: 0, keyframes: 0 },
    totalFrames: 0,
    droppedFrames: 0,
  };
  
  if (stats[format]) {
    stats[format].count++;
    stats[format].bytes += bytes;
  }
  
  if (format === 'h264' && isKeyframe) {
    stats.h264.keyframes = (stats.h264.keyframes || 0) + 1;
  }
  
  stats.totalFrames++;
  frameTransferStats.set(deviceId, stats);
}

/**
 * 获取帧传输统计
 * @param {string} deviceId
 * @returns {Object}
 */
function getFrameTransferStats(deviceId) {
  const stats = frameTransferStats.get(deviceId);
  if (!stats) return null;
  
  const jpegAvg = stats.jpeg.count > 0 ? Math.round(stats.jpeg.bytes / stats.jpeg.count) : 0;
  const webpAvg = stats.webp.count > 0 ? Math.round(stats.webp.bytes / stats.webp.count) : 0;
  const h264Avg = stats.h264.count > 0 ? Math.round(stats.h264.bytes / stats.h264.count) : 0;
  
  return {
    jpeg: { count: stats.jpeg.count, avgBytes: jpegAvg, totalBytes: stats.jpeg.bytes },
    webp: { count: stats.webp.count, avgBytes: webpAvg, totalBytes: stats.webp.bytes },
    h264: {
      count: stats.h264.count,
      avgBytes: h264Avg,
      totalBytes: stats.h264.bytes,
      keyframes: stats.h264.keyframes || 0,
    },
    totalFrames: stats.totalFrames,
    droppedFrames: stats.droppedFrames,
  };
}

// ===================== 设备健康检查 =====================

/**
 * 记录设备心跳
 * @param {string} deviceId
 * @param {boolean} healthy
 */
function recordDeviceHeartbeat(deviceId, healthy = true) {
  let health = deviceHealthStats.get(deviceId) || {
    online: 0,
    offline: 0,
    consecutiveFailures: 0,
    lastFailureReason: null,
    lastHeartbeatAt: Date.now(),
  };
  
  if (healthy) {
    health.online++;
    health.consecutiveFailures = 0;
  } else {
    health.offline++;
    health.consecutiveFailures++;
  }
  
  health.lastHeartbeatAt = Date.now();
  deviceHealthStats.set(deviceId, health);
}

/**
 * 获取设备健康状态
 * @param {string} deviceId
 * @returns {Object}
 */
function getDeviceHealth(deviceId) {
  const health = deviceHealthStats.get(deviceId);
  if (!health) {
    return { status: 'unknown' };
  }
  
  const successRate = health.online / (health.online + health.offline) * 100;
  
  return {
    status: health.consecutiveFailures >= 3 ? 'unhealthy' : 'healthy',
    successRate: Math.round(successRate),
    online: health.online,
    offline: health.offline,
    consecutiveFailures: health.consecutiveFailures,
    lastFailureReason: health.lastFailureReason,
    lastHeartbeatAt: health.lastHeartbeatAt,
  };
}

/**
 * 记录设备重连
 * @param {string} deviceId
 * @param {Object} info { disconnectReason, duration }
 */
function recordDeviceReconnect(deviceId, info = {}) {
  let log = deviceReconnectLog.get(deviceId) || [];
  
  log.push({
    timestamp: Date.now(),
    disconnectReason: info.disconnectReason || 'unknown',
    duration: info.duration || 0,
  });
  
  // 仅保留最近 100 条
  if (log.length > 100) {
    log = log.slice(-100);
  }
  
  deviceReconnectLog.set(deviceId, log);
}

/**
 * 获取设备重连历史
 * @param {string} deviceId
 * @returns {Array}
 */
function getReconnectHistory(deviceId) {
  return deviceReconnectLog.get(deviceId) || [];
}

// ===================== 清理函数 =====================

/**
 * 设备离线时的清理
 * @param {string} deviceId
 */
function cleanupDeviceResources(deviceId) {
  h264KeyframeCache.clear(deviceId);
  adaptiveFrameDropper.clear(deviceId);
  h264SequenceTracker.reset(deviceId);
  uiNodeCache.delete(deviceId);
  uiNodeHistory.delete(deviceId);
  
  const detector = uiChangeDetectors.get(deviceId);
  if (detector) {
    detector.reset();
  }
  
  elementLocator.clearCache(); // 清除缓存的查询结果
}

// ===================== 导出接口 =====================

module.exports = {
  // UI 节点管理
  storeUINodes,
  getUINodes,
  getUIChangeHistory,
  
  // AI 定位
  locateUIElement,
  locateUIElementsBatch,
  locateUIElementByPoint,
  
  // H.264 处理
  processH264Frame,
  getCachedKeyframe,
  updateNetworkQuality,
  
  // 统计
  updateFrameStats,
  getFrameTransferStats,
  
  // 健康检查
  recordDeviceHeartbeat,
  getDeviceHealth,
  recordDeviceReconnect,
  getReconnectHistory,
  
  // 清理
  cleanupDeviceResources,
  
  // 内部使用
  elementLocator,
  uiChangeDetectors,
};
