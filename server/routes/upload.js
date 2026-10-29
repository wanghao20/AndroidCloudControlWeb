const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const deviceManager = require("../ws/deviceManager");
const { requireAdminToken } = require("./auth");
const { verifyToken } = require("../middleware/auth");

function getServerBaseUrl(req) {
  const hostHeader = req.get("host") || "";
  const defaultPort = req.socket.localPort || process.env.PORT || 3000;
  let host = hostHeader.split(":")[0] || "";

  const configuredHost = process.env.SERVER_HOST || process.env.HOST;
  if (configuredHost) {
    host = configuredHost;
  }

  if (!host || host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === "IPv4" && !net.internal) {
          host = net.address;
          break;
        }
      }
      if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
        break;
      }
    }
  }

  if (!host) {
    host = "127.0.0.1";
  }

  return `${req.protocol}://${host}:${defaultPort}`;
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || ""));
  return base.replace(/[\u0000-\u001f<>:"/\\|?*\u2028\u2029]/gu, "_");
}

function getServerBaseUrl(req) {
  const hostHeader = req.get("host") || "";
  const defaultPort = req.socket.localPort || process.env.PORT || 3000;
  let host = hostHeader.split(":")[0] || "";

  const configuredHost = process.env.SERVER_HOST || process.env.HOST;
  if (configuredHost) {
    host = configuredHost;
  }

  if (!host || host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === "IPv4" && !net.internal) {
          host = net.address;
          break;
        }
      }
      if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
        break;
      }
    }
  }

  if (!host) {
    host = "127.0.0.1";
  }

  return `${req.protocol}://${host}:${defaultPort}`;
}

// 确保 uploads 目录存在
const uploadsDir = path.join(__dirname, "..", "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // 保持原始文件名，但为避免冲突，前缀时间戳
    const safeName = `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    cb(null, safeName);
  }
});

const upload = multer({ storage });

/**
 * 单文件上传并下发
 * 请求表单: form-data, 字段: file(必需), deviceId 或 group(二选一)
 */
function authOrAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token || req.body.token;
  if (token && token === process.env.ADMIN_TOKEN) {
    req.user = { role: "root", isAdminToken: true };
    return next();
  }
  return verifyToken(req, res, next);
}

router.post("/upload", authOrAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "missing file" });

  const { deviceId, group } = req.body;
  if (!deviceId && !group) {
    return res.status(400).json({ success: false, message: "missing deviceId or group" });
  }

  const originalName = path.basename(req.file.originalname || req.file.filename || "file");
  const storedName = `${Date.now()}_${sanitizeFileName(originalName)}`;
  const targetPath = path.join(uploadsDir, storedName);
  fs.renameSync(req.file.path, targetPath);

  const fileUrl = `${getServerBaseUrl(req)}/uploads/${storedName}`;
  const payload = { type: "download", url: fileUrl, fileName: originalName };

  // deviceId 模式：校验权限
  if (deviceId) {
    const token = req.headers["x-admin-token"] || req.query.token || req.body.token;
    const isAdminToken = token && token === process.env.ADMIN_TOKEN;
    const requester = isAdminToken ? { role: "root", isAdminToken: true } : (req.user || null);
    if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
    if (!deviceManager.canUserViewDevice(requester, deviceId)) {
      return res.status(403).json({ success: false, message: "无权发送到该设备" });
    }
    const ok = deviceManager.sendRaw(deviceId, payload);
    console.log(`[upload] deviceId=${deviceId} fileUrl=${fileUrl} sendOk=${ok}`);
    if (!ok) return res.status(500).json({ success: false, message: "device offline or send failed" });
    return res.json({ success: true, target: deviceId, url: fileUrl });
  }

  // group 模式：找到分组内在线设备并群发
  // group 模式：如果是子账号，仅下发给该子账号的设备
  const token = req.headers["x-admin-token"] || req.query.token || req.body.token;
  const isAdminToken = token && token === process.env.ADMIN_TOKEN;
  const requester = isAdminToken ? { role: "root", isAdminToken: true } : (req.user || null);
  let devices = deviceManager.listDevicesForUser(requester);
  devices = devices.filter((d) => {
    if (group === "UNGROUPED") {
      return !d.group && d.online;
    }
    return String(d.group) === String(group) && d.online;
  }).map(d => d.deviceId);
  if (devices.length === 0) return res.status(404).json({ success: false, message: "no online devices in group" });

  const result = deviceManager.sendBatchRaw(devices, payload);
  console.log(`[upload] group=${group} url=${fileUrl} sent=${result.success} failed=${result.failed} failedIds=${result.failedIds.join(",")}`);
  res.json({ success: true, group, url: fileUrl, result });
});

module.exports = router;
