/** @module control/viewer */
import { st, StreamDiag } from "./state.js";
import {
    clearSwipeTrail, drawSwipeTrail, exitExpandedControl, isControlChromeTarget, isDeviceImageTarget, refreshVisibleImageRect, releaseFrameBitmap, stopControlEvent, syncTouchLayers, terminateFrameDecodeWorker, updateCaptureStatusDisplay, updateCodecDisplayLayer,
} from "./frame.js";
import {
    canUseWebCodecsH264, getDeviceResolution, skipStaleDisplayFrames,
} from "./codec.js";
import {
    beginSwipeCaptureSlowdown, bootstrapCaptureSession, bumpControlActivity, clearControlIdleTimer, elevateControlCapture, endSwipeCaptureSlowdown, pickCaptureSpeedForSession, primeControlCapture, releaseControlCaptureToLow, scheduleControlIdleTimer, sendControl, sendSwipeControl, teardownControlSession,
} from "./session.js";

/* ================= 坐标换算 ================= */

function getPointFromOffset(offsetX, offsetY, rect) {

    const { w, h } = getDeviceResolution();

    const imgRatio = w / h;

    const containerRatio =
        rect.width / rect.height;

    let realImgWidth = rect.width;
    let realImgHeight = rect.height;

    let imgLeftOuter = 0;
    let imgTopOuter = 0;

    if (containerRatio > imgRatio) {

        realImgHeight = rect.height;

        realImgWidth =
            rect.height * imgRatio;

        imgLeftOuter =
            (rect.width - realImgWidth) / 2;

    } else {

        realImgWidth = rect.width;

        realImgHeight =
            rect.width / imgRatio;

        imgTopOuter =
            (rect.height - realImgHeight) / 2;
    }

    let clickX =
        offsetX - imgLeftOuter;

    let clickY =
        offsetY - imgTopOuter;

    if (clickX < 0) clickX = 0;
    if (clickY < 0) clickY = 0;

    if (clickX > realImgWidth)
        clickX = realImgWidth;

    if (clickY > realImgHeight)
        clickY = realImgHeight;

    const result = {
        x: Math.round(
            (clickX / realImgWidth) * w
        ),
        y: Math.round(
            (clickY / realImgHeight) * h
        )
    };

    // 调试日志 - 完整的中间过程
    // console.log('[坐标换算详解]', {
    //     '容器宽高': `${rect.width}x${rect.height}`,
    //     '容器比例': containerRatio.toFixed(4),
    //     '设备分辨率': `${w}x${h}`,
    //     '设备比例': imgRatio.toFixed(4),
    //     '实际图片宽高': `${realImgWidth.toFixed(0)}x${realImgHeight.toFixed(0)}`,
    //     '水平居中偏移': imgLeftOuter.toFixed(1),
    //     '竖直居中偏移': imgTopOuter.toFixed(1),
    //     '输入offsetX': offsetX.toFixed(1),
    //     '输入offsetY': offsetY.toFixed(1),
    //     '计算clickX': clickX.toFixed(1),
    //     '计算clickY': clickY.toFixed(1),
    //     '最终设备坐标X': result.x,
    //     '最终设备坐标Y': result.y,
    //     '比例计算X': `${clickX.toFixed(1)}/${realImgWidth.toFixed(0)} * ${w} = ${result.x}`,
    //     '比例计算Y': `${clickY.toFixed(1)}/${realImgHeight.toFixed(0)} * ${h} = ${result.y}`
    // });
    return result;
}

/** 将屏幕坐标转为 Canvas 缓冲坐标（与 drawSourceLetterboxed 的 cw/ch 一致） */
function clientToCanvasLocal(clientX, clientY) {
    const canvas = st.deviceCanvas || st.deviceImage;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    const content = st.lastFrameContentRect;
    const cw = content?.cw > 0 ? content.cw : Math.max(1, Math.floor(rect.width));
    const ch = content?.ch > 0 ? content.ch : Math.max(1, Math.floor(rect.height));
    return {
        localX: (clientX - rect.left) * (cw / rect.width),
        localY: (clientY - rect.top) * (ch / rect.height),
        cw,
        ch,
        rect,
    };
}

