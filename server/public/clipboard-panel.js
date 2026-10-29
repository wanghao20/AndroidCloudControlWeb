(function (global) {
    function getEl(id) {
        return document.getElementById(id);
    }

    function open(msg) {
        const modal = getEl("clipboardModal");
        const status = getEl("clipboardStatus");
        const textarea = getEl("clipboardText");
        if (modal) modal.classList.remove("hidden");
        const text = msg && msg.text != null ? String(msg.text) : "";
        if (textarea) textarea.value = text;
        if (status) {
            if (msg && msg.restrictedHint) {
                status.textContent = msg.restrictedHint;
            } else if (text.length) {
                status.textContent = `已读取设备剪切板（${text.length} 字符）`;
            } else {
                status.textContent =
                    "设备剪切板为空（请先在手机上复制内容；Android 10+ 需短暂弹出读取窗口）";
            }
        }
    }

    function showLoading(text) {
        const modal = getEl("clipboardModal");
        const status = getEl("clipboardStatus");
        const textarea = getEl("clipboardText");
        if (modal) modal.classList.remove("hidden");
        if (status) {
            status.textContent =
                text ||
                "正在读取设备剪切板…（Android 10+ 手机可能短暂弹出透明窗口）";
        }
        if (textarea) textarea.value = "";
    }

    function showError(msg) {
        const modal = getEl("clipboardModal");
        const status = getEl("clipboardStatus");
        if (modal) modal.classList.remove("hidden");
        if (status) {
            status.textContent = msg.error || msg.message || "读取设备剪切板失败";
        }
    }

    function showSetOk() {
        const status = getEl("clipboardStatus");
        if (status) status.textContent = "已下发到设备剪切板";
    }

    function close() {
        const modal = getEl("clipboardModal");
        if (modal) modal.classList.add("hidden");
    }

    function getText() {
        const textarea = getEl("clipboardText");
        return textarea ? textarea.value : "";
    }

    function bindModal() {
        const modal = getEl("clipboardModal");
        const closeBtn = getEl("btnCloseClipboardModal");
        if (closeBtn) closeBtn.onclick = close;
        if (modal) {
            modal.addEventListener("click", (e) => {
                if (e.target.classList.contains("ui-node-modal-backdrop")) {
                    close();
                }
            });
        }
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) {
                close();
            }
        });
    }

    bindModal();
    global.ClipboardPanel = { open, showLoading, showError, showSetOk, close, getText };
})(window);
