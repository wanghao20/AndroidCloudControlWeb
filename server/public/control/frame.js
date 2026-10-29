/** @module control/frame */
import { st, StreamDiag } from "./state.js";
import {
    captureModeLabel, clearCaptureBootstrapRetry, clearH264NoFrameFallbackTimer, endSwipeCaptureSlowdown,
    handleBinaryMessage, isPublicHttpPage, markDeviceOnlineFromStream, pickCaptureSpeedForSession, resolveDeviceOnline,
} from "./session.js";
import {
    canUseWebCodecsH264, getViewerQualityMode, getWebCodecsBlockReason, requestWebpFallback,
} from "./codec.js";

function detectFrameMime(bytes) {
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "image/webp";
    }
    return "image/jpeg";
}

export function parseWebFramePacket(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 4 || bytes[0] !== st.WEB_FRAME_MAGIC) return null;

    const second = bytes[1];
    // V2: [magic][format][idLen:2][st.deviceId][image] — format=0(JPEG) 也必须走此分支
    if (
        second === st.IMAGE_FORMAT_JPEG ||
        second === st.IMAGE_FORMAT_WEBP ||
        second === st.IMAGE_FORMAT_H264 ||
        second === 0x03
    ) {
        const idLen = (bytes[2] << 8) | bytes[3];
        const headerLen = 4 + idLen;
        if (headerLen >= bytes.length) return null;
        const deviceIdStr = new TextDecoder().decode(bytes.subarray(4, headerLen));
        const imageData = bytes.subarray(headerLen);
        if (!imageData.length) return null;
        const resolvedFormat =
            second === st.IMAGE_FORMAT_JPEG ? st.IMAGE_FORMAT_JPEG : second;
        const mimeType =
            second === st.IMAGE_FORMAT_WEBP
                ? "image/webp"
                : second === st.IMAGE_FORMAT_H264 || second === 0x03
                  ? "video/h264"
                  : "image/jpeg";
        return {
            deviceId: deviceIdStr,
            imageData,
            mimeType,
            format: resolvedFormat,
        };
    }

    const idLen = (bytes[1] << 8) | bytes[2];
    const headerLen = 3 + idLen;
    if (headerLen >= bytes.length) return null;
    const deviceIdStr = new TextDecoder().decode(bytes.subarray(3, headerLen));
    const imageData = bytes.subarray(headerLen);
    if (!imageData.length) return null;
    return { deviceId: deviceIdStr, imageData, mimeType: detectFrameMime(imageData), format: null };
}

/** 去掉 Android csd / Annex-B 前的 00 00 01 或 00 00 00 01 起始码 */
function stripH264StartCode(nal) {
    const b = nal instanceof Uint8Array ? nal : new Uint8Array(nal);
    let o = 0;
    while (o + 3 < b.length && b[o] === 0 && b[o + 1] === 0) {
        if (b[o + 2] === 1) return b.subarray(o + 3);
        if (o + 3 < b.length && b[o + 2] === 0 && b[o + 3] === 1) return b.subarray(o + 4);
        o++;
    }
    return b;
}

function codecStringFromSps(sps) {
    const nal = stripH264StartCode(sps);
    if (nal.length < 4) return "avc1.42E01F";
    const hex = (v) => v.toString(16).padStart(2, "0").toUpperCase();
    return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
}

/** WebCodecs 在带 description 时期望 AVCC（4 字节长度 + NAL）；Annex-B 需转换 */
function annexBToAvcc(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 4) return bytes;
    const isAnnexB =
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        (bytes[2] === 1 || (bytes[2] === 0 && bytes[3] === 1));
    if (!isAnnexB) return bytes;

    const nals = [];
    const findStart = (from) => {
        for (let j = from; j + 3 < bytes.length; j++) {
            if (bytes[j] === 0 && bytes[j + 1] === 0) {
                if (bytes[j + 2] === 1) return { pos: j, len: 3 };
                if (j + 3 < bytes.length && bytes[j + 2] === 0 && bytes[j + 3] === 1) {
                    return { pos: j, len: 4 };
                }
            }
        }
        return null;
    };

    let cur = findStart(0);
    while (cur) {
        const nalStart = cur.pos + cur.len;
        const next = findStart(nalStart);
        const nalEnd = next ? next.pos : bytes.length;
        if (nalEnd > nalStart) nals.push(bytes.subarray(nalStart, nalEnd));
        cur = next;
    }
    if (!nals.length) return bytes;

    let total = 0;
    for (const n of nals) total += 4 + n.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const n of nals) {
        out[o++] = (n.length >>> 24) & 0xff;
        out[o++] = (n.length >>> 16) & 0xff;
        out[o++] = (n.length >>> 8) & 0xff;
        out[o++] = n.length & 0xff;
        out.set(n, o);
        o += n.length;
    }
    return out;
}

function buildAvcDescription(sps, pps) {
    const spsNal = stripH264StartCode(sps);
    const ppsNal = stripH264StartCode(pps);
    const out = new Uint8Array(spsNal.length + ppsNal.length + 11);
    let o = 0;
    out[o++] = 1;
    out[o++] = spsNal[1] ?? 0x42;
    out[o++] = sps[2] ?? 0;
    out[o++] = sps[3] ?? 0;
    out[o++] = 0xff;
    out[o++] = 0xe1;
    out[o++] = (spsNal.length >> 8) & 0xff;
    out[o++] = spsNal.length & 0xff;
    out.set(spsNal, o);
    o += spsNal.length;
    out[o++] = 1;
    out[o++] = (ppsNal.length >> 8) & 0xff;
    out[o++] = ppsNal.length & 0xff;
    out.set(ppsNal, o);
    return out;
}