/** letterbox 内容区 → 设备逻辑像素（与投屏/手势坐标系一致） */
function canvasLocalToDevicePoint(localX, localY) {
    const content = st.lastFrameContentRect;
    const { w, h } = getDeviceResolution();
    if (content?.dw > 0 && content?.dh > 0) {
        const { dx, dy, dw, dh } = content;
        if (
            localX < dx ||
            localY < dy ||
            localX > dx + dw ||
            localY > dy + dh
        ) {
            return null;
        }
        return {
            x: Math.round(((localX - dx) / dw) * w),
            y: Math.round(((localY - dy) / dh) * h),
        };
    }
    const frame = st.lastFramePixelSize;
    if (frame?.bw > 0 && frame?.bh > 0 && content?.cw > 0 && content?.ch > 0) {
        const nx = localX / content.cw;
        const ny = localY / content.ch;
        if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
        return {
            x: Math.round(nx * w),
            y: Math.round(ny * h),
        };
    }
    return null;
}

/** 指针事件 → 设备像素坐标（点击/滑动/长按共用） */
function getPointFromEvent(e) {
    const local = clientToCanvasLocal(e.clientX, e.clientY);
    if (!local) return null;

    const mapped = canvasLocalToDevicePoint(local.localX, local.localY);
    if (mapped) return mapped;

    const { rect } = local;
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    if (
        offsetX < 0 ||
        offsetY < 0 ||
        offsetX > rect.width ||
        offsetY > rect.height
    ) {
        return null;
    }

    const { w, h } = getDeviceResolution();
    const imgRatio = w / h;
    const containerRatio = rect.width / rect.height;
    let contentW = rect.width;
    let contentH = rect.height;
    let padX = 0;
    let padY = 0;
    if (containerRatio > imgRatio) {
        contentH = rect.height;
        contentW = rect.height * imgRatio;
        padX = (rect.width - contentW) / 2;
    } else {
        contentW = rect.width;
        contentH = rect.width / imgRatio;
        padY = (rect.height - contentH) / 2;
    }
    const cx = offsetX - padX;
    const cy = offsetY - padY;
    if (cx < 0 || cy < 0 || cx > contentW || cy > contentH) return null;
    return {
        x: Math.round((cx / contentW) * w),
        y: Math.round((cy / contentH) * h),
    };
}

/* ================= 模式UI ================= */

function updateModeUI() {

    st.viewerFrame.classList.remove(
        "click-mode",
        "swipe-mode",
        "press-mode"
    );

    st.toggleClickMode.classList.remove(
        "active"
    );

    st.toggleSwipeMode.classList.remove(
        "active"
    );

    st.togglePressMode.classList.remove(
        "active"
    );

    if (st.currentControlMode === "click") {

        st.viewerFrame.classList.add(
            "click-mode"
        );

        st.toggleClickMode.classList.add(
            "active"
        );

        st.viewerTips.innerHTML =
            "🎯 点击模式";

    }

    else if (
        st.currentControlMode === "swipe"
    ) {

        st.viewerFrame.classList.add(
            "swipe-mode"
        );

        st.toggleSwipeMode.classList.add(
            "active"
        );

        st.viewerTips.innerHTML =
            "🌀 滑动模式";
    }

    else if (
        st.currentControlMode === "press"
    ) {

        st.viewerFrame.classList.add(
            "press-mode"
        );

        st.togglePressMode.classList.add(
            "active"
        );

        st.viewerTips.innerHTML =
            "🔥 长按模式";
    }

    syncTouchLayers();
}


function bindModeToggle(btn, mode) {
    if (!btn) return;
    const activate = (e) => {
        stopControlEvent(e);
        st.currentControlMode = mode;
        updateModeUI();
    };
    btn.addEventListener("pointerdown", stopControlEvent);
    btn.addEventListener("click", activate);
}

bindModeToggle(st.toggleClickMode, "click");
bindModeToggle(st.toggleSwipeMode, "swipe");
bindModeToggle(st.togglePressMode, "press");
/* ================= 禁止菜单 ================= */

window.addEventListener(
    "contextmenu",
    e => e.preventDefault(),
    { passive: false }
);

/* ================= 点击 ================= */

