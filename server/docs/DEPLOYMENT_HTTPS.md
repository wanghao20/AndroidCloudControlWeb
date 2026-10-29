# 群控后台部署：Cloudflare Tunnel / Nginx / HTTPS

域名示例：**whnetcn.top**  
Node 服务默认监听：**3000**（仅本机 `127.0.0.1`，不对外暴露也可）  
WebSocket 路径：**/ws**

---

## 架构选型（三选一）

| 方案 | 用户访问 | 服务器要开的端口 | H.264（WebCodecs） | 推荐场景 |
|------|----------|------------------|-------------------|----------|
| **A. Cloudflare Tunnel** | `https://whnetcn.top` | 无需公网 80/443（出站即可） | 支持 | **当前推荐**（已用） |
| **B. Nginx 反代 + Certbot** | `https://whnetcn.top` | 80、443 | 支持 | 自有 VPS、不用 Tunnel |
| **C. Node 自签 HTTPS** | `https://IP:3443` | 3443（局域网） | 支持 | 内网调试 |

**注意：**

- 浏览器控制页在 **HTTP** 下无法使用 WebCodecs 解 H.264，需 **HTTPS** 或走 WebP。
- 手机 App WebSocket 填 **`wss://whnetcn.top/ws`**，不是 `https://`，也不是 `:3000`。
- Tunnel 方案下 **不需要** 在服务器上再配 Certbot（HTTPS 由 Cloudflare 边缘提供）。

---

## 0. 通用：启动 Node 服务

```bash
cd /path/to/cloudControlWeb/server
npm install
cp .env.example .env   # 如有；至少配置 PORT、ADMIN_*、DEVICE_TOKEN
npm start
# 或: pm2 start app.js --name cloud-control
```

验证本机：

```bash
curl -sI http://127.0.0.1:3000/api/health | head -3
# 期望: HTTP/1.1 200 OK
```

`.env` 示例：

```env
PORT=3000
HOST=0.0.0.0
ADMIN_USERNAME=wh
ADMIN_PASSWORD=wh231951
ADMIN_TOKEN=admin-token
DEVICE_TOKEN=wanghaonet-device-token
```

---
 域名链接ip 免备案
## 方案 A：Cloudflare Tunnel（whnetcn.top）

### A.1 安装 cloudflared（CentOS Stream 9 / RHEL9）

```bash
# 官方 yum 源（示例，以 Cloudflare 文档为准）
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
# 按 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 安装

cloudflared --version
```

### A.2 登录并创建 Tunnel（首次）

```bash
cloudflared tunnel login
cloudflared tunnel create whnetcn
```

记下：

- Tunnel 名称：`whnetcn`
- 凭证 JSON 路径（示例）：`/root/.cloudflared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json`

### A.3 配置文件

```bash
mkdir -p /etc/cloudflared

cat << 'EOF' > /etc/cloudflared/config.yml
tunnel: whnetcn
credentials-file: /root/.cloudflared/5b86c3d2-e28b-4554-a8e5-eac5dfbd0d06.json

ingress:
  - hostname: whnetcn.top
    service: http://127.0.0.1:3000
    originRequest:
      connectTimeout: 30s
      noTLSVerify: true

  - service: http_status:404
EOF
```

> 将 `credentials-file` 换成你机器上真实的 JSON 路径。

### A.4 绑定 DNS（Cloudflare 自动 CNAME）

```bash
cloudflared tunnel route dns whnetcn whnetcn.top
```

成功后，Cloudflare DNS 会出现指向 Tunnel 的 **CNAME** 记录。

### A.5 systemd 服务（已安装则勿重复 install）

```bash
# 若提示 service already installed，跳过 install，只执行下面三行
# cloudflared service uninstall   # 仅确实要重装时用

systemctl enable cloudflared
systemctl restart cloudflared
systemctl status cloudflared
```

查看日志：

```bash
journalctl -u cloudflared -n 50 --no-pager
```

### A.6 Cloudflare 面板必开项

1. 域名 **SSL/TLS** → 加密模式：**灵活** 或 **完全**（源站 `http://127.0.0.1:3000` 时常用 **灵活**）。
2. **网络** → 打开 **WebSockets**（群控 `/ws` 必须）。
3. 可选：**SSL/TLS** → 始终使用 HTTPS。

### A.7 验证 HTTPS 已通

```bash
curl -sI https://whnetcn.top/api/health | head -5
# 期望: HTTP/2 200
```

浏览器打开：**https://whnetcn.top/**

控制台检查 WebCodecs：

```javascript
location.protocol        // "https:"
window.isSecureContext   // true
typeof VideoDecoder      // "function"
```

### A.8 防火墙（Tunnel 方案）

公网 **不必** 开放 80/443 到这台 VPS（流量走 Cloudflare 出站隧道）。  
只需保证服务器能访问 Cloudflare，且本机 **3000** 有 Node 在跑。

---

## 方案 B：Nginx 默认 80 + HTTPS 443（不用 Tunnel）

适用于：域名 DNS **直接解析到服务器 IP**，走 Nginx 反代。