export function parseH264ConfigPayload(payload) {
    if (payload.length < 8) return null;
    const spsLen =
        ((payload[0] & 0xff) << 24) |
        ((payload[1] & 0xff) << 16) |
        ((payload[2] & 0xff) << 8) |
        (payload[3] & 0xff);
    if (4 + spsLen + 4 > payload.length) return null;
    const sps = payload.subarray(4, 4 + spsLen);
    const base = 4 + spsLen;
    const ppsLen =
        ((payload[base] & 0xff) << 24) |
        ((payload[base + 1] & 0xff) << 16) |
        ((payload[base + 2] & 0xff) << 8) |
        (payload[base + 3] & 0xff);
    if (base + 4 + ppsLen > payload.length) return null;
    const pps = payload.subarray(base + 4, base + 4 + ppsLen);
    return { sps: stripH264StartCode(sps), pps: stripH264StartCode(pps) };
}

function queueDecodedVideoFrame(videoFrame) {
    if (st.pendingH264VideoFrame) {
        try {
            st.pendingH264VideoFrame.close();
        } catch (_) {
            /* ignore */
        }
    }
    st.pendingH264VideoFrame = videoFrame;
    if (st.h264VideoPaintScheduled) return;
    st.h264VideoPaintScheduled = true;
    const run = () => {
        st.h264VideoPaintScheduled = false;
        const frame = st.pendingH264VideoFrame;
        st.pendingH264VideoFrame = null;
        if (frame) drawDecodedVideoFrame(frame);
    };
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(run);
    } else if (typeof queueMicrotask === "function") {
        queueMicrotask(run);
    } else {
        Promise.resolve().then(run);
    }
}

function drawDecodedVideoFrame(videoFrame) {
    if (!st.deviceCanvas || !st.frameCanvasCtx) {
        try {
            videoFrame.close();
        } catch (_) {
            /* ignore */
        }
        return;
    }
    try {
        const bw = videoFrame.displayWidth || videoFrame.codedWidth;
        const bh = videoFrame.displayHeight || videoFrame.codedHeight;
        if (drawSourceLetterboxed(videoFrame, bw, bh)) {
            st.lastFramePaintAt = Date.now();
            recordFramePainted();
            markDeviceOnlineFromStream("h264_paint");
            clearH264NoFrameFallbackTimer();
            updateCaptureStatusDisplay();
        }
    } finally {
        try {
            videoFrame.close();
        } catch (_) {
            /* ignore */
        }
    }
}

async function ensureH264Decoder(sps, pps) {
    if (!canUseWebCodecsH264()) return false;
    if (st.h264Decoder && st.h264DecoderReady && st.h264Decoder.state === "configured") {
        return true;
    }
    if (st.h264Decoder) {
        try {
            st.h264Decoder.close();
        } catch (_) {
            /* ignore */
        }
        st.h264Decoder = null;
        st.h264DecoderReady = false;
    }
    try {
        st.h264Decoder = new VideoDecoder({
            output: (frame) => {
                queueDecodedVideoFrame(frame);
            },
            error: (e) => console.warn("[h264] decode error", e),
        });
        const spsNal = stripH264StartCode(sps);
        const ppsNal = stripH264StartCode(pps);
        st.h264Decoder.configure({
            codec: codecStringFromSps(spsNal),
            description: buildAvcDescription(spsNal, ppsNal),
            optimizeForLatency: true,
        });
        st.h264ChunkTimestampUs = 0;
        st.h264DecoderReady = true;
        updateCaptureStatusDisplay();
        return true;
    } catch (e) {
        console.warn("[h264] WebCodecs 初始化失败，将等待 WebP 回退", e);
        st.h264Decoder = null;
        st.h264DecoderReady = false;
        updateCaptureStatusDisplay();
        requestWebpFallback("H.264 解码器初始化失败");
        return false;
    }
}

/** 左上角：档位 + 实际收流格式 + 解码是否出画 */
export function isServerProfileDowngrade(name) {
    const p = String(name || "").toLowerCase();
    return p === "thumb" || p === "low" || p === "idle";
}

function getDisplayCaptureProfile() {
    if (st.controlSessionActive) {
        return st.captureProfileHint || pickCaptureSpeedForSession();
    }
    return st.captureProfileHint || pickCaptureSpeedForSession();
}