st.viewerFrame.addEventListener("click", (e) => {

    if (isControlChromeTarget(e.target)) {
        return;
    }

    if (
        st.isLongPressed ||
        st.ignoreNextClick
    ) {
        return;
    }

    if (!isDeviceImageTarget(e.target) && e.target !== st.viewerFrame) {
        return;
    }

    /* 未放大先进入控制模式 */

    if (!st.isExpanded) {

        st.isExpanded = true;

        st.viewerFrame.classList.add(
            "expanded"
        );

        syncTouchLayers();

        requestAnimationFrame(refreshVisibleImageRect);

        // 记录全屏时的详细信息
        setTimeout(() => {
            refreshVisibleImageRect();
            const rect = st.lastVisibleImageRect || st.deviceImage.getBoundingClientRect();
            const frameRect = st.viewerFrame.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(st.viewerFrame);
            // console.log('[全屏模式信息]', {
            //     'st.viewerFrame.position': computedStyle.position,
            //     'st.viewerFrame.inset': `top:${computedStyle.top} right:${computedStyle.right} bottom:${computedStyle.bottom} left:${computedStyle.left}`,
            //     'st.viewerFrame矩形': `x:${frameRect.x} y:${frameRect.y} w:${frameRect.width} h:${frameRect.height}`,
            //     'st.deviceImage矩形': `x:${rect.x} y:${rect.y} w:${rect.width} h:${rect.height}`,
            //     'left边距': rect.left,
            //     'top边距': rect.top,
            //     '窗口宽度': window.innerWidth,
            //     '窗口高度': window.innerHeight
            // });
        }, 100);

        updateModeUI();

        if (!st.captureSessionPrewarmed) {
            try {
                bootstrapCaptureSession();
            } catch (e) {
                console.warn("进入控制预暖失败", e.message);
            }
        }
        if (!st.captureElevated || Date.now() - st.lastElevateControlSentAt >= st.ELEVATE_CONTROL_COALESCE_MS) {
            try {
                primeControlCapture();
            } catch (e) {
                console.warn("进入全屏拉高帧失败", e.message);
            }
        }
        if (st.viewerTips) {
            st.viewerTips.innerHTML = st.lastFramePaintAt
                ? "🔴 控制中（可点击/滑动）"
                : "🔴 控制中（画面加载中，可先操作）";
        }

        return;
    }

    /* 不是点击/长按模式或不是有效图片区域直接退出 */

    if (
        st.currentControlMode !== "click"
        &&
        st.currentControlMode !== "press"
    ) {
        return;
    }

    if (!isDeviceImageTarget(e.target)) {
        return;
    }

    /* 统一计算坐标 */

    const p = getPointFromEvent(e);
    if (!p) return;

    /* ================= 长按模式 ================= */

    if (st.currentControlMode === "press") {

        sendControl({

            type: "press",

            x: p.x,

            y: p.y,

            duration: 1200
        });

        st.viewerTips.innerHTML =
            `🔥 长按 (${p.x}, ${p.y})`;

        return;
    }

    /* ================= 点击模式 ================= */

    sendControl({

        type: "click",

        x: p.x,

        y: p.y
    });

    st.viewerTips.innerHTML =
        `🎯 点击 (${p.x}, ${p.y})`;

    setTimeout(() => {

        if (!st.isExpanded) return;

        updateModeUI();

    }, 700);

});

/* ================= 退出 ================= */

st.btnCloseExpanded.addEventListener("pointerdown", stopControlEvent);
st.btnCloseExpanded.addEventListener("click", (e) => {
    stopControlEvent(e);
    exitExpandedControl();
});

window.addEventListener("pagehide", () => {
    releaseFrameBitmap();
    teardownControlSession();
});

window.addEventListener("beforeunload", () => {
    teardownControlSession();
});

document.addEventListener("visibilitychange", () => {
    if (!st.controlSessionActive) return;
    if (document.visibilityState === "hidden") {
        clearControlIdleTimer();
        if (!st.captureElevated) return;
        if (st.visibilityLowTimer) clearTimeout(st.visibilityLowTimer);
        st.visibilityLowTimer = setTimeout(() => {
            st.visibilityLowTimer = null;
            if (
                document.visibilityState === "hidden" &&
                st.controlSessionActive &&
                st.captureElevated
            ) {
                StreamDiag.log("标签页隐藏超时 → low");
                releaseControlCaptureToLow();
            }
        }, st.VISIBILITY_LOW_DELAY_MS);
        return;
    }
    if (st.visibilityLowTimer) {
        clearTimeout(st.visibilityLowTimer);
        st.visibilityLowTimer = null;
    }
    if (!st.captureElevated && st.ws && st.ws.readyState === WebSocket.OPEN) {
        elevateControlCapture("tab_visible");
    } else if (st.captureElevated) {
        scheduleControlIdleTimer();
    }
});