### B.1 安装 Nginx

```bash
sudo dnf install -y nginx
sudo systemctl enable nginx
```

### B.2 HTTP 80 反代（申请证书前也要能访问）

```bash
sudo tee /etc/nginx/conf.d/whnetcn.conf <<'EOF'
server {
    listen 80;
    server_name whnetcn.top;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3000/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
EOF

sudo nginx -t
sudo systemctl reload nginx
```

验证 80：

```bash
curl -sI http://whnetcn.top/api/health | head -3
```

### B.3 防火墙放行 80 / 443

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

云安全组同样放行 **80、443**。

### B.4 安装 Certbot 并开启 HTTPS（CentOS Stream 9）

```bash
sudo dnf install -y epel-release
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d whnetcn.top
```

按提示选择 **Redirect（强制跳转 HTTPS）**。

续期：

```bash
sudo systemctl enable certbot-renew.timer
sudo certbot renew --dry-run
```

### B.5 验证 HTTPS

```bash
curl -sI https://whnetcn.top/api/health | head -5
```

---

## 方案 C：Node 本机自签 HTTPS（仅局域网调试）

```bash
# Windows 开发机
powershell -ExecutionPolicy Bypass -File .\scripts\gen-dev-cert.ps1

# Linux（需 openssl）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/server.key -out certs/server.crt \
  -days 825 -nodes -subj "/CN=192.168.3.100"
```

将 `certs/server.key`、`certs/server.crt` 放到 `server/certs/` 后重启：

```bash
npm start
# 额外监听 HTTPS_PORT，默认 3443
```

访问：`https://局域网IP:3443/`（浏览器需手动信任自签证书）。

---

## 端口对照表

| 端口 | 用途 |
|------|------|
| **3000** | Node（`app.js`），Tunnel/Nginx 反代目标 |
| **80** | Nginx HTTP（方案 B，Certbot 验证用） |
| **443** | Nginx HTTPS 或用户访问 Cloudflare 边缘 |
| **3443** | Node 自签 HTTPS（方案 C，可选） |

Tunnel 方案：**对外不监听 80/443**，用户仍通过 `https://whnetcn.top`（Cloudflare 边缘 443）访问。

---

## 手机端与网页地址

| 端 | 地址 |
|----|------|
| 管理网页 | https://whnetcn.top/ |
| 控制页 | https://whnetcn.top/device.html?id=设备ID |
| 手机 WebSocket（代码默认） | **wss://whnetcn.top/ws** |
| 手机 deviceToken | 与服务器 `.env` 中 `DEVICE_TOKEN` 一致 |

Android `MyUtils.kt` 默认：

```text
wss://whnetcn.top/ws
```

---

## 常用运维命令速查

```bash
# Node / pm2
pm2 status
pm2 logs cloud-control
pm2 restart cloud-control

# Cloudflare Tunnel
systemctl status cloudflared
systemctl restart cloudflared
journalctl -u cloudflared -f

# Nginx
sudo nginx -t
sudo systemctl reload nginx
sudo tail -f /var/log/nginx/error.log

# 健康检查
curl -s http://127.0.0.1:3000/api/health
curl -sI https://whnetcn.top/api/health
```

---

## 外网投屏延迟 / 卡顿检查清单

**现象对照：** 局域网 `ws://192.168.3.100:3000` 滑动流畅，换 **whnetcn.top + Cloudflare** 后画面慢、控起来慢半拍 —— 多数是 **公网路径延迟**，不是本地代码坏了。

**数据路径简述：**

```text
局域网：手机 ──WiFi──► 电脑 Node:3000 ◄──浏览器
外网：  手机 ──4G/5G──► Cloudflare 边缘 ──Tunnel/Nginx──► 源站 Node ◄──浏览器
```

### 一、先确认「能连上」

- [ ] 服务器 Node 在跑：`curl -s http://127.0.0.1:3000/api/health` 返回 `ok`
- [ ] 外网健康检查：`curl -sI https://whnetcn.top/api/health` 为 **200**
- [ ] 手机 App：`serverWsBase` = **`wss://whnetcn.top/ws`**（无 `:3000`，是 **wss** 不是 ws）
- [ ] 手机 `deviceToken` 与服务器 `.env` 的 **`DEVICE_TOKEN`** 完全一致
- [ ] 手机后台账号（`ws_username` / owner）在后台用户表里存在（如 `wh`）
- [ ] Cloudflare 面板 → **网络** → **WebSockets：已开启**（未开则 WS 直接失败）
- [ ] Tunnel：`systemctl status cloudflared` 为 active；`config.yml` 指向 `http://127.0.0.1:3000`
- [ ] 控制页用 **`https://whnetcn.top/device.html?id=设备ID`** 打开（不要混用 `http://` 旧缓存）

### 二、Cloudflare Tunnel（方案 A）专项

