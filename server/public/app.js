const loginSection = document.getElementById("loginSection");
const dashboardSection = document.getElementById("dashboardSection");
const loginForm = document.getElementById("loginForm");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const deviceGrid = document.getElementById("deviceGrid");
const refreshButton = document.getElementById("refreshButton");
const logoutButton = document.getElementById("logoutButton");
const topAction = document.getElementById("topAction");
const remainingTimeBadge = document.getElementById("remainingTimeBadge");
const codecModeBadge = document.getElementById("codecModeBadge");

const groupFileInput = document.getElementById("groupFileInput");

// ================= HUD 交互 =================
const AUTO_REFRESH_MS = 15000;
let autoRefreshTimer = null;
let autoRefreshRaf = null;
let autoRefreshStart = 0;
let activeRefreshBar = null;

function showToast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(10px)";
    el.style.transition = "opacity 0.3s, transform 0.3s";
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function formatCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
  if (v >= 1000) return (v / 1000).toFixed(1) + "K";
  return String(v);
}

function pulseRefreshAnimation(el) {
  if (!el) return;
  el.classList.add("refreshing");
  setTimeout(() => el.classList.remove("refreshing"), 400);
}

function updateRefreshBarProgress() {
  if (!activeRefreshBar) return;
  const elapsed = Date.now() - autoRefreshStart;
  const pct = Math.min(100, (elapsed / AUTO_REFRESH_MS) * 100);
  activeRefreshBar.style.width = pct + "%";
  if (pct < 100) {
    autoRefreshRaf = requestAnimationFrame(updateRefreshBarProgress);
  }
}