/** 从往返缓存恢复时旧 WS 可能仍占「观众」位，需清理避免设备一直 high */
window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
        teardownControlSession();
    }
});

const backToList = document.getElementById("backToList");
if (backToList) {
    backToList.addEventListener("click", (e) => {
        e.preventDefault();
        teardownControlSession();
        window.location.href = "/";
    });
}


/* ================= Pointer 滑动控制 ================= */

function handlePointerDown(e) {
    if (!st.isExpanded) return;
    if (st.controlSessionActive) {
        bumpControlActivity();
    }

    if (isControlChromeTarget(e.target)) {
        return;
    }

    const swipeMode = st.currentControlMode === "swipe";
    if (swipeMode) {
        const onSwipeLayer =
            st.swipeOverlay &&
            (e.target === st.swipeOverlay || st.swipeOverlay.contains(e.target));
        if (!isDeviceImageTarget(e.target) && !onSwipeLayer) {
            return;
        }
    } else if (!isDeviceImageTarget(e.target)) {
        return;
    }

    st.pointerDown = true;
    st.pointerStartX = e.clientX;
    st.pointerStartY = e.clientY;

    const p = getPointFromEvent(e);
    if (!p) {
        st.pointerDown = false;
        if (swipeMode && st.viewerTips) {
            st.viewerTips.innerHTML = "⚠️ 无法换算坐标，请稍候画面加载";
        }
        return;
    }

    st.startOffsetPoint = p;

    if (swipeMode) {
        e.preventDefault();
        if (st.swipeOverlay?.setPointerCapture) {
            try {
                st.swipeOverlay.setPointerCapture(e.pointerId);
            } catch (err) {
                console.warn("setPointerCapture failed", err.message);
            }
        }
        st.isLongPressed = true;
        st.swipeTrailStartClient = { x: e.clientX, y: e.clientY };
        clearSwipeTrail();
        beginSwipeCaptureSlowdown();
        if (st.viewerTips) st.viewerTips.innerHTML = "🌀 开始滑动";
        return;
    }

    if (st.currentControlMode === "press") {

        st.touchTimer = setTimeout(() => {

            st.isLongPressed = true;
            st.ignoreNextClick = true;
            st.ignoreNextClickFromPress = true;

            sendControl({
                type: "press",
                x: p.x,
                y: p.y,
                duration: 1200
            });

            st.viewerTips.innerHTML =
                `🔥 长按 (${p.x}, ${p.y})`;

        }, 450);

        return;
    }

    // 点击模式需要长按
    st.touchTimer = setTimeout(() => {

        st.isLongPressed = true;

        st.viewerTips.innerHTML =
            "🔥 长按滑动已激活";

    }, 450);

}

st.viewerFrame.addEventListener("pointerdown", handlePointerDown);

/* ================= pointermove ================= */

function handlePointerMove(e) {

    if (!st.pointerDown) return;

    if (st.currentControlMode === "swipe") {
        e.preventDefault();
        if (st.swipeTrailStartClient) {
            drawSwipeTrail(
                st.swipeTrailStartClient.x,
                st.swipeTrailStartClient.y,
                e.clientX,
                e.clientY
            );
        }
    }

    // 点击/长按模式下移动太大取消长按
    if (
        (st.currentControlMode === "click" || st.currentControlMode === "press")
        &&
        !st.isLongPressed
    ) {

        const moveX =
            Math.abs(
                e.clientX - st.pointerStartX
            );

        const moveY =
            Math.abs(
                e.clientY - st.pointerStartY
            );

        if (moveX > 20 || moveY > 20) {

            clearTimeout(st.touchTimer);
        }

        return;
    }

    if (st.isLongPressed && st.currentControlMode === "swipe" && st.viewerTips) {
        st.viewerTips.innerHTML = "🌀 正在滑动...";
    }

}

st.viewerFrame.addEventListener("pointermove", handlePointerMove);

/* ================= pointerup ================= */

