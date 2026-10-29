/**
 * WebSocket 二进制画面协议 V2
 * 支持多格式：JPEG、WebP、H.264
 * 
 * 协议格式：
 * [0xF1][format:1byte][deviceIdLen:2bytes][deviceId utf8][imageData]
 * 
 * format 值：
 * - 0x00: JPEG (旧格式兼容)
 * - 0x01: WebP
 * - 0x02: H.264 raw NAL units
 * - 0x03: H.264 with timestamp
 */

const DEVICE_FRAME_MAGIC = 0xf1;
const WEB_FRAME_MAGIC = 0xf2;

// 图像格式标识
const IMAGE_FORMAT = {
  JPEG: 0x00,
  WEBP: 0x01,
  H264: 0x02,
  H264_TIMESTAMPED: 0x03,
};

const FORMAT_NAMES = {
  0x00: 'JPEG',
  0x01: 'WebP',
  0x02: 'H.264',
  0x03: 'H.264-TS',
};

/**
 * 解析设备端上报的二进制帧数据（新格式）
 * @param {Buffer} buf 原始二进制数据
 * @returns {Object|null} { deviceId, format, imageData, timestamp?, isKeyframe? }
 */
function parseDeviceFramePacket(buf) {
  const packet = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  
  // 尝试新格式 [0xF1][format][deviceIdLen][deviceId][data]
  if (packet.length >= 5 && packet[0] === DEVICE_FRAME_MAGIC) {
    const format = packet[1];
    
    // 检查格式是否有效（0x00 可能是旧 JPEG 格式）
    if (format <= 0x03 || format === 0x00) {
      const idLen = packet.readUInt16BE(2);
      const headerLen = 4 + idLen;
      
      if (headerLen < packet.length) {
        const deviceId = packet.toString('utf8', 4, headerLen);
        const imageData = packet.subarray(headerLen);
        
        if (imageData.length > 0) {
          const result = {
            deviceId,
            format,
            formatName: FORMAT_NAMES[format] || 'UNKNOWN',
            imageData,
            bytes: imageData.length,
          };
          
          // H.264 带时间戳的格式
          if (format === 0x03 && imageData.length >= 8) {
            result.timestamp = imageData.readUInt32BE(0);
            result.isKeyframe = (imageData[4] & 0x80) > 0;
            result.sequenceNum = imageData.readUInt32BE(5);
            result.h264Data = imageData.subarray(9);
          }
          
          return result;
        }
      }
    }
  }
  
  // 兼容旧格式 [0xF1][deviceIdLen][deviceId][jpeg]
  if (packet.length >= 4 && packet[0] === DEVICE_FRAME_MAGIC) {
    const idLen = packet.readUInt16BE(1);
    const headerLen = 3 + idLen;
    
    if (headerLen < packet.length) {
      const deviceId = packet.toString('utf8', 3, headerLen);
      const imageData = packet.subarray(headerLen);
      
      if (imageData.length > 0) {
        return {
          deviceId,
          format: IMAGE_FORMAT.JPEG,
          formatName: 'JPEG (legacy)',
          imageData,
          bytes: imageData.length,
          isLegacyFormat: true,
        };
      }
    }
  }
  
  return null;
}

/**
 * 打包发送给网页客户端的帧数据（新格式）
 * @param {string} deviceId 设备 ID
 * @param {Buffer} imageData 图像数据（JPEG/WebP/H.264）
 * @param {number} format 图像格式（IMAGE_FORMAT.*）
 * @param {Object} options 可选配置 { timestamp, isKeyframe, sequenceNum }
 * @returns {Buffer} 打包后的二进制数据
 */
function packWebFrame(deviceId, imageData, format = IMAGE_FORMAT.JPEG, options = {}) {
  const jpeg = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData);
  const idBuf = Buffer.from(String(deviceId), 'utf8');
  
  if (idBuf.length > 65535) {
    throw new Error('deviceId too long');
  }
  
  // [0xF2][format][deviceIdLen][deviceId][imageData]
  const out = Buffer.allocUnsafe(4 + idBuf.length + jpeg.length);
  out[0] = WEB_FRAME_MAGIC;
  out[1] = format;
  out.writeUInt16BE(idBuf.length, 2);
  idBuf.copy(out, 4);
  jpeg.copy(out, 4 + idBuf.length);
  
  return out;
}