function startAutoRefresh(barEl, refreshFn) {
  stopAutoRefresh();
  activeRefreshBar = barEl;
  if (barEl) barEl.style.width = "0%";
  autoRefreshStart = Date.now();
  autoRefreshRaf = requestAnimationFrame(updateRefreshBarProgress);
  autoRefreshTimer = setInterval(() => {
    refreshFn();
    autoRefreshStart = Date.now();
    if (barEl) barEl.style.width = "0%";
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (autoRefreshRaf) {
    cancelAnimationFrame(autoRefreshRaf);
    autoRefreshRaf = null;
  }
  activeRefreshBar = null;
}

async function fetchServerStats(animateEl) {
  pulseRefreshAnimation(animateEl);
  try {
    const resp = await fetch("/api/stats", {
      headers: { "x-admin-token": adminToken || "" },
    });
    if (!resp.ok) throw new Error("unauthorized");
    const data = await resp.json();
    const s = data.stats || {};
    const dashCore = document.getElementById("dashCoreValue");
    const onlineEl = document.getElementById("statOnline");
    const framesEl = document.getElementById("statFrames");
    const viewersEl = document.getElementById("statViewers");
    const broadcastEl = document.getElementById("statBroadcast");
    if (dashCore && !dashboardSection.classList.contains("hidden")) {
      const list = getFilteredSortedDeviceList();
      dashCore.textContent = `${list.length} 台设备`;
      updateDeviceOnlineStats();
    }
    if (onlineEl) onlineEl.textContent = s.onlineDevices ?? "--";
    if (framesEl) framesEl.textContent = formatCompact(s.framesReceived);
    if (viewersEl) viewersEl.textContent = s.webViewers ?? "--";
    if (broadcastEl) broadcastEl.textContent = formatCompact(s.framesBroadcast);
    return s;
  } catch {
    showToast("统计数据获取失败，请检查登录状态", "error");
    return null;
  }
}

async function halveServerStats() {
  try {
    const resp = await fetch("/api/stats/halve", {
      method: "POST",
      headers: { "x-admin-token": adminToken || "" },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || "操作失败");
    showToast("计数器已清理一半", "success");
    await fetchServerStats(document.getElementById("dashCoreValue"));
    return data;
  } catch (e) {
    if (!adminToken) {
      showToast("请先登录后再执行清理操作", "error");
    } else {
      showToast(e.message || "清理失败", "error");
    }
    return null;
  }
}

function normalizeExpireAt(value) {
  if (value == null || value === "") return -1;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return -1;
  return n;
}

function readStoredSession() {
  adminToken = localStorage.getItem("adminToken");
  role = localStorage.getItem("role") || null;
  expireAt = normalizeExpireAt(localStorage.getItem("expireAt"));
}

function isSessionValid() {
  if (!adminToken) return false;
  if (expireAt !== -1 && Date.now() > expireAt) return false;
  return true;
}

function clearStoredSession() {
  localStorage.removeItem("adminToken");
  localStorage.removeItem("role");
  localStorage.removeItem("expireAt");
  adminToken = null;
  role = null;
  expireAt = -1;
}

function restoreSessionOrLogin() {
  readStoredSession();
  if (!isSessionValid()) {
    if (adminToken) clearStoredSession();
    showLogin();
    return;
  }
  showDashboard();
}

let adminToken = localStorage.getItem("adminToken");
let role = localStorage.getItem("role") || null;
let expireAt = normalizeExpireAt(localStorage.getItem("expireAt"));
let ws = null;
let devices = new Map();
let frameRefreshInterval = null;
let renderPending = false;
let deviceOrderCounter = 0;
let frameObserver = null;
const visibleDeviceIds = new Set();
let wsListReady = false;
let thumbSubscribeTimer = null;
let wsReconnectTimer = null;
let wsSessionReplaced = false;

function clearThumbSubscribeTimer() {
  if (thumbSubscribeTimer) {
    clearTimeout(thumbSubscribeTimer);
    thumbSubscribeTimer = null;
  }
}

function clearWsReconnectTimer() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function disconnectWebSocket() {
  clearWsReconnectTimer();
  clearThumbSubscribeTimer();
  wsListReady = false;
  if (!ws) return;
  const socket = ws;
  ws = null;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  if (
    socket.readyState === WebSocket.OPEN
    || socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

// ================ 群控相关 ================
let selectedDevices = new Set(); // 多选的设备 ID 集合
let groupFilter = "ALL"; // 当前分组过滤
let deviceSearchQuery = ""; // 设备搜索关键词（分组 / 机型 / 备注）

// ================= 虚拟滚动（100 台仅渲染可见卡片） =================
const deviceGridViewport = document.getElementById("deviceGridViewport");
const virtualScrollBar = document.getElementById("virtualScrollBar");
const VIRTUAL_CARD_MIN_WIDTH = 220;
const VIRTUAL_GAP = 14;
const VIRTUAL_ROW_HEIGHT = 338;
const VIRTUAL_OVERSCAN_ROWS = 2;
let virtualCols = 4;
let virtualScrollRaf = null;
let thumbSubsCappedWarned = false;

function getWsUrl() {

    const params = new URLSearchParams(window.location.search);
    console.log(params);

    const deviceId = params.get("deviceId"); // ❗关键
    console.log("[WS] connect deviceId =", deviceId);

    const token = localStorage.getItem("adminToken");

    const wsBase =
        typeof WsDebug !== "undefined"
            ? WsDebug.resolveWsEndpoint()
            : `${location.origin.replace(/^http/, "ws")}/ws`;
    const url = new URL(wsBase);

    url.searchParams.set("clientType", "web");
    url.searchParams.set("subscribe", "list");

    // 控制页传 deviceId；列表页不传，走 subscribe=list
    if (deviceId && deviceId !== "ALL") {
        url.searchParams.set("deviceId", deviceId);
        url.searchParams.delete("subscribe");
    }

    if (token) {
        url.searchParams.set("token", token);
    }

    console.log("[WS] connect deviceId =", deviceId);

    return url.toString();
}

function formatRemainingTime(expireAtValue) {
  if (expireAtValue === -1) return "剩余使用：无限期";
  const diff = expireAtValue - Date.now();
  if (diff <= 0) return "已过期";
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分`);
  if (parts.length === 0) parts.push("少于1分钟");
  return `剩余使用：${parts.join("")}`;
}

function renderTopAction() {
  let html = `<span class="top-label">已登录</span>`;
  if (role === "root") {
    html += `<a class="action-btn" href="/users.html">[ 账号管理 ]</a>`;
  }
  topAction.innerHTML = html;
}

function updateRemainingTimeBadge() {
  if (!remainingTimeBadge) return;
  remainingTimeBadge.classList.remove("urgent");

  if (expireAt === -1) {
    remainingTimeBadge.textContent = "剩余使用：无限期";
    remainingTimeBadge.classList.remove("hidden");
    return;
  }

  const diff = expireAt - Date.now();
  if (diff <= 0) {
    remainingTimeBadge.textContent = "剩余使用：已过期";
    remainingTimeBadge.classList.add("urgent");
    remainingTimeBadge.classList.remove("hidden");
    return;
  }

  if (diff <= 24 * 3600 * 1000) {
    remainingTimeBadge.classList.add("urgent");
  }

  remainingTimeBadge.textContent = formatRemainingTime(expireAt);
  remainingTimeBadge.classList.remove("hidden");
}

function collectOnlineDeviceIds() {
  const ids = [];
  for (const d of devices.values()) {
    const id = d.deviceId || d.device_id;
    if (id && d.online !== false) ids.push(String(id));
  }
  return ids;
}

function renderCodecModeBadge(info) {
  if (!codecModeBadge || !info) return;
  codecModeBadge.textContent =
    info.codec === "h264" ? "编码：H.264（HTTPS）" : "编码：WebP";
  codecModeBadge.title =
    (info.label || "") +
    "；列表缩略图始终为 WebP。控制页选「清晰」才会用手机 H.264。";
  codecModeBadge.classList.remove("hidden");
}

/** 列表页：检测浏览器能力并通知所有在线手机 */
function syncListCodecPreference(options = {}) {
  if (!window.CodecClient) return;
  const info = CodecClient.detectAndPersist();
  renderCodecModeBadge(info);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const ids = collectOnlineDeviceIds();
  if (!ids.length) {
    if (!options.silentEmpty) {
      console.warn("[codec] 列表暂无在线设备，跳过 allowH264/preferWebp");
    }
    return;
  }
  const pushed = CodecClient.pushCodecToDevices(ws, ids);
  if (pushed && info.codec === "h264") {
    console.info(
      `[codec] 已向 ${pushed.count} 台下发 ${pushed.command.type}，控制页请用「清晰」`
    );
  }
}

function scheduleListCodecAfterThumbPolicy() {
  setTimeout(() => syncListCodecPreference({ silentEmpty: true }), 800);
}

function showDashboard() {
  loginSection.classList.add("hidden");
  dashboardSection.classList.remove("hidden");
  renderTopAction();
  updateRemainingTimeBadge();
  if (window.CodecClient) {
    renderCodecModeBadge(CodecClient.readPersisted());
  }
  connectWebSocket();
  renderGroupFilterOptions();
  initVirtualScroll();
  startFrameRefresh();
  fetchServerStats(document.getElementById("dashCoreValue"));
  startAutoRefresh(
    document.getElementById("dashRefreshBar"),
    () => fetchServerStats(document.getElementById("dashCoreValue"))
  );
  const dashDot = document.getElementById("dashStatusDot");
  if (dashDot) dashDot.classList.remove("status-dot--offline");
}

function showLogin() {
  dashboardSection.classList.add("hidden");
  loginSection.classList.remove("hidden");
  topAction.innerHTML = "";
  if (remainingTimeBadge) {
    remainingTimeBadge.classList.add("hidden");
  }
  if (codecModeBadge) {
    codecModeBadge.classList.add("hidden");
  }
  disconnectWebSocket();
  stopFrameRefresh();
  stopAutoRefresh();
}

// ================= 🖼️ HTTP API 获取设备截图 =================
async function fetchDeviceFrame(deviceId) {
  try {
    const resp = await fetch(`/api/device/${deviceId}/frame`, {
      headers: { "x-admin-token": adminToken || "" }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.image) {
        const device = devices.get(deviceId);
        if (device) {
          const newImage = data.image.startsWith("data:image")
            ? data.image
            : `data:image/jpeg;base64,${data.image}`;
          if (device.lastFrame !== newImage) {
            device.lastFrame = newImage;
            device.lastFrameAt = Date.now();
            scheduleRenderDevices();
          }
        }
      }
    }
  } catch (e) {
    console.warn(`获取设备 ${deviceId} 的截图失败:`, e);
  }
}

function scheduleRenderDevices() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderDevices();
  });
}

function getDeviceModelSortKey(device) {
  const brand = String(device.brand || "").trim();
  const model = String(device.model || "").trim();
  const label = `${brand} ${model}`.trim();
  return label || String(device.deviceId || "");
}

function hasDeviceGroup(device) {
  return !!(device.group && String(device.group).trim());
}

function getDeviceGroupSortKey(device) {
  return hasDeviceGroup(device) ? String(device.group).trim() : "\uffff";
}

function compareDevicesForList(a, b) {
  if (a.online !== b.online) return a.online ? -1 : 1;
  const aGrouped = hasDeviceGroup(a);
  const bGrouped = hasDeviceGroup(b);
  if (aGrouped !== bGrouped) return aGrouped ? -1 : 1;
  if (groupFilter === "ALL") {
    const groupCmp = getDeviceGroupSortKey(a).localeCompare(getDeviceGroupSortKey(b), "zh-CN", {
      sensitivity: "base",
      numeric: true,
    });
    if (groupCmp !== 0) return groupCmp;
  }
  return getDeviceModelSortKey(a).localeCompare(getDeviceModelSortKey(b), "zh-CN", {
    sensitivity: "base",
    numeric: true,
  });
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function getDeviceSearchHaystack(device) {
  const groupLabel = hasDeviceGroup(device) ? String(device.group).trim() : "未分组";
  const modelLabel = getDeviceModelSortKey(device);
  const remarkLabel = String(device.remark || "").trim() || "暂无备注";
  return normalizeSearchText(`${groupLabel} ${modelLabel} ${remarkLabel}`);
}

function deviceMatchesSearch(device, query) {
  const keyword = normalizeSearchText(query);
  if (!keyword) return true;
  return getDeviceSearchHaystack(device).includes(keyword);
}

function getEmptyListMessage() {
  if (devices.size === 0) {
    return "暂无可用设备，正等待安卓设备群控注册连接...";
  }
  if (deviceSearchQuery.trim()) {
    return `未找到匹配「${escapeHtml(deviceSearchQuery.trim())}」的设备`;
  }
  return "当前筛选条件下没有设备";
}

function matchesGroupFilter(device) {
  if (groupFilter === "ALL") return true;
  if (groupFilter === "UNGROUPED") return !device.group;
  return device.group === groupFilter;
}

function getFilteredSortedDeviceList() {
  return Array.from(devices.values())
    .filter((device) => matchesGroupFilter(device) && deviceMatchesSearch(device, deviceSearchQuery))
    .sort(compareDevicesForList);
}

function updateDeviceOnlineStats() {
  const el = document.getElementById("deviceOnlineStats");
  if (!el) return;
  const list = getFilteredSortedDeviceList();
  let online = 0;
  let offline = 0;
  for (const d of list) {
    if (d.online === false) offline++;
    else online++;
  }
  el.innerHTML =
    `<span class="stat-online">在线 ${online}</span>` +
    `<span class="stat-sep"> · </span>` +
    `<span class="stat-offline">离线 ${offline}</span>`;
}

function getVirtualCols() {
  if (!deviceGridViewport) return 4;
  const w = deviceGridViewport.clientWidth || 800;
  return Math.max(1, Math.floor((w + VIRTUAL_GAP) / (VIRTUAL_CARD_MIN_WIDTH + VIRTUAL_GAP)));
}

function getVirtualVisibleRange(totalCount) {
  virtualCols = getVirtualCols();
  const rowCount = Math.max(1, Math.ceil(totalCount / virtualCols));
  const scrollTop = deviceGridViewport?.scrollTop || 0;
  const viewH = deviceGridViewport?.clientHeight || 600;
  const startRow = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS);
  const endRow = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop + viewH) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN_ROWS
  );
  return {
    start: startRow * virtualCols,
    end: Math.min(totalCount, (endRow + 1) * virtualCols),
    startRow,
    rowCount,
  };
}

/** 虚拟滚动视口内在线设备 ID */
function getVirtuallyVisibleOnlineDeviceIds() {
  const list = getFilteredSortedDeviceList().filter((d) => d.online);
  const { start, end } = getVirtualVisibleRange(list.length);
  return list.slice(start, end).map((d) => d.deviceId);
}

/** 列表 WS 缩略图订阅：视口内 ∩ Intersection 可见，最多 24（服务端按账号再限 30） */
function getThumbSubscriptionIds() {
  const viewportIds = new Set(getVirtuallyVisibleOnlineDeviceIds());
  const ids = [];
  visibleDeviceIds.forEach((id) => {
    if (viewportIds.has(id)) ids.push(id);
  });
  if (ids.length > 0) return ids.slice(0, 24);
  return Array.from(viewportIds).slice(0, 20);
}

function initVirtualScroll() {
  if (!deviceGridViewport) return;
  deviceGridViewport.addEventListener(
    "scroll",
    () => {
      if (virtualScrollRaf) return;
      virtualScrollRaf = requestAnimationFrame(() => {
        virtualScrollRaf = null;
        renderDevices();
        if (wsListReady) publishThumbSubscription();
      });
    },
    { passive: true }
  );
  window.addEventListener("resize", () => {
    renderDevices();
    if (wsListReady) publishThumbSubscription();
  });
}

function updateVirtualScrollBar(start, end, total) {
  if (!virtualScrollBar) return;
  if (total === 0) {
    virtualScrollBar.classList.add("hidden");
    return;
  }
  virtualScrollBar.classList.remove("hidden");
  virtualScrollBar.textContent =
    total <= end - start
      ? `共 ${total} 台（已全部显示）`
      : `滚动浏览：当前渲染 ${start + 1}–${end} / 共 ${total} 台 · 缩略图仅推送可见区域`;
}

function patchDeviceCardThumbnail(deviceId, imageSrc) {
  const card = document.querySelector(
    `.device-card[data-device-id="${CSS.escape(deviceId)}"]`
  );
  if (!card) return false;
  const box = card.querySelector(".device-card-image");
  if (!box) return false;
  let img = box.querySelector("img");
  if (img) {
    if (img.src !== imageSrc) img.src = imageSrc;
    return true;
  }
  box.innerHTML = `<img src="${imageSrc}" alt="${escapeHtml(deviceId)}" />`;
  return true;
}

function publishThumbSubscription() {
  if (!wsListReady || !ws || ws.readyState !== WebSocket.OPEN) return;
  clearThumbSubscribeTimer();
  thumbSubscribeTimer = setTimeout(() => {
    thumbSubscribeTimer = null;
    if (!wsListReady || !ws || ws.readyState !== WebSocket.OPEN) return;
    const deviceIds = getThumbSubscriptionIds();
    ws.send(JSON.stringify({ type: "subscribe_thumbnails", deviceIds }));
    scheduleListCodecAfterThumbPolicy();
  }, 200);
}

function setupFrameObserver() {
  if (!("IntersectionObserver" in window)) return;
  if (!frameObserver) {
    frameObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const id = entry.target.dataset.deviceId;
        if (!id) return;
        if (entry.isIntersecting) {
          visibleDeviceIds.add(id);
          if (wsListReady) {
            publishThumbSubscription();
          } else {
            const device = devices.get(id);
            if (device?.online) fetchDeviceFrame(id);
          }
        } else {
          visibleDeviceIds.delete(id);
          if (wsListReady) publishThumbSubscription();
        }
      });
    }, {
      root: deviceGridViewport || null,
      rootMargin: "80px",
      threshold: 0.08,
    });
  }
  frameObserver.disconnect();
  document.querySelectorAll(".device-card[data-device-id]").forEach((el) => {
    frameObserver.observe(el);
  });
  if (wsListReady) publishThumbSubscription();
}

function supplementMissingVisibleThumbs() {
  getThumbSubscriptionIds().forEach((id) => {
    const device = devices.get(id);
    if (device?.online && !device.lastFrame) {
      fetchDeviceFrame(id);
    }
  });
}

// WS 推送为主；未连接时 HTTP 轮询降级
function startFrameRefresh() {
  if (frameRefreshInterval) clearInterval(frameRefreshInterval);
  const intervalMs = wsListReady ? 45000 : 5000;
  frameRefreshInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && wsListReady) {
      supplementMissingVisibleThumbs();
      return;
    }
    const viewportIds = new Set(getVirtuallyVisibleOnlineDeviceIds());
    visibleDeviceIds.forEach((id) => {
      if (viewportIds.has(id)) fetchDeviceFrame(id);
    });
  }, intervalMs);
}

// 停止定时刷新
function stopFrameRefresh() {
  if (frameRefreshInterval) {
    clearInterval(frameRefreshInterval);
    frameRefreshInterval = null;
  }
  if (frameObserver) {
    frameObserver.disconnect();
  }
  visibleDeviceIds.clear();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseAndroidVersion(version) {
  if (!version) return [-1];
  const raw = String(version).trim();
  const numeric = raw.match(/\d+(?:\.\d+)*/);
  if (!numeric) return [-1];
  return numeric[0].split(".").map((part) => Number(part));
}

function compareVersionArrays(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ai = Number.isFinite(a[i]) ? a[i] : 0;
    const bi = Number.isFinite(b[i]) ? b[i] : 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function buildDeviceCardHtml(device) {
        const statusClass = device.online ? "status-online" : "status-offline";
        const image = device.lastFrame || "";
        const isSelected = selectedDevices.has(device.deviceId);
        const remark = device.remark ? escapeHtml(device.remark) : "暂无备注";
        const hasGroup = hasDeviceGroup(device);
        const groupText = hasGroup ? escapeHtml(device.group) : "未分组";
        const groupBadgeClass = hasGroup ? "group-text--named" : "group-text--ungrouped";
        const ownerText = device.owner ? escapeHtml(device.owner) : "未上报";
        const showOwner = role === "root";
        return `
        <article class="device-card ${isSelected ? 'selected' : ''}" data-device-id="${escapeHtml(device.deviceId)}">
          <div class="device-card-checkbox">
            <input type="checkbox" class="device-checkbox" data-device-id="${escapeHtml(device.deviceId)}" ${isSelected ? 'checked' : ''} />
          </div>
          <div class="device-card-image">
            ${image ? `<img src="${image}" alt="${escapeHtml(device.deviceId)}" />` : `<div class="placeholder">等待截图推送</div>`}
          </div>
          <div class="device-card-body">
            <div class="card-title">${escapeHtml(device.brand || "未知品牌")} ${escapeHtml(device.model || "未知机型")}</div>
            <div class="device-meta">
              <span class="meta-label">ID:</span> ${escapeHtml(device.deviceId)}
            </div>
            ${showOwner ? `
            <div class="device-meta device-owner-row">
              <span class="meta-label">绑定账号:</span>
              <span class="device-owner-name">${ownerText}</span>
            </div>` : ""}
            <div class="device-remark-row">
              <span class="remark-label">备注:</span>
              <span class="remark-text">${remark}</span>
              <button class="remark-edit-btn" data-device-id="${escapeHtml(device.deviceId)}">[ 编辑 ]</button>
            </div>
            <div class="device-group-row">
              <span class="remark-label">分组:</span>
              <span class="group-text ${groupBadgeClass}">${groupText}</span>
              <button class="group-edit-btn" data-device-id="${escapeHtml(device.deviceId)}">[ 设置 ]</button>
            </div>
            <div class="device-tag ${statusClass}">
              <span class="device-status-dot" aria-hidden="true"></span>
              <span class="device-status-text">${device.online ? "在线" : "离线"}</span>
            </div>
            <div class="device-stats">${device.width}x${device.height} · Android ${device.android || "-"}</div>
            <div class="card-actions">
              <a class="button" href="device.html?id=${device.deviceId}">[ 进入控制中心 ]</a>
              ${showOwner ? `<button type="button" class="device-delete-btn" data-device-id="${escapeHtml(device.deviceId)}">[ 删除设备 ]</button>` : ""}
            </div>
          </div>
        </article>`;
}

// ================= 虚拟滚动设备网格渲染 =================
function renderDevices() {
  const list = getFilteredSortedDeviceList();
  const total = list.length;
  const { start, end, startRow, rowCount } = getVirtualVisibleRange(total);
  const slice = list.slice(start, end);

  if (total === 0) {
    deviceGrid.style.paddingTop = "0";
    deviceGrid.style.minHeight = "0";
    deviceGrid.innerHTML = `<div class="empty-tips">${getEmptyListMessage()}</div>`;
  } else {
    deviceGrid.style.paddingTop = `${startRow * VIRTUAL_ROW_HEIGHT}px`;
    deviceGrid.style.minHeight = `${rowCount * VIRTUAL_ROW_HEIGHT}px`;
    deviceGrid.innerHTML = slice.map(buildDeviceCardHtml).join("");
  }

  const dashCore = document.getElementById("dashCoreValue");
  if (dashCore) dashCore.textContent = `${total} 台设备`;
  updateDeviceOnlineStats();
  updateVirtualScrollBar(start, end, total);
  
  // 绑定复选框和备注按钮事件
  attachCheckboxListeners();
  attachRemarkButtons();
  attachGroupButtons();
  attachDeleteButtons();
  setupFrameObserver();
  if (wsListReady) publishThumbSubscription();
}

// ================= 📱 群控相关函数 =================

/**
 * 绑定设备卡片复选框的点击事件
 */
function attachCheckboxListeners() {
  document.querySelectorAll(".device-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const deviceId = e.target.dataset.deviceId;
      if (e.target.checked) {
        selectedDevices.add(deviceId);
      } else {
        selectedDevices.delete(deviceId);
      }
    });
  });
}

/**
 * 绑定备注编辑按钮事件
 */
function attachRemarkButtons() {
  document.querySelectorAll(".remark-edit-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const deviceId = button.dataset.deviceId;
      const device = devices.get(deviceId);
      const currentRemark = device?.remark || "";
      const remark = window.prompt("请输入设备备注", currentRemark);
      if (remark === null) return;
      const trimmed = remark.trim();
      await saveDeviceRemark(deviceId, trimmed);
      const exist = devices.get(deviceId) || {};
      devices.set(deviceId, { ...exist, remark: trimmed });
      renderDevices();
    });
  });
}

/**
 * 保存设备备注到后台
 */
async function saveDeviceRemark(deviceId, remark) {
  try {
    const resp = await fetch(`/api/device/${deviceId}/remark`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken || ""
      },
      body: JSON.stringify({ remark })
    });

    const contentType = resp.headers.get("content-type") || "";
    let data;
    if (contentType.includes("application/json")) {
      data = await resp.json();
    } else {
      const text = await resp.text();
      throw new Error(`服务器返回非 JSON 响应: ${text}`);
    }

    if (!resp.ok) {
      throw new Error(data.message || "保存备注失败");
    }
    return data.remark;
  } catch (error) {
    alert(`备注保存失败：${error.message}`);
    return remark;
  }
}

function attachGroupButtons() {
  document.querySelectorAll(".group-edit-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const deviceId = button.dataset.deviceId;
      const device = devices.get(deviceId);
      const currentGroup = device?.group || "";
      const group = window.prompt("请输入设备分组名称，留空则取消分组", currentGroup);
      if (group === null) return;
      const trimmed = group.trim();
      await saveDeviceGroup(deviceId, trimmed);
      const exist = devices.get(deviceId) || {};
      devices.set(deviceId, { ...exist, group: trimmed });
      renderGroupFilterOptions();
      renderDevices();
    });
  });
}

async function saveDeviceGroup(deviceId, group) {
  try {
    const resp = await fetch(`/api/device/${deviceId}/group`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken || ""
      },
      body: JSON.stringify({ group })
    });

    const contentType = resp.headers.get("content-type") || "";
    let data;
    if (contentType.includes("application/json")) {
      data = await resp.json();
    } else {
      const text = await resp.text();
      throw new Error(`服务器返回非 JSON 响应: ${text}`);
    }

    if (!resp.ok) {
      throw new Error(data.message || "保存分组失败");
    }
    return data.group;
  } catch (error) {
    alert(`分组保存失败：${error.message}`);
    return group;
  }
}

function renderGroupFilterOptions() {
  const filter = document.getElementById("groupFilterSelect");
  if (!filter) return;

  const groups = new Set(["ALL", "UNGROUPED"]);
  Array.from(devices.values()).forEach((device) => {
    if (device.group) {
      groups.add(device.group);
    }
  });

  const current = filter.value || groupFilter;
  filter.innerHTML = `
    <option value="ALL">全部分组</option>
    <option value="UNGROUPED">未分组</option>
  ` + Array.from(groups)
    .filter((item) => item !== "ALL" && item !== "UNGROUPED")
    .sort()
    .map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`)
    .join("");
  filter.value = current;
}

function getDevicesInCurrentGroupFilter() {
  return Array.from(devices.values()).filter((device) => {
    if (groupFilter === "ALL") return true;
    if (groupFilter === "UNGROUPED") return !device.group;
    return device.group === groupFilter;
  });
}

function selectCurrentGroup() {
  const groupIds = getDevicesInCurrentGroupFilter().map((d) => d.deviceId);
  const allSelected =
    groupIds.length > 0 && groupIds.every((id) => selectedDevices.has(id));

  if (allSelected) {
    selectedDevices.clear();
  } else {
    selectedDevices.clear();
    groupIds.forEach((id) => selectedDevices.add(id));
  }
  renderDevices();
}

function syncGroupActions() {
  if (selectedDevices.size < 2) {
    alert("请先选择至少两台设备，再使用同步群控");
    return;
  }
  const deviceIds = Array.from(selectedDevices);
  const firstDeviceId = deviceIds[0];
  const syncParam = encodeURIComponent(deviceIds.join(","));
  window.location.href = `device.html?id=${encodeURIComponent(firstDeviceId)}&syncGroup=${syncParam}`;
}

function batchGroupControl() {
  // 获取当前分组的所有在线设备
  const groupDevices = Array.from(devices.values()).filter((device) => {
    if (groupFilter === "ALL") return device.online;
    if (groupFilter === "UNGROUPED") return !device.group && device.online;
    return device.group === groupFilter && device.online;
  }).map(d => d.deviceId);

  if (groupDevices.length < 1) {
    alert("当前分组没有在线设备可用于群控");
    return;
  }

  if (groupDevices.length === 1) {
    alert("当前分组至少需要2台在线设备进行群控");
    return;
  }

  const firstDeviceId = groupDevices[0];
  const syncParam = encodeURIComponent(groupDevices.join(","));
  window.location.href = `device.html?id=${encodeURIComponent(firstDeviceId)}&syncGroup=${syncParam}`;
}

/**
 * 根据操作类型显示/隐藏对应的参数表单
 */
function updateControlParamFields() {
  const type = document.getElementById("batchControlType").value;
  
  // 隐藏所有参数组
  document.getElementById("clickParams").classList.add("hidden");
  document.getElementById("longClickParams").classList.add("hidden");
  document.getElementById("swipeParams").classList.add("hidden");
  document.getElementById("keyParams").classList.add("hidden");
  document.getElementById("inputParams").classList.add("hidden");
  
  // 根据类型显示对应参数
  switch (type) {
    case "click":
      document.getElementById("clickParams").classList.remove("hidden");
      break;
    case "longClick":
      document.getElementById("longClickParams").classList.remove("hidden");
      break;
    case "swipe":
      document.getElementById("swipeParams").classList.remove("hidden");
      break;
    case "key":
      document.getElementById("keyParams").classList.remove("hidden");
      break;
    case "input":
      document.getElementById("inputParams").classList.remove("hidden");
      break;
  }
}

/**
 * 执行群控命令
 */
async function executeBatchControl() {
  const type = document.getElementById("batchControlType").value;
  if (!type) {
    alert("请选择操作类型");
    return;
  }
  
  if (selectedDevices.size === 0) {
    alert("请至少选择一台设备");
    return;
  }
  
  const deviceIds = Array.from(selectedDevices);
  const command = { type };
  
  // 根据操作类型获取参数
  switch (type) {
    case "click": {
      const x = parseInt(document.getElementById("clickX").value);
      const y = parseInt(document.getElementById("clickY").value);
      if (isNaN(x) || isNaN(y)) {
        alert("请输入有效的坐标");
        return;
      }
      command.x = x;
      command.y = y;
      break;
    }
    case "longClick": {
      const x = parseInt(document.getElementById("longClickX").value);
      const y = parseInt(document.getElementById("longClickY").value);
      const duration = parseInt(document.getElementById("longClickDuration").value);
      if (isNaN(x) || isNaN(y) || isNaN(duration)) {
        alert("请输入有效的坐标和时长");
        return;
      }
      command.x = x;
      command.y = y;
      command.duration = duration;
      break;
    }
    case "swipe": {
      const x1 = parseInt(document.getElementById("swipeX1").value);
      const y1 = parseInt(document.getElementById("swipeY1").value);
      const x2 = parseInt(document.getElementById("swipeX2").value);
      const y2 = parseInt(document.getElementById("swipeY2").value);
      const duration = parseInt(document.getElementById("swipeDuration").value);
      if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2) || isNaN(duration)) {
        alert("请输入有效的坐标和时长");
        return;
      }
      command.x1 = x1;
      command.y1 = y1;
      command.x2 = x2;
      command.y2 = y2;
      command.duration = duration;
      break;
    }
    case "key": {
      const keyCode = document.getElementById("keyCode").value;
      if (!keyCode) {
        alert("请选择按键");
        return;
      }
      command.text = keyCode;
      break;
    }
    case "input": {
      const text = document.getElementById("inputText").value.trim();
      if (!text) {
        alert("请输入文本内容");
        return;
      }
      command.text = text;
      break;
    }
  }
  
  await runBatchControl(deviceIds, command);
}

function showBatchFeedback(text, clearMs = 5000) {
  const status = document.getElementById("batchStatus");
  if (status) {
    status.textContent = text;
    if (clearMs > 0) {
      setTimeout(() => {
        if (status.textContent === text) status.textContent = "";
      }, clearMs);
    }
    return;
  }
  alert(text);
}

async function runBatchControl(deviceIds, command) {
  const executeBtn = document.getElementById("executeBatchBtn");
  if (executeBtn) executeBtn.disabled = true;
  showBatchFeedback("执行中…", 0);

  try {
    const resp = await fetch("/api/control/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": adminToken || ""
      },
      body: JSON.stringify({ deviceIds, ...command })
    });

    const data = await resp.json();
    if (!resp.ok || !data.success) {
      showBatchFeedback(`❌ ${data.message || "执行失败"}`);
      return;
    }

    const r = data.result || {};
    const failed = r.failed || 0;
    let msg = `✅ ${data.summary || `成功 ${r.success || 0}/${deviceIds.length}`}`;
    if (failed > 0 && Array.isArray(r.failedIds) && r.failedIds.length) {
      const ids = r.failedIds.slice(0, 3).map((id) => String(id).slice(-8)).join(", ");
      const more = r.failedIds.length > 3 ? "…" : "";
      msg += `；失败设备(尾号): ${ids}${more}`;
    }
    showBatchFeedback(msg);
  } catch (error) {
    showBatchFeedback(`❌ 网络错误: ${error.message}`);
  } finally {
    if (executeBtn) executeBtn.disabled = false;
  }
}