function handlePointerUp(e) {

    if (isControlChromeTarget(e.target)) {
        st.pointerDown = false;
        clearTimeout(st.touchTimer);
        st.isLongPressed = false;
        return;
    }

    if (st.currentControlMode === "swipe" || st.ignoreNextClick) {
        e.preventDefault();
    }

    st.pointerDown = false;

    clearTimeout(st.touchTimer);

    if (!st.isExpanded) return;

    /* ================= 滑动模式 ================= */

    if (st.currentControlMode === "swipe" && st.isLongPressed && st.startOffsetPoint) {

        const endOffsetPoint = getPointFromEvent(e);
        if (st.swipeOverlay?.releasePointerCapture) {
            try {
                st.swipeOverlay.releasePointerCapture(e.pointerId);
            } catch (err) {
                /* 可能已由系统释放 */
            }
        }
        clearSwipeTrail();
        st.swipeTrailStartClient = null;
        endSwipeCaptureSlowdown();

        if (!endOffsetPoint) {
            st.isLongPressed = false;
            if (st.viewerTips) st.viewerTips.innerHTML = "⚠️ 滑动终点坐标无效";
            return;
        }

        const sent = sendSwipeControl({
            type: "swipe",
            x1: st.startOffsetPoint.x,
            y1: st.startOffsetPoint.y,
            x2: endOffsetPoint.x,
            y2: endOffsetPoint.y,
            duration: 280
        });

        if (sent && st.viewerTips) {
            st.viewerTips.innerHTML = "🌀 滑动已发送";
        }

        st.ignoreNextClick = true;
        setTimeout(() => {
            st.ignoreNextClick = false;
        }, 700);
    }

    if (st.ignoreNextClickFromPress) {
        setTimeout(() => {
            st.ignoreNextClick = false;
            st.ignoreNextClickFromPress = false;
        }, 0);
    }

    /* 重置状态 */

    st.isLongPressed = false;

}

st.viewerFrame.addEventListener("pointerup", handlePointerUp);
st.viewerFrame.addEventListener("pointercancel", handlePointerUp);

updateModeUI();

/* ================= 侧边按钮 ================= */

document.getElementById("btnBack").onclick =
    () => sendControl({ type: "back" });

document.getElementById("btnHome").onclick =
    () => sendControl({ type: "home" });

if (st.btnFetchUiNodes) {
    st.btnFetchUiNodes.onclick = () => {
        if (st.uiNodeModal) st.uiNodeModal.classList.remove("hidden");
        if (typeof UiInspector !== "undefined" && UiInspector.showLoading) {
            UiInspector.showLoading("正在抓取界面截图与节点树...");
        } else {
            if (st.uiNodeStatus) st.uiNodeStatus.textContent = "正在请求设备节点信息...";
            if (st.uiNodeData) st.uiNodeData.textContent = "";
        }
        sendControl({ type: "fetchUiNodes" });
    };
}

if (st.btnFetchScreenshot) {
    st.btnFetchScreenshot.onclick = () => {
        if (typeof ScreenshotEditor !== "undefined" && ScreenshotEditor.showLoading) {
            ScreenshotEditor.showLoading("正在请求设备原图…");
        }
        sendControl({ type: "fetchScreenshot" });
    };
}

function requestDeviceClipboard() {
    if (typeof ClipboardPanel !== "undefined" && ClipboardPanel.showLoading) {
        ClipboardPanel.showLoading("正在读取设备剪切板…");
    } else if (st.clipboardModal) {
        st.clipboardModal.classList.remove("hidden");
    }
    sendControl({ type: "getClipboard" });
}

if (st.btnDeviceClipboard) {
    st.btnDeviceClipboard.onclick = requestDeviceClipboard;
}

if (st.btnRefreshClipboard) {
    st.btnRefreshClipboard.onclick = requestDeviceClipboard;
}

if (st.btnSetClipboard) {
    st.btnSetClipboard.onclick = () => {
        const text =
            typeof ClipboardPanel !== "undefined" && ClipboardPanel.getText
                ? ClipboardPanel.getText()
                : document.getElementById("clipboardText")?.value ?? "";
        sendControl({ type: "setClipboard", text });
        if (typeof ClipboardPanel !== "undefined" && ClipboardPanel.showSetOk) {
            ClipboardPanel.showSetOk();
        }
    };
}

if (st.btnCloseUiNodeModal) {
    st.btnCloseUiNodeModal.onclick = () => {
        if (st.uiNodeModal) st.uiNodeModal.classList.add("hidden");
    };
}

if (st.uiNodeModal) {
    st.uiNodeModal.addEventListener("click", (e) => {
        if (e.target.classList.contains("ui-node-modal-backdrop")) {
            st.uiNodeModal.classList.add("hidden");
        }
    });
}