export function updateCaptureStatusDisplay(profileHint) {
    if (!st.captureSpeedStatus) return;
    if (profileHint) {
        if (
            st.controlSessionActive &&
            isServerProfileDowngrade(profileHint)
        ) {
            const keep = pickCaptureSpeedForSession();
            const now = Date.now();
            if (!st.lastDowngradePingWarnAt || now - st.lastDowngradePingWarnAt > 8000) {
                st.lastDowngradePingWarnAt = now;
                StreamDiag.warn("忽略服务端降档", profileHint, "→ 保持", keep);
            }
        } else if (!st.controlSessionActive) {
            st.captureProfileHint = profileHint;
        }
    }

    const profilePart =
        captureModeLabel(getDisplayCaptureProfile()) || "画质：—";

    let pipePart = " | 等待画面";
    if (!st.lastRxStreamFormat && st.ws) {
        if (st.ws.readyState !== WebSocket.OPEN) {
            pipePart = " | 等待画面（WS 未连接）";
        } else if (st.deviceInfo && !resolveDeviceOnline(st.deviceInfo)) {
            pipePart = st.deviceForceOffline
                ? " | 等待画面（设备已断开）"
                : " | 等待画面（设备离线）";
        } else if (st.ws.readyState === WebSocket.OPEN && !st.controlWsConnected) {
            pipePart = " | 控制通道重连中…";
        }
    }
    if (st.lastRxStreamFormat === "h264") {
        if (!canUseWebCodecsH264()) {
            const why = getWebCodecsBlockReason();
            pipePart = st.webpFallbackRequested
                ? ` | 手机仍发 H.264，切换 WebP 中…${why ? `（${why}）` : ""}`
                : why
                  ? ` | 收流 H.264 · ${why}`
                  : " | 收流 H.264 · 无法解码（无画面）";
        } else if (!st.h264ConfigReceived) {
            pipePart = " | 收流 H.264 · 等待 CONFIG（无画面）";
        } else if (!st.h264DecoderReady) {
            pipePart = " | 收流 H.264 · 解码器初始化失败（无画面）";
        } else if (!st.lastFramePaintAt) {
            pipePart = " | 收流 H.264 · 等待关键帧（无画面）";
        } else {
            pipePart = " | 收流 H.264 · 解码正常 ✓";
        }
    } else if (st.lastRxStreamFormat === "webp") {
        pipePart = st.lastFramePaintAt
            ? " | 收流 WebP · 显示正常 ✓"
            : " | 收流 WebP · 等待首帧";
    } else if (st.lastRxStreamFormat === "jpeg") {
        pipePart = st.lastFramePaintAt
            ? " | 收流 Base64 JPEG · 显示正常 ✓"
            : " | 收流 Base64 JPEG · 等待首帧";
    }

    const backlog = getDisplayBacklog();
    const fps =
        st.paintFpsSamples.length > 0
            ? Math.round(
                  st.paintFpsSamples.reduce((a, b) => a + b, 0) / st.paintFpsSamples.length
              )
            : 0;
    let extra = "";
    if (fps > 0) extra += ` | 显示 ~${fps}fps`;
    if (backlog > 0) extra += ` | 待绘 ${backlog}`;
    else if (st.framesSkippedCoalesce > 0 && fps >= 8) extra += " | 流畅";
    st.captureSpeedStatus.textContent = profilePart + pipePart + extra;
    maybeLogStreamDiagSummary(fps, backlog);
}

function maybeLogStreamDiagSummary(fps, backlog) {
    if (!StreamDiag.enabled()) return;
    const now = Date.now();
    if (now - st.lastStreamDiagSummaryAt < 2000) return;
    st.lastStreamDiagSummaryAt = now;
    const rxFps = Math.round(
        (st.wsBinaryRxWindowCount + st.jsonFrameRxWindowCount) / 2
    );
    const binaryRxFps = Math.round(st.wsBinaryRxWindowCount / 2);
    const rxKb = Math.round(st.wsBinaryRxWindowBytes / 1024);
    const warmupMs = Date.now() - (st.streamDiagSessionStartedAt || 0);
    if (StreamDiag.enabled() && warmupMs > 10000 && rxFps > 0) {
        let hint;
        if (st.currentCodecMode === "base64") {
            if (rxFps >= 1 && rxFps <= st.BASE64_EXPECTED_MAX_FPS + 1) {
                /* 设计上限约 3–4fps（280ms 节流 + 静止跳帧），属正常 */
            } else if (rxFps < 1 || fps < 1) {
                hint =
                    "Base64 长时间无帧：确认手机在线、已重装 APK；静止屏约 0.5fps 重发属正常。要更顺请切 WebP/H.264";
            } else {
                hint =
                    "Base64 突发帧率异常；要更高帧率可试「流畅」(WebP) 或 HTTPS+H.264";
            }
        } else if (
            rxFps < 5 &&
            fps < 5 &&
            isPublicHttpPage() &&
            getViewerQualityMode() === "quality"
        ) {
            hint = "公网 HTTP「清晰」易卡，建议点「流畅」或上 HTTPS";
        } else if (rxFps < 5 && fps < 5) {
            hint = "HTTP 仅 WebP；要更顺可上 HTTPS+H.264";
        }
        if (hint) {
            StreamDiag.warn("收帧偏低 rxFps=", rxFps, "显示~", fps, "fps →", hint);
        }
    }
    StreamDiag.log("summary", {
        displayProfile: getDisplayCaptureProfile(),
        viewerQuality: getViewerQualityMode(),
        codecMode: st.currentCodecMode,
        serverPingHint: st.captureProfileHint,
        rxFormat: st.lastRxStreamFormat,
        paintFps: fps,
        rxFps,
        jsonRxFps: Math.round(st.jsonFrameRxWindowCount / 2),
        binaryRxFps,
        backlog,
        coalesced: st.framesSkippedCoalesce,
        wsRxKB: Math.round(st.wsBinaryRxWindowBytes / 1024),
        decodeInFlight: st.frameDecodeInFlight,
        h264Ready: st.h264DecoderReady,
        base64ExpectedMaxFps:
            st.currentCodecMode === "base64" ? st.BASE64_EXPECTED_MAX_FPS : undefined,
    });
    st.wsBinaryRxWindowCount = 0;
    st.wsBinaryRxWindowBytes = 0;
    st.jsonFrameRxWindowCount = 0;
}

/** 真实待绘积压（非累计丢帧数） */
function getDisplayBacklog() {
    let n = 0;
    if (st.pendingFrameBlob) n++;
    if (st.frameDecodeInFlight) n++;
    if (st.pendingH264Decode) n++;
    if (st.pendingH264VideoFrame) n++;
    if (st.latestWsBinary) n++;
    return n;
}

