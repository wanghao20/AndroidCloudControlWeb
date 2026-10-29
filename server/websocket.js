const { WebSocketServer } = require("ws");
const { getPool } = require("./db");

// ==================== 连接池 ====================

// deviceId -> ws
const deviceClients = new Map();

// ws -> { deviceId }
const webClients = new Map();

// ==================== WebSocket 主入口 ====================

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const urlParams = new URL(req.url, "http://localhost").searchParams;
    const clientType = urlParams.get("type") || "web";

    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    // ==================== WEB 端 ====================
    if (clientType === "web") {
      const deviceId = url.searchParams.get("deviceId") || null;
      ws.clientType = "web";

      // ⭐关键：绑定订阅设备
      webClients.set(ws, {
        deviceId,
      });

      ws.on("close", () => {
        webClients.delete(ws);
      });

      return;
    }

    // ==================== DEVICE 端 ====================
    ws.clientType = "device";
    ws.deviceId = null;

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await handleMessage(ws, msg);
      } catch (e) {
        console.error("[WS] message parse error:", e.message);
      }
    });

    ws.on("close", async () => {
      if (ws.deviceId) {
        deviceClients.delete(ws.deviceId);

        try {
          const pool = await getPool();
          await pool.query(
            "UPDATE devices SET status='offline' WHERE device_id=?",
            [ws.deviceId]
          );
        } catch (e) {
          console.error("[WS] offline update error:", e.message);
        }

        // ⭐只通知订阅该设备的网页
        broadcastToWeb({
          type: "device_update",
          deviceId: ws.deviceId,
          status: "offline",
        });
      }
    });
  });

  // 心跳
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(pingInterval));

  console.log("[WS] WebSocket server attached on /ws");
  return wss;
}

// ==================== 消息处理 ====================

async function handleMessage(ws, msg) {
  const pool = await getPool();

  switch (msg.type) {

    // ============ 注册设备 ============
    case "register": {
      const { deviceId, model } = msg;
      if (!deviceId) return;

      ws.deviceId = deviceId;
      deviceClients.set(deviceId, ws);

      await pool.query(
        `INSERT INTO devices (device_id, model, status, last_online)
         VALUES (?, ?, 'online', ?)
         ON DUPLICATE KEY UPDATE model=VALUES(model), status='online', last_online=VALUES(last_online)`,
        [deviceId, model || "", Date.now()]
      );

      sendTo(ws, {
        type: "registered",
        success: true,
      });

      // ⭐只推送给订阅该设备的网页
      broadcastToWeb({
        type: "device_update",
        deviceId,
        status: "online",
        model: model || "",
      });

      break;
    }

    // ============ 心跳 ============
    case "heartbeat": {
      const { deviceId, currentFileId, step } = msg;
      if (!deviceId) return;

      await pool.query(
        `UPDATE devices SET status='online', last_online=?, current_file_id=?, current_step=?
         WHERE device_id=?`,
        [Date.now(), currentFileId || "", step || "", deviceId]
      );

      broadcastToWeb({
        type: "device_update",
        deviceId,
        status: "online",
        currentFileId: currentFileId || "",
        step: step || "",
      });

      break;
    }

    // ============ 进度 ============
    case "process_update": {
      const { deviceId, fileId, version, status, errorMsg } = msg;
      if (!deviceId || !fileId) return;

      await pool.query(
        `INSERT INTO file_process (file_id, device_id, version, status, error_msg)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE version=VALUES(version), status=VALUES(status), error_msg=VALUES(error_msg)`,
        [fileId, deviceId, version || 0, status || "pending", errorMsg || null]
      );

      broadcastToWeb({
        type: "process_update",
        deviceId,
        fileId,
        version: version || 0,
        status: status || "pending",
        errorMsg: errorMsg || "",
      });

      break;
    }

    // ============ 日志 ============
    case "log": {
      const { deviceId, level, message } = msg;
      if (!deviceId || !message) return;

      await pool.query(
        "INSERT INTO logs (device_id, level, message) VALUES (?, ?, ?)",
        [deviceId, level || "info", message]
      );

      broadcastToWeb({
        type: "new_log",
        deviceId,
        level: level || "info",
        message,
      });

      break;
    }
  }
}

// ==================== 工具函数 ====================

function sendTo(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// ⭐核心修复：设备订阅广播
function broadcastToWeb(data) {
  const payload = JSON.stringify(data);
  const deviceId = data.deviceId;
  if (!info.deviceId || !deviceId) continue;
  for (const [ws, info] of webClients) {
    if (ws.readyState !== 1) continue;

    // ⭐关键：只发给订阅该设备的网页
    if (
      info.deviceId &&
      deviceId &&
      String(info.deviceId) !== String(deviceId)
    ) {
      continue;
    }

    ws.send(payload);
  }
}

// ==================== 设备控制 ====================

function notifyDevice(deviceId, data) {
  const ws = deviceClients.get(deviceId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function notifyAllDevices(data) {
  const payload = JSON.stringify(data);
  for (const [, ws] of deviceClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function getOnlineDeviceIds() {
  return [...deviceClients.keys()];
}

// ==================== 导出 ====================

module.exports = {
  setupWebSocket,
  broadcastToWeb,
  notifyDevice,
  notifyAllDevices,
  getOnlineDeviceIds,
};