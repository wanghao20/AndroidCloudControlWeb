/** @module control/session */
import { st, StreamDiag } from "./state.js";
import { handleAudioBinary, resumeControlAudio, stopControlAudio, DEVICE_AUDIO_MAGIC } from "./audio.js";
import {
    deliverBase64JpegFrame, isServerProfileDowngrade, jpegBytesToBlob, paintBase64Frame, parseH264ConfigPayload, parseWebFramePacket, queueDeviceFrameBlob, queueH264Chunk, queueWsBinaryMessage, revokeLastBase64ObjectUrl, terminateFrameDecodeWorker, updateCaptureStatusDisplay, updateCodecDisplayLayer,
} from "./frame.js";
import {
    canUseWebCodecsH264, forcePreferWebp, formatControlAck, getDefaultCodecMode, getViewerQualityMode, getWebCodecsBlockReason, requestWebpFallback, shouldSkipStaleDisplayFrames, skipStaleDisplayFrames, syncCaptureCodecPreference, updateGroupControlTitle,
} from "./codec.js";
import {
    updateCodecModeButtons,
} from "./viewer.js";

/* ================= websocket ================= */

function getWebSocketBaseUrl() {
    if (typeof WsDebug !== "undefined") {
        return WsDebug.resolveWsEndpoint();
    }
    return `${window.location.origin.replace(/^http/, "ws")}/ws`;
}

/** 局域网/本机（可走 H.264 或低延迟 WebP） */
function isPrivateLanHost(hostname) {
    if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
        return true;
    }
    if (/^192\.168\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    return false;
}

/** 公网 IP + HTTP：浏览器禁止 WebCodecs，只能 WebP */
export function isPublicHttpPage() {
    if (window.CodecClient && CodecClient.isPublicHttpPage) {
        return CodecClient.isPublicHttpPage();
    }
    return location.protocol === "http:" && !isPrivateLanHost(location.hostname);
}

export function pickCaptureSpeedForSession() {
    if (!st.captureElevated) return "low";
    if (st.currentCodecMode === "base64") return "high";
    return getViewerQualityMode() === "smooth" ? "smooth" : "high";
}

export function clearControlIdleTimer() {
    if (st.controlIdleLowTimer) {
        clearTimeout(st.controlIdleLowTimer);
        st.controlIdleLowTimer = null;
    }
}

export function scheduleControlIdleTimer() {
    clearControlIdleTimer();
    if (!st.controlSessionActive || !st.captureElevated) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
    }
    st.controlIdleLowTimer = setTimeout(() => {
        st.controlIdleLowTimer = null;
        if (!st.controlSessionActive || !st.captureElevated) return;
        StreamDiag.log("控制页 30s 无操作 → low");
        releaseControlCaptureToLow();
    }, st.CONTROL_IDLE_LOW_MS);
}

/** 用户操作后刷新 idle 计时；若已降档则重新拉高 */
export function bumpControlActivity() {
    if (!st.controlSessionActive) return;
    if (!st.captureElevated) {
        elevateControlCapture("user_activity");
        return;
    }
    scheduleControlIdleTimer();
}

/** 进入控制页：默认高刷 + 启动 30s 无操作降档计时 */
export function elevateControlCapture(reason) {
    st.captureElevated = true;
    clearControlIdleTimer();
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - st.lastElevateControlSentAt < st.ELEVATE_CONTROL_COALESCE_MS) {
        scheduleControlIdleTimer();
        if (StreamDiag.enabled() && reason) {
            StreamDiag.log("控制页高刷(跳过重复)", reason);
        }
        return;
    }
    st.lastElevateControlSentAt = now;
    sendControl({ type: "resumeCapture" }, { skipFeedback: true });
    const speed = pickCaptureSpeedForSession();
    const isSmooth = getViewerQualityMode() === "smooth";
    if (st.currentCodecMode === "base64") {
        sendControl({ type: "setCodecMode", mode: "base64" }, { skipFeedback: true });
    } else if (isSmooth) {
        sendControl({ type: "preferWebp" }, { skipFeedback: true });
        sendControl({ type: "setCodecMode", mode: "webp" }, { skipFeedback: true });
    } else {
        syncCaptureCodecPreference({ force: true });
    }
    sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
    if (st.currentCodecMode !== "base64") {
        sendControl({ type: "requestFrame" }, { skipFeedback: true });
    }
    st.captureProfileHint = speed;
    st.captureSessionPrewarmed = true;
    updateCaptureStatusDisplay(speed);
    scheduleControlIdleTimer();
    if (StreamDiag.enabled() && reason) {
        StreamDiag.log("控制页高刷", reason);
    }
}

/** 兼容旧调用名 */
export function primeControlCapture() {
    elevateControlCapture("prime");
}

/** 离开控制页 / 无操作超时：降回 low（仍保持采集，供列表预览等） */
export function releaseControlCaptureToLow() {
    st.captureElevated = false;
    st.lastElevateControlSentAt = 0;
    clearControlIdleTimer();
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
    sendControl({ type: "resumeCapture" }, { skipFeedback: true });
    sendControl({ type: "setCaptureSpeed", speed: "low" }, { skipFeedback: true });
    st.captureProfileHint = "low";
    updateCaptureStatusDisplay("low");
    StreamDiag.log("控制页降档 low");
}

