const express = require("express");
const router = express.Router();
const usersStore = require("../usersStore");
const { verifyToken, requireRoot } = require("../middleware/auth");

function adminOrRoot(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query?.token || req.body?.token;
  if (token && token === process.env.ADMIN_TOKEN) return next();
  // else require JWT root
  verifyToken(req, res, () => {
    if (req.user && req.user.role === "root") return next();
    return res.status(403).json({ success: false, message: "require root" });
  });
}

router.get("/", adminOrRoot, (req, res) => {
  const list = usersStore.getAllUsers();
  res.json(list);
});

router.post("/create", adminOrRoot, (req, res) => {
  const { username, password, maxDevices, days } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "missing fields" });
  const expireAt = typeof days === "number" && days > 0 ? Date.now() + days * 24 * 3600 * 1000 : -1;
  const user = usersStore.createUser({ username, password, role: "sub", maxDevices: typeof maxDevices === "number" ? maxDevices : -1, expireAt });
  res.json({ success: true, user });
});

router.post("/delete", adminOrRoot, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "missing id" });
  const target = usersStore.findUserById(id);
  if (!target) return res.status(404).json({ success: false, message: "user not found" });
  if (target.role === "root") return res.status(403).json({ success: false, message: "root user cannot be deleted" });
  usersStore.deleteUser(id);
  res.json({ success: true });
});

router.post("/update", adminOrRoot, (req, res) => {
  const { id, password, maxDevices, expireAt, disabled } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "missing id" });
  const target = usersStore.findUserById(id);
  if (!target) return res.status(404).json({ success: false, message: "user not found" });
  if (target.role === "root") return res.status(403).json({ success: false, message: "root user cannot be modified" });
  const data = {};
  if (password) data.password = password;
  if (typeof maxDevices === "number") data.maxDevices = maxDevices;
  if (typeof expireAt === "number") data.expireAt = expireAt;
  if (typeof disabled === "boolean") data.disabled = disabled;
  const user = usersStore.updateUser(id, data);
  res.json({ success: true, user });
});

module.exports = router;