// ================= 登录与鉴权 =================
async function login(event) {
  event.preventDefault();
  const username = loginUsername.value.trim();
  const password = loginPassword.value.trim();
  if (!username || !password) return;

  const resp = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json();
  if (!resp.ok) {
    if (body.message === "用户已过期") {
      alert("登录失败：账号已过期，请联系管理员");
    } else {
      alert(body.message || "登录失败");
    }
    return;
  }

  adminToken = body.token;
  localStorage.setItem("adminToken", adminToken);
  role = body.role || "sub";
  localStorage.setItem("role", role);
  expireAt = normalizeExpireAt(body.expireAt);
  localStorage.setItem("expireAt", String(expireAt));
  devices.clear();
  disconnectWebSocket();
  showDashboard();
}

function logout() {
  clearStoredSession();
  devices.clear();
  disconnectWebSocket();
  stopFrameRefresh();
  showLogin();
}

// ================= WebSocket 连接 =================
function connectWebSocket() {
  if (!isSessionValid()) return;
  wsSessionReplaced = false;
  if (ws) {
    const state = ws.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
  }

  wsListReady = false;
  ws = new WebSocket(getWsUrl());
  ws.onopen = () => {
    if (!isSessionValid()) {
      disconnectWebSocket();
      return;
    }
    console.log("[WS] 设备列表通道已握手成功");
    wsListReady = true;
    syncListCodecPreference();
    setTimeout(() => syncListCodecPreference(), 400);
    publishThumbSubscription();
    startFrameRefresh();
  };
  ws.onmessage = (event) => {
    try { handleWsMessage(JSON.parse(event.data)); } catch (e) { console.warn("List WS error", e); }
  };
  ws.onclose = (ev) => {
    wsListReady = false;
    ws = null;
    if (wsSessionReplaced || ev?.code === 4001) {
      wsSessionReplaced = false;
      stopFrameRefresh();
      alert("该子账号已在其他页面登录，当前页面已断开");
      logout();
      return;
    }
    if (!isSessionValid()) {
      stopFrameRefresh();
      return;
    }
    startFrameRefresh();
    clearWsReconnectTimer();
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWebSocket();
    }, 3000);
  };
}

