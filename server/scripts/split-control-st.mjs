/**
 * 使用 st 对象拆分 control.js.bak（仅生成 codec/frame/session/viewer）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const bakPath = path.join(publicDir, "control.js.bak");
const outDir = path.join(publicDir, "control");

const lines = fs.readFileSync(bakPath, "utf8").split(/\r?\n/);
const slice = (from, to) => lines.slice(from - 1, to).join("\n");

const ST_KEYS = [
    "syncGroupDeviceIds", "syncGroupParam", "captureSessionPrewarmed", "INTERACTIVE_CONTROL_TYPES",
    "MASTER_ONLY_COMMANDS", "h264VideoPaintScheduled", "pendingH264VideoFrame", "h264DecodeFlushScheduled",
    "lastDowngradePingWarnAt", "controlPingReassertAt", "captureBootstrapRetryCount", "captureBootstrapRetryTimer",
    "codecPreferenceSynced", "STORAGE_VIEWER_QUALITY", "CONTROL_IDLE_LOW_MS", "CAPTURE_BOOTSTRAP_MAX_RETRIES",
    "CAPTURE_BOOTSTRAP_RETRY_MS", "H264_NO_FRAME_FALLBACK_MS", "h264NoFrameFallbackTimer", "webpFallbackRequested",
    "lastFramePaintAt", "h264ConfigReceived", "lastRxStreamFormat", "captureProfileHint", "lastPreferWebpSentAt",
    "h264ChunkTimestampUs", "h264DecoderReady", "IMAGE_FORMAT_H264", "IMAGE_FORMAT_WEBP", "IMAGE_FORMAT_JPEG",
    "WEB_FRAME_MAGIC", "lastFrameContentRect", "framePaintGeneration", "frameRafScheduled", "swipeCapturingSlow",
    "SWIPE_THROTTLE_MS", "lastSwipeSentAt", "sendControlAnimationTimer", "ignoreNextClickFromPress", "ignoreNextClick",
    "isLongPressed", "streamDiagSessionStartedAt", "controlSessionActive", "wsReconnectAttempt", "wsReconnectTimer",
    "deviceMetaRefreshTimer", "DEVICE_ONLINE_STALE_MS", "lastDeviceFrameRxAt", "deviceForceOffline", "deviceStreamOnline",
    "controlWsConnected", "BASE64_EXPECTED_MAX_FPS", "ELEVATE_CONTROL_COALESCE_MS", "lastElevateControlSentAt",
    "VISIBILITY_LOW_DELAY_MS", "BASE64_MIN_PAINT_MS", "lastBase64DisplayFp", "pendingBase64FrameSrc", "base64BackLoading",
    "deviceFrameStack", "btnCodecH264", "btnCodecWebp", "btnCodecBase64", "swipeTrailCanvas", "togglePressMode",
    "toggleSwipeMode", "toggleClickMode", "btnCloseUiNodeModal", "btnFetchUiNodes", "captureSpeedStatus",
    "masterDeviceSelect", "masterDeviceRow", "jsonFrameRxWindowCount", "wsBinaryRxWindowCount", "wsBinaryRxBytes",
    "wsBinaryRxWindowBytes", "wsBinaryRxCount", "lastWsBinaryRxAt", "framesPaintedSession", "framesSkippedCoalesce",
    "frameDecodeInFlight", "latestWsBinary", "lastCaptureStatusPaintAt", "lastStreamDiagSummaryAt", "lastBase64ObjectUrl",
    "lastRequestFrameSentAt", "base64PaintCoalesceTimer", "lastBase64PaintAt", "visibilityLowTimer", "lastCanvasPaintH",
    "lastCanvasPaintW", "frameCanvasCtx", "pendingFrameBlob", "latestFrameBitmap", "paintFpsSamples", "lastPaintFpsAt",
    "wsBinaryRaf", "deviceUploadStatus", "deviceFileInput", "btnUploadFile", "btnSetLowSpeed", "btnSetHighSpeed",
    "pointerStartY", "pointerStartX", "frameDecodeWorkerJobId", "frameDecodeWorker", "currentControlMode",
    "lastVisibleImageRect", "startOffsetPoint", "swipeTrailStartClient", "CANVAS_BACKING_HYSTERESIS_PX",
    "lastDeviceFrameBlob", "lastDeviceFrameDataUrl", "H264_FRAME_DELTA", "H264_FRAME_KEY", "H264_FRAME_CONFIG",
    "h264Decoder", "controlIdleLowTimer", "captureElevated", "pendingH264Decode", "deviceImage", "base64FrontEl",
    "base64BackEl", "isExpanded", "touchTimer", "pointerDown", "startY", "startX", "deviceInfo", "ws",
    "uiNodeData", "uiNodeStatus", "uiNodeModal", "btnCloseExpanded", "viewerTips", "viewerFrame", "deviceTitle",
    "deviceMeta", "swipeOverlay", "deviceImageB", "deviceImageA", "deviceCanvas", "currentCodecMode",
    "btnSpeedTest",
];

const SKIP_WORDS = new Set([
    "StreamDiag", "CodecClient", "VideoDecoder", "EncodedVideoChunk", "WebSocket", "Worker", "ImageBitmap",
    "TextDecoder", "Uint8Array", "ArrayBuffer", "FormData", "performance", "localStorage", "document", "window",
    "console", "JSON", "Math", "Date", "Promise", "Set", "Map", "Blob", "URL", "location", "cancelAnimationFrame",
    "requestAnimationFrame", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "alert", "prompt",
    "fetch", "atob", "UiInspector",
]);

function transformCode(code) {
    let out = code;
    for (const key of ST_KEYS) {
        if (SKIP_WORDS.has(key)) continue;
        const re = new RegExp(`(?<!st\\.)\\b${key}\\b`, "g");
        out = out.replace(re, `st.${key}`);
    }
    for (const key of ["params", "deviceId", "token", "ws"]) {
        const re = new RegExp(`(?<!st\\.)(?<!\\.)\\b${key}\\b(?!\\s*:)`, "g");
        out = out.replace(re, `st.${key}`);
    }
    out = out.replace(/\bst\.StreamDiag\b/g, "StreamDiag");
    out = out.replace(/(\b(?:msg|parsed|d|i)\.)st\.deviceId\b/g, "$1deviceId");
    out = out.replace(/\bst\.deviceId:/g, "deviceId:");
    out = out.replace(/\{\s*st\.deviceId,/g, "{ deviceId: st.deviceId,");
    out = out.replace(/type: "control",\s*st\.deviceId,/g, 'type: "control", deviceId: st.deviceId,');
    out = out.replace(/st\.ws:\/\//g, "ws://");
    out = out.replace(/\/st\.ws/g, "/ws");
    return out;
}

function wrap(name, code, extra = "") {
    return `/** @module control/${name} */\nimport { st, StreamDiag } from "./state.js";\n${extra}\n${transformCode(code)}\n`;
}

function frameBlock() {
    const skip = [[996, 996], [1082, 1089], [1388, 1389], [1601, 1602]];
    const parts = [];
    let from = 479;
    for (const [a, b] of skip) {
        if (from <= a - 1) parts.push(slice(from, a - 1));
        from = b + 1;
    }
    if (from <= 1731) parts.push(slice(from, 1731));
    return parts.join("\n");
}

const codecRaw = [slice(124, 179), slice(232, 394), slice(432, 450)].join("\n\n")
    .replace(/\bfunction updateGroupControlTitle\b/, "export function updateGroupControlTitle")
    .replace(/\bfunction initMasterDeviceSelect\b/, "export function initMasterDeviceSelect")
    .replace(/\bfunction initViewerQualityBar\b/, "export function initViewerQualityBar");

const sessionRaw = slice(1732, 2712).replace(/\bfunction connectWebSocket\b/, "export function connectWebSocket");
const viewerRaw = slice(2713, 3702)
    .replace(/\n\/\/ 初始化：建立 WebSocket 连接\nconnectWebSocket\(\);\n/, "\n");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "codec.js"), wrap("codec", codecRaw));
fs.writeFileSync(path.join(outDir, "frame.js"), wrap("frame", frameBlock()));
fs.writeFileSync(path.join(outDir, "session.js"), wrap("session", sessionRaw));
fs.writeFileSync(path.join(outDir, "viewer.js"), wrap("viewer", viewerRaw));

fs.writeFileSync(
    path.join(outDir, "main.js"),
    `import { st } from "./state.js";\nimport { updateGroupControlTitle, initMasterDeviceSelect, initViewerQualityBar } from "./codec.js";\nimport "./frame.js";\nimport { connectWebSocket } from "./session.js";\nimport "./viewer.js";\n\nupdateGroupControlTitle();\ninitMasterDeviceSelect();\ninitViewerQualityBar();\nconnectWebSocket();\n`
);

fs.writeFileSync(
    path.join(publicDir, "control.js"),
    `/** 入口：控制页模块（st 共享状态） */\nimport "./control/main.js";\n`
);

console.log("st-split modules OK");
