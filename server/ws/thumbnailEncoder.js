const sharp = require("sharp");

const THUMB_WIDTH = 160;
const THUMB_JPEG_QUALITY = 55;
const thumbCache = new Map();

/**
 * 将设备 JPEG 帧压缩为列表缩略图（宽 160，mozjpeg）
 * @param {Buffer} jpegBuffer
 * @param {string} deviceId 用于缓存
 * @param {number} frameAt 源帧时间戳
 * @returns {Promise<Buffer|null>}
 */
async function encodeListThumbnail(jpegBuffer, deviceId, frameAt) {
  if (!jpegBuffer || !jpegBuffer.length) return null;

  const cacheKey = String(deviceId);
  const cached = thumbCache.get(cacheKey);
  if (
    cached &&
    cached.frameAt === frameAt &&
    cached.sourceLen === jpegBuffer.length
  ) {
    return cached.buffer;
  }

  try {
    const buffer = await sharp(jpegBuffer)
      .rotate()
      .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
      .jpeg({ quality: THUMB_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    thumbCache.set(cacheKey, {
      buffer,
      frameAt: frameAt || Date.now(),
      sourceLen: jpegBuffer.length,
    });

    if (thumbCache.size > 120) {
      const oldest = thumbCache.keys().next().value;
      thumbCache.delete(oldest);
    }

    return buffer;
  } catch (err) {
    console.warn("[ThumbnailEncoder] 压缩失败", deviceId, err.message);
    return null;
  }
}

function clearThumbnailCache(deviceId) {
  if (deviceId) thumbCache.delete(String(deviceId));
  else thumbCache.clear();
}

module.exports = {
  encodeListThumbnail,
  clearThumbnailCache,
  THUMB_WIDTH,
};
