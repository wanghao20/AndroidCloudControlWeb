const jwt = require("jsonwebtoken");
const usersStore = require("../usersStore");

const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, Object.assign({ expiresIn: "30d" }, opts));
}

function verifyToken(req, res, next) {
  const auth = req.headers["authorization"] || req.query?.token || req.body?.token || req.headers["x-admin-token"];
  if (!auth) return res.status(401).json({ success: false, message: "missing token" });
  let token = auth;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) token = auth.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.userId || payload.id;
    const user = usersStore.findUserById(userId) || usersStore.findUser(payload.username);
    if (!user) return res.status(401).json({ success: false, message: "user not found" });
    if (user.disabled) return res.status(403).json({ success: false, message: "user disabled" });
    if (user.expireAt !== -1 && Date.now() > user.expireAt) return res.status(403).json({ success: false, message: "user expired" });
    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "invalid token" });
  }
}

function requireRoot(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: "missing user" });
  if (req.user.role !== "root") return res.status(403).json({ success: false, message: "require root" });
  next();
}

module.exports = { signToken, verifyToken, requireRoot };