export function connectWebSocket() {

    const url = new URL(getWebSocketBaseUrl());

    url.searchParams.set("clientType", "web");
    url.searchParams.set("deviceId", st.deviceId);
    if (st.token) {
        url.searchParams.set("token", st.token);
    }

    st.ws = new WebSocket(url.toString());
    st.ws.binaryType = "arraybuffer";

    st.ws.onopen = () => {
        console.log("[WS] 已连接");
        st.controlWsConnected = true;
        st.streamDiagSessionStartedAt = Date.now();
        st.wsReconnectAttempt = 0;
        updateWsLinkStatus("connected");
        scheduleDeviceMetaRefresh();
        try {
            st.ws.send(
                JSON.stringify({
                    type: "subscribe_control",
                    deviceId: String(st.deviceId),
                })
            );
            StreamDiag.log("subscribe_control 已发送", st.deviceId);
        } catch (e) {
            StreamDiag.warn("subscribe_control 发送失败", e.message);
        }
        try {
            bootstrapCaptureSession();
        } catch (e) {
            console.warn("[WS] 初始化采集策略失败", e.message);
        }
        void refreshDeviceMetaFromServer();
    };


    st.ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            const head = new Uint8Array(e.data, 0, 1);
            if (head[0] === DEVICE_AUDIO_MAGIC) {
                handleAudioBinary(e.data);
                return;
            }
            queueWsBinaryMessage(e.data);
            return;
        }
        if (typeof e.data !== "string") {
            return;
        }
        try {
            handleMessage(JSON.parse(e.data));
        } catch (err) {
            console.warn(err);
        }
    };

    st.ws.onclose = (ev) => {
        st.controlWsConnected = false;
        if (st.deviceInfo) renderDevice(st.deviceInfo);
        if (st.sessionReplaced || ev?.code === 4001) {
            st.sessionReplaced = false;
            st.controlSessionActive = false;
            alert("该子账号已在其他控制页登录，当前页面已断开");
            window.location.href = "/";
            return;
        }
        if (!st.controlSessionActive) return;
        updateWsLinkStatus("reconnecting");
        if (st.wsReconnectTimer) clearTimeout(st.wsReconnectTimer);
        st.wsReconnectAttempt += 1;
        const delay = Math.min(1000 * Math.pow(2, st.wsReconnectAttempt - 1), 30000);
        st.wsReconnectTimer = setTimeout(connectWebSocket, delay);
    };
}

function updateWsLinkStatus(state) {
    if (!st.viewerTips) return;
    if (state === "connected") {
        if (!st.isExpanded) {
            st.viewerTips.textContent = "点击画面放大控制";
        }
        return;
    }
    if (state === "reconnecting") {
        st.viewerTips.innerHTML = `🔴 控制通道断开，${st.wsReconnectAttempt > 0 ? `第 ${st.wsReconnectAttempt} 次` : ""}重连中…`;
    }
}

/** 离开控制页时恢复从机投屏，避免长期处于 pause 状态 */
function resumeSyncGroupFollowersCapture() {
    if (st.syncGroupDeviceIds.length < 2) return;
    st.syncGroupDeviceIds
        .filter((id) => String(id) !== String(st.deviceId))
        .forEach((id) => {
            sendControlToDevice(id, { type: "resumeCapture" }, { skipFeedback: true });
        });
}

/** 退出控制页：降回 low（不 pause，便于列表/重连仍可取帧） */
function releaseControlCapture() {
    releaseControlCaptureToLow();
    if (st.syncGroupDeviceIds.length >= 2) {
        st.syncGroupDeviceIds
            .filter((id) => String(id) !== String(st.deviceId))
            .forEach((id) => {
                if (st.ws && st.ws.readyState === WebSocket.OPEN) {
                    sendControlToDevice(
                        id,
                        { type: "setCaptureSpeed", speed: "low" },
                        { skipFeedback: true }
                    );
                }
            });
    }
}

export function teardownControlSession() {
    if (!st.controlSessionActive) return;
    clearControlIdleTimer();
    st.deviceStreamOnline = false;
    st.deviceForceOffline = false;
    st.lastDeviceFrameRxAt = 0;
    st.controlWsConnected = false;
    clearDeviceMetaRefreshTimer();
    st.captureElevated = false;
    st.controlSessionActive = false;
    st.codecPreferenceSynced = false;
    terminateFrameDecodeWorker();
    clearH264NoFrameFallbackTimer();
    st.webpFallbackRequested = false;
    st.captureSessionPrewarmed = false;
    st.pendingH264Decode = null;
    st.h264DecodeFlushScheduled = false;
    skipStaleDisplayFrames();
    if (st.wsBinaryRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(st.wsBinaryRaf);
    }
    st.wsBinaryRaf = 0;
    st.framesSkippedCoalesce = 0;
    st.paintFpsSamples.length = 0;
    if (st.wsReconnectTimer) {
        clearTimeout(st.wsReconnectTimer);
        st.wsReconnectTimer = null;
    }
    clearCaptureBootstrapRetry();
    if (st.base64PaintCoalesceTimer) {
        clearTimeout(st.base64PaintCoalesceTimer);
        st.base64PaintCoalesceTimer = null;
    }
    if (st.visibilityLowTimer) {
        clearTimeout(st.visibilityLowTimer);
        st.visibilityLowTimer = null;
    }
    revokeLastBase64ObjectUrl();
    if (st.deviceAudioEnabled) {
        try {
            sendControl({ type: "stopAudio" }, { skipFeedback: true });
        } catch (_) {
            /* ignore */
        }
        st.deviceAudioEnabled = false;
    }
    stopControlAudio();
    try {
        if (st.ws && st.ws.readyState === WebSocket.OPEN) {
            releaseControlCapture();
        }
    } catch (e) {
        console.warn("[control] releaseCapture failed", e.message);
    }
    if (st.ws) {
        const sock = st.ws;
        st.ws = null;
        sock.onclose = null;
        sock.onopen = null;
        sock.onmessage = null;
        if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
            try {
                sock.close(1000, "control_page_leave");
            } catch (_) {
                /* ignore */
            }
        }
    }
}