function recordFramePainted() {
    st.framesPaintedSession++;
    const now = Date.now();
    if (st.lastPaintFpsAt > 0) {
        const dt = now - st.lastPaintFpsAt;
        if (dt > 0 && dt < 2000) {
            st.paintFpsSamples.push(1000 / dt);
            while (st.paintFpsSamples.length > 12) st.paintFpsSamples.shift();
        }
    }
    st.lastPaintFpsAt = now;
}

function h264PayloadHasIdr(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let i = 0;
    while (i + 4 < data.length) {
        const len =
            ((data[i] & 0xff) << 24) |
            ((data[i + 1] & 0xff) << 16) |
            ((data[i + 2] & 0xff) << 8) |
            (data[i + 3] & 0xff);
        if (len <= 0 || i + 4 + len > data.length) break;
        if ((data[i + 4] & 0x1f) === 5) return true;
        i += 4 + len;
    }
    let k = 0;
    while (k + 3 < data.length) {
        let sc = 0;
        if (data[k] === 0 && data[k + 1] === 0) {
            if (data[k + 2] === 1) sc = 3;
            else if (k + 3 < data.length && data[k + 2] === 0 && data[k + 3] === 1) sc = 4;
        }
        if (sc === 0) {
            k++;
            continue;
        }
        const nal = k + sc;
        if (nal < data.length && (data[nal] & 0x1f) === 5) return true;
        k = nal + 1;
    }
    return false;
}

function decodeH264Chunk(frameType, payload) {
    if (!st.h264DecoderReady || !st.h264Decoder) return;
    try {
        const avcc = annexBToAvcc(payload);
        const isKey =
            frameType === st.H264_FRAME_KEY ||
            frameType === st.H264_FRAME_CONFIG ||
            h264PayloadHasIdr(avcc);
        st.h264ChunkTimestampUs += 41667;
        const chunk = new EncodedVideoChunk({
            type: isKey ? "key" : "delta",
            timestamp: st.h264ChunkTimestampUs,
            data: avcc,
        });
        if (st.h264Decoder.state === "configured") {
            st.h264Decoder.decode(chunk);
        }
    } catch (e) {
        console.warn("[h264] chunk decode failed", e);
    }
}

/** 只解码最新一帧，避免 H.264 积压导致画面与控制反馈落后 1～2 秒 */
export function queueH264Chunk(frameType, payload) {
    if (!canUseWebCodecsH264() || !st.h264DecoderReady || !st.h264Decoder) return;

    if (frameType === st.H264_FRAME_CONFIG) {
        const cfg = parseH264ConfigPayload(payload);
        if (cfg) ensureH264Decoder(cfg.sps, cfg.pps);
        return;
    }

    st.pendingH264Decode = { frameType, payload };
    if (st.h264DecodeFlushScheduled) return;
    st.h264DecodeFlushScheduled = true;
    const run = () => {
        st.h264DecodeFlushScheduled = false;
        const job = st.pendingH264Decode;
        st.pendingH264Decode = null;
        if (job) decodeH264Chunk(job.frameType, job.payload);
    };
    if (typeof queueMicrotask === "function") {
        queueMicrotask(run);
    } else {
        Promise.resolve().then(run);
    }
}

export function initDeviceFrameCanvas() {
    if (!st.deviceCanvas) return;
    st.frameCanvasCtx = st.deviceCanvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
    });
    if (st.frameCanvasCtx) {
        st.frameCanvasCtx.imageSmoothingEnabled = true;
        st.frameCanvasCtx.imageSmoothingQuality = "high";
    }
}

/** 赋值 canvas.width/height 会清空位图；仅在实际尺寸变化超过阈值时重置，避免 1px 抖动闪黑 */

function getCanvasClientSize() {
    if (!st.deviceCanvas) return { cw: 1, ch: 1 };
    const rect = st.deviceCanvas.getBoundingClientRect();
    return {
        cw: Math.max(1, Math.floor(rect.width)),
        ch: Math.max(1, Math.floor(rect.height)),
    };
}

function ensureCanvasBackingStore(cw, ch) {
    const pw = st.deviceCanvas.width;
    const ph = st.deviceCanvas.height;
    const needResize =
        pw < 1 ||
        ph < 1 ||
        Math.abs(pw - cw) >= st.CANVAS_BACKING_HYSTERESIS_PX ||
        Math.abs(ph - ch) >= st.CANVAS_BACKING_HYSTERESIS_PX;
    if (!needResize) {
        return { cw: pw, ch: ph, resized: false };
    }
    st.deviceCanvas.width = cw;
    st.deviceCanvas.height = ch;
    st.lastCanvasPaintW = 0;
    st.lastCanvasPaintH = 0;
    return { cw, ch, resized: true };
}

function fillCanvasLetterboxIfNeeded(cw, ch) {
    if (!st.frameCanvasCtx) return;
    if (st.lastCanvasPaintW === cw && st.lastCanvasPaintH === ch) return;
    st.frameCanvasCtx.fillStyle = "#0a0a0a";
    st.frameCanvasCtx.fillRect(0, 0, cw, ch);
    st.lastCanvasPaintW = cw;
    st.lastCanvasPaintH = ch;
}

function computeLetterboxDest(bw, bh, cw, ch) {
    const scale = Math.min(cw / bw, ch / bh);
    const dw = bw * scale;
    const dh = bh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    return { dx, dy, dw, dh };
}

