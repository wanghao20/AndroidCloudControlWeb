const path = require("path");

const appDir = __dirname;
const logsDir = path.join(appDir, "logs");

/**
 * PM2 启动配置（云控后台）
 *
 * 常用命令：
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 logs cloud-control-web
 *   pm2 restart cloud-control-web
 *   pm2 stop cloud-control-web
 *   pm2 save && pm2 startup
 *
 * 环境变量：在同目录 .env 中配置（app.js 已通过 dotenv 加载）
 *   PORT / HTTPS_PORT / JWT_SECRET / DEVICE_TOKEN / ADMIN_TOKEN 等
 */
module.exports = {
  apps: [
    {
      name: "cloud-control-web",
      script: path.join(appDir, "app.js"),
      cwd: appDir,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 8000,
      listen_timeout: 15000,
      time: true,
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: path.join(logsDir, "pm2-error.log"),
      out_file: path.join(logsDir, "pm2-out.log"),
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