export function handleBinaryMessage(arrayBuffer) {
    const parsed = parseWebFramePacket(new Uint8Array(arrayBuffer));
    if (st.currentCodecMode === "base64") {
        if (!parsed) {
            if (StreamDiag.enabled() && st.wsBinaryRxCount <= 5) {
                StreamDiag.warn("base64 二进制帧解析失败", arrayBuffer.byteLength);
            }
            return;
        }
        if (String(parsed.deviceId) !== String(st.deviceId)) return;
        const raw = parsed.imageData;
        if (!raw || !raw.length) return;
        const isJpeg =
            parsed.format === st.IMAGE_FORMAT_JPEG ||
            parsed.format === 0x00 ||
            parsed.mimeType === "image/jpeg";
        if (!isJpeg) return;
        st.wsBinaryRxWindowBytes += raw.length;
        if (deliverBase64JpegFrame(raw)) return;
    }
    if (!parsed) return;
    if (String(parsed.deviceId) !== String(st.deviceId)) return;

    const raw = parsed.imageData;
    if (StreamDiag.enabled() && st.wsBinaryRxCount <= 5) {
        StreamDiag.log("frame parsed format=", parsed.format, "bytes=", raw.length);
    }
    const rxH264 =
        parsed.format === st.IMAGE_FORMAT_H264 || parsed.format === 0x03;
    if (rxH264 && raw.length > 1) {
        if (!canUseWebCodecsH264()) {
            st.lastRxStreamFormat = "h264";
            forcePreferWebp(getWebCodecsBlockReason() || "HTTP 无法解码 H.264", {
                allowRepeat: true,
                updateTips: false,
            });
            // 持续收到 H.264 时反复通知手机切换，直到生效
            if (st.wsBinaryRxCount % 3 === 0) {
                sendControl({ type: "preferWebp" }, { skipFeedback: true });
            }
            updateCaptureStatusDisplay();
            return;
        }
        st.lastRxStreamFormat = "h264";
        const frameType = raw[0];
        const payload = raw.subarray(1);
        if (frameType === st.H264_FRAME_CONFIG) {
            st.h264ConfigReceived = true;
            const cfg = parseH264ConfigPayload(payload);
            if (cfg) {
                ensureH264Decoder(cfg.sps, cfg.pps).then((ok) => {
                    if (!ok) return;
                    scheduleH264NoFrameFallback();
                });
            } else {
                updateCaptureStatusDisplay();
                requestWebpFallback("H.264 CONFIG 无效");
            }
            return;
        }
        updateCaptureStatusDisplay();
        if (st.h264DecoderReady) {
            queueH264Chunk(frameType, payload);
            if (!st.lastFramePaintAt) {
                scheduleH264NoFrameFallback();
            }
        } else {
            scheduleH264NoFrameFallback();
        }
        return;
    }

    clearH264NoFrameFallbackTimer();

    st.lastRxStreamFormat =
        parsed.format === st.IMAGE_FORMAT_WEBP || parsed.mimeType === "image/webp"
            ? "webp"
            : "jpeg";
    updateCaptureStatusDisplay();
    const blob =
        parsed.mimeType === "image/jpeg" || parsed.format === st.IMAGE_FORMAT_JPEG
            ? jpegBytesToBlob(raw)
            : new Blob([raw.slice ? raw.slice() : raw], {
                  type: parsed.mimeType || "image/jpeg",
              });
    markDeviceOnlineFromStream("ws_binary");
    queueDeviceFrameBlob(blob);
}

export function captureModeLabel(profile) {
    if (!profile) return "";
    if (st.currentCodecMode === "base64") return "画质：Base64 (JPEG·JSON)";
    const p = String(profile).toLowerCase();
    if (p === "smooth") return "画质：流畅 (WebP·均衡)";
    if (p === "high") return "画质：清晰 (WebP/H.264·高分辨率)";
    if (p === "thumb") return "画质：列表缩略图 (thumb·约1fps，异常)";
    if (p === "medium" || p === "mid") return "画质：均衡 (medium)";
    if (p === "low") return "画质：节省 (low)";
    return `画质：${profile}`;
}

