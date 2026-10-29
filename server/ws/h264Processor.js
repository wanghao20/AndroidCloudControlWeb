/**
 * H.264 视频流处理模块
 * 
 * 功能：
 * - 解析 H.264 NAL 单元
 * - 检测关键帧（I 帧）
 * - 管理帧缓存
 * - 自适应丢帧策略
 */

const crypto = require('crypto');

// H.264 NAL 单元类型
const NAL_TYPE = {
  SLICE_LAYER_WITHOUT_PARTITION_A_NON_IDR: 1,  // P 帧
  SLICE_LAYER_PARTITION_A_NON_IDR: 2,
  SLICE_LAYER_PARTITION_B_NON_IDR: 3,
  SLICE_LAYER_PARTITION_C_NON_IDR: 4,
  SLICE_LAYER_IDR: 5,  // I 帧（关键帧）
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
  STREAM_END: 11,
};

const NAL_TYPE_NAMES = {
  1: 'P-slice',
  2: 'Partition-A',
  3: 'Partition-B',
  4: 'Partition-C',
  5: 'I-slice (IDR)',
  6: 'SEI',
  7: 'SPS',
  8: 'PPS',
  9: 'AUD',
  11: 'Stream-end',
};

/**
 * 解析单个 NAL 单元，获取其类型和属性
 * @param {Buffer} nalUnit H.264 NAL 单元数据
 * @returns {Object} { type, typeName, isKeyframe, forbidden, refIdc, payload }
 */
function parseNALUnit(nalUnit) {
  if (!nalUnit || nalUnit.length < 1) {
    return null;
  }
  
  const headerByte = nalUnit[0];
  const forbidden = (headerByte & 0x80) >> 7;
  const refIdc = (headerByte & 0x60) >> 5;
  const type = headerByte & 0x1F;
  
  return {
    type,
    typeName: NAL_TYPE_NAMES[type] || `Unknown(${type})`,
    isKeyframe: (type === NAL_TYPE.SLICE_LAYER_IDR),
    isSPS: (type === NAL_TYPE.SPS),
    isPPS: (type === NAL_TYPE.PPS),
    forbidden,
    refIdc,
    payload: nalUnit.subarray(1),
  };
}

/**
 * 从 H.264 原始数据中提取所有 NAL 单元
 * @param {Buffer} h264Data H.264 原始数据
 * @returns {Array} NAL 单元数组
 */
function extractNALUnits(h264Data) {
  const units = [];
  let start = 0;
  
  const data = Buffer.isBuffer(h264Data) ? h264Data : Buffer.from(h264Data);
  
  for (let i = 0; i < data.length - 2; i++) {
    // 查找 NAL 起始码: 0x000001 或 0x00000001
    let foundStart = false;
    let codeLength = 0;
    
    if (i === 0 && data[0] === 0x00 && data[1] === 0x00) {
      if (data[2] === 0x01) {
        foundStart = true;
        codeLength = 3;
      } else if (data[2] === 0x00 && data[3] === 0x01) {
        foundStart = true;
        codeLength = 4;
        i++;
      }
    } else if (i > 0 && data[i - 1] === 0x00 && data[i] === 0x00 && data[i + 1] === 0x01) {
      foundStart = true;
      codeLength = 3;
    } else if (i > 1 && data[i - 2] === 0x00 && data[i - 1] === 0x00 && 
               data[i] === 0x00 && data[i + 1] === 0x01) {
      foundStart = true;
      codeLength = 4;
      i++;
    }
    
    if (foundStart && i > start) {
      const nalData = data.subarray(start, i - (codeLength - 1));
      if (nalData.length > 0) {
        units.push(nalData);
      }
      start = i + 1;
      i += codeLength - 1;
    }
  }
  
  // 添加最后一个 NAL 单元
  if (start < data.length) {
    units.push(data.subarray(start));
  }
  
  return units;
}

/**
 * 检测 H.264 数据是否包含关键帧（IDR 帧）
 * @param {Buffer} h264Data
 * @returns {boolean}
 */
function hasKeyframe(h264Data) {
  const units = extractNALUnits(h264Data);
  return units.some(unit => {
    const nal = parseNALUnit(unit);
    return nal && nal.isKeyframe;
  });
}

/**
 * 获取 H.264 数据的统计信息
 * @param {Buffer} h264Data
 * @returns {Object} { unitCount, keyframeCount, hasIdr, spsCount, ppsCount, totalSize }
 */
function analyzeH264(h264Data) {
  const units = extractNALUnits(h264Data);
  const stats = {
    unitCount: units.length,
    keyframeCount: 0,
    hasIdr: false,
    spsCount: 0,
    ppsCount: 0,
    totalSize: h264Data.length,
    nalTypes: {},
  };
  
  units.forEach(unit => {
    const nal = parseNALUnit(unit);
    if (!nal) return;
    
    if (nal.isKeyframe) {
      stats.keyframeCount++;
      stats.hasIdr = true;
    }
    if (nal.isSPS) stats.spsCount++;
    if (nal.isPPS) stats.ppsCount++;
    
    stats.nalTypes[nal.type] = (stats.nalTypes[nal.type] || 0) + 1;
  });
  
  return stats;
}

