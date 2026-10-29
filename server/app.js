const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const devicesRoute = require("./routes/devices");
const controlRoute = require("./routes/control");
const authRoute = require("./routes/auth");
const uploadRoute = require("./routes/upload");
const usersRoute = require("./routes/users");
const { setupWebSocket } = require("./ws");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.locals.deviceToken = process.env.DEVICE_TOKEN || "device-token";
app.locals.adminToken = process.env.ADMIN_TOKEN || "admin-token";
app.locals.adminUsername = process.env.ADMIN_USERNAME || "admin";
app.locals.adminPassword = process.env.ADMIN_PASSWORD || "password";

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use("/api/auth", authRoute);
app.use("/api", devicesRoute);
app.use("/api", controlRoute);
app.use("/api", uploadRoute);
app.use("/api/users", usersRoute);

// ... 前面代码保持不变 ...

app.get("/api/speed-test-download", (req, res) => {
  const size = Math.min(parseInt(req.query.size) || 262144, 1048576);
  const buf = Buffer.alloc(size, 0x41);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
});

app.post("/api/speed-test-upload", (req, res) => {
  let bytes = 0;
  req.on("data", (chunk) => { bytes += chunk.length; });
  req.on("end", () => {
    res.json({ ok: true, bytes });
  });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const deviceManager = require("./ws/deviceManager");
const serverStartedAt = Date.now();

app.get("/api/health", (req, res) => {
  const stats = deviceManager.getServerStats();
  res.json({
    ok: true,
    timestamp: Date.now(),
    onlineDevices: stats.onlineDevices,
    uptime: Date.now() - serverStartedAt,
    port: PORT,
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;
const SSL_KEY_PATH =
  process.env.SSL_KEY_PATH || path.join(__dirname, "certs", "server.key");
const SSL_CERT_PATH =
  process.env.SSL_CERT_PATH || path.join(__dirname, "certs", "server.crt");

const os = require("os");

function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (
        alias.family === "IPv4" &&
        alias.address !== "127.0.0.1" &&
        !alias.internal
      ) {
        return alias.address;
      }
    }
  }
  return "localhost";
}

function loadTlsOptions() {
  if (!fs.existsSync(SSL_KEY_PATH) || !fs.existsSync(SSL_CERT_PATH)) {
    return null;
  }
  return {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH),
  };
}

function printBanner(lanIp, lines) {
  console.log("\x1b[36m%s\x1b[0m", "────────────────────────────────────────────────────────");
  console.log("\x1b[32m%s\x1b[0m", "  🚀 设备管理与群控后台，启动成功！");
  console.log("");
  for (const line of lines) {
    console.log("\x1b[37m%s\x1b[0m", `  ${line}`);
  }
  console.log("");
  console.log("\x1b[33m%s\x1b[0m", `  管理用户名: ${app.locals.adminUsername}`);
  console.log("\x1b[33m%s\x1b[0m", `  管理密码: ${app.locals.adminPassword}`);
  console.log("\x1b[36m%s\x1b[0m", "────────────────────────────────────────────────────────");
}

const lanIp = getNetworkIp();
const tls = loadTlsOptions();
const bannerLines = [];

const httpServer = http.createServer(app);
setupWebSocket(httpServer, app.locals);
httpServer.listen(PORT, "0.0.0.0", () => {
  bannerLines.push(`- HTTP 本地:   http://localhost:${PORT}`);
  bannerLines.push(`- HTTP 局域网: http://${lanIp}:${PORT}`);
  bannerLines.push(
    "  （HTTP 下浏览器无法 WebCodecs 解 H.264，控制页请用下方 HTTPS 或 WebP）"
  );
  if (!tls) {
    bannerLines.push(
      `- HTTPS: 未启用（将证书放到 certs/server.key + server.crt，见 scripts/gen-dev-cert.ps1）`
    );
    printBanner(lanIp, bannerLines);
  }
});

if (tls) {
  const httpsServer = https.createServer(tls, app);
  setupWebSocket(httpsServer, app.locals);
  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    const httpsLines = [
      `- HTTPS 本地:   https://localhost:${HTTPS_PORT}`,
      `- HTTPS 局域网: https://${lanIp}:${HTTPS_PORT}  ← 控制页 H.264 请用此地址`,
      "  （自签证书首次需在 Chrome 点「高级」→「继续访问」）",
    ];
    printBanner(lanIp, [...bannerLines, ...httpsLines]);
  });
}