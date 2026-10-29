const express = require("express");
const router = express.Router();
const deviceManager = require("../ws/deviceManager");
const { requireAdminToken } = require("./auth");
const { verifyToken } = require("../middleware/auth");

function authOrAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token || req.body.token;
  if (token && token === process.env.ADMIN_TOKEN) {
    req.user = { role: "root", isAdminToken: true };
    return next();
  }
  return verifyToken(req, res, next);
}

function getRequester(req) {
  if (req.user) return req.user;
  return null;
}

router.post("/control", authOrAdmin, (req, res) => {
  const { deviceId, type, x, y, x1, y1, x2, y2, duration, text } = req.body;
  if (!deviceId || !type) {
    return res.status(400).json({ success: false, message: "deviceId 和 type 为必填项" });
  }
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  if (!deviceManager.canUserViewDevice(requester, deviceId)) {
    return res.status(403).json({ success: false, message: "无权控制该设备" });
  }

  const command = { type };
  if (x !== undefined) command.x = x;
  if (y !== undefined) command.y = y;
  if (x1 !== undefined) command.x1 = x1;
  if (y1 !== undefined) command.y1 = y1;
  if (x2 !== undefined) command.x2 = x2;
  if (y2 !== undefined) command.y2 = y2;
  if (duration !== undefined) command.duration = duration;
  if (text !== undefined) command.text = text;

  const success = deviceManager.sendControl(deviceId, command);
  if (!success) {
    return res.status(404).json({ success: false, message: "设备离线或指令发送失败" });
  }

  res.json({ success: true, command });
});

/**
 * 批量控制接口 - 同时向多个设备发送相同的控制指令
 * 请求体格式:
 * {
 *   "deviceIds": ["device1", "device2", ...],
 *   "type": "click" | "swipe" | "input" | "longClick" | "key",
 *   "x": number,
 *   "y": number,
 *   ... 其他参数
 * }
 */
router.post("/control/batch", authOrAdmin, (req, res) => {
  const { deviceIds, type, x, y, x1, y1, x2, y2, duration, text } = req.body;
  
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return res.status(400).json({ success: false, message: "deviceIds 必须是非空数组" });
  }
  if (!type) {
    return res.status(400).json({ success: false, message: "type 为必填项" });
  }

  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });

  let targetIds = deviceIds;
  if (!(requester.role === "root" || requester.isAdminToken)) {
    targetIds = deviceIds.filter((d) => deviceManager.canUserViewDevice(requester, d));
    if (targetIds.length === 0) return res.status(403).json({ success: false, message: "无可操作的设备" });
  }

  const command = { type };
  if (x !== undefined) command.x = x;
  if (y !== undefined) command.y = y;
  if (x1 !== undefined) command.x1 = x1;
  if (y1 !== undefined) command.y1 = y1;
  if (x2 !== undefined) command.x2 = x2;
  if (y2 !== undefined) command.y2 = y2;
  if (duration !== undefined) command.duration = duration;
  if (text !== undefined) command.text = text;
  const result = deviceManager.sendBatchControl(targetIds, command);
  const allFailed = result.success === 0 && result.failed > 0;

  res.status(allFailed ? 502 : 200).json({
    success: !allFailed,
    summary: `成功 ${result.success}/${targetIds.length} 台，失败 ${result.failed} 台`,
    result,
    failedIds: result.failedIds || [],
  });
});

module.exports = router;
