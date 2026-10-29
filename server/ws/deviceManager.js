const { load, save } = require("../store");
const usersStore = require("../usersStore");

// ==================== 1. 全局数据存储结构 ====================
// 使用 Map 存储所有已连接的安卓设备信息，键名(Key)为 deviceId，值(Value)为设备状态对象
const deviceClients = new Map();

// 设备备注持久化存储
const deviceRemarks = new Map();

// 设备分组持久化存储，值为字符串组名
const deviceGroups = new Map();

// 使用 Set 存储所有已连接的网页前端客户端，自动去重，便于批量广播画面
const webClients = new Map();

// 引入工具，用于在服务器控制台控制高频日志打印频率
let lastLogTime = 0;

const {
  packWebFrame,
  normalizeFramePayload,
  detectImageFormat,
  IMAGE_FORMAT,
} = require("./frameProtocol");

const lastControlAt = new Map();
const CONTROL_BOOST_MS = 5000;
const viewerLeaveLowTimers = new Map();
const VIEWER_LEAVE_LOW_DELAY_MS = 2500;
const deviceUploadPolicyApplied = new Map();
/** 控制页已打开的设备（不依赖 WS 查询串是否被反代剥掉） */
const activeControlDeviceIds = new Set();
/** 已向设备下发 startAudio 的设备 */
const audioCaptureActiveIds = new Set();
let uploadPolicyReconcileTimer = null;
const { encodeListThumbnail, clearThumbnailCache } = require("./thumbnailEncoder");

const MAX_DEVICES_WITH_FRAME = 60;
const MAX_FRAME_BYTES = 800000;
const THUMBNAIL_CACHE_MIN_MS = 25000;
const FRAME_BROADCAST_MIN_INTERVAL_MS = 50;
/** 控制页转发上限（约 30fps），只发最新帧，避免浏览器积压计数飙到上千 */
const WEB_CONTROL_BROADCAST_MS = 33;
/** 仅控制观众、无列表缩略图时尽量零延迟转发 */
const WEB_CONTROL_REALTIME_MS = 0;

function getWebControlBroadcastDelayMs(deviceId) {
  const id = String(deviceId);
  if (!hasWebViewer(id)) return WEB_CONTROL_BROADCAST_MS;
  if (hasListThumbnailSubscriber(id)) return WEB_CONTROL_BROADCAST_MS;
  return WEB_CONTROL_REALTIME_MS;
}

const lastThumbnailUpdateAt = new Map();
const pendingBroadcastFrame = new Map();
const broadcastFlushTimers = new Map();
/** 自适应画质：近期帧时间戳 */
const deviceFrameTimestamps = new Map();
const lastListThumbBroadcastAt = new Map();
const listThumbEncodeInflight = new Set();
const LIST_THUMB_MIN_INTERVAL_MS = 10000;
const MAX_LIST_THUMB_SOURCE_BYTES = 450000;
const MAX_LIST_THUMB_PAYLOAD_BYTES = 48000;

/** 单账号最多同时订阅缩略图的设备数（跨多个列表页标签页合计） */
const MAX_LIST_THUMB_DEVICES_PER_USER = 30;
/** 单账号列表缩略图 WS 出站：每秒最多条数 */
const MAX_LIST_THUMB_MSG_PER_USER_PER_SEC = 12;
const userThumbOutboundWindow = new Map();

const serverStats = {
  framesReceived: 0,
  framesBroadcast: 0,
  framesDroppedNoViewer: 0,
  framesCoalesced: 0,
  thumbnailSkipped: 0,
  framesDroppedOversize: 0,
  framesBinaryReceived: 0,
  framesBinaryBroadcast: 0,
  framesWebpReceived: 0,
  listThumbnailsSent: 0,
  listThumbnailsEncodeFailed: 0,
  listThumbSubsCapped: 0,
  listThumbOutboundDropped: 0,
  batchControls: 0,
};

loadDeviceRemarks();
loadDeviceGroups();
loadDeviceHistory();
try {
  const repaired = usersStore.repairSubDevicesFromRoot();
  if (repaired > 0) {
    console.log(`[DeviceManager] 启动时已修复 ${repaired} 条子账号设备归属`);
  }
} catch (err) {
  console.warn("[DeviceManager] 修复子账号设备归属失败", err.message);
}

// ==================== 2. 设备连接管理函数 ====================

/**
 * 添加或注册一个新连接的安卓设备
 * @param {string} deviceId 设备唯一ID
 * @param {WebSocket} ws 当前设备的 WebSocket 连接实例
 * @param {Object} info 安卓端上报的硬件环境参数
 */
function addDevice(deviceId, ws, info) {
  // 如果该设备之前连过，先获取其之前保留的数据（主要是首帧或上一帧画面）
  const existing = deviceClients.get(deviceId) || {};
  
  // 将新状态和连接写入 Map
  deviceClients.set(deviceId, {
    ws, // 保存连接实例，用于后续向该手机发送反向控制指令
    info: {
      deviceId,
      brand: info.brand || "",
      model: info.model || "",
      android: info.android || "",
      width: info.width || 0,
      height: info.height || 0,
      orientation: info.orientation ?? existing.info?.orientation ?? 0,
      remark: getDeviceRemark(deviceId),
      group: getDeviceGroup(deviceId),
      owner:
        info.owner != null && String(info.owner).trim() !== ""
          ? String(info.owner).trim()
          : (existing.info?.owner || ""),
      registeredAt: existing.info?.registeredAt || Date.now(), // 保留首次注册时间
    },
    lastFrame: existing.lastFrame || null,
    lastFrameBin: existing.lastFrameBin || null,
    lastFrameAt: existing.lastFrameAt || null,
    lastPing: Date.now(),                      // 录入心跳时间
  });
  
  // 持久化设备历史记录（包括设备信息但不包括实时连接状态）
  saveDeviceHistory();
  
  console.log(`[DeviceManager] 设备注册成功: ID=${deviceId}, 型号=${info.model || "未知"}, 所有者=${info.owner || "unknown"}`);
}

/**
 * 当安卓设备断开连接时，将其从管理列表中移除
 * @param {string} deviceId 设备唯一ID
 */
function removeDevice(deviceId) {
  deviceUploadPolicyApplied.delete(String(deviceId));
  const device = deviceClients.get(deviceId);
  if (!device) return;
  device.ws = null;  // 标记连接已断开
  device.lastPing = 0;  // 重置 lastPing，确保状态判断为离线
  clearDeviceBroadcastState(deviceId);
  console.log(`[DeviceManager] 设备连接已断开，保留离线记录: ID=${deviceId}`);
}