function handleMessage(msg) {
    if (msg.type === "session_replaced") {
        st.sessionReplaced = true;
        try {
            st.ws?.close();
        } catch (_) {}
        return;
    }

    if (msg.type === "device_ui_nodes" || msg.type === "ui_nodes") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        if (st.uiNodeModal) st.uiNodeModal.classList.remove("hidden");
        if (typeof UiInspector !== "undefined" && UiInspector.open) {
            UiInspector.open(msg);
        } else {
            const nodes = msg.nodes || msg.data || msg.payload || msg.raw || msg;
            if (st.uiNodeStatus) st.uiNodeStatus.textContent = "已获取节点信息";
            if (st.uiNodeData) {
                st.uiNodeData.textContent =
                    typeof nodes === "string" ? nodes : JSON.stringify(nodes, null, 2);
            }
        }
        return;
    }

    if (msg.type === "device_ui_nodes_error" || msg.type === "ui_nodes_error") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        if (st.uiNodeModal) st.uiNodeModal.classList.remove("hidden");
        if (typeof UiInspector !== "undefined" && UiInspector.showError) {
            UiInspector.showError(msg);
        } else {
            if (st.uiNodeStatus) st.uiNodeStatus.textContent = msg.error || msg.message || "获取节点信息失败";
            if (st.uiNodeData) st.uiNodeData.textContent = JSON.stringify(msg, null, 2);
        }
        return;
    }

    if (msg.type === "device_screenshot" || msg.type === "screenshot") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        if (typeof ScreenshotEditor !== "undefined" && ScreenshotEditor.open) {
            ScreenshotEditor.open(msg);
        }
        return;
    }

    if (msg.type === "device_screenshot_error" || msg.type === "screenshot_error") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        if (typeof ScreenshotEditor !== "undefined" && ScreenshotEditor.showError) {
            ScreenshotEditor.showError(msg);
        }
        return;
    }

    if (msg.type === "device_clipboard" || msg.type === "clipboard") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        if (typeof ClipboardPanel !== "undefined" && ClipboardPanel.open) {
            ClipboardPanel.open(msg);
        }
        return;
    }

    if (msg.type === "device_clipboard_error" || msg.type === "clipboard_error") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        if (typeof ClipboardPanel !== "undefined" && ClipboardPanel.showError) {
            ClipboardPanel.showError(msg);
        }
        return;
    }

    if (msg.type === "device_frame") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        let img = msg.image;
        if (!img) return;
        img = img.replace(/[\r\n\s]/g, "");
        const dataUrl = img.startsWith("data:image") ? img : `data:image/jpeg;base64,${img}`;
        st.lastRxStreamFormat = "jpeg";
        st.wsBinaryRxWindowBytes += dataUrl.length;
        const reportedSpeed =
            msg.speed ||
            msg.captureSpeed ||
            msg.capture_speed ||
            (msg.command && (msg.command.speed || msg.command.captureSpeed));
        if (reportedSpeed && reportedSpeed !== st.captureProfileHint) {
            st.captureProfileHint = reportedSpeed;
            updateCaptureStatusDisplay(reportedSpeed);
        } else {
            const now = Date.now();
            if (!st.lastCaptureStatusPaintAt || now - st.lastCaptureStatusPaintAt > 800) {
                st.lastCaptureStatusPaintAt = now;
                updateCaptureStatusDisplay();
            }
        }
        markDeviceOnlineFromStream("device_frame");
        paintBase64Frame(dataUrl);
        return;
    }

    if (msg.type === "device_registered") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        st.deviceForceOffline = false;
        st.deviceStreamOnline = true;
        const d = msg.device || msg;
        renderDevice({
            ...(st.deviceInfo || {}),
            ...d,
            deviceId: d.deviceId || d.device_id || st.deviceId,
            online: true,
        });
        return;
    }

    // 单独的速率上报消息处理
    if (msg.type === "subscribe_control_ack") {
        StreamDiag.log("subscribe_control_ack", msg.captureProfile || msg.deviceId);
        if (!st.captureElevated || Date.now() - st.lastElevateControlSentAt >= st.ELEVATE_CONTROL_COALESCE_MS) {
            primeControlCapture();
        } else {
            StreamDiag.log("subscribe_control_ack 已预热，跳过高刷");
        }
        return;
    }

    if (msg.type === "device_ping") {
        const incomingId = msg.deviceId || msg.device_id;
        if (incomingId && String(incomingId) !== String(st.deviceId)) return;
        markDeviceOnlineFromStream("device_ping");

        const sw = msg.screenWidth || msg.screen_width;
        const sh = msg.screenHeight || msg.screen_height;
        if (sw > 0 && sh > 0) {
            const prevW = st.deviceInfo?.width;
            const prevH = st.deviceInfo?.height;
            st.deviceInfo = {
                ...(st.deviceInfo || {}),
                width: sw,
                height: sh,
            };
            if (prevW !== sw || prevH !== sh) {
                renderDevice(st.deviceInfo);
                if (st.viewerTips && st.isExpanded) {
                    st.viewerTips.innerHTML = `📐 屏幕 ${sw}×${sh}`;
                }
            }
        }

        const sp = msg.captureProfile || msg.captureSpeed;
        if (!sp || !captureModeLabel(sp)) return;

        if (!isServerProfileDowngrade(sp)) {
            StreamDiag.log("device_ping captureProfile=", sp);
        }

        if (
            isServerProfileDowngrade(sp) &&
            st.controlSessionActive &&
            st.captureElevated &&
            st.ws &&
            st.ws.readyState === 1
        ) {
            const speed = pickCaptureSpeedForSession();
            const now = Date.now();
            if (!st.controlPingReassertAt || now - st.controlPingReassertAt > 5000) {
                st.controlPingReassertAt = now;
                StreamDiag.warn("服务端建议", sp, "→ 重发 setCaptureSpeed", speed);
                sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
            }
            updateCaptureStatusDisplay();
        } else if (st.captureElevated) {
            st.captureProfileHint = pickCaptureSpeedForSession();
            updateCaptureStatusDisplay(st.captureProfileHint);
        } else {
            st.captureProfileHint = sp;
            updateCaptureStatusDisplay(sp);
        }

        if (st.captureSpeedStatus && st.ws && st.ws.readyState === 1) {
            st.captureSpeedStatus.textContent += " · 通道正常";
        }
        return;
    }

    if (msg.type === 'capture_speed' || msg.type === 'captureSpeed' || msg.type === 'capture_speed_update') {
        const sp = msg.speed || msg.captureSpeed || msg.capture_speed || (msg.data && msg.data.speed);
        if (sp) updateCaptureStatusDisplay(sp);
        return;
    }

    if (msg.type === "device_display_update") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) !== String(st.deviceId)) return;
        const d = msg.device || msg;
        if (d.width && d.height) {
            st.deviceInfo = { ...(st.deviceInfo || {}), ...d, width: d.width, height: d.height };
            renderDevice(st.deviceInfo);
            if (st.viewerTips && st.isExpanded) {
                st.viewerTips.innerHTML = `📐 屏幕已更新 ${d.width}×${d.height}`;
            }
        }
        return;
    }

    if (msg.type === "device_list") {

        const d = msg.devices.find(i =>

            String(i.device_id) ===
            String(st.deviceId)

            ||

            String(i.deviceId) ===
            String(st.deviceId)
        );

        if (d) {
            if (d.online === true) {
                st.deviceForceOffline = false;
                st.deviceStreamOnline = true;
            }
            renderDevice(d);
        }
    }

    if (msg.type === "control_ack") {
        if (msg.deviceId || msg.deviceIds) {
            if (st.viewerTips) st.viewerTips.innerHTML = formatControlAck(msg);
        }
        return;
    }

    if (msg.type === "device_disconnected") {
        const incomingId = msg.deviceId || msg.device_id;
        if (String(incomingId) === String(st.deviceId)) {
            markDeviceOfflineFromServer("device_disconnected");
        }
        return;
    }
}