/** 将位图/视频帧绘制到 Canvas（不每帧 clearRect） */
function drawSourceLetterboxed(imageSource, bw, bh) {
    if (!st.deviceCanvas || !st.frameCanvasCtx || bw < 1 || bh < 1) return false;
    let { cw, ch } = getCanvasClientSize();
    if (cw < 2 || ch < 2) return false;
    ({ cw, ch } = ensureCanvasBackingStore(cw, ch));
    const { dx, dy, dw, dh } = computeLetterboxDest(bw, bh, cw, ch);
    fillCanvasLetterboxIfNeeded(cw, ch);
    st.frameCanvasCtx.imageSmoothingEnabled = true;
    st.frameCanvasCtx.imageSmoothingQuality = "high";
    st.frameCanvasCtx.drawImage(imageSource, 0, 0, bw, bh, dx, dy, dw, dh);
    st.lastFrameContentRect = { dx, dy, dw, dh, cw, ch };
    st.lastFramePixelSize = { bw, bh };
    refreshVisibleImageRect();
    return true;
}

function waitNextPaintFrame() {
    if (typeof requestAnimationFrame !== "function") {
        return Promise.resolve();
    }
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function releaseFrameBitmap() {
    if (st.latestFrameBitmap) {
        st.latestFrameBitmap.close();
        st.latestFrameBitmap = null;
    }
    if (st.h264Decoder) {
        try {
            st.h264Decoder.close();
        } catch (_) {
            /* ignore */
        }
        st.h264Decoder = null;
        st.h264DecoderReady = false;
        st.h264ConfigReceived = false;
        updateCaptureStatusDisplay();
    }
}


export function refreshVisibleImageRect() {
    if (!st.deviceImage) return;
    st.lastVisibleImageRect = st.deviceImage.getBoundingClientRect();
    if (usesBase64ImgDisplay()) {
        updateBase64ContentRect();
    }
}

/** Base64 img 模式：在 st.viewerFrame 坐标系下计算 letterbox 内容区（供滑动/点击换算） */
export function updateBase64ContentRect() {
    if (!usesBase64ImgDisplay() || !st.viewerFrame || !st.deviceImage) {
        return;
    }
    const frameRect = st.viewerFrame.getBoundingClientRect();
    const imgRect = st.deviceImage.getBoundingClientRect();
    const nw = st.deviceImage.naturalWidth || 0;
    const nh = st.deviceImage.naturalHeight || 0;
    if (nw < 1 || nh < 1 || frameRect.width < 8 || imgRect.width < 4) {
        return;
    }
    const scale = Math.min(imgRect.width / nw, imgRect.height / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    const dx = imgRect.left - frameRect.left + (imgRect.width - dw) / 2;
    const dy = imgRect.top - frameRect.top + (imgRect.height - dh) / 2;
    st.lastFrameContentRect = {
        dx,
        dy,
        dw,
        dh,
        cw: frameRect.width,
        ch: frameRect.height,
    };
}

/** Base64 已改 Canvas 单缓冲绘制，不再使用双 img（避免切换 visibility 闪黑） */
export function usesBase64ImgDisplay() {
    return false;
}

export function updateCodecDisplayLayer() {
    if (st.deviceFrameStack) {
        st.deviceFrameStack.classList.remove("device-frame-stack--base64-img");
    }
    st.deviceImage = st.deviceCanvas || st.deviceImageA;
    if (!st.frameCanvasCtx && st.deviceCanvas) {
        initDeviceFrameCanvas();
    }
}

function noteBase64FramePainted() {
    st.lastFramePaintAt = Date.now();
    recordFramePainted();
    st.lastRxStreamFormat = "jpeg";
    clearCaptureBootstrapRetry();
    updateCaptureStatusDisplay();
}

function base64FrameFingerprint(src) {
    if (!src) return "";
    if (src.length < 256) return String(src.length);
    const mid = src.charCodeAt(200) ^ src.charCodeAt(Math.floor(src.length * 0.5));
    const tail = src.charCodeAt(src.length - 80);
    return `${src.length}:${mid}:${tail}`;
}

export function revokeLastBase64ObjectUrl() {
    if (st.lastBase64ObjectUrl) {
        URL.revokeObjectURL(st.lastBase64ObjectUrl);
        st.lastBase64ObjectUrl = null;
    }
}

/** Base64 模式：合并收帧 + 限频上屏（避免操作后连闪） */
function queueBase64DeviceFrame(src) {
    if (!usesBase64ImgDisplay()) return;
    st.jsonFrameRxWindowCount++;
    st.pendingBase64FrameSrc = src;
    if (st.base64PaintCoalesceTimer) return;
    const elapsed = Date.now() - st.lastBase64PaintAt;
    const wait = Math.max(0, st.BASE64_MIN_PAINT_MS - elapsed);
    st.base64PaintCoalesceTimer = setTimeout(() => {
        st.base64PaintCoalesceTimer = null;
        const next = st.pendingBase64FrameSrc;
        st.pendingBase64FrameSrc = null;
        if (!next) return;
        if (st.base64BackLoading) {
            st.pendingBase64FrameSrc = next;
            queueBase64DeviceFrame(next);
            return;
        }
        applyBase64DeviceFrame(next);
    }, wait);
}

/** 双 img 乒乓缓冲：新帧在隐藏层解码，完成后再切换，避免改可见层 src 时闪黑 */
function applyBase64DeviceFrame(src) {
    let visible = st.base64FrontEl || st.deviceImageA;
    let back = st.base64BackEl || st.deviceImageB;
    if (!visible || !back) return;

    const fp = base64FrameFingerprint(src);
    if (fp && fp === st.lastBase64DisplayFp) return;
    st.lastBase64DisplayFp = fp;

    st.deviceImage = visible;

    const afterPaint = (shownEl) => {
        st.base64BackLoading = false;
        st.lastBase64PaintAt = Date.now();
        updateBase64ContentRect();
        refreshVisibleImageRect();
        noteBase64FramePainted();
        if (StreamDiag.enabled() && st.framesPaintedSession <= 5) {
            StreamDiag.log(
                "base64 img 显示",
                shownEl.naturalWidth,
                "x",
                shownEl.naturalHeight
            );
        }
        if (st.pendingBase64FrameSrc) {
            const queued = st.pendingBase64FrameSrc;
            st.pendingBase64FrameSrc = null;
            applyBase64DeviceFrame(queued);
        }
    };

    const swapVisibleBack = () => {
        visible.classList.remove("device-frame-img--visible");
        visible.classList.add("device-frame-img--hidden");
        back.classList.remove("device-frame-img--hidden");
        back.classList.add("device-frame-img--visible");
        st.base64BackEl = visible;
        st.base64FrontEl = back;
        st.deviceImage = st.base64FrontEl;
        afterPaint(back);
    };

    if (!visible.src || visible.naturalWidth < 1) {
        st.base64BackLoading = true;
        visible.onload = () => {
            visible.onload = null;
            visible.onerror = null;
            afterPaint(visible);
        };
        visible.onerror = () => {
            st.base64BackLoading = false;
            StreamDiag.warn("base64 首帧 img 加载失败");
        };
        visible.src = src;
        return;
    }

    if (st.base64BackLoading) {
        st.pendingBase64FrameSrc = src;
        return;
    }

    if (back.src === src && back.complete && back.naturalWidth > 0) {
        swapVisibleBack();
        return;
    }

    st.base64BackLoading = true;
    back.onload = () => {
        back.onload = null;
        back.onerror = null;
        swapVisibleBack();
    };
    back.onerror = () => {
        back.onload = null;
        back.onerror = null;
        st.base64BackLoading = false;
        StreamDiag.warn("base64 背层 img 加载失败");
        if (st.pendingBase64FrameSrc) {
            const queued = st.pendingBase64FrameSrc;
            st.pendingBase64FrameSrc = null;
            applyBase64DeviceFrame(queued);
        }
    };
    back.src = src;
}

export function deliverBase64JpegFrame(bytes) {
    if (st.currentCodecMode !== "base64") return false;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    st.jsonFrameRxWindowCount++;
    markDeviceOnlineFromStream("base64_binary");
    queueDeviceFrameBlob(jpegBytesToBlob(view));
    return true;
}

export function isDeviceImageTarget(target) {
    return st.deviceFrameStack && target && st.deviceFrameStack.contains(target);
}

/** 顶部退出 / 模式切换等控件，不参与点击、滑动坐标换算 */
export function isControlChromeTarget(target) {
    if (!target) return false;
    if (st.btnCloseExpanded && (target === st.btnCloseExpanded || st.btnCloseExpanded.contains(target))) {
        return true;
    }
    const modeBar = document.querySelector(".mode-toggle-bar");
    if (modeBar && (target === modeBar || modeBar.contains(target))) {
        return true;
    }
    return false;
}

export function stopControlEvent(e) {
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") {
        e.stopImmediatePropagation();
    }
}

export function exitExpandedControl() {
    st.isExpanded = false;
    st.pointerDown = false;
    st.isLongPressed = false;
    st.ignoreNextClick = false;
    st.ignoreNextClickFromPress = false;
    clearTimeout(st.touchTimer);
    st.viewerFrame.classList.remove("expanded");
    st.viewerTips.innerHTML = "点击画面放大控制";
    syncTouchLayers();
    clearSwipeTrail();
    endSwipeCaptureSlowdown();
    // 控制页 Base64 保持 high，退出全屏不再降回 4s 一帧
}

export function syncTouchLayers() {
    if (!st.swipeOverlay || !st.deviceFrameStack) return;
    const swipeActive = st.isExpanded && st.currentControlMode === "swipe";
    st.swipeOverlay.classList.toggle("swipe-touch-overlay--active", swipeActive);
    st.deviceFrameStack.classList.toggle("device-frame-stack--display-only", swipeActive);
}

export function clearSwipeTrail() {
    if (!st.swipeTrailCanvas) return;
    const ctx = st.swipeTrailCanvas.getContext("2d");
    if (!ctx) return;
    const rect = st.swipeOverlay.getBoundingClientRect();
    st.swipeTrailCanvas.width = rect.width;
    st.swipeTrailCanvas.height = rect.height;
    ctx.clearRect(0, 0, rect.width, rect.height);
}

export function drawSwipeTrail(clientX1, clientY1, clientX2, clientY2) {
    if (!st.swipeTrailCanvas || !st.swipeOverlay) return;
    const rect = st.swipeOverlay.getBoundingClientRect();
    st.swipeTrailCanvas.width = rect.width;
    st.swipeTrailCanvas.height = rect.height;
    const ctx = st.swipeTrailCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = "rgba(59, 130, 246, 0.92)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(clientX1 - rect.left, clientY1 - rect.top);
    ctx.lineTo(clientX2 - rect.left, clientY2 - rect.top);
    ctx.stroke();
}

function flushPendingFrameBlob() {
    st.frameRafScheduled = false;
    const next = st.pendingFrameBlob;
    st.pendingFrameBlob = null;
    if (next) void paintDeviceFrameBlob(next);
}

function getDecodeResizeWidth() {
    if (!st.deviceCanvas) return undefined;
    const rect = st.deviceCanvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    if (w < 1) return undefined;
    const cap = getViewerQualityMode() === "smooth" ? 360 : 640;
    return Math.min(w, cap);
}

/** 从协议解析出的 Uint8Array 构造 Blob（避免 subarray 共享底层缓冲导致解码失败） */
export function jpegBytesToBlob(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new Blob([view.slice()], { type: "image/jpeg" });
}

function decodeBlobForPaint(blob, resizeWidth) {
    if (st.currentCodecMode === "base64") {
        return createImageBitmap(blob);
    }
    const workerPromise = decodeBlobViaWorker(blob, resizeWidth);
    if (workerPromise) return workerPromise;
    return createFrameBitmap(blob);
}


function getFrameDecodeWorker() {
    if (st.frameDecodeWorker) return st.frameDecodeWorker;
    if (typeof Worker === "undefined") return null;
    try {
        st.frameDecodeWorker = new Worker("frame-decode-worker.js");
    } catch (e) {
        console.warn("[frame] Worker 不可用，回退主线程解码", e);
        return null;
    }
    return st.frameDecodeWorker;
}

export function terminateFrameDecodeWorker() {
    if (st.frameDecodeWorker) {
        st.frameDecodeWorker.terminate();
        st.frameDecodeWorker = null;
    }
}

function createFrameBitmap(blob) {
    const resizeWidth = getDecodeResizeWidth();
    if (resizeWidth) {
        try {
            return createImageBitmap(blob, {
                resizeWidth,
                resizeQuality: "low",
            });
        } catch (_) {
            /* 旧版浏览器无 resize 参数 */
        }
    }
    return createImageBitmap(blob);
}

/** 尽快绘帧：解码进行中只保留最新 blob，避免并行 createImageBitmap 卡死主线程 */
export function queueDeviceFrameBlob(blob) {
    st.pendingFrameBlob = blob;
    if (st.frameDecodeInFlight) return;
    if (st.frameRafScheduled) return;
    st.frameRafScheduled = true;
    if (typeof queueMicrotask === "function") {
        queueMicrotask(flushPendingFrameBlob);
    } else {
        Promise.resolve().then(flushPendingFrameBlob);
    }
}

export function queueWsBinaryMessage(arrayBuffer) {
    if (st.latestWsBinary) st.framesSkippedCoalesce++;
    st.latestWsBinary = arrayBuffer;
    st.wsBinaryRxCount++;
    st.wsBinaryRxBytes += arrayBuffer.byteLength || 0;
    st.wsBinaryRxWindowCount++;
    st.wsBinaryRxWindowBytes += arrayBuffer.byteLength || 0;
    const now = Date.now();
    const gap = st.lastWsBinaryRxAt ? now - st.lastWsBinaryRxAt : 0;
    st.lastWsBinaryRxAt = now;
    if (StreamDiag.enabled() && (st.wsBinaryRxCount <= 3 || gap > 800)) {
        StreamDiag.log("ws rx binary", arrayBuffer.byteLength, "B gapMs", gap);
    }
    if (StreamDiag.enabled() && getViewerQualityMode() === "smooth") {
        if (arrayBuffer.byteLength > 20000 && gap > 0 && gap < 800) {
            StreamDiag.warn(
                "流畅档大帧",
                arrayBuffer.byteLength,
                "B gapMs",
                gap,
                "（界面变化过快，手机将自动缩小）"
            );
        } else if (arrayBuffer.byteLength > 5000 && gap >= 2000) {
            StreamDiag.log(
                "流畅档恢复帧",
                arrayBuffer.byteLength,
                "B gapMs",
                gap,
                "（静止跳帧后首帧，已修复）"
            );
        }
    }
    if (st.wsBinaryRaf) return;
    const run = () => {
        st.wsBinaryRaf = 0;
        const buf = st.latestWsBinary;
        st.latestWsBinary = null;
        if (buf) handleBinaryMessage(buf);
    };
    // 立即解析解码，不等 vsync 对齐（减少 ~16ms 延迟）
    if (typeof queueMicrotask === "function") {
        st.wsBinaryRaf = 1;
        queueMicrotask(run);
    } else {
        st.wsBinaryRaf = 1;
        Promise.resolve().then(run);
    }
}

function decodeBlobViaWorker(blob, resizeWidth) {
    const worker = getFrameDecodeWorker();
    if (!worker) return null;
    const jobId = ++st.frameDecodeWorkerJobId;
    const timeoutMs = 4000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            reject(new Error("frame-decode-worker timeout"));
        }, timeoutMs);
        const onMessage = (ev) => {
            if (!ev.data || ev.data.id !== jobId) return;
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            if (ev.data.error) {
                reject(new Error(ev.data.error));
                return;
            }
            resolve(ev.data.bitmap);
        };
        const onError = (err) => {
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            reject(err);
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage({ id: jobId, blob, resizeWidth });
    });
}