/**
 * 主账号删除设备：断开在线连接并从内存、历史、绑定关系中彻底移除
 */
function deleteDevicePermanently(deviceId) {
  const id = String(deviceId);
  if (!id) return false;

  const device = deviceClients.get(id);
  if (device?.ws) {
    try {
      const state = device.ws.readyState;
      if (state === 1 || state === 0) {
        device.ws.close(1000, "deleted by admin");
      }
    } catch (err) {
      console.warn(`[DeviceManager] 关闭设备 WS 失败 ${id}:`, err.message);
    }
  }

  clearDeviceBroadcastState(id);
  deviceUploadPolicyApplied.delete(id);
  activeControlDeviceIds.delete(id);
  const hadClient = deviceClients.delete(id);

  deviceRemarks.delete(id);
  saveDeviceRemarks();
  deviceGroups.delete(id);
  saveDeviceGroups();

  const history = load("deviceHistory");
  let hadHistory = false;
  if (Array.isArray(history)) {
    const filtered = history.filter((item) => item && String(item.deviceId) !== id);
    hadHistory = filtered.length !== history.length;
    if (hadHistory) save("deviceHistory", filtered);
  } else if (hadClient) {
    saveDeviceHistory();
  }

  usersStore.removeDeviceFromAllUsers(id);

  broadcastToWeb(id, { type: "device_deleted", deviceId: id });
  console.log(`[DeviceManager] 设备已删除: ${id}`);
  return hadClient || hadHistory || true;
}

function clearDeviceBroadcastState(deviceId) {
  const id = String(deviceId);
  const timer = broadcastFlushTimers.get(id);
  if (timer) clearTimeout(timer);
  broadcastFlushTimers.delete(id);
  pendingBroadcastFrame.delete(id);
  lastThumbnailUpdateAt.delete(id);
  deviceFrameTimestamps.delete(id);
  lastListThumbBroadcastAt.delete(id);
  listThumbEncodeInflight.delete(id);
  activeControlDeviceIds.delete(id);
  stopDeviceAudioCapture(id);
  deviceUploadPolicyApplied.delete(id);
  clearThumbnailCache(id);
}

function noteDeviceFrameReceived(deviceId) {
  updateDevicePing(deviceId);
  const now = Date.now();
  let list = deviceFrameTimestamps.get(deviceId) || [];
  list.push(now);
  const windowMs = 12000;
  list = list.filter((t) => now - t <= windowMs);
  deviceFrameTimestamps.set(deviceId, list);
}

/** WS 已连接且近期有心跳或上传帧 → 在线（列表/详情共用） */
const DEVICE_ONLINE_PING_MS = 90000;
const DEVICE_ONLINE_FRAME_MS = 90000;

function isDeviceRecordOnline(device) {
  if (!device) return false;
  if (!device.ws || device.ws.readyState !== 1) return false;
  const now = Date.now();
  if (device.lastPing > 0 && now - device.lastPing < DEVICE_ONLINE_PING_MS) {
    return true;
  }
  if (device.lastFrameAt > 0 && now - device.lastFrameAt < DEVICE_ONLINE_FRAME_MS) {
    return true;
  }
  return false;
}

/**
 * 根据是否有人观看、近期实际上传帧率建议采集档位
 * @returns {"low"|"medium"|"high"}
 */
function markDeviceControl(deviceId) {
  if (!deviceId) return;
  lastControlAt.set(String(deviceId), Date.now());
}

function isDeviceUnderActiveControl(deviceId) {
  const id = String(deviceId);
  return (
    activeControlDeviceIds.has(id) ||
    hasWebViewer(id) ||
    deviceUploadPolicyApplied.get(id) === "control"
  );
}

function startDeviceAudioCapture(deviceId) {
  const id = String(deviceId);
  if (!id) return false;
  audioCaptureActiveIds.add(id);
  return sendControl(id, { type: "startAudio" }, { skipPinControl: true });
}

function stopDeviceAudioCapture(deviceId) {
  const id = String(deviceId);
  if (!id || !audioCaptureActiveIds.has(id)) return false;
  audioCaptureActiveIds.delete(id);
  return sendControl(id, { type: "stopAudio" }, { skipPinControl: true });
}

/** 控制页接入：钉住 control 策略，禁止被列表缩略图 ping 打回 thumb */
function pinControlSession(deviceId, reason) {
  const id = String(deviceId);
  if (!id) return false;
  activeControlDeviceIds.add(id);
  const leaveTimer = viewerLeaveLowTimers.get(id);
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    viewerLeaveLowTimers.delete(id);
  }
  markDeviceControl(id);
  const prev = deviceUploadPolicyApplied.get(id);
  deviceUploadPolicyApplied.set(id, "control");
  let ok = false;
  if (prev !== "control") {
    ok = sendControl(id, { type: "resumeCapture" });
    console.log(
      `[DeviceManager] ${id} 钉住控制会话 (${reason}) viewers=${countControlViewers(id)} ok=${ok}`
    );
  }
  return ok;
}

function suggestCaptureProfile(deviceId) {
  const id = String(deviceId);
  if (isDeviceUnderActiveControl(id)) {
    return "high";
  }
  if (hasListThumbnailSubscriber(id)) {
    return "thumb";
  }
  return "idle";
}

function getDeviceUploadPolicy(deviceId) {
  const id = String(deviceId);
  if (hasWebViewer(id)) return "control";
  if (hasListThumbnailSubscriber(id)) return "thumb";
  return "none";
}