- [ ] **SSL/TLS** 加密模式与源站一致（源站仅 HTTP:3000 时常用 **灵活** 或 **完全**）
- [ ] 未对 `/ws` 做会阻断升级的 Page Rule（缓存、重定向到 http 等）
- [ ] `journalctl -u cloudflared -f` 连接设备时无大量报错、断连
- [ ] 接受现实：Tunnel 比局域网 **多 2～3 跳**，实时投屏延迟通常 **+50～200ms** 属正常

**若外网仍很卡、可接受改架构：**

- [ ] 评估改 **方案 B**（域名 A 记录到 VPS IP + Nginx 反代 `/ws`），少一层 Tunnel，往往更稳、略低延迟
- [ ] 服务器选与 **主要用户同区域**（国内用户 → 国内 VPS）

### 三、Nginx 直连接（方案 B）专项

- [ ] `location /ws` 已配置 `Upgrade` / `Connection "upgrade"`（见本文 B.2）
- [ ] `proxy_read_timeout` 足够大（如 **86400**），避免长连接被 Nginx 掐断
- [ ] `proxy_buffering off;`（可选，对实时 WS 更友好）

### 四、控制页 / 编码（外网建议）

- [ ] 浏览器控制台：`location.protocol` 为 **`https:`**，`typeof VideoDecoder` 为 **`function`**（才能 H.264）
- [ ] 左上角状态：收流 **H.264 或 WebP** 正常；**待绘 0～1**；显示 **~8fps 以上** 较理想
- [ ] 外网优先 **HTTPS + H.264**；HTTP 环境会自动 **preferWebp**（带宽更大，过 CF 更易卡）
- [ ] 卡顿明显时：属预期，App 会按发送耗时 **自动降档**（high → medium → low）

### 五、与本地调试开关区分

| 环境 | 手机地址 | 网页 |
|------|----------|------|
| **本地调试** | `MyUtils.DEBUG_USE_LOCAL_WS = true` → `ws://192.168.3.100:3000/ws` | `ws-debug.js` `USE_LOCAL = true` |
| **生产外网** | `DEBUG_USE_LOCAL_WS = false`，`wss://whnetcn.top/ws` | `USE_LOCAL = false`，用 `https://whnetcn.top` |

**不要** 生产环境仍开 debug 指向局域网，也不要指望外网达到局域网同样延迟。

### 六、直接用 IP（如 `http://43.248.3.34:8080`）仍卡

与是否走 Cloudflare **无关**，常见原因：

| 原因 | 说明 |
|------|------|
| **HTTP 公网 IP** | 浏览器 **不能用 H.264**，只能 WebP，流量约为 H.264 的数倍，公网更易卡 |
| **手机未连同一地址** | `MyUtils.DEBUG_USE_LOCAL_WS` 仍为 `true` 时，手机连的是局域网 `192.168.x.x`，不是 VPS |
| **8080 多为 Nginx 反代** | 须给 `/ws` 配 `Upgrade`；Node 实际常在 **3000** |
| **地理距离 / 上行** | 手机 4G/5G 上行有限，即使用 IP 也比同 WiFi 慢 |

**建议配置：**

1. 手机：`DEBUG_USE_LOCAL_WS = false`，App 里 **serverWsBase** = `ws://43.248.3.34:8080/ws`（与网页端口一致，**ws** 不是 http）
2. 网页：用 `http://43.248.3.34:8080` 登录；控制页会自动 **medium 档 + WebP**（已优化）
3. 若要明显更流畅：为该 IP 配 **HTTPS**（443 + 证书），控制页即可 **H.264**

### 七、快速对比自测

1. 同一台手机、同一网络下先测 **局域网 debug** → 应流畅（你已验证）。
2. 关 debug，改 **wss + whnetcn.top**，同一操作再测 → 若仅此时变卡，即可认定是 **链路问题**。
3. 可选：手机开热点给电脑，电脑访问 `https://whnetcn.top`，对比 WiFi 下局域网 —— 分离「上行带宽」与「CF」因素。

---

## 故障排查

| 现象 | 处理 |
|------|------|
| `https://whnetcn.top` 502 | 本机 Node 未启动；`config.yml` 端口不是 3000 |
| 网页能开，设备离线 | 手机 WS 是否为 `wss://whnetcn.top/ws`；token 是否一致 |
| 提示不支持 WebCodecs | 是否用了 `http://`；强刷控制页缓存 |
| WS 连不上 | Cloudflare 是否开启 **WebSockets** |
| **外网画面/控制明显比局域网卡** | 见上一节「外网投屏检查清单」；优先查 Tunnel/距离/上行，非 DNS 单点 |
| `certbot: command not found` | CentOS 用 `dnf`，不要用 `apt` |
| `cloudflared service already installed` | 勿重复 `service install`，只 `restart` |

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `app.js` | HTTP 3000 + 可选自签 HTTPS 3443 |
| `scripts/gen-dev-cert.ps1` | Windows 生成本地自签证书 |
| `ws/index.js` | WebSocket 路径 `/ws` |
| `public/control.js` | 控制页；HTTPS 下 H.264 / HTTP 自动 preferWebp |

---

*文档随部署方式更新；当前生产推荐：**方案 A Cloudflare Tunnel + https://whnetcn.top**。*