function markDeviceOfflineFromServer(reason) {
    st.deviceForceOffline = true;
    st.deviceStreamOnline = false;
    st.lastDeviceFrameRxAt = 0;
    if (st.deviceInfo) {
        st.deviceInfo = { ...st.deviceInfo, online: false };
        renderDevice(st.deviceInfo);
    }
    if (st.viewerTips) {
        st.viewerTips.innerHTML = "📵 设备已断开连接，指令将无法执行";
    }
    if (StreamDiag.enabled() && reason) {
        StreamDiag.log("设备状态→离线", reason);
    }
}

export function resolveDeviceOnline(d) {
    if (st.deviceForceOffline) return false;
    if (d && d.online === false) return false;
    if (st.deviceStreamOnline) return true;
    if (!d) return false;
    if (d.online === true) return true;
    const now = Date.now();
    if (st.lastDeviceFrameRxAt && now - st.lastDeviceFrameRxAt < st.DEVICE_ONLINE_STALE_MS) {
        return true;
    }
    if (st.lastFramePaintAt && now - st.lastFramePaintAt < st.DEVICE_ONLINE_STALE_MS) {
        return true;
    }
    return false;
}

export function markDeviceOnlineFromStream(source) {
    st.deviceForceOffline = false;
    st.lastDeviceFrameRxAt = Date.now();
    const wasOffline = !st.deviceStreamOnline && (!st.deviceInfo || st.deviceInfo.online !== true);
    st.deviceStreamOnline = true;
    if (!st.deviceInfo) {
        st.deviceInfo = {
            deviceId: st.deviceId,
            brand: "-",
            model: "-",
            android: "-",
            width: 1080,
            height: 2400,
            online: true,
        };
        renderDevice(st.deviceInfo);
        return;
    }
    if (wasOffline || st.deviceInfo.online !== true) {
        st.deviceInfo = { ...st.deviceInfo, online: true };
        renderDevice(st.deviceInfo);
        if (StreamDiag.enabled() && source) {
            StreamDiag.log("设备状态→在线", source);
        }
    }
}

async function refreshDeviceMetaFromServer() {
    if (!st.deviceId || !st.token) return;
    try {
        const resp = await fetch(`/api/device/${encodeURIComponent(st.deviceId)}`, {
            headers: { "x-admin-token": st.token },
            cache: "no-store",
        });
        if (!resp.ok) return;
        const d = await resp.json();
        if (d.online === true) {
            st.deviceForceOffline = false;
            st.deviceStreamOnline = true;
        } else if (d.online === false) {
            st.deviceForceOffline = true;
            st.deviceStreamOnline = false;
        }
        renderDevice({ ...(st.deviceInfo || {}), ...d });
    } catch (_) {
        /* ignore */
    }
}