function handleWsMessage(message) {
  switch (message.type) {
    case "device_list":
      devices.clear();
      message.devices.forEach((device) => updateDevice(device));
      renderGroupFilterOptions();
      renderDevices();
      syncListCodecPreference();
      break;
    case "device_registered": {
      updateDevice(message.device);
      renderGroupFilterOptions();
      renderDevices();
      const id = message.deviceId || message.device?.deviceId || message.device?.device_id;
      if (id && window.CodecClient && ws && ws.readyState === WebSocket.OPEN) {
        CodecClient.pushCodecToDevices(ws, [String(id)]);
      }
      break;
    }
    case "device_disconnected":
      setDeviceOffline(message.deviceId);
      renderDevices();
      break;
    case "device_deleted":
      removeDeviceFromList(message.deviceId);
      break;
    case "device_thumbnail":
      applyDeviceThumbnail(message.deviceId, message.image, message.lastFrameAt);
      break;
    case "subscribe_thumbnails_ack":
      if (message.capped && !thumbSubsCappedWarned) {
        thumbSubsCappedWarned = true;
        console.warn(
          `[WS] 缩略图订阅已按账号上限裁剪为 ${message.count}/${message.maxPerUser} 台`
        );
      }
      scheduleListCodecAfterThumbPolicy();
      break;
    case "session_replaced":
      wsSessionReplaced = true;
      disconnectWebSocket();
      stopFrameRefresh();
      alert(message.message || "该子账号已在其他页面登录，当前页面已断开");
      logout();
      break;
    case "control_ack": {
      const cmd = message.command?.type;
      if (cmd === "allowH264" || cmd === "preferWebp") {
        const r = message.result;
        const total = message.deviceIds?.length ?? 0;
        console.info(
          `[codec] 批量 ${cmd}：成功 ${r?.success ?? 0}/${total}`,
          r?.failedIds?.length ? `失败 ${r.failedIds.join(",")}` : ""
        );
      }
      break;
    }
    default:
      break;
  }
}