function applyDeviceUploadPolicy(deviceId, reason) {
  const id = String(deviceId);
  if (activeControlDeviceIds.has(id)) {
    if (deviceUploadPolicyApplied.get(id) !== "control") {
      pinControlSession(id, `活跃控制中(${reason})`);
    }
    return false;
  }
  const policy = getDeviceUploadPolicy(id);
  const prev = deviceUploadPolicyApplied.get(id);
  if (prev === policy) return false;

  if (prev === "control" && policy === "thumb") {
    console.warn(
      `[StreamDiag] 阻止 control→thumb 降档 device=${id} (${reason}) viewers=${countControlViewers(id)} thumbSubs=${hasListThumbnailSubscriber(id)}`
    );
    return false;
  }

  if (policy === "none") {
    const lastCtrl = lastControlAt.get(id);
    if (
      activeControlDeviceIds.has(id) ||
      (lastCtrl && Date.now() - lastCtrl < 120000)
    ) {
      console.warn(
        `[StreamDiag] 跳过 pauseCapture device=${id} (${reason}) 近期仍有控制活动`
      );
      return false;
    }
  }

  deviceUploadPolicyApplied.set(id, policy);
  let ok = false;

  switch (policy) {
    case "control":
      lastControlAt.delete(id);
      // 仅恢复采集；编码(WebP/H.264)与 high 档位由网页 codec-client / control.js 下发，
      // 避免在 preferWebp 之前先发 high 把手机切到 H.264（HTTP 直连 IP 会卡死）
      ok = sendControl(id, { type: "resumeCapture" });
      if (ok) {
        console.log(`[DeviceManager] ${id} 上传策略→控制 (${reason})`);
      }
      break;
    case "thumb":
      if (isDeviceUnderActiveControl(id)) {
        console.warn(
          `[StreamDiag] 跳过 thumb 策略 device=${id} (${reason}) 控制页活跃中`
        );
        return false;
      }
      lastControlAt.delete(id);
      ok = sendControl(id, { type: "resumeCapture" });
      ok =
        sendControl(
          id,
          { type: "setCaptureProfile", profile: "thumb" },
          { skipPinControl: true }
        ) ||
        sendControl(id, { type: "setCaptureSpeed", speed: "thumb" }, { skipPinControl: true }) ||
        ok;
      if (ok) {
        console.log(`[DeviceManager] ${id} 上传策略→列表缩略图 (${reason})`);
      }
      break;
    case "none":
    default:
      lastControlAt.delete(id);
      ok = sendControl(id, { type: "resumeCapture" }, { skipPinControl: true });
      ok =
        sendControl(id, { type: "setCaptureSpeed", speed: "low" }, { skipPinControl: true }) ||
        ok;
      if (ok) {
        console.log(`[DeviceManager] ${id} 上传策略→低刷 (${reason})`);
      }
      break;
  }
  return ok;
}

function scheduleDeviceUploadPolicyReconcile(delayMs = 400) {
  if (uploadPolicyReconcileTimer) {
    clearTimeout(uploadPolicyReconcileTimer);
  }
  uploadPolicyReconcileTimer = setTimeout(() => {
    uploadPolicyReconcileTimer = null;
    reconcileAllDeviceUploadPolicies("批量对齐");
  }, delayMs);
}

function reconcileAllDeviceUploadPolicies(reason) {
  for (const [deviceId, device] of deviceClients) {
    if (!device.ws || device.ws.readyState !== 1) continue;
    applyDeviceUploadPolicy(deviceId, reason);
  }
}

function evictOldFramesIfNeeded() {
  const entries = [...deviceClients.entries()].filter(([, d]) => d.lastFrame);
  if (entries.length <= MAX_DEVICES_WITH_FRAME) return;
  entries.sort((a, b) => (a[1].lastFrameAt || 0) - (b[1].lastFrameAt || 0));
  const excess = entries.length - MAX_DEVICES_WITH_FRAME;
  for (let i = 0; i < excess; i++) {
    entries[i][1].lastFrame = null;
    entries[i][1].lastFrameBin = null;
  }
}

// ==================== 3. 设备状态与画面更新 ====================

/**
 * 接收安卓端高频上传的屏幕帧图片，并缓存在内存中
 * @param {string} deviceId 设备唯一ID
 * @param {string|Buffer} image 手机端传来的图片数据
 */
function updateDeviceFrame(deviceId, image, formatHint) {
  const device = deviceClients.get(deviceId);
  if (!device || image == null) return;

  serverStats.framesReceived++;

  const bin = normalizeFramePayload(image);
  if (!bin || !bin.length) return;
  if (bin.length > MAX_FRAME_BYTES) {
    serverStats.framesDroppedOversize++;
    return;
  }

  const frameFormat =
    typeof formatHint === "number" ? formatHint : detectImageFormat(bin);
  device.lastFrameFormat = frameFormat;

  if (Buffer.isBuffer(image)) {
    serverStats.framesBinaryReceived++;
  }
  if (frameFormat === IMAGE_FORMAT.WEBP) {
    serverStats.framesWebpReceived = (serverStats.framesWebpReceived || 0) + 1;
  }

  // 无实时观众时降低缩略图缓存频率（列表 HTTP 仍可拉取，但减少内存写入）
  if (!hasWebViewer(deviceId)) {
    const lastThumb = lastThumbnailUpdateAt.get(deviceId) || 0;
    if (Date.now() - lastThumb < THUMBNAIL_CACHE_MIN_MS) {
      serverStats.thumbnailSkipped++;
      return;
    }
    lastThumbnailUpdateAt.set(deviceId, Date.now());
  }

  device.lastFrameBin = bin;
  device.lastFrame = null;
  device.lastFrameAt = Date.now();
  evictOldFramesIfNeeded();

  const now = Date.now();
  if (now - lastLogTime > 3000) {
    lastLogTime = now;
  }

  maybeBroadcastListThumbnail(deviceId);
}

function isListSubscribeMode(deviceId) {
  return !deviceId || deviceId === "ALL";
}

function getDeviceOwnerMap() {
  const map = new Map();
  for (const [deviceId, device] of deviceClients.entries()) {
    const owner = device.info?.owner;
    if (owner) map.set(String(deviceId), String(owner).trim());
  }
  return map;
}

function resolveDeviceOwnerName(deviceId) {
  const id = String(deviceId);
  const device = deviceClients.get(id);
  if (device?.info?.owner) return String(device.info.owner).trim();
  const fromHistory = usersStore.getOwnerMapFromHistory().get(id);
  return fromHistory || "";
}

function listDevicesForUser(user) {
  const all = getDevices();
  if (!user) return [];
  if (user.role === "root" || user.isAdminToken) return all;
  if (!user.id || !user.username) return [];

  usersStore.claimDevicesForSubUser(user);

  const uname = String(user.username).trim();
  const myDeviceIds = new Set(
    (usersStore.getUserDevices(user.id) || []).map((id) => String(id))
  );

  return all.filter((d) => {
    const id = String(d.deviceId);
    if (myDeviceIds.has(id)) return true;
    if (resolveDeviceOwnerName(id) === uname) {
      usersStore.bindDevice(user.id, id);
      myDeviceIds.add(id);
      return true;
    }
    return false;
  });
}