window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.uiNodeModal) {
        st.uiNodeModal.classList.add("hidden");
    }
});

function bindClick(id, handler) {
    const el = document.getElementById(id);
    if (el) el.onclick = handler;
}

bindClick("btnRecents", () => sendControl({ type: "recents" }));

bindClick("btnInputText", () => {
    const text = prompt("请输入文本");
    if (!text) return;
    sendControl({ type: "input", text });
});
/* ================= capture speed 控制按钮 ================= */
if (st.btnSetHighSpeed) {
    st.btnSetHighSpeed.onclick = () => {
        sendControl({
            type: "setCaptureSpeed",
            speed: "high"
        });
        if (st.viewerTips) st.viewerTips.innerHTML = "🔴 已切换为实时监控（高帧率）";
        updateCaptureStatusDisplay("high");
    };
}

if (st.btnSetLowSpeed) {
    st.btnSetLowSpeed.onclick = () => {
        sendControl({
            type: "setCaptureSpeed",
            speed: "low"
        });
        if (st.viewerTips) st.viewerTips.innerHTML = "🟢 已切换为节省流量（低帧率）";
        updateCaptureStatusDisplay("low");
    };
}

if (st.btnUploadFile && st.deviceFileInput) {
    st.btnUploadFile.addEventListener("click", () => {
        st.deviceFileInput.value = "";
        st.deviceFileInput.click();
    });
}
if (st.deviceFileInput) {
    st.deviceFileInput.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await uploadFileToDevice(file);
    });
}

async function uploadFileToDevice(file) {
    if (!file) return;
    if (!st.deviceUploadStatus) return;
    st.deviceUploadStatus.textContent = "上传中…";
    const formData = new FormData();
    formData.append("file", file);
    formData.append("deviceId", st.deviceId);

    try {
        const resp = await fetch("/api/upload", {
            method: "POST",
            headers: { "x-admin-token": st.token || "" },
            body: formData,
        });
        const data = await resp.json();
        if (!resp.ok) {
            st.deviceUploadStatus.textContent = `上传失败：${data.message || "服务器错误"}`;
            return;
        }
        st.deviceUploadStatus.textContent = `下发成功：${data.url}`;
    } catch (err) {
        st.deviceUploadStatus.textContent = `上传失败：${err.message}`;
    }
    setTimeout(() => {
        if (st.deviceUploadStatus) st.deviceUploadStatus.textContent = "";
    }, 5000);
}

/* ================= 网速检测 ================= */

if (st.btnSpeedTest) {
    st.btnSpeedTest.onclick = runSpeedTest;
}

async function runSpeedTest() {
    if (st.btnSpeedTest) st.btnSpeedTest.disabled = true;
    const results = { download: 0, upload: 0 };

    try {
        if (st.viewerTips) st.viewerTips.innerHTML = "⏳ 正在检测下载速度…";

        const dlSize = 256 * 1024;
        const dlUrl = `/api/speed-test-download?size=${dlSize}&t=${Date.now()}`;
        const dlStart = performance.now();
        const dlResp = await fetch(dlUrl, { cache: "no-store" });
        if (dlResp.ok) {
            const blob = await dlResp.blob();
            const dlEnd = performance.now();
            const dlMs = dlEnd - dlStart;
            results.download = Math.round((blob.size * 8) / (dlMs / 1000) / 1024);
        }

        if (st.viewerTips) st.viewerTips.innerHTML = "⏳ 正在检测上传速度…";

        const ulSize = 128 * 1024;
        const ulData = new Uint8Array(ulSize);
        for (let i = 0; i < ulData.length; i++) ulData[i] = Math.random() * 256 | 0;
        const ulBlob = new Blob([ulData]);
        const ulForm = new FormData();
        ulForm.append("data", ulBlob, "speedtest.bin");

        const ulStart = performance.now();
        const ulResp = await fetch("/api/speed-test-upload", {
            method: "POST",
            headers: { "x-admin-token": st.token || "" },
            body: ulForm,
        });
        const ulEnd = performance.now();
        if (ulResp.ok) {
            const ulMs = ulEnd - ulStart;
            results.upload = Math.round((ulSize * 8) / (ulMs / 1000) / 1024);
        }

        const dlLabel = results.download > 1024
            ? `${(results.download / 1024).toFixed(1)} Mbps`
            : `${results.download} Kbps`;
        const ulLabel = results.upload > 1024
            ? `${(results.upload / 1024).toFixed(1)} Mbps`
            : `${results.upload} Kbps`;

        alert(`网速检测结果\n\n下载：${dlLabel}\n上传：${ulLabel}`);
        if (st.viewerTips) st.viewerTips.innerHTML = `网速：下载 ${dlLabel} / 上传 ${ulLabel}`;
    } catch (err) {
        alert(`网速检测失败：${err.message}`);
        if (st.viewerTips) st.viewerTips.innerHTML = "网速检测失败";
    } finally {
        if (st.btnSpeedTest) st.btnSpeedTest.disabled = false;
    }
}

