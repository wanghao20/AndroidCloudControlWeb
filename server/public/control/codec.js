/** @module control/codec */
import { st, StreamDiag } from "./state.js";
import {
    updateCaptureStatusDisplay,
} from "./frame.js";
import {
    isPublicHttpPage, pickCaptureSpeedForSession, sendControl,
} from "./session.js";

export function updateGroupControlTitle() {
    if (!st.deviceTitle) return;
    if (st.syncGroupDeviceIds.length < 2) {
        st.deviceTitle.textContent = `设备控制：${st.deviceId}`;
        if (st.masterDeviceRow) st.masterDeviceRow.classList.add("hidden");
        return;
    }
    const shortId = st.deviceId.length > 8 ? `…${st.deviceId.slice(-8)}` : st.deviceId;
    st.deviceTitle.textContent =
        `设备控制：${st.deviceId}（群控 ${st.syncGroupDeviceIds.length} 台 · 主屏 ${shortId}）`;
    if (st.masterDeviceRow) st.masterDeviceRow.classList.remove("hidden");
}

export function initMasterDeviceSelect() {
    if (!st.masterDeviceSelect || st.syncGroupDeviceIds.length < 2) return;
    st.masterDeviceSelect.innerHTML = st.syncGroupDeviceIds
        .map((id) => {
            const selected = String(id) === String(st.deviceId) ? " selected" : "";
            const label = id.length > 16 ? `…${id.slice(-12)}` : id;
            return `<option value="${id}"${selected}>${label}</option>`;
        })
        .join("");
    st.masterDeviceSelect.onchange = () => {
        const newId = st.masterDeviceSelect.value;
        if (!newId || String(newId) === String(st.deviceId)) return;
        const syncParam = encodeURIComponent(st.syncGroupDeviceIds.join(","));
        window.location.href =
            `device.html?id=${encodeURIComponent(newId)}&syncGroup=${syncParam}`;
    };
}

/** 点击坐标映射到手机真实分辨率（投屏 JPEG 已缩放，不能用 naturalWidth） */
export function getDeviceResolution() {
    return {
        w: st.deviceInfo?.width || 1080,
        h: st.deviceInfo?.height || 2400,
    };
}

export function formatControlAck(msg) {
    const r = msg.result;
    if (r && typeof r.success === "number" && Array.isArray(msg.deviceIds)) {
        const total = msg.deviceIds.length;
        const ok = r.success;
        const failed = r.failed || 0;
        if (failed === 0) {
            return `✅ 群控指令已下发（${ok}/${total}）`;
        }
        const failedIds = (r.failedIds || []).slice(0, 2).join(", ");
        const suffix = (r.failedIds || []).length > 2 ? "…" : "";
        return `⚠️ 部分失败 ${ok}/${total}${failedIds ? `，失败：${failedIds}${suffix}` : ""}`;
    }
    const ok = msg.success === true || (r && r.success > 0);
    return ok ? "✅ 指令已下发" : "❌ 指令下发失败";
}


export function canUseWebCodecsH264() {
    return window.CodecClient
        ? CodecClient.canUseWebCodecsH264()
        : typeof VideoDecoder !== "undefined" &&
              typeof EncodedVideoChunk !== "undefined" &&
              window.isSecureContext === true;
}

export function getWebCodecsBlockReason() {
    if (window.CodecClient) return CodecClient.getWebCodecsBlockReason();
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
        return "浏览器缺少 VideoDecoder（请用较新 Chrome/Edge）";
    }
    if (!window.isSecureContext) {
        return `当前为 ${location.protocol} 非安全连接，H.264 需 HTTPS 或 localhost`;
    }
    return "";
}

/** 强制手机 WebP（HTTP 可重复下发，直到收流不再是 H.264） */
export function forcePreferWebp(reason, options = {}) {
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
    if (st.currentCodecMode === "base64") return;
    const allowRepeat = options.allowRepeat === true || isPublicHttpPage();
    const now = Date.now();
    if (!allowRepeat && st.webpFallbackRequested) return;
    if (allowRepeat && now - st.lastPreferWebpSentAt < 800) return;
    st.lastPreferWebpSentAt = now;
    st.webpFallbackRequested = true;
    const msg = reason || "网页无法解码 H.264";
    console.warn("[codec] 请求手机改用 WebP:", msg);
    sendControl({ type: "preferWebp" }, { skipFeedback: true });
    updateCaptureStatusDisplay();
    if (st.viewerTips && options.updateTips !== false) {
        st.viewerTips.innerHTML = `⚠️ ${msg}，已通知手机改用 WebP`;
    }
}

export function requestWebpFallback(reason) {
    forcePreferWebp(reason, { allowRepeat: false, updateTips: true });
}

function getDefaultViewerQuality() {
    return "smooth";
}

/** 流量最小：HTTPS 用 H.264，否则 WebP（Base64 体积最大） */
export function getDefaultCodecMode() {
    return canUseWebCodecsH264() ? "h264" : "webp";
}