/**
 * H.264 关键帧缓存管理器
 */
class KeyframeCache {
  constructor(maxAge = 5000) {
    this.cache = new Map();  // deviceId -> { data, timestamp, hash }
    this.maxAge = maxAge;
  }
  
  /**
   * 缓存关键帧
   * @param {string} deviceId
   * @param {Buffer} keyframeData
   */
  set(deviceId, keyframeData) {
    const hash = crypto.createHash('md5').update(keyframeData).digest('hex');
    const cached = this.cache.get(deviceId);
    
    // 避免缓存重复的帧
    if (cached && cached.hash === hash) {
      cached.timestamp = Date.now();
      return false;
    }
    
    this.cache.set(deviceId, {
      data: Buffer.from(keyframeData),
      timestamp: Date.now(),
      hash,
    });
    
    return true;
  }
  
  /**
   * 获取缓存的关键帧
   * @param {string} deviceId
   * @returns {Buffer|null}
   */
  get(deviceId) {
    const cached = this.cache.get(deviceId);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > this.maxAge) {
      this.cache.delete(deviceId);
      return null;
    }
    
    return cached.data;
  }
  
  /**
   * 清除特定设备的缓存
   * @param {string} deviceId
   */
  clear(deviceId) {
    this.cache.delete(deviceId);
  }
  
  /**
   * 清除所有缓存
   */
  clearAll() {
    this.cache.clear();
  }
}

/**
 * H.264 自适应丢帧控制器
 * 
 * 根据网络延迟和丢包率，动态决定是否丢弃 P 帧
 */
class AdaptiveFrameDropper {
  constructor() {
    this.deviceStats = new Map();  // deviceId -> { latency, packetLoss, shouldDrop }
  }
  
  /**
   * 更新设备的网络统计
   * @param {string} deviceId
   * @param {number} latencyMs 延迟（毫秒）
   * @param {number} packetLoss 丢包率 (0.0-1.0)
   */
  updateStats(deviceId, latencyMs, packetLoss = 0) {
    const stats = this.deviceStats.get(deviceId) || {};
    
    // 计算是否应该丢弃 P 帧
    // 阈值：延迟 > 300ms 或 丢包率 > 5%
    const shouldDrop = latencyMs > 300 || packetLoss > 0.05;
    
    this.deviceStats.set(deviceId, {
      latency: latencyMs,
      packetLoss,
      shouldDrop,
      updatedAt: Date.now(),
    });
  }
  
  /**
   * 决定是否应该丢弃此帧
   * @param {string} deviceId
   * @param {boolean} isKeyframe
   * @returns {boolean} 返回 true 表示应该丢弃
   */
  shouldDrop(deviceId, isKeyframe) {
    if (isKeyframe) {
      // 关键帧永远不丢弃
      return false;
    }
    
    const stats = this.deviceStats.get(deviceId);
    if (!stats) return false;
    
    return stats.shouldDrop;
  }
  
  /**
   * 清除特定设备的统计
   * @param {string} deviceId
   */
  clear(deviceId) {
    this.deviceStats.delete(deviceId);
  }
}

/**
 * H.264 序列号跟踪（用于检测丢帧）
 */
class H264SequenceTracker {
  constructor() {
    this.sequences = new Map();  // deviceId -> { lastSeq, missed }
  }
  
  /**
   * 记录新的序列号
   * @param {string} deviceId
   * @param {number} seqNum
   * @returns {Object} { missed, lastSeq }
   */
  track(deviceId, seqNum) {
    const tracker = this.sequences.get(deviceId) || { lastSeq: seqNum - 1, missed: 0 };
    
    const missed = seqNum - tracker.lastSeq - 1;
    
    this.sequences.set(deviceId, {
      lastSeq: seqNum,
      missed: tracker.missed + Math.max(0, missed),
    });
    
    return {
      missed,
      totalMissed: tracker.missed + Math.max(0, missed),
    };
  }
  
  /**
   * 获取统计信息
   * @param {string} deviceId
   * @returns {Object}
   */
  getStats(deviceId) {
    return this.sequences.get(deviceId) || { lastSeq: 0, missed: 0 };
  }
  
  /**
   * 重置追踪
   * @param {string} deviceId
   */
  reset(deviceId) {
    this.sequences.delete(deviceId);
  }
}

module.exports = {
  // 常量
  NAL_TYPE,
  NAL_TYPE_NAMES,
  
  // 单元解析函数
  parseNALUnit,
  extractNALUnits,
  hasKeyframe,
  analyzeH264,
  
  // 辅助类
  KeyframeCache,
  AdaptiveFrameDropper,
  H264SequenceTracker,
};