function clearDeviceMetaRefreshTimer() {
    if (st.deviceMetaRefreshTimer) {
        clearInterval(st.deviceMetaRefreshTimer);
        st.deviceMetaRefreshTimer = null;
    }
}

/** 定时拉服务端状态，手机静默重连后无需手动刷新页面 */
function scheduleDeviceMetaRefresh() {
    clearDeviceMetaRefreshTimer();
    if (!st.controlSessionActive) return;
    st.deviceMetaRefreshTimer = setInterval(() => {
        if (!st.controlSessionActive || !st.ws || st.ws.readyState !== WebSocket.OPEN) return;
        void refreshDeviceMetaFromServer();
    }, 12000);
}

function renderDevice(d) {
    const merged = { ...(st.deviceInfo || {}), ...d };
    merged.online = resolveDeviceOnline(merged);
    st.deviceInfo = merged;

    const linkOk = st.controlWsConnected && st.ws && st.ws.readyState === WebSocket.OPEN;
    if ((!merged.online || !linkOk) && st.deviceAudioEnabled) {
        st.deviceAudioEnabled = false;
        if (st.ws && st.ws.readyState === WebSocket.OPEN) {
            sendControl({ type: "stopAudio" }, { skipFeedback: true });
        }
    }

    const onlineStatus = merged.online
        ? `<span class="meta-status meta-status--online"><span class="meta-status-dot" aria-hidden="true"></span>在线</span>`
        : `<span class="meta-status meta-status--offline"><span class="meta-status-dot" aria-hidden="true"></span>离线</span>`;

    const audioToggleDisabled = !merged.online || !linkOk;
    const audioToggleChecked = st.deviceAudioEnabled ? " checked" : "";
    const audioToggleDisabledAttr = audioToggleDisabled ? " disabled" : "";
    const audioToggle = `<label class="meta-audio-toggle">
            <input type="checkbox" id="toggleDeviceAudio"${audioToggleChecked}${audioToggleDisabledAttr} />
            <span>声音</span>
        </label>`;

    const linkStatus = linkOk
        ? `<span class="meta-status">控制通道正常</span>`
        : `<span class="meta-status">控制通道断开</span>`;

    st.deviceMeta.innerHTML = `
        <div class="meta-primary">品牌：${merged.brand || "-"}</div>
        <div class="meta-primary">型号：${merged.model || "-"}</div>
        <div class="meta-primary">系统：Android ${merged.android || "-"}</div>
        <div class="meta-secondary">分辨率：${merged.width || 1080} × ${merged.height || 2400}${merged.orientation === 2 ? " · 横屏" : merged.orientation === 1 ? " · 竖屏" : ""}</div>
        <div class="meta-secondary meta-secondary--device-status">设备：${onlineStatus}${audioToggle}</div>
        <div class="meta-secondary">网页：${linkStatus}</div>
    `;
}

export function setDeviceAudioEnabled(enabled) {
    const next = !!enabled;
    if (next === st.deviceAudioEnabled) return;
    st.deviceAudioEnabled = next;
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
    if (next) {
        resumeControlAudio();
        sendControl({ type: "startAudio" }, { skipFeedback: true });
    } else {
        sendControl({ type: "stopAudio" }, { skipFeedback: true });
    }
}

export function initDeviceAudioToggle() {
    if (!st.deviceMeta || st.deviceMeta.dataset.audioToggleBound) return;
    st.deviceMeta.dataset.audioToggleBound = "1";
    st.deviceMeta.addEventListener("change", (e) => {
        if (e.target.id !== "toggleDeviceAudio") return;
        setDeviceAudioEnabled(e.target.checked);
    });
}

function flashControlFeedback() {
    if (!st.viewerFrame) return;
    st.viewerFrame.classList.add("control-feedback");
    if (st.sendControlAnimationTimer) clearTimeout(st.sendControlAnimationTimer);
    st.sendControlAnimationTimer = setTimeout(() => {
        st.viewerFrame.classList.remove("control-feedback");
        st.sendControlAnimationTimer = null;
    }, 120);
}

function sendControlToDevice(targetDeviceId, command, options = {}) {
    if (!st.ws || st.ws.readyState !== 1) return;
    if (command && shouldSkipStaleDisplayFrames(command)) {
        skipStaleDisplayFrames();
    }
    const payload = {
        type: "control",
        deviceId: targetDeviceId,
        command,
    };
    if (StreamDiag.enabled()) {
        StreamDiag.log("[WS SEND]", payload.type, payload.command?.type || payload.command);
    }
    st.ws.send(JSON.stringify(payload));

    const skipFeedback = options.skipFeedback
        || command.type === "setCaptureSpeed"
        || command.type === "pauseCapture"
        || command.type === "resumeCapture"
        || (command.type === "swipe" && st.currentControlMode === "swipe");
    if (!skipFeedback) {
        flashControlFeedback();
    }
}