export function getViewerQualityMode() {
    try {
        const v = localStorage.getItem(st.STORAGE_VIEWER_QUALITY);
        if (v === "smooth" || v === "quality") return v;
    } catch (_) {
        /* ignore */
    }
    return getDefaultViewerQuality();
}

function setViewerQualityMode(mode) {
    const next = mode === "smooth" ? "smooth" : "quality";
    try {
        localStorage.setItem(st.STORAGE_VIEWER_QUALITY, next);
    } catch (_) {
        /* ignore */
    }
    updateViewerQualityButtons();
    const speed = pickCaptureSpeedForSession();
    st.captureProfileHint = speed;
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
    // 「流畅/清晰」只调帧率，不自动改编码（编码仅由 Base64/WebP/H.264 按钮切换）
    if (st.currentCodecMode === "base64") {
        sendControl({ type: "setCodecMode", mode: "base64" }, { skipFeedback: true });
        st.codecPreferenceSynced = true;
        if (st.captureElevated) {
            sendControl({ type: "setCaptureSpeed", speed: "high" }, { skipFeedback: true });
        } else {
            sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
        }
        updateCaptureStatusDisplay(st.captureElevated ? "high" : speed);
        StreamDiag.log("画质切换 →", next, "保持 Base64");
        return;
    }
    st.codecPreferenceSynced = false;
    if (next === "quality" && st.currentCodecMode !== "base64") {
        syncCaptureCodecPreference({ force: true });
    } else if (next === "quality" && st.currentCodecMode === "base64") {
        sendControl({ type: "setCodecMode", mode: "base64" }, { skipFeedback: true });
        st.codecPreferenceSynced = true;
    } else {
        st.webpFallbackRequested = true;
        st.codecPreferenceSynced = true;
    }
    sendControl({ type: "setCaptureSpeed", speed }, { skipFeedback: true });
    updateCaptureStatusDisplay(speed);
    StreamDiag.log("画质切换 →", next, "setCaptureSpeed", speed);
}

function updateViewerQualityButtons() {
    const mode = getViewerQualityMode();
    const btnSmooth = document.getElementById("btnQualitySmooth");
    const btnQuality = document.getElementById("btnQualityHigh");
    if (btnSmooth) btnSmooth.classList.toggle("active", mode === "smooth");
    if (btnQuality) btnQuality.classList.toggle("active", mode === "quality");
}

export function initViewerQualityBar() {
    st.captureProfileHint = pickCaptureSpeedForSession();
    updateViewerQualityButtons();
    const btnSmooth = document.getElementById("btnQualitySmooth");
    const btnQuality = document.getElementById("btnQualityHigh");
    if (btnSmooth) {
        btnSmooth.addEventListener("click", () => setViewerQualityMode("smooth"));
    }
    if (btnQuality) {
        btnQuality.addEventListener("click", () => setViewerQualityMode("quality"));
    }
}

/** 按浏览器能力同步编码（仅 webp/h264 用户选项；Base64 模式不自动 preferWebp/allowH264） */
export function syncCaptureCodecPreference(options = {}) {
    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;
    if (st.currentCodecMode === "base64") {
        st.codecPreferenceSynced = true;
        return;
    }
    const force = options.force === true;
    if (!force && st.codecPreferenceSynced) return;

    if (getViewerQualityMode() === "smooth") {
        sendControl({ type: "preferWebp" }, { skipFeedback: true });
        st.webpFallbackRequested = true;
        st.codecPreferenceSynced = true;
        return;
    }

    if (window.CodecClient) {
        CodecClient.detectAndPersist();
        const cmd = CodecClient.getCodecCommand();
        if (cmd.type === "allowH264" && canUseWebCodecsH264()) {
            st.webpFallbackRequested = false;
            sendControl(cmd, { skipFeedback: true });
            st.codecPreferenceSynced = true;
        } else {
            forcePreferWebp(
                CodecClient.getWebCodecsBlockReason() || "网页不支持 H.264 解码",
                { allowRepeat: true, updateTips: false }
            );
            st.codecPreferenceSynced = true;
        }
        return;
    }
    if (canUseWebCodecsH264()) {
        st.webpFallbackRequested = false;
        sendControl({ type: "allowH264" }, { skipFeedback: true });
        st.codecPreferenceSynced = true;
    } else {
        forcePreferWebp(getWebCodecsBlockReason() || "网页不支持 H.264 解码", {
            allowRepeat: true,
            updateTips: false,
        });
        st.codecPreferenceSynced = true;
    }
}

/** 仅滑动时丢弃积压画面（点击保留上一帧直到新帧，降低「卡几秒」体感） */
export function shouldSkipStaleDisplayFrames(command) {
    return command && command.type === "swipe";
}

/** 取消进行中的旧解码；保留 pending 帧，避免滑动后收帧变慢时出现长时间无画 */
export function skipStaleDisplayFrames() {
    st.framePaintGeneration++;
    st.latestWsBinary = null;
    st.pendingH264Decode = null;
    if (st.pendingH264VideoFrame) {
        try {
            st.pendingH264VideoFrame.close();
        } catch (_) {
            /* ignore */
        }
        st.pendingH264VideoFrame = null;
    }
    st.h264VideoPaintScheduled = false;
}
