/**
 * WebSocket 二进制画面协议（设备 0xF1 / 网页 0xF2）
 * V2: [magic][format:1][deviceIdLen:2][deviceId][imageData]
 * 兼容旧版: [magic][deviceIdLen:2][deviceId][imageData] 视为 JPEG/WebP 魔数检测
 */

const DEVICE_FRAME_MAGIC = 0xf1;
const WEB_FRAME_MAGIC = 0xf2;
const DEVICE_AUDIO_MAGIC = 0xf3;

const IMAGE_FORMAT = {
  JPEG: 0x00,
  WEBP: 0x01,
  H264: 0x02,
  H264_TIMESTAMPED: 0x03,
};

const FORMAT_NAMES = {
  0x00: "JPEG",
  0x01: "WebP",
  0x02: "H.264",
  0x03: "H.264-TS",
};

function mimeTypeForFormat(format) {
  if (format === IMAGE_FORMAT.WEBP) return "image/webp";
  return "image/jpeg";
}

function isWebP(buf) {
  if (!buf || buf.length < 12) return false;
  return (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  );
}

function detectImageFormat(buf) {
  if (!buf || buf.length < 2) return IMAGE_FORMAT.JPEG;
  if (buf[0] === 0xff && buf[1] === 0xd8) return IMAGE_FORMAT.JPEG;
  if (isWebP(buf)) return IMAGE_FORMAT.WEBP;
  return IMAGE_FORMAT.JPEG;
}

function parseDeviceFramePacketV2(packet) {
  const format = packet[1];
  const idLen = packet.readUInt16BE(2);
  const headerLen = 4 + idLen;
  if (headerLen >= packet.length) return null;
  const deviceId = packet.toString("utf8", 4, headerLen);
  const imageData = packet.subarray(headerLen);
  if (!imageData.length) return null;
  const resolvedFormat =
    format === IMAGE_FORMAT.JPEG ? detectImageFormat(imageData) : format;
  return {
    deviceId,
    format: resolvedFormat,
    formatName: FORMAT_NAMES[format] || "UNKNOWN",
    imageData,
    mimeType: mimeTypeForFormat(resolvedFormat),
    bytes: imageData.length,
    isLegacyFormat: false,
  };
}

function parseDeviceAudioPacket(buf) {
  const packet = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (packet.length < 9 || packet[0] !== DEVICE_AUDIO_MAGIC) return null;
  const sampleRate = packet.readUInt32BE(1);
  const channels = packet[5];
  const idLen = packet.readUInt16BE(6);
  const headerLen = 8 + idLen;
  if (headerLen >= packet.length) return null;
  const deviceId = packet.toString("utf8", 8, headerLen);
  const pcmData = packet.subarray(headerLen);
  if (!pcmData.length) return null;
  return { deviceId, sampleRate, channels, pcmData, bytes: pcmData.length };
}

function parseDeviceFramePacket(buf) {
  const packet = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  if (packet.length >= 5 && packet[0] === DEVICE_FRAME_MAGIC) {
    const second = packet[1];
    if (
      second === IMAGE_FORMAT.WEBP ||
      second === IMAGE_FORMAT.H264 ||
      second === IMAGE_FORMAT.H264_TIMESTAMPED
    ) {
      const v2 = parseDeviceFramePacketV2(packet);
      if (v2) return v2;
    }
  }

  if (packet.length >= 4 && packet[0] === DEVICE_FRAME_MAGIC) {
    const idLen = packet.readUInt16BE(1);
    const headerLen = 3 + idLen;
    if (headerLen < packet.length) {
      const deviceId = packet.toString("utf8", 3, headerLen);
      const imageData = packet.subarray(headerLen);
      if (imageData.length > 0) {
        const format = detectImageFormat(imageData);
        return {
          deviceId,
          format,
          formatName: `${FORMAT_NAMES[format] || "JPEG"} (legacy)`,
          imageData,
          mimeType: mimeTypeForFormat(format),
          bytes: imageData.length,
          isLegacyFormat: true,
        };
      }
    }
  }

  if (packet.length >= 5 && packet[0] === DEVICE_FRAME_MAGIC && packet[1] === IMAGE_FORMAT.JPEG) {
    const v2 = parseDeviceFramePacketV2(packet);
    if (v2) return v2;
  }

  return null;
}

function parseWebFramePacket(buf) {
  const packet = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  if (packet.length >= 5 && packet[0] === WEB_FRAME_MAGIC) {
    const format = packet[1];
    if (format <= IMAGE_FORMAT.H264_TIMESTAMPED) {
      const idLen = packet.readUInt16BE(2);
      const headerLen = 4 + idLen;
      if (headerLen < packet.length) {
        const deviceId = packet.toString("utf8", 4, headerLen);
        const imageData = packet.subarray(headerLen);
        if (imageData.length > 0) {
          const resolved =
            format === IMAGE_FORMAT.JPEG ? detectImageFormat(imageData) : format;
          return {
            deviceId,
            format: resolved,
            imageData,
            mimeType: mimeTypeForFormat(resolved),
            isLegacyFormat: false,
          };
        }
      }
    }
  }

  if (packet.length >= 4 && packet[0] === WEB_FRAME_MAGIC) {
    const idLen = packet.readUInt16BE(1);
    const headerLen = 3 + idLen;
    if (headerLen < packet.length) {
      const deviceId = packet.toString("utf8", 3, headerLen);
      const imageData = packet.subarray(headerLen);
      if (imageData.length > 0) {
        const format = detectImageFormat(imageData);
        return {
          deviceId,
          format,
          imageData,
          mimeType: mimeTypeForFormat(format),
          isLegacyFormat: true,
        };
      }
    }
  }

  return null;
}

function packWebFrame(deviceId, imageData, format = IMAGE_FORMAT.JPEG) {
  const img = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData);
  const idBuf = Buffer.from(String(deviceId), "utf8");
  if (idBuf.length > 65535) {
    throw new Error("deviceId too long");
  }
  const fmt =
    typeof format === "number" ? format : detectImageFormat(img);
  const out = Buffer.allocUnsafe(4 + idBuf.length + img.length);
  out[0] = WEB_FRAME_MAGIC;
  out[1] = fmt;
  out.writeUInt16BE(idBuf.length, 2);
  idBuf.copy(out, 4);
  img.copy(out, 4 + idBuf.length);
  return out;
}

function normalizeFramePayload(image) {
  if (Buffer.isBuffer(image)) return image;
  if (typeof image === "string") {
    let clean = image.replace(/[\r\n\s]/g, "");
    if (clean.startsWith("data:image")) {
      const comma = clean.indexOf(",");
      clean = comma >= 0 ? clean.slice(comma + 1) : clean;
    }
    if (!clean) return null;
    return Buffer.from(clean, "base64");
  }
  return null;
}

module.exports = {
  DEVICE_FRAME_MAGIC,
  WEB_FRAME_MAGIC,
  DEVICE_AUDIO_MAGIC,
  IMAGE_FORMAT,
  FORMAT_NAMES,
  mimeTypeForFormat,
  parseDeviceFramePacket,
  parseDeviceAudioPacket,
  parseWebFramePacket,
  packWebFrame,
  detectImageFormat,
  isWebP,
  normalizeFramePayload,
};