export function sendControl(command, options = {}) {
    if (!st.ws || st.ws.readyState !== 1) return false;
    if (command && shouldSkipStaleDisplayFrames(command)) {
        skipStaleDisplayFrames();
    }
    const masterOnly = st.MASTER_ONLY_COMMANDS.has(command.type);
    const payload = {
        type: "control",
        deviceId: st.deviceId,
        command,
    };
    if (!masterOnly && st.syncGroupDeviceIds.length > 0) {
        payload.deviceIds = st.syncGroupDeviceIds;
    }
    if (StreamDiag.enabled()) {
        StreamDiag.log("[WS SEND]", payload.type, payload.command?.type || payload.command);
    }
    st.ws.send(JSON.stringify(payload));

    if (command && st.INTERACTIVE_CONTROL_TYPES.has(command.type)) {
        bumpControlActivity();
    }

    const skipFeedback = options.skipFeedback
        || command.type === "setCaptureSpeed"
        || command.type === "pauseCapture"
        || command.type === "resumeCapture"
        || (command.type === "swipe" && st.currentControlMode === "swipe");
    if (!skipFeedback) {
        flashControlFeedback();
    }
    // Base64：手机端 notifyUserInteraction 已补帧，勿再刷 requestFrame（易连发闪屏）
    if (
        command &&
        st.INTERACTIVE_CONTROL_TYPES.has(command.type) &&
        st.currentCodecMode !== "base64" &&
        st.ws &&
        st.ws.readyState === 1
    ) {
        const now = Date.now();
        if (now - st.lastRequestFrameSentAt >= 400) {
            st.lastRequestFrameSentAt = now;
            setTimeout(() => {
                if (st.ws && st.ws.readyState === 1) {
                    sendControl({ type: "requestFrame" }, { skipFeedback: true });
                }
            }, 40);
        }
    }
    return true;
}

export function clearH264NoFrameFallbackTimer() {
    if (st.h264NoFrameFallbackTimer) {
        clearTimeout(st.h264NoFrameFallbackTimer);
        st.h264NoFrameFallbackTimer = null;
    }
}

/** 已收 H.264 CONFIG 但长时间无画面 → 自动 preferWebp */
export function scheduleH264NoFrameFallback() {
    clearH264NoFrameFallbackTimer();
    if (!canUseWebCodecsH264() || st.webpFallbackRequested) return;
    st.h264NoFrameFallbackTimer = setTimeout(() => {
        st.h264NoFrameFallbackTimer = null;
        if (
            st.lastRxStreamFormat === "h264" &&
            st.h264ConfigReceived &&
            !st.lastFramePaintAt &&
            !st.webpFallbackRequested
        ) {
            requestWebpFallback("H.264 长时间无画面");
        }
    }, st.H264_NO_FRAME_FALLBACK_MS);
}

function clearCaptureBootstrapRetryTimer() {
    if (st.captureBootstrapRetryTimer) {
        clearTimeout(st.captureBootstrapRetryTimer);
        st.captureBootstrapRetryTimer = null;
    }
}

export function clearCaptureBootstrapRetry() {
    clearCaptureBootstrapRetryTimer();
    st.captureBootstrapRetryCount = 0;
}

function scheduleCaptureBootstrapRetry() {
    clearCaptureBootstrapRetryTimer();
    st.captureBootstrapRetryTimer = setTimeout(() => {
        st.captureBootstrapRetryTimer = null;
        if (!st.controlSessionActive || !st.ws || st.ws.readyState !== WebSocket.OPEN) return;
        if (st.lastFramePaintAt > 0) return;
        if (
            (st.wsBinaryRxCount > 0 || st.jsonFrameRxWindowCount > 0) &&
            st.captureBootstrapRetryCount < st.CAPTURE_BOOTSTRAP_MAX_RETRIES
        ) {
            st.captureBootstrapRetryCount++;
            StreamDiag.log(
                "bootstrap 已收流未出画，延后重试",
                st.captureBootstrapRetryCount,
                "/",
                st.CAPTURE_BOOTSTRAP_MAX_RETRIES
            );
            scheduleCaptureBootstrapRetry();
            return;
        }
        console.warn("[control] 长时间无画面，重试 resume + 编码 + 档位");
        sendControl({ type: "resumeCapture" }, { skipFeedback: true });
        if (st.currentCodecMode === "base64") {
            sendControl({ type: "setCodecMode", mode: "base64" }, { skipFeedback: true });
        } else {
            syncCaptureCodecPreference({ force: true });
        }
        const speed = pickCaptureSpeedForSession();
        if (st.syncGroupDeviceIds.length < 2) {
            sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
        } else {
            applySyncGroupCapturePolicy();
        }
        st.captureProfileHint = speed;
        updateCaptureStatusDisplay(speed);
        if (st.viewerTips && !st.isExpanded) {
            st.viewerTips.innerHTML =
                "画面仍未收到，已重试唤醒投屏；请确认手机在线且投屏服务已开启";
        }
    }, st.CAPTURE_BOOTSTRAP_RETRY_MS);
}

/**
 * 进入控制页即预拉高帧并选好编码，避免第一次点全屏再等管线切换。
 * 全屏时仅展开 UI，不再重复 setCaptureSpeed。
 */