/* ================= 编码模式切换 ================= */

export function updateCodecModeButtons() {
    if (st.btnCodecBase64) st.btnCodecBase64.classList.toggle("active", st.currentCodecMode === "base64");
    if (st.btnCodecWebp) st.btnCodecWebp.classList.toggle("active", st.currentCodecMode === "webp");
    if (st.btnCodecH264) st.btnCodecH264.classList.toggle("active", st.currentCodecMode === "h264");
}

function switchCodecMode(mode, options = {}) {
    const force = options.force === true;
    if (!force && mode === st.currentCodecMode) return;
    st.currentCodecMode = mode;
    updateCodecModeButtons();

    if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return;

    switch (mode) {
        case "base64":
            terminateFrameDecodeWorker();
            skipStaleDisplayFrames();
            st.h264DecoderReady = false;
            st.h264ConfigReceived = false;
            st.lastRxStreamFormat = "";
            sendControl({ type: "setCodecMode", mode: "base64" }, { skipFeedback: true });
            sendControl({ type: "resumeCapture" }, { skipFeedback: true });
            sendControl({ type: "setCaptureSpeed", speed: "high" }, { skipFeedback: true });
            sendControl({ type: "requestFrame" }, { skipFeedback: true });
            st.webpFallbackRequested = false;
            st.codecPreferenceSynced = true;
            updateCodecDisplayLayer();
            st.captureProfileHint = "high";
            updateCaptureStatusDisplay("high");
            if (st.captureElevated) {
                scheduleControlIdleTimer();
            }
            if (st.viewerTips) st.viewerTips.innerHTML = "已切换到 Base64 模式（JPEG·JSON）";
            break;
        case "webp":
            updateCodecDisplayLayer();
            st.webpFallbackRequested = true;
            st.codecPreferenceSynced = true;
            sendControl({ type: "setCodecMode", mode: "webp" }, { skipFeedback: true });
            sendControl({ type: "preferWebp" }, { skipFeedback: true });
            sendControl({ type: "resumeCapture" }, { skipFeedback: true });
            sendControl(
                { type: "setCaptureSpeed", speed: pickCaptureSpeedForSession() },
                { skipFeedback: true }
            );
            sendControl({ type: "requestFrame" }, { skipFeedback: true });
            st.captureElevated = true;
            st.captureProfileHint = "high";
            st.captureSessionPrewarmed = true;
            scheduleControlIdleTimer();
            updateCaptureStatusDisplay("high");
            if (st.viewerTips) st.viewerTips.innerHTML = "已切换到 WebP 模式（二进制帧）";
            break;
        case "h264":
            updateCodecDisplayLayer();
            if (!canUseWebCodecsH264()) {
                alert("当前环境不支持 H.264 解码（需要 HTTPS 或 localhost）");
                st.currentCodecMode = "base64";
                updateCodecModeButtons();
                return;
            }
            sendControl({ type: "setCodecMode", mode: "h264" }, { skipFeedback: true });
            sendControl({ type: "allowH264" }, { skipFeedback: true });
            sendControl({ type: "setCaptureSpeed", speed: "high" }, { skipFeedback: true });
            st.webpFallbackRequested = false;
            st.codecPreferenceSynced = true;
            if (st.viewerTips) st.viewerTips.innerHTML = "已切换到 H.264 模式（硬件解码）";
            break;
    }
    StreamDiag.log("编码模式切换 →", mode);
}

if (st.btnCodecBase64) st.btnCodecBase64.addEventListener("click", () => switchCodecMode("base64"));
if (st.btnCodecWebp) st.btnCodecWebp.addEventListener("click", () => switchCodecMode("webp"));
if (st.btnCodecH264) st.btnCodecH264.addEventListener("click", () => switchCodecMode("h264"));