/** Canvas 绘制最新帧（Worker/主线程解码 + 丢弃过期结果） */
async function paintDeviceFrameBlob(blob) {
    if (!st.deviceCanvas) {
        StreamDiag.warn("paint: st.deviceCanvas 不存在");
        return;
    }
    if (!st.frameCanvasCtx) {
        initDeviceFrameCanvas();
    }
    if (!st.frameCanvasCtx) {
        StreamDiag.warn("paint: 无法获取 2d 上下文");
        return;
    }
    st.frameDecodeInFlight = true;
    let nextBlob = blob;
    const resizeWidth = getDecodeResizeWidth();
    try {
        while (nextBlob) {
            const generation = ++st.framePaintGeneration;
            let bitmap;
            try {
                bitmap = await decodeBlobForPaint(nextBlob, resizeWidth);
            } catch (e) {
                console.warn("[frame] Canvas 解码失败", e);
                StreamDiag.warn("Canvas 解码失败", e?.message || e);
                updateCaptureStatusDisplay();
                break;
            }
            nextBlob = null;
            if (generation !== st.framePaintGeneration) {
                bitmap.close();
                nextBlob = st.pendingFrameBlob;
                st.pendingFrameBlob = null;
                if (nextBlob) continue;
                break;
            }
            releaseFrameBitmap();
            st.latestFrameBitmap = bitmap;

            const bw = bitmap.width;
            const bh = bitmap.height;
            await waitNextPaintFrame();
            if (generation !== st.framePaintGeneration) {
                releaseFrameBitmap();
                nextBlob = st.pendingFrameBlob;
                st.pendingFrameBlob = null;
                if (nextBlob) continue;
                break;
            }
            const painted = drawSourceLetterboxed(bitmap, bw, bh);
            if (!painted) {
                releaseFrameBitmap();
                nextBlob = st.pendingFrameBlob;
                st.pendingFrameBlob = null;
                if (nextBlob) continue;
                break;
            }
            st.lastFramePaintAt = Date.now();
            recordFramePainted();
            markDeviceOnlineFromStream("canvas_paint");
            clearH264NoFrameFallbackTimer();
            clearCaptureBootstrapRetry();
            updateCaptureStatusDisplay();
            if (StreamDiag.enabled() && st.framesPaintedSession <= 3) {
                const { cw, ch } = getCanvasClientSize();
                StreamDiag.log("paint webp/jpeg", bw, "x", bh, "canvas", cw, "x", ch);
            }

            nextBlob = st.pendingFrameBlob;
            st.pendingFrameBlob = null;
            if (nextBlob) continue;
            break;
        }
    } finally {
        st.frameDecodeInFlight = false;
        if (st.pendingFrameBlob) queueDeviceFrameBlob(st.pendingFrameBlob);
    }
}

