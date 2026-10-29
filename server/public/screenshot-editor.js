/**
 * 设备原图截图：截图模式框选保存 / 移动模式缩放平移
 */
(function (global) {
    const state = {
        mode: "crop",
        naturalW: 0,
        naturalH: 0,
        scale: 1,
        translateX: 0,
        translateY: 0,
        minScale: 0.05,
        maxScale: 8,
        selection: null,
        dragKind: null,
        dragStart: null,
        loadedImage: null,
        deviceLabel: "",
    };

    function getEl(id) {
        return document.getElementById(id);
    }

    function normalizeImageSrc(msg) {
        let image = msg.image || (msg.raw && msg.raw.image) || "";
        if (image && !String(image).startsWith("data:")) {
            image = `data:image/jpeg;base64,${image}`;
        }
        return image;
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function applyTransform() {
        const layer = getEl("screenshotTransformLayer");
        if (!layer) return;
        layer.style.width = `${state.naturalW}px`;
        layer.style.height = `${state.naturalH}px`;
        layer.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
        drawOverlay();
        updateMeta();
    }

    function fitToViewport() {
        const viewport = getEl("screenshotViewport");
        if (!viewport || !state.naturalW || !state.naturalH) return;
        const vw = viewport.clientWidth;
        const vh = viewport.clientHeight;
        const fit = Math.min(vw / state.naturalW, vh / state.naturalH, 1);
        state.scale = fit;
        state.translateX = (vw - state.naturalW * fit) / 2;
        state.translateY = (vh - state.naturalH * fit) / 2;
        applyTransform();
    }

    function viewportToImage(vx, vy) {
        return {
            x: (vx - state.translateX) / state.scale,
            y: (vy - state.translateY) / state.scale,
        };
    }

    function imageToViewport(ix, iy) {
        return {
            x: ix * state.scale + state.translateX,
            y: iy * state.scale + state.translateY,
        };
    }

    function normalizeSelection(x1, y1, x2, y2) {
        const left = clamp(Math.min(x1, x2), 0, state.naturalW);
        const top = clamp(Math.min(y1, y2), 0, state.naturalH);
        const right = clamp(Math.max(x1, x2), 0, state.naturalW);
        const bottom = clamp(Math.max(y1, y2), 0, state.naturalH);
        if (right - left < 2 || bottom - top < 2) return null;
        return { left, top, right, bottom };
    }

    function updateSaveButton() {
        const btn = getEl("btnScreenshotSave");
        if (!btn) return;
        btn.disabled = state.mode !== "crop" || !state.selection;
    }

    function updateMeta() {
        const meta = getEl("screenshotMeta");
        if (!meta) return;
        const sizeText = state.naturalW && state.naturalH ? `${state.naturalW} × ${state.naturalH}` : "—";
        let selText = "未框选";
        if (state.selection) {
            const w = Math.round(state.selection.right - state.selection.left);
            const h = Math.round(state.selection.bottom - state.selection.top);
            selText = `${Math.round(state.selection.left)},${Math.round(state.selection.top)} · ${w}×${h}px`;
        }
        meta.textContent = `原图 ${sizeText} · 缩放 ${Math.round(state.scale * 100)}% · 选区 ${selText}`;
    }

    function drawOverlay() {
        const canvas = getEl("screenshotOverlay");
        const viewport = getEl("screenshotViewport");
        if (!canvas || !viewport) return;
        const w = viewport.clientWidth;
        const h = viewport.clientHeight;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        if (state.mode !== "crop" || !state.selection) return;

        const p1 = imageToViewport(state.selection.left, state.selection.top);
        const p2 = imageToViewport(state.selection.right, state.selection.bottom);
        const x = p1.x;
        const y = p1.y;
        const rw = p2.x - p1.x;
        const rh = p2.y - p1.y;

        ctx.fillStyle = "rgba(15, 23, 42, 0.45)";
        ctx.fillRect(0, 0, w, h);
        ctx.clearRect(x, y, rw, rh);

        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(x, y, rw, rh);
        ctx.setLineDash([]);

        ctx.fillStyle = "rgba(34, 197, 94, 0.12)";
        ctx.fillRect(x, y, rw, rh);
    }

    function setMode(mode) {
        state.mode = mode;
        state.dragKind = null;
        const cropBtn = getEl("btnScreenshotModeCrop");
        const panBtn = getEl("btnScreenshotModePan");
        const viewport = getEl("screenshotViewport");
        if (cropBtn) cropBtn.classList.toggle("active", mode === "crop");
        if (panBtn) panBtn.classList.toggle("active", mode === "pan");
        if (viewport) {
            viewport.classList.toggle("screenshot-viewport--crop", mode === "crop");
            viewport.classList.toggle("screenshot-viewport--pan", mode === "pan");
        }
        if (mode === "pan") {
            state.selection = null;
        }
        updateSaveButton();
        drawOverlay();
        updateMeta();
        updateHint();
    }

    function updateHint() {
        const hint = getEl("screenshotHint");
        if (!hint) return;
        hint.textContent =
            state.mode === "crop"
                ? "截图模式：在原图上左键拖拽框选，保存时按原图像素裁剪。"
                : "移动模式：滚轮缩放，按住左键拖拽平移原图。";
    }

    function getViewportPoint(e) {
        const viewport = getEl("screenshotViewport");
        if (!viewport) return null;
        const rect = viewport.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onPointerDown(e) {
        if (e.button !== 0) return;
        const viewport = getEl("screenshotViewport");
        if (!viewport || !state.loadedImage) return;
        const pt = getViewportPoint(e);
        if (!pt) return;

        if (state.mode === "crop") {
            const imgPt = viewportToImage(pt.x, pt.y);
            state.dragKind = "crop";
            state.dragStart = { vx: pt.x, vy: pt.y, ix: imgPt.x, iy: imgPt.y };
            state.selection = null;
            updateSaveButton();
            viewport.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }

        state.dragKind = "pan";
        state.dragStart = {
            vx: pt.x,
            vy: pt.y,
            tx: state.translateX,
            ty: state.translateY,
        };
        viewport.setPointerCapture(e.pointerId);
        viewport.classList.add("is-panning");
        e.preventDefault();
    }

    function onPointerMove(e) {
        const pt = getViewportPoint(e);
        if (!pt || !state.dragStart) return;

        if (state.dragKind === "crop") {
            const imgPt = viewportToImage(pt.x, pt.y);
            state.selection = normalizeSelection(
                state.dragStart.ix,
                state.dragStart.iy,
                imgPt.x,
                imgPt.y
            );
            updateSaveButton();
            drawOverlay();
            updateMeta();
            return;
        }

        if (state.dragKind === "pan") {
            state.translateX = state.dragStart.tx + (pt.x - state.dragStart.vx);
            state.translateY = state.dragStart.ty + (pt.y - state.dragStart.vy);
            applyTransform();
        }
    }

    function onPointerUp(e) {
        const viewport = getEl("screenshotViewport");
        if (viewport && viewport.hasPointerCapture(e.pointerId)) {
            viewport.releasePointerCapture(e.pointerId);
        }
        viewport?.classList.remove("is-panning");
        state.dragKind = null;
        state.dragStart = null;
        updateSaveButton();
    }

    function onWheel(e) {
        if (state.mode !== "pan") return;
        e.preventDefault();
        const viewport = getEl("screenshotViewport");
        if (!viewport) return;
        const pt = getViewportPoint(e);
        if (!pt) return;

        const imgBefore = viewportToImage(pt.x, pt.y);
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const nextScale = clamp(state.scale * factor, state.minScale, state.maxScale);
        state.scale = nextScale;
        state.translateX = pt.x - imgBefore.x * state.scale;
        state.translateY = pt.y - imgBefore.y * state.scale;
        applyTransform();
    }

    function saveSelectionToLocal() {
        if (!state.loadedImage || !state.selection) return;
        const { left, top, right, bottom } = state.selection;
        const w = Math.round(right - left);
        const h = Math.round(bottom - top);
        if (w < 1 || h < 1) return;

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(state.loadedImage, left, top, w, h, 0, 0, w, h);

        canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const label = state.deviceLabel ? `${state.deviceLabel}-` : "";
            a.href = url;
            a.download = `${label}screenshot-${stamp}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);

            const status = getEl("screenshotStatus");
            if (status) status.textContent = `已保存 ${w}×${h}px 原图选区`;
        }, "image/png");
    }

    function bindEditorEvents() {
        const viewport = getEl("screenshotViewport");
        if (!viewport || viewport.dataset.bound === "1") return;
        viewport.dataset.bound = "1";
        viewport.addEventListener("pointerdown", onPointerDown);
        viewport.addEventListener("pointermove", onPointerMove);
        viewport.addEventListener("pointerup", onPointerUp);
        viewport.addEventListener("pointercancel", onPointerUp);
        viewport.addEventListener("wheel", onWheel, { passive: false });
        window.addEventListener("resize", () => {
            if (state.loadedImage) fitToViewport();
        });
    }

    function bindToolbar() {
        const cropBtn = getEl("btnScreenshotModeCrop");
        const panBtn = getEl("btnScreenshotModePan");
        const saveBtn = getEl("btnScreenshotSave");
        if (cropBtn) cropBtn.onclick = () => setMode("crop");
        if (panBtn) panBtn.onclick = () => setMode("pan");
        if (saveBtn) saveBtn.onclick = saveSelectionToLocal;
        bindEditorEvents();
        setMode("crop");
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("原图加载失败"));
            img.src = src;
        });
    }

    function buildResolutionStatus(msg) {
        const screenW = Number(msg.screenWidth || msg.screen_width || 0);
        const screenH = Number(msg.screenHeight || msg.screen_height || 0);
        const source = String(msg.imageSource || msg.image_source || "").toLowerCase();
        const sizeText = `${state.naturalW}×${state.naturalH}px`;

        if (source === "accessibility") {
            return `已加载全屏原图 ${sizeText}`;
        }
        if (source === "logical_projection") {
            if (screenW > 0 && screenH > 0) {
                const matchScreen =
                    state.naturalW >= screenW * 0.92 && state.naturalH >= screenH * 0.92;
                return matchScreen
                    ? `已加载全屏原图 ${sizeText}`
                    : `已加载高清截图 ${sizeText}（设备屏 ${screenW}×${screenH}）`;
            }
            return `已加载高清截图 ${sizeText}`;
        }
        if (screenW > 0 && screenH > 0) {
            const matchScreen =
                state.naturalW >= screenW * 0.92 && state.naturalH >= screenH * 0.92;
            if (matchScreen) {
                return `已加载原图 ${sizeText}`;
            }
            if (source === "capture_buffer") {
                return `已加载投屏缓冲 ${sizeText}（设备屏 ${screenW}×${screenH}，非全分辨率）`;
            }
            return `已加载投屏画面 ${sizeText}（设备屏 ${screenW}×${screenH}，非全分辨率）`;
        }
        if (source === "stream" || state.naturalW <= 720) {
            return `已加载 ${sizeText}（疑似投屏缩略图，非手机全分辨率原图）`;
        }
        return `已加载原图 ${sizeText}`;
    }

    async function open(msg) {
        const modal = getEl("screenshotModal");
        const status = getEl("screenshotStatus");
        const panel = getEl("screenshotEditorPanel");
        const imgEl = getEl("screenshotImage");
        if (modal) modal.classList.remove("hidden");

        const src = normalizeImageSrc(msg);
        if (!src) {
            if (status) status.textContent = "未收到设备原图";
            if (panel) panel.style.display = "none";
            return;
        }

        if (status) status.textContent = "正在加载原图…";
        if (panel) panel.style.display = "none";

        try {
            const img = await loadImage(src);
            state.loadedImage = img;
            state.naturalW = img.naturalWidth || msg.imageWidth || 0;
            state.naturalH = img.naturalHeight || msg.imageHeight || 0;
            state.selection = null;
            state.deviceLabel = msg.deviceId ? String(msg.deviceId).slice(0, 16) : "";
            if (imgEl) {
                imgEl.src = src;
                imgEl.width = state.naturalW;
                imgEl.height = state.naturalH;
            }
            if (panel) panel.style.display = "";
            if (status) {
                status.textContent = buildResolutionStatus(msg);
            }
            setMode("crop");
            fitToViewport();
            updateSaveButton();
        } catch (e) {
            if (status) status.textContent = e.message || "原图加载失败";
            if (panel) panel.style.display = "none";
        }
    }

    function showLoading(text) {
        const modal = getEl("screenshotModal");
        const status = getEl("screenshotStatus");
        const panel = getEl("screenshotEditorPanel");
        if (modal) modal.classList.remove("hidden");
        if (status) status.textContent = text || "正在请求设备原图…";
        if (panel) panel.style.display = "none";
        state.loadedImage = null;
        state.selection = null;
        updateSaveButton();
    }

    function showError(msg) {
        const modal = getEl("screenshotModal");
        const status = getEl("screenshotStatus");
        const panel = getEl("screenshotEditorPanel");
        if (modal) modal.classList.remove("hidden");
        if (status) status.textContent = msg.error || msg.message || "获取截图失败";
        if (panel) panel.style.display = "none";
    }

    function close() {
        const modal = getEl("screenshotModal");
        if (modal) modal.classList.add("hidden");
    }

    function bindModal() {
        const modal = getEl("screenshotModal");
        const closeBtn = getEl("btnCloseScreenshotModal");
        if (closeBtn) closeBtn.onclick = close;
        if (modal) {
            modal.addEventListener("click", (e) => {
                if (e.target.classList.contains("ui-node-modal-backdrop")) close();
            });
        }
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) {
                close();
            }
        });
        bindToolbar();
    }

    bindModal();
    global.ScreenshotEditor = { open, showLoading, showError, close };
})(window);
