/** 控制页共享状态（跨模块通过 st.xxx 读写） */
export const StreamDiag = {
    enabled() {
        try {
            if (st.params.has("diag")) return true;
            return localStorage.getItem("streamDiag") === "1";
        } catch (_) {
            return st.params.has("diag");
        }
    },
    log(...args) {
        if (!this.enabled()) return;
        console.log("[StreamDiag]", ...args);
    },
    warn(...args) {
        if (!this.enabled()) return;
        console.warn("[StreamDiag]", ...args);
    },
};

export const st = {
    params: new URLSearchParams(window.location.search),
    deviceId: null,
    syncGroupParam: null,
    syncGroupDeviceIds: [],
    token: null,
    currentCodecMode: "webp",
    deviceCanvas: null,
    deviceImageA: null,
    deviceImageB: null,
    deviceFrameStack: null,
    btnCodecBase64: null,
    btnCodecWebp: null,
    btnCodecH264: null,
    swipeOverlay: null,
    swipeTrailCanvas: null,
    deviceImage: null,
    base64FrontEl: null,
    base64BackEl: null,
    base64BackLoading: false,
    pendingBase64FrameSrc: null,
    lastBase64DisplayFp: "",
    BASE64_MIN_PAINT_MS: 280,
    VISIBILITY_LOW_DELAY_MS: 2500,
    ELEVATE_CONTROL_COALESCE_MS: 1200,
    lastElevateControlSentAt: 0,
    BASE64_EXPECTED_MAX_FPS: 4,
    visibilityLowTimer: null,
    lastBase64PaintAt: 0,
    base64PaintCoalesceTimer: null,
    lastRequestFrameSentAt: 0,
    lastBase64ObjectUrl: null,
    frameCanvasCtx: null,
    lastCanvasPaintW: 0,
    lastCanvasPaintH: 0,
    latestFrameBitmap: null,
    pendingFrameBlob: null,
    latestWsBinary: null,
    frameDecodeInFlight: false,
    wsBinaryRaf: 0,
    framesSkippedCoalesce: 0,
    framesPaintedSession: 0,
    paintFpsSamples: [],
    lastPaintFpsAt: 0,
    lastWsBinaryRxAt: 0,
    wsBinaryRxCount: 0,
    wsBinaryRxWindowBytes: 0,
    wsBinaryRxBytes: 0,
    wsBinaryRxWindowCount: 0,
    jsonFrameRxWindowCount: 0,
    lastStreamDiagSummaryAt: 0,
    lastCaptureStatusPaintAt: 0,
    deviceMeta: null,
    deviceTitle: null,
    masterDeviceRow: null,
    masterDeviceSelect: null,
    viewerFrame: null,
    viewerTips: null,
    captureSpeedStatus: null,
    btnCloseExpanded: null,
    btnFetchUiNodes: null,
    btnFetchScreenshot: null,
    btnScreenRecord: null,
    screenRecordStatus: null,
    recordingIndicator: null,
    btnDeviceClipboard: null,
    clipboardModal: null,
    btnCloseClipboardModal: null,
    btnSetClipboard: null,
    btnRefreshClipboard: null,
    uiNodeModal: null,
    btnCloseUiNodeModal: null,
    uiNodeStatus: null,
    uiNodeData: null,
    toggleClickMode: null,
    toggleSwipeMode: null,
    togglePressMode: null,
    MASTER_ONLY_COMMANDS: new Set([
        "setCaptureSpeed",
        "fetchUiNodes",
        "fetchScreenshot",
        "pauseCapture",
        "resumeCapture",
        "startAudio",
        "stopAudio",
    ]),
    ws: null,
    controlWsConnected: false,
    deviceInfo: null,
    deviceStreamOnline: false,
    deviceForceOffline: false,
    deviceAudioEnabled: false,
    lastDeviceFrameRxAt: 0,
    DEVICE_ONLINE_STALE_MS: 20000,
    deviceMetaRefreshTimer: null,
    wsReconnectTimer: null,
    wsReconnectAttempt: 0,
    controlSessionActive: true,
    sessionReplaced: false,
    streamDiagSessionStartedAt: 0,
    isExpanded: false,
    touchTimer: null,
    isLongPressed: false,
    ignoreNextClick: false,
    ignoreNextClickFromPress: false,
    sendControlAnimationTimer: null,
    lastSwipeSentAt: 0,
    SWIPE_THROTTLE_MS: 80,
    swipeCapturingSlow: false,
    frameRafScheduled: false,
    framePaintGeneration: 0,
    lastFrameContentRect: null,
    lastFramePixelSize: null,
    WEB_FRAME_MAGIC: 0xf2,
    IMAGE_FORMAT_JPEG: 0x00,
    IMAGE_FORMAT_WEBP: 0x01,
    IMAGE_FORMAT_H264: 0x02,
    H264_FRAME_CONFIG: 0,
    H264_FRAME_KEY: 1,
    H264_FRAME_DELTA: 2,
    h264Decoder: null,
    h264DecoderReady: false,
    h264ChunkTimestampUs: 0,
    lastPreferWebpSentAt: 0,
    captureProfileHint: "",
    lastRxStreamFormat: null,
    h264ConfigReceived: false,
    lastFramePaintAt: 0,
    webpFallbackRequested: false,
    h264NoFrameFallbackTimer: null,
    H264_NO_FRAME_FALLBACK_MS: 800,
    CAPTURE_BOOTSTRAP_RETRY_MS: 2000,
    CAPTURE_BOOTSTRAP_MAX_RETRIES: 3,
    CONTROL_IDLE_LOW_MS: 30000,
    controlIdleLowTimer: null,
    captureElevated: false,
    STORAGE_VIEWER_QUALITY: "viewerQualityMode",
    codecPreferenceSynced: false,
    captureBootstrapRetryTimer: null,
    captureBootstrapRetryCount: 0,
    controlPingReassertAt: 0,
    lastDowngradePingWarnAt: 0,
    h264DecodeFlushScheduled: false,
    pendingH264Decode: null,
    pendingH264VideoFrame: null,
    h264VideoPaintScheduled: false,
    INTERACTIVE_CONTROL_TYPES: new Set(["click", "swipe", "longClick", "press", "input"]),
    captureSessionPrewarmed: false,
    CANVAS_BACKING_HYSTERESIS_PX: 2,
    startX: 0,
    startY: 0,
    swipeTrailStartClient: null,
    startOffsetPoint: null,
    lastVisibleImageRect: null,
    currentControlMode: "click",
    frameDecodeWorker: null,
    frameDecodeWorkerJobId: 0,
    lastDeviceFrameDataUrl: null,
    lastDeviceFrameBlob: null,
    pointerDown: false,
    pointerStartX: 0,
    pointerStartY: 0,
    btnSetHighSpeed: null,
    btnSetLowSpeed: null,
    btnUploadFile: null,
    deviceFileInput: null,
    deviceUploadStatus: null,
    btnSpeedTest: null,
};