function canUserViewDevice(user, deviceId) {
  if (!user) return false;
  if (user.role === "root" || user.isAdminToken) return true;
  if (!user.id || !user.username) return false;

  const id = String(deviceId);
  const myDevices = (usersStore.getUserDevices(user.id) || []).map(String);
  if (myDevices.includes(id)) return true;

  const owner = resolveDeviceOwnerName(id);
  if (owner && owner === String(user.username).trim()) {
    usersStore.bindDevice(user.id, id);
    return true;
  }
  return false;
}

function hasListWebClients() {
  for (const [, info] of webClients) {
    if (info.subscribeMode === "list") return true;
  }
  return false;
}

function hasListThumbnailSubscriber(deviceId) {
  const id = String(deviceId);
  for (const [, info] of webClients) {
    if (info.subscribeMode !== "list") continue;
    if (!info.thumbDeviceIds || info.thumbDeviceIds.size === 0) continue;
    if (info.thumbDeviceIds.has(id)) return true;
  }
  return false;
}

function getUserRateLimitKey(user) {
  if (!user) return "anonymous";
  if (user.isAdminToken) return "admin-token";
  return String(user.id || user.username || "anonymous");
}

/** 子账号被新页面顶替时使用的 WebSocket 关闭码 */
const SUB_SESSION_REPLACED_CLOSE_CODE = 4001;

function disconnectSubUserWebClient(otherWs, message) {
  try {
    if (otherWs.readyState === 1) {
      otherWs.send(
        JSON.stringify({
          type: "session_replaced",
          message:
            message || "该子账号已在其他页面登录，当前连接已断开",
        })
      );
    }
  } catch (_) {}
  try {
    otherWs.close(SUB_SESSION_REPLACED_CLOSE_CODE, "session replaced");
  } catch (_) {}
}

/** 子账号仅允许一个网页端 WebSocket（避免多开控制页占用带宽） */
function enforceSubUserSingleWebSession(ws, user) {
  if (!user || user.role !== "sub" || user.isAdminToken) return;
  const userKey = getUserRateLimitKey(user);
  for (const [otherWs, otherInfo] of webClients) {
    if (otherWs === ws) continue;
    if (getUserRateLimitKey(otherInfo.user) !== userKey) continue;
    console.log(
      `[DeviceManager] 子账号单会话：断开旧连接 user=${user.username} mode=${otherInfo.subscribeMode}`
    );
    disconnectSubUserWebClient(
      otherWs,
      "该子账号已在其他页面登录，当前连接已断开"
    );
  }
}

function countUserThumbSubscriptions(userKey, excludeWs) {
  const ids = new Set();
  for (const [otherWs, otherInfo] of webClients) {
    if (excludeWs && otherWs === excludeWs) continue;
    if (otherInfo.subscribeMode !== "list") continue;
    if (getUserRateLimitKey(otherInfo.user) !== userKey) continue;
    otherInfo.thumbDeviceIds?.forEach((id) => ids.add(id));
  }
  return ids;
}

function canSendListThumbToUser(user) {
  const key = getUserRateLimitKey(user);
  const now = Date.now();
  let entry = userThumbOutboundWindow.get(key);
  if (!entry || now - entry.windowStart >= 1000) {
    entry = { count: 0, windowStart: now };
    userThumbOutboundWindow.set(key, entry);
  }
  if (entry.count >= MAX_LIST_THUMB_MSG_PER_USER_PER_SEC) {
    serverStats.listThumbOutboundDropped++;
    return false;
  }
  entry.count++;
  return true;
}

function maybeBroadcastListThumbnail(deviceId) {
  if (!hasListWebClients()) return;
  if (!hasListThumbnailSubscriber(deviceId)) return;

  const now = Date.now();
  const lastAt = lastListThumbBroadcastAt.get(deviceId) || 0;
  if (now - lastAt < LIST_THUMB_MIN_INTERVAL_MS) return;

  const device = deviceClients.get(deviceId);
  const bin = device?.lastFrameBin;
  if (!bin || !bin.length || bin.length > MAX_LIST_THUMB_SOURCE_BYTES) return;

  const id = String(deviceId);
  if (listThumbEncodeInflight.has(id)) return;
  listThumbEncodeInflight.add(id);

  const frameAt = device.lastFrameAt || now;
  encodeListThumbnail(bin, id, frameAt)
    .then((thumbBin) => {
      listThumbEncodeInflight.delete(id);
      if (!thumbBin || !thumbBin.length) {
        serverStats.listThumbnailsEncodeFailed++;
        return;
      }
      if (thumbBin.length > MAX_LIST_THUMB_PAYLOAD_BYTES) return;
      if (!hasListThumbnailSubscriber(id)) return;

      const sendAt = Date.now();
      if (sendAt - (lastListThumbBroadcastAt.get(id) || 0) < LIST_THUMB_MIN_INTERVAL_MS) {
        return;
      }
      lastListThumbBroadcastAt.set(id, sendAt);
      serverStats.listThumbnailsSent++;
      broadcastListThumbnail(id, thumbBin.toString("base64"), frameAt);
    })
    .catch(() => {
      listThumbEncodeInflight.delete(id);
      serverStats.listThumbnailsEncodeFailed++;
    });
}

function broadcastListThumbnail(deviceId, imageBase64, lastFrameAt) {
  const payload = JSON.stringify({
    type: "device_thumbnail",
    deviceId: String(deviceId),
    image: imageBase64,
    lastFrameAt: lastFrameAt || Date.now(),
  });

  for (const [ws, info] of webClients) {
    if (ws.readyState !== 1 || info.subscribeMode !== "list") continue;
    if (info.thumbDeviceIds?.size > 0 && !info.thumbDeviceIds.has(String(deviceId))) {
      continue;
    }
    if (!canUserViewDevice(info.user, deviceId)) continue;
    if (!canSendListThumbToUser(info.user)) continue;
    try {
      ws.send(payload);
    } catch (err) {
      console.error("[DeviceManager] 列表缩略图推送失败", err.message);
    }
  }
}

/**
 * 设置列表页缩略图订阅（按账号总订阅数上限）
 * @returns {{ accepted: string[], capped: boolean, maxPerUser: number }}
 */