function applyDeviceThumbnail(deviceId, image, lastFrameAt) {
  if (!deviceId || !image) return;
  const exist = devices.get(deviceId) || { deviceId };
  let cleanImage = String(image).replace(/[\r\n\s]/g, "");
  if (!cleanImage.startsWith("data:image")) {
    cleanImage = "data:image/jpeg;base64," + cleanImage;
  }
  devices.set(deviceId, {
    ...exist,
    deviceId,
    lastFrame: cleanImage,
    lastFrameAt: lastFrameAt || Date.now(),
  });
  const viewportIds = new Set(getVirtuallyVisibleOnlineDeviceIds());
  if (!viewportIds.has(deviceId)) return;
  if (visibleDeviceIds.size > 0 && !visibleDeviceIds.has(deviceId)) return;
  if (patchDeviceCardThumbnail(deviceId, cleanImage)) return;
  scheduleRenderDevices();
}

function updateDevice(device) {
  const exist = devices.get(device.deviceId) || {};
  const order = exist.order != null ? exist.order : deviceOrderCounter++;
  const remark = device.remark !== undefined ? device.remark : exist.remark || "";
  const group = device.group !== undefined ? device.group : exist.group || "";
  const online = typeof device.online === "boolean" ? device.online : true;
  devices.set(device.deviceId, {
    ...exist,
    ...device,
    remark,
    group,
    online,
    lastFrameAt: device.lastFrameAt || exist.lastFrameAt || Date.now(),
    order,
  });
}

