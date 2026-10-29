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

router.get("/devices", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  return res.json(deviceManager.listDevicesForUser(requester));
});

router.get("/device/:id", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  const device = deviceManager.getDevice(req.params.id);
  if (!device) return res.status(404).json({ success: false, message: "设备未找到" });
  if (!deviceManager.canUserViewDevice(requester, device.deviceId)) {
    return res.status(403).json({ success: false, message: "无权查看该设备" });
  }
  res.json(device);
});

router.get("/device/:id/frame", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  const frame = deviceManager.getDeviceFrame(req.params.id);
  if (!frame) return res.status(404).json({ success: false, message: "未找到截图" });
  if (!deviceManager.canUserViewDevice(requester, req.params.id)) {
    return res.status(403).json({ success: false, message: "无权查看该设备截图" });
  }
  res.json({ deviceId: req.params.id, image: frame });
});

router.post("/device/:id/remark", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  const deviceId = req.params.id;
  if (!deviceManager.canUserViewDevice(requester, deviceId)) {
    return res.status(403).json({ success: false, message: "无权修改该设备" });
  }
  const remark = req.body.remark;
  if (typeof remark !== "string") {
    return res.status(400).json({ success: false, message: "remark 必须是字符串" });
  }
  const savedRemark = deviceManager.setDeviceRemark(deviceId, remark.trim());
  res.json({ success: true, deviceId, remark: savedRemark });
});

router.post("/device/:id/group", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  const deviceId = req.params.id;
  if (!deviceManager.canUserViewDevice(requester, deviceId)) {
    return res.status(403).json({ success: false, message: "无权修改该设备" });
  }
  const group = req.body.group;
  if (typeof group !== "string") {
    return res.status(400).json({ success: false, message: "group 必须是字符串" });
  }
  const savedGroup = deviceManager.setDeviceGroup(deviceId, group.trim());
  res.json({ success: true, deviceId, group: savedGroup });
});

router.get("/groups", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  const myDevicesData = deviceManager.listDevicesForUser(requester);
  if (requester.role === "root" || requester.isAdminToken) {
    return res.json({ groups: deviceManager.getGroupList() });
  }
  const groups = new Set(["UNGROUPED"]);
  myDevicesData.forEach((device) => {
    if (device.group) groups.add(device.group);
  });
  res.json({ groups: Array.from(groups).sort() });
});

router.get("/stats", authOrAdmin, (req, res) => {
  res.json({ success: true, stats: deviceManager.getServerStats() });
});

router.post("/stats/halve", authOrAdmin, (req, res) => {
  const stats = deviceManager.halveServerStats();
  res.json({ success: true, stats, message: "计数器已清理一半" });
});

router.delete("/device/:id", authOrAdmin, (req, res) => {
  const requester = getRequester(req);
  if (!requester) return res.status(401).json({ success: false, message: "unauthorized" });
  if (requester.role !== "root" && !requester.isAdminToken) {
    return res.status(403).json({ success: false, message: "仅主账号可删除设备" });
  }
  const deviceId = String(req.params.id || "").trim();
  if (!deviceId) {
    return res.status(400).json({ success: false, message: "missing deviceId" });
  }
  deviceManager.deleteDevicePermanently(deviceId);
  res.json({ success: true, deviceId });
});

module.exports = router;