/** 最近一帧（全屏切换时重绘） */

function base64DataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: "image/jpeg" });
}

function repaintCachedDeviceFrame() {
    if (st.lastDeviceFrameBlob) {
        queueDeviceFrameBlob(st.lastDeviceFrameBlob);
    } else if (st.lastDeviceFrameDataUrl) {
        paintBase64Frame(st.lastDeviceFrameDataUrl);
    }
}

/** Base64 JSON 帧：转 Blob 后走 Canvas 单缓冲（与 WebP 相同，不闪黑） */
export function paintBase64Frame(dataUrl) {
    if (!dataUrl) return;
    const fp = base64FrameFingerprint(dataUrl);
    if (fp && fp === st.lastBase64DisplayFp) return;
    st.lastBase64DisplayFp = fp;
    st.lastDeviceFrameDataUrl = dataUrl;
    try {
        const blob = base64DataUrlToBlob(dataUrl);
        st.lastDeviceFrameBlob = blob;
        st.jsonFrameRxWindowCount++;
        queueDeviceFrameBlob(blob);
        if (StreamDiag.enabled() && st.framesPaintedSession === 0 && st.jsonFrameRxWindowCount <= 2) {
            StreamDiag.log("base64 帧入队", blob.size, "B");
        }
    } catch (e) {
        StreamDiag.warn("base64→blob 失败", e?.message || e);
    }
}