function updateDeviceFrame(deviceId, image) {
  const exist = devices.get(deviceId) || { deviceId };

  let cleanImage = image || "";
  if (typeof cleanImage === "string") {
    cleanImage = cleanImage.replace(/[\r\n\s]/g, "");
    if (!cleanImage.startsWith("data:image")) {
      cleanImage = "data:image/jpeg;base64," + cleanImage;
    }
  }

  devices.set(deviceId, {
    ...exist,
    deviceId,
    lastFrame: cleanImage,
    lastFrameAt: Date.now(),
  });
}

function setDeviceOffline(deviceId) {
  const exist = devices.get(deviceId);
  if (!exist) return;
  devices.set(deviceId, { ...exist, online: false });
}

function removeDeviceFromList(deviceId) {
  if (!deviceId) return;
  const id = String(deviceId);
  devices.delete(id);
  selectedDevices.delete(id);
  visibleDeviceIds.delete(id);
  renderGroupFilterOptions();
  renderDevices();
}

function attachDeleteButtons() {
  if (role !== "root") return;
  document.querySelectorAll(".device-delete-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      event.preventDefault();
      const deviceId = button.dataset.deviceId;
      const device = devices.get(deviceId);
      const label = device
        ? `${device.brand || ""} ${device.model || ""} (${deviceId})`.trim()
        : deviceId;
      if (!window.confirm(`确定从列表中删除设备？\n${label}\n\n在线设备将断开连接；手机再次上线会重新出现。`)) {
        return;
      }
      await deleteDevice(deviceId);
    });
  });
}

