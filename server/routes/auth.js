const express = require("express");
const router = express.Router();
const usersStore = require("../usersStore");
const { signToken } = require("../middleware/auth");

// POST /api/auth/login
router.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = usersStore.findUser(username);
  if (!user) return res.status(401).json({ success: false, message: "用户名或密码错误" });
  if (user.password !== password) return res.status(401).json({ success: false, message: "用户名或密码错误" });
  if (user.disabled) return res.status(403).json({ success: false, message: "用户被禁用" });
  if (user.expireAt !== -1 && Date.now() > user.expireAt) return res.status(403).json({ success: false, message: "用户已过期" });

  if (user.role === "sub") {
    usersStore.claimDevicesForSubUser(user);
  }

  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  const deviceCount =
    user.role === "sub" ? (usersStore.getUserDevices(user.id) || []).length : undefined;
  res.json({ success: true, token, role: user.role, expireAt: user.expireAt, deviceCount });
});

// 保留原来的简单 admin token 检查（兼容旧管理端）
function requireAdminToken(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token || req.body.token;
  if (token && token === process.env.ADMIN_TOKEN) return next();
  return res.status(401).json({ success: false, message: "无效的管理令牌" });
}

module.exports = router;
module.exports.requireAdminToken = requireAdminToken;
