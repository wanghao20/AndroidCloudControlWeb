# 生成本机 HTTPS 自签证书（供局域网 WebCodecs / H.264 测试）
# 需要已安装 OpenSSL（Git for Windows 自带）

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$certsDir = Join-Path $root "certs"
New-Item -ItemType Directory -Force -Path $certsDir | Out-Null

$key = Join-Path $certsDir "server.key"
$crt = Join-Path $certsDir "server.crt"

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -First 1 -ExpandProperty IPAddress)

if (-not $lanIp) { $lanIp = "192.168.3.100" }

Write-Host "生成证书 CN=$lanIp -> $certsDir"

& openssl req -x509 -newkey rsa:2048 `
    -keyout $key -out $crt -days 825 -nodes `
    -subj "/CN=$lanIp" `
    -addext "subjectAltName=IP:$lanIp,DNS:localhost"

Write-Host "完成。重启 node app.js 后访问: https://${lanIp}:3443/"