st.deviceId = st.params.get("id");
st.syncGroupParam = st.params.get("syncGroup");
st.syncGroupDeviceIds = st.syncGroupParam ? st.syncGroupParam.split(",").filter(Boolean) : [];
st.token = localStorage.getItem("adminToken");
st.deviceCanvas = document.getElementById("deviceCanvas");
st.deviceImageA = document.getElementById("deviceImageA");
st.deviceImageB = document.getElementById("deviceImageB");
st.deviceFrameStack = document.getElementById("deviceFrameStack");
st.btnCodecBase64 = document.getElementById("btnCodecBase64");
st.btnCodecWebp = document.getElementById("btnCodecWebp");
st.btnCodecH264 = document.getElementById("btnCodecH264");
st.swipeOverlay = document.getElementById("swipeOverlay");
st.swipeTrailCanvas = document.getElementById("swipeTrailCanvas");
st.deviceImage = st.deviceCanvas || st.deviceImageA;
st.base64FrontEl = st.deviceImageA;
st.base64BackEl = st.deviceImageB;
st.deviceMeta = document.getElementById("deviceMeta");
st.deviceTitle = document.getElementById("deviceTitle");
st.masterDeviceRow = document.getElementById("masterDeviceRow");
st.masterDeviceSelect = document.getElementById("masterDeviceSelect");
st.viewerFrame = document.getElementById("viewerFrame");
st.viewerTips = document.getElementById("viewerTips");
st.captureSpeedStatus = document.getElementById("captureSpeedStatus");
st.btnCloseExpanded = document.getElementById("btnCloseExpanded");
st.btnFetchUiNodes = document.getElementById("btnFetchUiNodes");
st.btnFetchScreenshot = document.getElementById("btnFetchScreenshot");
st.btnScreenRecord = document.getElementById("btnScreenRecord");
st.screenRecordStatus = document.getElementById("screenRecordStatus");
st.recordingIndicator = document.getElementById("recordingIndicator");
st.btnDeviceClipboard = document.getElementById("btnDeviceClipboard");
st.clipboardModal = document.getElementById("clipboardModal");
st.btnCloseClipboardModal = document.getElementById("btnCloseClipboardModal");
st.btnSetClipboard = document.getElementById("btnSetClipboard");
st.btnRefreshClipboard = document.getElementById("btnRefreshClipboard");
st.uiNodeModal = document.getElementById("uiNodeModal");
st.btnCloseUiNodeModal = document.getElementById("btnCloseUiNodeModal");
st.uiNodeStatus = document.getElementById("uiNodeStatus");
st.uiNodeData = document.getElementById("uiNodeData");
st.toggleClickMode = document.getElementById("toggleClickMode");
st.toggleSwipeMode = document.getElementById("toggleSwipeMode");
st.togglePressMode = document.getElementById("togglePressMode");
st.btnSetHighSpeed = document.getElementById("btnSetHighSpeed");
st.btnSetLowSpeed = document.getElementById("btnSetLowSpeed");
st.btnUploadFile = document.getElementById("btnUploadFile");
st.deviceFileInput = document.getElementById("deviceFileInput");
st.deviceUploadStatus = document.getElementById("deviceUploadStatus");
st.btnSpeedTest = document.getElementById("btnSpeedTest");

if (!st.deviceId) {
    document.body.innerHTML =
        "<div style='padding:40px;text-align:center;color:#ef4444;'>未指定设备ID</div>";
    throw new Error("missing deviceId");
}