export function bootstrapCaptureSession(options = {}) {
    const soft = options.soft === true;
    StreamDiag.log("bootstrap", {
        soft,
        codec: st.currentCodecMode,
        quality: getViewerQualityMode(),
        targetSpeed: st.currentCodecMode === "base64" ? "high" : pickCaptureSpeedForSession(),
    });
    if (!soft) {
        st.captureSessionPrewarmed = false;
        st.webpFallbackRequested = false;
        st.lastPreferWebpSentAt = 0;
        st.codecPreferenceSynced = false;
        st.currentCodecMode = getDefaultCodecMode();
        updateCodecDisplayLayer();
        updateCodecModeButtons();
    }

    // Base64 模式（用户手动切换时）
    if (st.currentCodecMode === "base64") {
        updateCodecDisplayLayer();
        if (!soft && st.ws && st.ws.readyState === WebSocket.OPEN) {
            primeControlCapture();
        }
        st.codecPreferenceSynced = true;
        return;
    }

    const speed = pickCaptureSpeedForSession();
    const isSmooth = getViewerQualityMode() === "smooth";
    if (!soft && st.ws && st.ws.readyState === WebSocket.OPEN) {
        primeControlCapture();
    }
    if (isSmooth) {
        st.webpFallbackRequested = true;
        st.codecPreferenceSynced = true;
    } else {
        syncCaptureCodecPreference({ force: soft });
    }
    const applySpeed = () => {
        if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
        if (!isSmooth && !canUseWebCodecsH264()) {
            syncCaptureCodecPreference({ force: true });
        }
        if (st.syncGroupDeviceIds.length < 2) {
            sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
            const retrySpeed =
                !canUseWebCodecsH264() && getViewerQualityMode() !== "smooth";
            if (retrySpeed) {
                setTimeout(() => {
                    if (st.ws && st.ws.readyState === WebSocket.OPEN) {
                        sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
                    }
                }, 280);
            }
        } else {
            applySyncGroupCapturePolicy();
        }
        st.captureSessionPrewarmed = true;
        st.captureProfileHint = speed;
        updateCaptureStatusDisplay(speed);
        if (!soft) scheduleCaptureBootstrapRetry();
    };
    const httpQuality =
        isPublicHttpPage() && getViewerQualityMode() === "quality" && !canUseWebCodecsH264();
    // 公网 HTTP 清晰模式：必须确保 preferWebp 先到达手机，再发 high
    // 否则手机会先启动 H.264 编码器（网页无法解码）
    const delay = isSmooth
            ? 40
            : canUseWebCodecsH264()
              ? 80
              : httpQuality
                ? 350
                : 200;
    // 公网 HTTP：先多发几次 preferWebp 确保手机收到
    if (httpQuality && !soft) {
        sendControl({ type: "preferWebp" }, { skipFeedback: true });
        setTimeout(() => {
            if (st.ws && st.ws.readyState === WebSocket.OPEN) {
                sendControl({ type: "preferWebp" }, { skipFeedback: true });
            }
        }, 100);
    }
    setTimeout(applySpeed, soft ? (httpQuality ? 80 : 60) : delay);
    if (st.viewerTips && !st.isExpanded) {
        if (isPublicHttpPage()) {
            st.viewerTips.innerHTML =
                getViewerQualityMode() === "quality"
                    ? "公网 HTTP「清晰」约 8～15fps；要更顺请点「流畅」或配置 HTTPS"
                    : "公网 HTTP 无法 H.264（WebP）；建议 HTTPS。WS：ws://" +
                      location.host +
                      "/ws";
        } else {
            st.viewerTips.innerHTML = "点击画面进入控制（画面加载中也可点）";
        }
    }
}

/** 群控：从机暂停投屏，仅主屏维持采集 */
function applySyncGroupCapturePolicy() {
    const speed = pickCaptureSpeedForSession();
    if (st.syncGroupDeviceIds.length < 2) {
        sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
        return;
    }
    const followers = st.syncGroupDeviceIds.filter(
        (id) => String(id) !== String(st.deviceId)
    );
    followers.forEach((id) => {
        sendControlToDevice(id, { type: "pauseCapture" }, { skipFeedback: true });
    });
    sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
    updateGroupControlTitle();
}

export function sendSwipeControl(swipePayload) {
    const now = Date.now();
    if (now - st.lastSwipeSentAt < st.SWIPE_THROTTLE_MS) {
        if (st.viewerTips) st.viewerTips.innerHTML = "⏳ 滑动过快，请稍候";
        return false;
    }
    st.lastSwipeSentAt = now;
    if (StreamDiag.enabled()) {
        const { w, h } = st.deviceInfo || {};
        StreamDiag.log(
            "swipe coords",
            `${swipePayload.x1},${swipePayload.y1} → ${swipePayload.x2},${swipePayload.y2}`,
            "screen",
            `${w || "?"}x${h || "?"}`,
            "frame",
            st.lastFramePixelSize
                ? `${st.lastFramePixelSize.bw}x${st.lastFramePixelSize.bh}`
                : "n/a",
            "letterbox",
            st.lastFrameContentRect
        );
    }
    const ok = sendControl(swipePayload, { skipFeedback: true });
    if (!ok && st.viewerTips) {
        st.viewerTips.innerHTML = "⚠️ 未连接服务器，滑动未发送";
    }
    return !!ok;
}

export function beginSwipeCaptureSlowdown() {
    if (st.swipeCapturingSlow) return;
    st.swipeCapturingSlow = true;
    // Base64 不再滑动降档，避免与 high 打架导致 4s 一帧
}

export function endSwipeCaptureSlowdown() {
    if (!st.swipeCapturingSlow) return;
    st.swipeCapturingSlow = false;
}

