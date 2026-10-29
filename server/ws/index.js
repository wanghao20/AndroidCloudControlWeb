const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const usersStore = require("../usersStore");
const {
    addDevice,
    removeDevice,
    queueDeviceFrameBroadcast,
    broadcastJsonDeviceFrame,
    updateDeviceDisplay,
    suggestCaptureProfile,
    setWebClientThumbSubscription,
    clearDeviceBroadcastState,
    updateDevicePing,
    getDevices,
    getDevice,
    listDevicesForUser,
    canUserViewDevice,
    hasDevice,
    sendControl,
    sendBatchControl,
    broadcastToWeb,
    registerWebClient,
    removeWebClient,
    applyDeviceUploadPolicy,
    hasWebViewer,
    countControlViewers,
    getDeviceUploadPolicyApplied,
    isDeviceUnderActiveControl,
    bindWebClientControlSession,
    broadcastDevicePing,
    broadcastAudioPacket,
} = require("./deviceManager");
const { parseDeviceFramePacket, parseDeviceAudioPacket } = require("./frameProtocol");

function setupWebSocket(server, locals) {
    const wss = new WebSocketServer({
        server,
        path: "/ws",
        /** 已压缩的 WebP/H.264 再 deflate 只会更慢，关闭以降延迟 */
        perMessageDeflate: false,
        /** ui_nodes 含 JPEG Base64，需大于单帧投屏 JSON */
        maxPayload: 2 * 1024 * 1024,
    });

    wss.on("connection", (ws, req) => {
          // 禁用 Nagle 算法，减少小包延迟
          if (req.socket) {
              req.socket.setNoDelay(true);
          }

          const url = new URL(req.url, `http://${req.headers.host}`);
          const clientType = url.searchParams.get("clientType") || "web";
          const token = url.searchParams.get("token") || "";
          const username = url.searchParams.get("username") || null;

        ws.isAlive = true;
        ws.on("pong", () => {
            ws.isAlive = true;
        });

        if (clientType === "device") {
          if (token !== locals.deviceToken) {
            ws.close(1008, "invalid device token");
            return;
          }
          ws.clientType = "device";
          ws.username = username ? String(username).trim() : null;
          ws.on("message", (raw) => handleDeviceMessage(ws, raw));
          ws.on("close", () => {
            if (ws.deviceId) {
              clearDeviceBroadcastState(ws.deviceId);
              removeDevice(ws.deviceId);
              broadcastToWeb(ws.deviceId, { type: "device_disconnected", deviceId: ws.deviceId });
            }
          });
        } else {
          let wsUser = null;
          if (token === locals.adminToken) {
            wsUser = { role: "root", isAdminToken: true };
          } else if (token) {
            try {
              const payload = jwt.verify(token, process.env.JWT_SECRET || "secret-key");
              const userId = payload.userId || payload.id;
              const user = usersStore.findUserById(userId) || usersStore.findUser(payload.username);
              if (!user) throw new Error("user not found");
              if (user.disabled) throw new Error("user disabled");
              if (user.expireAt !== -1 && Date.now() > user.expireAt) throw new Error("user expired");
              wsUser = { id: user.id, username: user.username, role: user.role };
            } catch (err) {
              console.warn("[WS] invalid web token", err.message);
              ws.close(1008, "invalid web token");
              return;
            }
          } else {
            const userAgent = req.headers['user-agent'] || '';
            const isAndroid = /android|mobile|phone/i.test(userAgent);
            const clientDesc = isAndroid ? "安卓手机" : "浏览器";
            const clientIp = req.socket.remoteAddress || "unknown";
            console.warn(`[WS] ${clientDesc}客户端无效连接 - 缺少token (IP: ${clientIp}, UA: ${userAgent.substring(0, 50)})`);
            ws.close(1008, "missing web token");
            return;
          }

          ws.clientType = "web";
          ws.user = wsUser;
          const deviceId = url.searchParams.get("deviceId");
          registerWebClient(ws, deviceId, wsUser);
          const devicesToSend = listDevicesForUser(wsUser);
          if (wsUser.role === "sub") {
            console.log(
              `[WS] 子账号列表 user=${wsUser.username} id=${wsUser.id} devices=${devicesToSend.length}`
            );
          }
          ws.send(JSON.stringify({ type: "device_list", devices: devicesToSend }));
          ws.on("message", (raw) => handleWebMessage(ws, raw));
          ws.on("close", () => removeWebClient(ws));
        }
    });

    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on("close", () => clearInterval(heartbeat));
    console.log("[WS] WebSocket server attached on /ws");
    return wss;
}
function handleDeviceMessage(ws, raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  if (buf.length >= 1 && buf[0] === 0xf3) {
    const audio = parseDeviceAudioPacket(buf);
    if (audio) {
      const currentDeviceId = audio.deviceId || ws.deviceId;
      if (!currentDeviceId) return;
      ws.deviceId = ws.deviceId || currentDeviceId;
      updateDevicePing(currentDeviceId);
      broadcastAudioPacket(currentDeviceId, buf);
      return;
    }
  }

  const binaryFrame = parseDeviceFramePacket(buf);
  if (binaryFrame) {
    const currentDeviceId = binaryFrame.deviceId || ws.deviceId;
    if (!currentDeviceId) return;
    ws.deviceId = ws.deviceId || currentDeviceId;
    updateDevicePing(currentDeviceId);
    queueDeviceFrameBroadcast(
      currentDeviceId,
      binaryFrame.imageData,
      binaryFrame.format
    );
    return;
  }

  let msg;
  try {
    const rawStr = buf.toString("utf8");
    msg = JSON.parse(rawStr);
  } catch (error) {
    console.warn("[WS] invalid device message", error.message);
    return;
  }

  const currentDeviceId = msg.deviceId || msg.device_id || ws.deviceId;
  if (!currentDeviceId) return;

  if (msg.type === "frame" && !ws._frameLogCount) {
    ws._frameLogCount = 0;
  }
  if (msg.type === "frame") {
    ws._frameLogCount = (ws._frameLogCount || 0) + 1;
    if (ws._frameLogCount <= 3) {
      console.log(`[WS] 设备 ${currentDeviceId} JSON frame #${ws._frameLogCount} image=${String(msg.image || "").length} chars`);
    }
  }
  if (!currentDeviceId) return;

  switch (msg.type) {
    case "register": {
      const username = ws.username || null;
      // 验证 owner 与 username
      const owner = msg.owner || null;
      if (!username) {
        ws.send(JSON.stringify({ type: "error", message: "missing username in ws query" }));
        ws.close();
        return;
      }
      if (!owner || String(owner).trim() !== String(username).trim()) {
        ws.send(JSON.stringify({ type: "error", message: "register.owner must equal username" }));
        ws.close();
        return;
      }
      // lazy-require usersStore to avoid circular deps
      const usersStore = require("../usersStore");
      const user = usersStore.findUser(username);
      if (!user) {
        ws.send(JSON.stringify({ type: "error", message: "user not found" }));
        ws.close();
        return;
      }
      if (user.disabled) {
        ws.send(JSON.stringify({ type: "error", message: "user disabled" }));
        ws.close();
        return;
      }
      if (user.expireAt !== -1 && Date.now() > user.expireAt) {
        ws.send(JSON.stringify({ type: "error", message: "user expired" }));
        ws.close();
        return;
      }

      // 子账号不能抢占其他子账号的设备；若设备仅在 root 名下，允许子账号按手机填写的账号接管
      const ownerId = usersStore.findDeviceOwner(currentDeviceId);
      if (ownerId && ownerId !== user.id && user.role !== "root") {
        const ownerUser = usersStore.findUserById(ownerId);
        if (ownerUser && ownerUser.role !== "root") {
          ws.send(JSON.stringify({ type: "error", message: "设备已归属其他账号" }));
          ws.close();
          return;
        }
      }

      // 设备数量限制：按在线设备数统计，避免离线/历史绑定设备导致误判
      if (user.role !== "root" && user.maxDevices !== -1) {
        const list = usersStore.getUserDevices(user.id) || [];
        const onlineCount = list.filter((d) => hasDevice(d)).length;
        if (!list.includes(currentDeviceId) && onlineCount >= user.maxDevices) {
          ws.send(JSON.stringify({ type: "error", message: "设备数量达到上限" }));
          ws.close();
          return;
        }
      }

      // 绑定设备到用户
      usersStore.bindDevice(user.id, currentDeviceId);

      ws.deviceId = currentDeviceId;
      const ownerName = String(user.username).trim();
      addDevice(currentDeviceId, ws, Object.assign({}, msg, { owner: ownerName }));
      console.log(
        `[WS] 设备注册 deviceId=${currentDeviceId} owner=${ownerName} userId=${user.id} role=${user.role} wsQuery=${username}`
      );
      applyDeviceUploadPolicy(currentDeviceId, "设备上线");
      ws.send(JSON.stringify({ type: "registered", success: true }));
      const registeredDevice = getDevice(currentDeviceId);
      broadcastToWeb(currentDeviceId, {
        type: "device_registered",
        deviceId: currentDeviceId,
        device: registeredDevice,
      });
      break;
    }

    case "frame": {
      const rawImage = msg.image || msg.img || msg.data;
      if (!rawImage) return;
      updateDevicePing(currentDeviceId);
      const delivered = broadcastJsonDeviceFrame(currentDeviceId, rawImage);
      if (!ws._frameLoggedOnce && delivered) {
        ws._frameLoggedOnce = true;
        console.log(
          `[WS] 设备 ${currentDeviceId} 首帧 JSON frame 已收到并广播 (${String(rawImage).length} chars)`
        );
      }
      break;
    }

    case "ui_nodes": {
      broadcastToWeb(currentDeviceId, {
        type: "device_ui_nodes",
        deviceId: String(currentDeviceId),
        nodes: msg.nodes || msg.data || msg.payload || null,
        root: msg.root || null,
        image: msg.image || null,
        imageWidth: msg.imageWidth || msg.image_width || 0,
        imageHeight: msg.imageHeight || msg.image_height || 0,
        imageSource: msg.imageSource || msg.image_source || "",
        screenWidth: msg.screenWidth || msg.screen_width || 0,
        screenHeight: msg.screenHeight || msg.screen_height || 0,
        timestamp: msg.timestamp || Date.now(),
        raw: msg,
      });
      break;
    }

    case "screenshot": {
      broadcastToWeb(currentDeviceId, {
        type: "device_screenshot",
        deviceId: String(currentDeviceId),
        image: msg.image || null,
        imageWidth: msg.imageWidth || msg.image_width || 0,
        imageHeight: msg.imageHeight || msg.image_height || 0,
        screenWidth: msg.screenWidth || msg.screen_width || 0,
        screenHeight: msg.screenHeight || msg.screen_height || 0,
        imageSource: msg.imageSource || msg.image_source || "",
        timestamp: msg.timestamp || Date.now(),
        raw: msg,
      });
      break;
    }

    case "screenshot_error": {
      broadcastToWeb(currentDeviceId, {
        type: "device_screenshot_error",
        deviceId: String(currentDeviceId),
        error: msg.error || msg.message || "设备返回截图失败",
        raw: msg,
      });
      break;
    }

    case "ui_nodes_error": {
      broadcastToWeb(currentDeviceId, {
        type: "device_ui_nodes_error",
        deviceId: String(currentDeviceId),
        error: msg.error || msg.message || "设备返回节点信息失败",
        raw: msg,
      });
      break;
    }

    case "clipboard": {
      broadcastToWeb(currentDeviceId, {
        type: "device_clipboard",
        deviceId: String(currentDeviceId),
        text: msg.text != null ? String(msg.text) : "",
        source: msg.source || "",
        restrictedHint: msg.restrictedHint || msg.hint || "",
        timestamp: msg.timestamp || Date.now(),
        raw: msg,
      });
      break;
    }

    case "clipboard_error": {
      broadcastToWeb(currentDeviceId, {
        type: "device_clipboard_error",
        deviceId: String(currentDeviceId),
        error: msg.error || msg.message || "读取设备剪切板失败",
        raw: msg,
      });
      break;
    }

    case "display_update": {
      const updated = updateDeviceDisplay(currentDeviceId, msg);
      if (updated) {
        broadcastToWeb(currentDeviceId, {
          type: "device_display_update",
          deviceId: String(currentDeviceId),
          device: updated,
          width: updated.width,
          height: updated.height,
          orientation: updated.orientation,
        });
      }
      break;
    }

    case "ping": {
      updateDevicePing(currentDeviceId);
      const id = String(currentDeviceId);
      const underControl = isDeviceUnderActiveControl(id);
      if (!underControl) {
        applyDeviceUploadPolicy(id, "心跳对齐上传策略");
      }
      const captureProfile = underControl ? "high" : suggestCaptureProfile(id);
      if (underControl && captureProfile !== "high") {
        console.warn(
          `[StreamDiag] 设备 ${id} 控制中 viewers=${countControlViewers(id)} policy=${getDeviceUploadPolicyApplied(id)} 已强制 high`
        );
      }
      ws.send(JSON.stringify({
        type: "pong",
        captureProfile,
        serverTs: Date.now(),
      }));
      broadcastDevicePing(id, captureProfile, {
        screenWidth: msg.screenWidth || msg.screen_width,
        screenHeight: msg.screenHeight || msg.screen_height,
      });
      break;
    }

    default: {
      console.warn("[WS] unsupported device message type:", msg.type);
    }
  }
}




function handleWebMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch (error) {
        console.warn("[WS] invalid web message", error.message);
        return;
    }

    if (msg.type === "subscribe_control") {
        const targetId = String(msg.deviceId || msg.device_id || "");
        if (!targetId) {
            ws.send(JSON.stringify({ type: "error", message: "missing deviceId" }));
            return;
        }
        bindWebClientControlSession(ws, targetId, "subscribe_control");
        ws.send(
            JSON.stringify({
                type: "subscribe_control_ack",
                deviceId: targetId,
                captureProfile: "high",
            })
        );
        return;
    }

    if (msg.type === "subscribe_thumbnails") {
        const deviceIds = Array.isArray(msg.deviceIds) ? msg.deviceIds : [];
        const result = setWebClientThumbSubscription(ws, deviceIds);
        ws.send(JSON.stringify({
            type: "subscribe_thumbnails_ack",
            count: result.accepted.length,
            requested: deviceIds.length,
            capped: result.capped,
            maxPerUser: result.maxPerUser,
        }));
        return;
    }

    if (msg.type === "control") {
        if (!msg.command) {
            ws.send(JSON.stringify({ type: "error", message: "missing command" }));
            return;
        }

        const user = ws.user || {};
        const isRoot = user.role === "root" || user.isAdminToken;

        if (Array.isArray(msg.deviceIds) && msg.deviceIds.length > 0) {
            let deviceIds = msg.deviceIds;
            if (!isRoot) {
              deviceIds = deviceIds.filter((id) => canUserViewDevice(user, id));
              if (deviceIds.length === 0) {
                ws.send(JSON.stringify({ type: "error", message: "无权控制任何设备" }));
                return;
              }
            }
            const result = sendBatchControl(deviceIds, msg.command);
            ws.send(
                JSON.stringify({
                    type: "control_ack",
                    deviceIds,
                    command: msg.command,
                    result,
                })
            );
            return;
        }

        if (!msg.deviceId) {
            ws.send(JSON.stringify({ type: "error", message: "missing deviceId" }));
            return;
        }

        if (!isRoot && !canUserViewDevice(user, msg.deviceId)) {
          ws.send(JSON.stringify({ type: "error", message: "无权控制该设备" }));
          return;
        }

        const success = sendControl(msg.deviceId, msg.command);
        ws.send(JSON.stringify({ type: "control_ack", deviceId: msg.deviceId, success }));
        return;
    }

    ws.send(JSON.stringify({ type: "error", message: "unsupported web message type" }));
}

module.exports = { setupWebSocket };