function setWebClientThumbSubscription(ws, deviceIds) {
  const info = webClients.get(ws);
  const empty = {
    accepted: [],
    capped: false,
    maxPerUser: MAX_LIST_THUMB_DEVICES_PER_USER,
  };
  if (!info || info.subscribeMode !== "list") return empty;

  const userKey = getUserRateLimitKey(info.user);
  const requested = (Array.isArray(deviceIds) ? deviceIds : [])
    .map((id) => String(id))
    .filter(Boolean)
    .slice(0, 24);

  const usedByOthers = countUserThumbSubscriptions(userKey, ws);
  const accepted = [];
  let capped = false;

  for (const id of requested) {
    if (accepted.length + usedByOthers.size >= MAX_LIST_THUMB_DEVICES_PER_USER) {
      if (!usedByOthers.has(id) && !accepted.includes(id)) capped = true;
      continue;
    }
    if (usedByOthers.has(id)) {
      accepted.push(id);
      continue;
    }
    accepted.push(id);
    usedByOthers.add(id);
  }

  if (capped) serverStats.listThumbSubsCapped++;

  info.thumbDeviceIds = new Set(accepted);
  scheduleDeviceUploadPolicyReconcile(350);
  return { accepted, capped, maxPerUser: MAX_LIST_THUMB_DEVICES_PER_USER };
}

/**
 * 防抖广播：节流窗口结束后推送最新一帧，避免控制页卡在旧画面
 */
function broadcastBinaryFrame(deviceId, imageBuffer, format) {
  const fmt =
    typeof format === "number" ? format : detectImageFormat(imageBuffer);
  const packet = packWebFrame(deviceId, imageBuffer, fmt);
  for (const [ws, info] of webClients) {
    if (ws.readyState !== 1) continue;
    if (String(info.deviceId) !== String(deviceId)) continue;
    try {
      ws.send(packet, { binary: true });
    } catch (err) {
      console.error("[DeviceManager] 二进制广播失败", err.message);
    }
  }
}

/** 音频 PCM 直通转发（不节流，控制页专用） */
function broadcastAudioPacket(deviceId, audioBuffer) {
  const id = String(deviceId);
  if (!hasWebViewer(id) || !audioBuffer || !audioBuffer.length) return;
  for (const [ws, info] of webClients) {
    if (ws.readyState !== 1) continue;
    if (info.subscribeMode !== "control") continue;
    if (String(info.deviceId) !== id) continue;
    try {
      ws.send(audioBuffer, { binary: true });
    } catch (err) {
      console.error("[DeviceManager] 音频广播失败", err.message);
    }
  }
}

/**
 * 设备 JSON Base64 帧（type=frame）→ 缓存 + 转发给控制页
 */
function broadcastJsonDeviceFrame(deviceId, rawImage) {
  const id = String(deviceId);
  if (!rawImage) return false;

  const hasViewer = hasWebViewer(id);
  const hasThumbSub = hasListThumbnailSubscriber(id);
  if (!hasViewer && !hasThumbSub) {
    serverStats.framesDroppedNoViewer++;
    return false;
  }

  const bin = normalizeFramePayload(rawImage);
  if (bin && bin.length) {
    if (bin.length > MAX_FRAME_BYTES) {
      serverStats.framesDroppedOversize++;
    } else {
      noteDeviceFrameReceived(id);
      updateDeviceFrame(id, bin, IMAGE_FORMAT.JPEG);
    }
  }

  if (!hasViewer) return true;

  const imageStr =
    typeof rawImage === "string"
      ? rawImage.replace(/[\r\n\s]/g, "")
      : bin
        ? bin.toString("base64")
        : "";
  if (!imageStr) return false;

  serverStats.framesBroadcast++;
  broadcastToWeb(id, {
    type: "device_frame",
    deviceId: id,
    image: imageStr,
  });
  return true;
}

function queueDeviceFrameBroadcast(deviceId, imagePayload, formatHint) {
  const bin = normalizeFramePayload(imagePayload);
  if (!bin) return;

  const format =
    typeof formatHint === "number" ? formatHint : detectImageFormat(bin);

  const isH264 =
    format === IMAGE_FORMAT.H264 || format === IMAGE_FORMAT.H264_TIMESTAMPED;

  const hasViewer = hasWebViewer(deviceId);
  const hasThumbSub = hasListThumbnailSubscriber(deviceId);

  if (!hasViewer && !hasThumbSub) {
    serverStats.framesDroppedNoViewer++;
    return;
  }

  if (!isH264) {
    noteDeviceFrameReceived(deviceId);
    updateDeviceFrame(deviceId, bin, format);
  }

  if (!hasViewer) {
    return;
  }

  // 零延迟直发：控制页无列表缩略图订阅时跳过 setTimeout，直接转发最新帧
  if (!hasThumbSub) {
    serverStats.framesBroadcast++;
    serverStats.framesBinaryBroadcast++;
    broadcastBinaryFrame(deviceId, bin, format);
    return;
  }

  // 有列表缩略图订阅者时保留节流（避免列表页带宽爆炸）
  pendingBroadcastFrame.set(deviceId, { bin, format });
  if (broadcastFlushTimers.has(deviceId)) {
    serverStats.framesCoalesced++;
    return;
  }

  const flushToWeb = (delayMs) => {
    const timer = setTimeout(() => {
      broadcastFlushTimers.delete(deviceId);
      const pending = pendingBroadcastFrame.get(deviceId);
      if (!pending) return;
      pendingBroadcastFrame.delete(deviceId);
      serverStats.framesBroadcast++;
      serverStats.framesBinaryBroadcast++;
      broadcastBinaryFrame(deviceId, pending.bin, pending.format);
      if (pendingBroadcastFrame.has(deviceId)) {
        flushToWeb(getWebControlBroadcastDelayMs(deviceId));
      }
    }, delayMs);
    broadcastFlushTimers.set(deviceId, timer);
  };

  flushToWeb(0);
}

function getServerStats() {
  return {
    ...serverStats,
    onlineDevices: [...deviceClients.values()].filter(
      (d) => d.ws && d.ws.readyState === 1
    ).length,
    devicesWithFrame: [...deviceClients.values()].filter((d) => d.lastFrame).length,
    webViewers: webClients.size,
  };
}

/** 将所有累计计数器减半（清理一半） */
function halveServerStats() {
  for (const key of Object.keys(serverStats)) {
    serverStats[key] = Math.floor(serverStats[key] / 2);
  }
  return getServerStats();
}

/**
 * 刷新手机的心跳（Ping）时间，确保其在线状态
 * @param {string} deviceId 设备唯一ID
 */