function drawImageSourceToCanvas(imageSource) {
    if (!st.deviceCanvas || !st.frameCanvasCtx) {
        StreamDiag.warn("drawImageSourceToCanvas: canvas 未初始化");
        return false;
    }
    const bw = imageSource.naturalWidth || imageSource.width || 0;
    const bh = imageSource.naturalHeight || imageSource.height || 0;
    if (bw < 1 || bh < 1) {
        StreamDiag.warn("drawImageSourceToCanvas: 图片尺寸无效", bw, bh);
        return false;
    }
    if (!drawSourceLetterboxed(imageSource, bw, bh)) {
        const { cw, ch } = getCanvasClientSize();
        StreamDiag.warn("drawImageSourceToCanvas: canvas 尺寸过小", cw, ch);
        return false;
    }
    st.lastFramePaintAt = Date.now();
    recordFramePainted();
    updateCaptureStatusDisplay();
    if (StreamDiag.enabled() && st.framesPaintedSession <= 5) {
        const { cw, ch } = getCanvasClientSize();
        StreamDiag.log("drawImageSourceToCanvas ok", bw, "x", bh, "canvas", cw, "x", ch);
    }
    return true;
}

function drawBitmapToCanvas(bmp) {
    if (!bmp) return;
    if (!st.deviceCanvas || !st.frameCanvasCtx) {
        initDeviceFrameCanvas();
        if (!st.deviceCanvas || !st.frameCanvasCtx) {
            try {
                bmp.close();
            } catch (_) {
                /* ignore */
            }
            return;
        }
    }
    requestAnimationFrame(() => {
        try {
            drawImageSourceToCanvas(bmp);
        } finally {
            try {
                bmp.close();
            } catch (_) {
                /* ignore */
            }
        }
    });
}

window.addEventListener("resize", () => {
    refreshVisibleImageRect();
    if (st.latestFrameBitmap && st.frameCanvasCtx) {
        drawSourceLetterboxed(
            st.latestFrameBitmap,
            st.latestFrameBitmap.width,
            st.latestFrameBitmap.height
        );
    }
    if (st.swipeOverlay?.classList.contains("swipe-touch-overlay--active")) {
        clearSwipeTrail();
    }
});