/**
 * 将 H.264 数据打包为带元数据的格式
 * @param {string} deviceId
 * @param {Buffer} h264Data
 * @param {Object} metadata { timestamp, isKeyframe, sequenceNum }
 * @returns {Buffer}
 */
function packWebFrameH264(deviceId, h264Data, metadata = {}) {
  const h264 = Buffer.isBuffer(h264Data) ? h264Data : Buffer.from(h264Data);
  const idBuf = Buffer.from(String(deviceId), 'utf8');
  
  const timestamp = metadata.timestamp || 0;
  const isKeyframe = metadata.isKeyframe ? 0x80 : 0x00;
  const sequenceNum = metadata.sequenceNum || 0;
  
  // [0xF2][0x03][deviceIdLen][deviceId][timestamp:4][flags][seqNum:4][h264Data]
  const out = Buffer.allocUnsafe(4 + idBuf.length + 9 + h264.length);
  out[0] = WEB_FRAME_MAGIC;
  out[1] = IMAGE_FORMAT.H264_TIMESTAMPED;
  out.writeUInt16BE(idBuf.length, 2);
  idBuf.copy(out, 4);
  
  const dataStart = 4 + idBuf.length;
  out.writeUInt32BE(timestamp, dataStart);
  out[dataStart + 4] = isKeyframe;
  out.writeUInt32BE(sequenceNum, dataStart + 5);
  h264.copy(out, dataStart + 9);
  
  return out;
}

/**
 * 检查是否为 WebP 格式
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isWebP(buf) {
  if (buf.length < 12) return false;
  // WebP 文件头: RIFF....WEBP
  return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
         buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
}

/**
 * 检查是否为 H.264 NAL 单元
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isH264NAL(buf) {
  if (buf.length < 3) return false;
  // H.264 NAL 起始码: 0x00 0x00 0x01 或 0x00 0x00 0x00 0x01
  return (buf[0] === 0x00 && buf[1] === 0x00 && 
          (buf[2] === 0x01 || (buf[3] === 0x01 && buf[2] === 0x00)));
}

/**
 * 自动检测图像格式
 * @param {Buffer} buf 图像数据
 * @returns {number} IMAGE_FORMAT 值
 */
function detectImageFormat(buf) {
  // JPEG 文件头: FF D8
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
    return IMAGE_FORMAT.JPEG;
  }
  
  // WebP 文件头
  if (isWebP(buf)) {
    return IMAGE_FORMAT.WEBP;
  }
  
  // H.264 NAL 单元
  if (isH264NAL(buf)) {
    return IMAGE_FORMAT.H264;
  }
  
  // 默认 JPEG
  return IMAGE_FORMAT.JPEG;
}

/**
 * 标准化图像数据（支持 base64、Buffer、Data URL 等格式）
 * @param {*} image
 * @returns {Buffer|null}
 */
function normalizeFramePayload(image) {
  if (Buffer.isBuffer(image)) return image;
  if (typeof image === 'string') {
    let clean = image.replace(/[\r\n\s]/g, '');
    if (clean.startsWith('data:image')) {
      const comma = clean.indexOf(',');
      clean = comma >= 0 ? clean.slice(comma + 1) : clean;
    }
    if (!clean) return null;
    return Buffer.from(clean, 'base64');
  }
  return null;
}

module.exports = {
  // 常量导出
  DEVICE_FRAME_MAGIC,
  WEB_FRAME_MAGIC,
  IMAGE_FORMAT,
  FORMAT_NAMES,
  
  // 核心函数
  parseDeviceFramePacket,
  packWebFrame,
  packWebFrameH264,
  
  // 工具函数
  isWebP,
  isH264NAL,
  detectImageFormat,
  normalizeFramePayload,
};
