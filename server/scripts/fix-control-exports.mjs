/**
 * 为 control 拆分模块补齐 export / import（修复跨文件 ReferenceError）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "public", "control");

const exportsByFile = {
    "frame.js": [
        "deliverBase64JpegFrame", "isServerProfileDowngrade", "jpegBytesToBlob", "paintBase64Frame",
        "parseH264ConfigPayload", "parseWebFramePacket", "queueDeviceFrameBlob", "queueH264Chunk",
        "queueWsBinaryMessage", "revokeLastBase64ObjectUrl", "terminateFrameDecodeWorker",
        "updateCaptureStatusDisplay", "updateCodecDisplayLayer", "clearSwipeTrail", "drawSwipeTrail",
        "exitExpandedControl", "isControlChromeTarget", "isDeviceImageTarget", "refreshVisibleImageRect",
        "releaseFrameBitmap", "stopControlEvent", "syncTouchLayers", "updateBase64ContentRect",
        "usesBase64ImgDisplay", "initDeviceFrameCanvas",
    ],
    "session.js": [
        "captureModeLabel", "clearCaptureBootstrapRetry", "clearH264NoFrameFallbackTimer", "endSwipeCaptureSlowdown",
        "handleBinaryMessage", "isPublicHttpPage", "markDeviceOnlineFromStream", "pickCaptureSpeedForSession",
        "resolveDeviceOnline", "scheduleH264NoFrameFallback", "beginSwipeCaptureSlowdown", "bootstrapCaptureSession",
        "bumpControlActivity", "clearControlIdleTimer", "elevateControlCapture", "primeControlCapture",
        "releaseControlCaptureToLow", "scheduleControlIdleTimer", "sendControl", "sendSwipeControl",
        "teardownControlSession",
    ],
    "codec.js": [
        "canUseWebCodecsH264", "forcePreferWebp", "formatControlAck", "getViewerQualityMode",
        "getWebCodecsBlockReason", "requestWebpFallback", "shouldSkipStaleDisplayFrames", "skipStaleDisplayFrames",
        "syncCaptureCodecPreference", "getDeviceResolution",
    ],
    "viewer.js": ["updateCodecModeButtons"],
};

const importsByFile = {
    "session.js": {
        "./frame.js": [
            "deliverBase64JpegFrame", "isServerProfileDowngrade", "jpegBytesToBlob", "paintBase64Frame",
            "parseH264ConfigPayload", "parseWebFramePacket", "queueDeviceFrameBlob", "queueH264Chunk",
            "queueWsBinaryMessage", "revokeLastBase64ObjectUrl", "terminateFrameDecodeWorker",
            "updateCaptureStatusDisplay", "updateCodecDisplayLayer",
        ],
        "./codec.js": [
            "canUseWebCodecsH264", "forcePreferWebp", "formatControlAck", "getViewerQualityMode",
            "getWebCodecsBlockReason", "requestWebpFallback", "shouldSkipStaleDisplayFrames",
            "skipStaleDisplayFrames", "syncCaptureCodecPreference",
        ],
        "./viewer.js": ["updateCodecModeButtons"],
    },
    "frame.js": {
        "./session.js": [
            "captureModeLabel", "clearCaptureBootstrapRetry", "clearH264NoFrameFallbackTimer", "endSwipeCaptureSlowdown",
            "isPublicHttpPage", "markDeviceOnlineFromStream", "pickCaptureSpeedForSession", "resolveDeviceOnline",
        ],
        "./codec.js": [
            "canUseWebCodecsH264", "getViewerQualityMode", "getWebCodecsBlockReason", "requestWebpFallback",
        ],
    },
    "codec.js": {
        "./frame.js": ["updateCaptureStatusDisplay"],
        "./session.js": ["isPublicHttpPage", "pickCaptureSpeedForSession", "sendControl"],
    },
    "viewer.js": {
        "./frame.js": [
            "clearSwipeTrail", "drawSwipeTrail", "exitExpandedControl", "isControlChromeTarget",
            "isDeviceImageTarget", "refreshVisibleImageRect", "releaseFrameBitmap", "stopControlEvent",
            "syncTouchLayers", "updateBase64ContentRect", "updateCaptureStatusDisplay", "updateCodecDisplayLayer",
            "usesBase64ImgDisplay",
        ],
        "./codec.js": ["canUseWebCodecsH264", "getDeviceResolution"],
        "./session.js": [
            "beginSwipeCaptureSlowdown", "bootstrapCaptureSession", "bumpControlActivity", "clearControlIdleTimer",
            "elevateControlCapture", "endSwipeCaptureSlowdown", "pickCaptureSpeedForSession", "primeControlCapture",
            "releaseControlCaptureToLow", "scheduleControlIdleTimer", "sendControl", "sendSwipeControl",
            "teardownControlSession",
        ],
    },
};

function addExports(file, names) {
    let code = fs.readFileSync(path.join(dir, file), "utf8");
    for (const name of names) {
        if (code.includes(`export function ${name}`)) continue;
        code = code.replace(
            new RegExp(`^function ${name}\\b`, "m"),
            `export function ${name}`
        );
    }
    fs.writeFileSync(path.join(dir, file), code);
}

function addImports(file, groups) {
    let code = fs.readFileSync(path.join(dir, file), "utf8");
    const marker = 'import { st, StreamDiag } from "./state.js";';
    if (!code.includes(marker)) {
        console.warn("skip imports (no marker):", file);
        return;
    }
    const lines = [];
    for (const [mod, names] of Object.entries(groups)) {
        lines.push(`import {`);
        lines.push(`    ${names.join(", ")},`);
        lines.push(`} from "${mod}";`);
    }
    const block = lines.join("\n");
    if (code.includes(block)) return;
    // 移除已有重复 import 块（简单：若已存在 from "./frame.js" 则跳过整文件）
    const firstFrom = Object.keys(groups)[0];
    if (code.includes(`from "${firstFrom}"`)) return;
    code = code.replace(marker, `${marker}\n${block}`);
    fs.writeFileSync(path.join(dir, file), code);
}

for (const [file, names] of Object.entries(exportsByFile)) {
    addExports(file, names);
}
for (const [file, groups] of Object.entries(importsByFile)) {
    addImports(file, groups);
}

console.log("fix-control-exports OK");
