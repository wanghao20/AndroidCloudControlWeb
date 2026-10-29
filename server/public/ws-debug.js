/**
 * 本地调试 WebSocket（发布前将 USE_LOCAL 改为 false）
 *
 * 网页请用：http://192.168.3.100:3000 打开并登录（与 .env ADMIN_USERNAME / ADMIN_PASSWORD 一致）
 * 手机 App：MyUtils.kt 里 DEBUG_USE_LOCAL_WS = true，HOST/PORT/USERNAME 与这里对齐
 */
(function (global) {
    const USE_LOCAL = false;
    const LOCAL_WS_HOST = "192.168.3.100";
    /** 必须与 server/.env 的 PORT 一致 */
    const LOCAL_WS_PORT = "3000";
    const LOCAL_WS_BASE = `ws://${LOCAL_WS_HOST}:${LOCAL_WS_PORT}/ws`;

    function resolveWsEndpoint() {
        if (USE_LOCAL) {
            console.info("[WsDebug] 使用本地 WS:", LOCAL_WS_BASE);
            return LOCAL_WS_BASE;
        }
        return `${global.location.origin.replace(/^http/, "ws")}/ws`;
    }

    global.WsDebug = {
        USE_LOCAL,
        LOCAL_WS_HOST,
        LOCAL_WS_PORT,
        LOCAL_WS_BASE,
        resolveWsEndpoint,
    };
})(typeof window !== "undefined" ? window : globalThis);