async function deleteDevice(deviceId) {
  try {
    const resp = await fetch(`/api/device/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { "x-admin-token": adminToken || "" },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(data.message || "删除失败");
      return;
    }
    removeDeviceFromList(deviceId);
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

// 事件总线绑定
loginForm.addEventListener("submit", login);

const dashRefreshStatsBtn = document.getElementById("dashRefreshStatsBtn");
if (dashRefreshStatsBtn) {
  dashRefreshStatsBtn.addEventListener("click", () => {
    fetchServerStats(document.getElementById("dashCoreValue"));
    autoRefreshStart = Date.now();
    const bar = document.getElementById("dashRefreshBar");
    if (bar) bar.style.width = "0%";
  });
}

const dashHalveBtn = document.getElementById("dashHalveBtn");
if (dashHalveBtn) {
  dashHalveBtn.addEventListener("click", () => halveServerStats());
}

if (refreshButton) {
  refreshButton.addEventListener("click", () => {
    if (wsListReady) {
      syncListCodecPreference();
      publishThumbSubscription();
      supplementMissingVisibleThumbs();
      return;
    }
    getVirtuallyVisibleOnlineDeviceIds().forEach((id) => fetchDeviceFrame(id));
  });
}
if (logoutButton) {
  logoutButton.addEventListener("click", logout);
}

const groupFilterSelect = document.getElementById("groupFilterSelect");
if (groupFilterSelect) {
  groupFilterSelect.addEventListener("change", (event) => {
    groupFilter = event.target.value;
    visibleDeviceIds.clear();
    if (deviceGridViewport) deviceGridViewport.scrollTop = 0;
    renderDevices();
  });
}

const deviceSearchInput = document.getElementById("deviceSearchInput");
if (deviceSearchInput) {
  deviceSearchInput.addEventListener("input", (event) => {
    deviceSearchQuery = event.target.value;
    visibleDeviceIds.clear();
    if (deviceGridViewport) deviceGridViewport.scrollTop = 0;
    renderDevices();
  });
  deviceSearchInput.addEventListener("search", () => {
    if (deviceSearchInput.value === "") {
      deviceSearchQuery = "";
      visibleDeviceIds.clear();
      if (deviceGridViewport) deviceGridViewport.scrollTop = 0;
      renderDevices();
    }
  });
}

const selectGroupBtn = document.getElementById("selectGroupBtn");
if (selectGroupBtn) {
  selectGroupBtn.addEventListener("click", selectCurrentGroup);
}

const groupUploadBtn = document.getElementById("groupUploadBtn");
if (groupUploadBtn) {
  groupUploadBtn.addEventListener("click", () => {
    if (!groupFilter || groupFilter === "ALL") {
      alert("请先选择要上传文件的分组");
      return;
    }
    if (!groupFileInput) return;
    groupFileInput.value = "";
    groupFileInput.click();
  });
}
if (groupFileInput) {
  groupFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await uploadFileToGroup(file, groupFilter);
  });
}

const syncGroupBtn = document.getElementById("syncGroupBtn");
if (syncGroupBtn) {
  syncGroupBtn.addEventListener("click", syncGroupActions);
}

const batchGroupControlBtn = document.getElementById("batchGroupControlBtn");
if (batchGroupControlBtn) {
  batchGroupControlBtn.addEventListener("click", batchGroupControl);
}

async function uploadFileToGroup(file, group) {
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("group", group);

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "x-admin-token": adminToken || "" },
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      alert(data.message || "上传并下发失败");
      return;
    }
    alert(`文件已上传并下发：${data.url}`);
  } catch (error) {
    alert(`上传失败：${error.message}`);
  }
}

restoreSessionOrLogin();

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    restoreSessionOrLogin();
  }
});