function updateDevicePing(deviceId) {
  const device = deviceClients.get(deviceId);
  if (!device) return;
  device.lastPing = Date.now();
}

// ==================== 4. 数据查询接口（对外暴露给 API 使用） ====================

/**
 * 获取当前所有已连接设备的简要列表信息（屏蔽大体积图片源码，用于设备列表页展示）
 * @returns {Array} 设备信息数组
 */
function getDevices() {
  return [...deviceClients.values()].map((device) => ({
    deviceId: device.info.deviceId,
    brand: device.info.brand,
    model: device.info.model,
    android: device.info.android,
    width: device.info.width,
    height: device.info.height,
    orientation: device.info.orientation || 0,
    owner: device.info.owner || "",
    remark: getDeviceRemark(device.info.deviceId),
    group: getDeviceGroup(device.info.deviceId),
    online: isDeviceRecordOnline(device),
    lastFrameAt: device.lastFrameAt,
    lastPing: device.lastPing,
    hasFrame: !!(device.lastFrame || device.lastFrameBin),
  }));
}

/**
 * 更新设备屏幕尺寸（旋转后）
 * @returns {Object|null} 更新后的设备摘要
 */
function updateDeviceDisplay(deviceId, payload) {
  const device = deviceClients.get(deviceId);
  if (!device) return null;

  if (payload.width) device.info.width = Number(payload.width);
  if (payload.height) device.info.height = Number(payload.height);
  if (payload.orientation !== undefined) {
    device.info.orientation = Number(payload.orientation);
  }

  saveDeviceHistory();
  return getDevice(deviceId);
}

/**
 * 获取单台设备的完整详细数据（包含最后一帧画面，用于单个控制页初始化）
 * @param {string} deviceId 设备唯一ID
 * @returns {Object|null}
 */
function getDevice(deviceId) {
  const device = deviceClients.get(deviceId);
  if (!device) return null;
  
  const online = isDeviceRecordOnline(device);

  return {
    deviceId: device.info.deviceId,
    brand: device.info.brand,
    model: device.info.model,
    android: device.info.android,
    width: device.info.width,
    height: device.info.height,
    orientation: device.info.orientation || 0,
    owner: device.info.owner || "",
    remark: getDeviceRemark(device.info.deviceId),
    group: getDeviceGroup(device.info.deviceId),
    online: online,
    lastFrameAt: device.lastFrameAt,
    lastPing: device.lastPing,
    lastFrame: device.lastFrame,
  };
}

/**
 * 纯粹提取某台设备的画面（给独立的 HTTP 图片流接口使用）
 * @param {string} deviceId 设备唯一ID
 * @returns {string|Buffer|null}
 */
function getDeviceFrame(deviceId) {
  const device = deviceClients.get(deviceId);
  if (!device) return null;
  if (device.lastFrame) return device.lastFrame;
  if (device.lastFrameBin && device.lastFrameBin.length) {
    return device.lastFrameBin.toString("base64");
  }
  return null;
}

/**
 * 加载设备备注到内存
 */
function loadDeviceRemarks() {
  const list = load("deviceRemarks");
  if (!Array.isArray(list)) return;
  list.forEach((item) => {
    if (item && item.deviceId) {
      deviceRemarks.set(String(item.deviceId), item.remark || "");
    }
  });
}

/**
 * 保存设备备注到本地文件
 */
function saveDeviceRemarks() {
  const list = Array.from(deviceRemarks.entries()).map(([deviceId, remark]) => ({ deviceId, remark }));
  save("deviceRemarks", list);
}

/**
 * 获取设备备注
 * @param {string} deviceId
 * @returns {string}
 */
function getDeviceRemark(deviceId) {
  return deviceRemarks.get(deviceId) || "";
}

function getDeviceGroup(deviceId) {
  return deviceGroups.get(deviceId) || "";
}

function loadDeviceGroups() {
  const list = load("deviceGroups");
  if (!Array.isArray(list)) return;
  list.forEach((item) => {
    if (item && item.deviceId) {
      deviceGroups.set(String(item.deviceId), item.group || "");
    }
  });
}

function saveDeviceGroups() {
  const list = Array.from(deviceGroups.entries()).map(([deviceId, group]) => ({ deviceId, group }));
  save("deviceGroups", list);
}

/**
 * 设置设备备注，并持久化保存
 * @param {string} deviceId
 * @param {string} remark
 * @returns {string}
 */
function setDeviceRemark(deviceId, remark) {
  const text = remark ? String(remark).trim() : "";
  if (text) {
    deviceRemarks.set(deviceId, text);
  } else {
    deviceRemarks.delete(deviceId);
  }
  saveDeviceRemarks();
  const device = deviceClients.get(deviceId);
  if (device) {
    device.info.remark = text;
  }
  return text;
}

/**
 * 设置设备分组，并持久化保存
 * @param {string} deviceId
 * @param {string} group
 * @returns {string}
 */
function setDeviceGroup(deviceId, group) {
  const groupName = group ? String(group).trim() : "";
  if (groupName) {
    deviceGroups.set(deviceId, groupName);
  } else {
    deviceGroups.delete(deviceId);
  }
  saveDeviceGroups();
  const device = deviceClients.get(deviceId);
  if (device) {
    device.info.group = groupName;
  }
  return groupName;
}

function getGroupList() {
  const groups = Array.from(new Set(Array.from(deviceGroups.values()).filter((name) => name && name.length > 0)));
  return groups.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/**
 * 快速检查某个设备 ID 是否在连接列表中
 * @param {string} deviceId 设备唯一ID
 * @returns {boolean}
 */
function hasDevice(deviceId) {
  const device = deviceClients.get(deviceId);
  return !!device && device.ws && device.ws.readyState === 1;
}

// ==================== 5. 逆向控制与群发广播 ====================

/**
 * 后端向目标手机发送无障碍控制指令（点击、滑动、按键等）
 * @param {string} deviceId 设备唯一ID
 * @param {Object} payload 具体的控制动作和参数
 * @returns {boolean} 是否发送成功
 */
const CAPTURE_PIN_COMMAND_TYPES = new Set([
  "setCaptureSpeed",
  "setCaptureProfile",
  "resumeCapture",
  "preferWebp",
  "forceWebp",
  "allowH264",
  "preferH264",
]);

function shouldPinControlOnCommand(payload, options = {}) {
  if (options.skipPinControl) return false;
  const cmdType = payload && payload.type;
  if (!CAPTURE_PIN_COMMAND_TYPES.has(cmdType)) return false;
  if (cmdType === "setCaptureProfile" || cmdType === "setCaptureSpeed") {
    const tier = String(
      payload.profile || payload.speed || ""
    ).toLowerCase();
    if (tier === "thumb" || tier === "low" || tier === "idle") {
      return false;
    }
  }
  return true;
}

function sendControl(deviceId, payload, options = {}) {
  const id = String(deviceId);
  const device = deviceClients.get(id);
  const cmdType = payload && payload.type;
  if (cmdType === "startAudio") {
    audioCaptureActiveIds.add(id);
  } else if (cmdType === "stopAudio") {
    audioCaptureActiveIds.delete(id);
  }
  if (shouldPinControlOnCommand(payload, options)) {
    pinControlSession(id, `cmd:${cmdType}`);
  }
  if (
    cmdType === "click" ||
    cmdType === "swipe" ||
    cmdType === "longClick" ||
    cmdType === "press" ||
    cmdType === "input"
  ) {
    markDeviceControl(id);
  }

  // 检查设备连接是否存在，且 WebSocket 通道状态必须为 OPEN (1)
  if (!device || !device.ws || device.ws.readyState !== 1) {
    console.warn(`[DeviceManager] 发送控制失败，设备 ${deviceId} 离线或连接未准备就绪`);
    return false;
  }

  try {
    console.log(`[DeviceManager] 正在向设备 ${deviceId} 发送控制指令:`, payload);
    device.ws.send(JSON.stringify({
      type: "control",
      command: payload,
    }));

    return true;
  } catch (error) {
    console.error(`[DeviceManager] 发送控制指令发生异常，目标: ${deviceId}:`, error.message);
    return false;
  }
}

/**
 * 批量向多个设备发送同一个控制指令（群控功能）
 * @param {Array<string>} deviceIds 设备 ID 列表
 * @param {Object} payload 具体的控制动作和参数
 * @returns {Object} {success: 成功数量, failed: 失败数量, failedIds: 失败的设备ID列表}
 */
function sendBatchControl(deviceIds, payload) {
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return { success: 0, failed: 0, failedIds: [] };
  }

  serverStats.batchControls++;

  const envelope = JSON.stringify({
    type: "control",
    command: payload,
  });

  let successCount = 0;
  const failedIds = [];

  const cmdType = payload && payload.type;
  const isInteractive =
    cmdType === "click" ||
    cmdType === "swipe" ||
    cmdType === "longClick" ||
    cmdType === "press" ||
    cmdType === "input";

  for (const deviceId of deviceIds) {
    const device = deviceClients.get(deviceId);
    if (device && device.ws && device.ws.readyState === 1) {
      try {
        if (isInteractive) markDeviceControl(deviceId);
        device.ws.send(envelope);
        successCount++;
      } catch (error) {
        console.error(`[DeviceManager] 批量控制发送失败 ${deviceId}:`, error.message);
        failedIds.push(deviceId);
      }
    } else {
      failedIds.push(deviceId);
    }
  }

  const failedCount = failedIds.length;
  console.log(`[DeviceManager] 批量控制完成：成功 ${successCount}/${deviceIds.length}，失败 ${failedCount} 台设备`);

  return { success: successCount, failed: failedCount, failedIds };
}

/**
 * 核心广播函数：将手机上报的数据（如画面帧、注册信息），实时分发给当前打开了浏览器网页的所有用户
 * @param {Object} data 需要推送给前端的 JSON 数据对象
 */
/**
 * 是否有网页控制端正在订阅该设备的实时画面
 * @param {string} deviceId
 * @returns {boolean}
 */
function countControlViewers(deviceId) {
  const id = String(deviceId);
  let n = 0;
  for (const [ws, info] of webClients) {
    if (ws.readyState !== 1) continue;
    if (info.subscribeMode !== "control") continue;
    if (info.deviceId && String(info.deviceId) === id) n++;
  }
  return n;
}

function hasWebViewer(deviceId) {
  return countControlViewers(deviceId) > 0;
}

function getDeviceUploadPolicyApplied(deviceId) {
  return deviceUploadPolicyApplied.get(String(deviceId));
}

function broadcastDevicePing(deviceId, serverProfile, extra = {}) {
  const id = String(deviceId);
  const payloadBase = {
    type: "device_ping",
    deviceId: id,
    timestamp: Date.now(),
    ...extra,
  };
  for (const [ws, info] of webClients) {
    if (ws.readyState !== 1) continue;
    if (
      info.subscribeMode === "control" &&
      info.deviceId &&
      String(info.deviceId) !== id
    ) {
      continue;
    }
    let captureProfile = serverProfile;
    if (
      info.subscribeMode === "control" &&
      info.deviceId &&
      String(info.deviceId) === id
    ) {
      captureProfile = "high";
    }
    try {
      ws.send(
        JSON.stringify({
          ...payloadBase,
          captureProfile,
        })
      );
    } catch (err) {
      console.error("[DeviceManager] device_ping 广播失败", err.message);
    }
  }
}

function broadcastToWeb(deviceId, data) {

  if (data && data.type === "device_ping") {
    broadcastDevicePing(deviceId, data.captureProfile || "idle");
    return;
  }

  const payload =
    JSON.stringify(data);

  for (const [ws, info] of webClients) {

    if (ws.readyState !== 1)
      continue;

    if (data.type === "device_frame") {
      if (String(info.deviceId) !== String(deviceId)) {
        continue;
      }
      if (!ws._frameDeliveryLogged) {
        ws._frameDeliveryLogged = true;
        console.log(`[Broadcast] device_frame 首次投递给网页客户端 deviceId=${deviceId} info.deviceId=${info.deviceId}`);
      }
    } else {
      if (data.deviceId && info.user && !canUserViewDevice(info.user, data.deviceId)) {
        continue;
      }
    }

    try {

      ws.send(payload);

    } catch (err) {

      console.error(
        "[DeviceManager] 广播失败",
        err.message
      );
    }
  }
}


/**
 * 注册一个新打开的群控前端网页客户端
 * @param {WebSocket} ws 网页端的 WebSocket 连接实例
 */
function registerWebClient(ws, deviceId, user) {
  enforceSubUserSingleWebSession(ws, user);
  const listMode = isListSubscribeMode(deviceId);
  webClients.set(ws, {
    deviceId: listMode ? null : deviceId,
    user: user || null,
    subscribeMode: listMode ? "list" : "control",
    thumbDeviceIds: new Set(),
  });

  if (!listMode && deviceId) {
    pinControlSession(String(deviceId), "控制页接入");
  } else {
    scheduleDeviceUploadPolicyReconcile(200);
  }

  console.log(
    `[DeviceManager] 网页端接入 mode=${listMode ? "list" : "control"} deviceId=${deviceId || "ALL"} user=${user ? user.username : "unknown"}`
  );
}
/**
 * 当用户关闭群控网页、刷新页面或断开连接时，将其移除广播队列
 * @param {WebSocket} ws 网页端的 WebSocket 连接实例
 */
function notifyDeviceNoControlViewer(deviceId) {
  const id = String(deviceId);
  if (!id) return;

  const prev = viewerLeaveLowTimers.get(id);
  if (prev) clearTimeout(prev);

  // 勿在 WS 刚断开时立刻 pauseCapture（重连/刷新会误停采集导致控制页无画面）
  viewerLeaveLowTimers.set(
    id,
    setTimeout(() => {
      viewerLeaveLowTimers.delete(id);
      if (!hasWebViewer(id)) {
        activeControlDeviceIds.delete(id);
        stopDeviceAudioCapture(id);
        applyDeviceUploadPolicy(id, "控制观众离开");
      }
    }, VIEWER_LEAVE_LOW_DELAY_MS)
  );
}

/**
 * 控制页 WS 建连后补登记（反代未转发 ?deviceId 时）
 */
function bindWebClientControlSession(ws, deviceId, reason) {
  const id = String(deviceId || "");
  if (!id || !ws) return false;
  const info = webClients.get(ws);
  if (!info) return false;
  info.subscribeMode = "control";
  info.deviceId = id;
  return pinControlSession(id, reason || "subscribe_control");
}

function removeWebClient(ws) {
  const info = webClients.get(ws);
  webClients.delete(ws);

  if (info && info.subscribeMode === "control" && info.deviceId) {
    notifyDeviceNoControlViewer(info.deviceId);
  } else {
    scheduleDeviceUploadPolicyReconcile(300);
  }

  console.log(`[DeviceManager] 网页控制端断开`);
}

// ==================== 5.5 设备历史记录持久化（用于重启后恢复设备列表） ====================

/**
 * 加载设备历史记录（不包括实时连接状态，只保留设备元信息）
 */
function loadDeviceHistory() {
  const list = load("deviceHistory");
  if (!Array.isArray(list)) return;
  list.forEach((item) => {
    if (item && item.deviceId) {
      // 创建离线的设备记录，等待重新连接时更新
      deviceClients.set(item.deviceId, {
        ws: null,
        info: {
          deviceId: item.deviceId,
          brand: item.brand || "",
          model: item.model || "",
          android: item.android || "",
          width: item.width || 0,
          height: item.height || 0,
          remark: getDeviceRemark(item.deviceId),
          group: getDeviceGroup(item.deviceId),
          owner: item.owner || "",
          registeredAt: item.registeredAt || Date.now(),
        },
        lastFrame: null,
        lastFrameAt: null,
        lastPing: 0,
      });
    }
  });
  console.log(`[DeviceManager] 已加载 ${list.length} 个设备历史记录`);
}

/**
 * 保存设备历史记录到本地文件（仅保留元信息，不保留实时连接状态）
 */
function saveDeviceHistory() {
  const list = Array.from(deviceClients.values()).map((device) => ({
    deviceId: device.info.deviceId,
    brand: device.info.brand,
    model: device.info.model,
    android: device.info.android,
    width: device.info.width,
    height: device.info.height,
    owner: device.info.owner,
    registeredAt: device.info.registeredAt,
    lastPing: device.lastPing,
  }));
  save("deviceHistory", list);
}

// ==================== 6. 模块导出 ====================
module.exports = {
  addDevice,
  removeDevice,
  deleteDevicePermanently,
  updateDeviceFrame,
  updateDeviceDisplay,
  suggestCaptureProfile,
  setWebClientThumbSubscription,
  broadcastJsonDeviceFrame,
  queueDeviceFrameBroadcast,
  clearDeviceBroadcastState,
  getServerStats,
  halveServerStats,
  updateDevicePing,
  getDevices,
  listDevicesForUser,
  canUserViewDevice,
  getDevice,
  getDeviceFrame,
  hasDevice,
  setDeviceRemark,
  setDeviceGroup,
  getGroupList,
  sendControl,
  sendBatchControl,
  broadcastToWeb,
  broadcastAudioPacket,
  broadcastDevicePing,
  hasWebViewer,
  countControlViewers,
  getDeviceUploadPolicyApplied,
  isDeviceUnderActiveControl,
  pinControlSession,
  bindWebClientControlSession,
  registerWebClient,
  removeWebClient,
  applyDeviceUploadPolicy,
  reconcileAllDeviceUploadPolicies,
  loadDeviceHistory,
  saveDeviceHistory,
};

// =============== 额外导出：发送原始消息（不包裹为 control） ===============
/**
 * 直接向单台设备发送任意 JSON 消息（不会被包裹为 control）
 * @param {string} deviceId
 * @param {Object} payload
 * @returns {boolean}
 */
function sendRaw(deviceId, payload) {
  const device = deviceClients.get(deviceId);
  if (!device || !device.ws || device.ws.readyState !== 1) {
    console.warn(`[DeviceManager] sendRaw 失败，设备 ${deviceId} 离线或未就绪`);
    return false;
  }

  try {
    device.ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error(`[DeviceManager] sendRaw 异常，目标: ${deviceId}:`, err.message);
    return false;
  }
}

/**
 * 向多台设备发送相同的原始消息
 * @param {Array<string>} deviceIds
 * @param {Object} payload
 * @returns {{success:number,failed:number,failedIds:Array<string>}}
 */
function sendBatchRaw(deviceIds, payload) {
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return { success: 0, failed: 0, failedIds: [] };
  }

  let successCount = 0;
  const failedIds = [];
  for (const id of deviceIds) {
    if (sendRaw(id, payload)) successCount++;
    else failedIds.push(id);
  }

  const failedCount = failedIds.length;
  console.log(`[DeviceManager] 批量原始消息发送完成：成功 ${successCount}/${deviceIds.length}，失败 ${failedCount} 台设备`);
  return { success: successCount, failed: failedCount, failedIds };
}

// 将新函数导出
module.exports.sendRaw = sendRaw;
module.exports.sendBatchRaw = sendBatchRaw;
