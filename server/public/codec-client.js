/**
 * 浏览器端 H.264 / WebP 能力检测（设备列表、控制页共用）
 * HTTP 公网 IP 一律 WebP，仅 HTTPS / localhost 才可能 H.264。
 */
(function (global) {
    const STORAGE_CODEC = "viewerCodec";
    const STORAGE_CODEC_REASON = "viewerCodecReason";

    function isPrivateLanHost(hostname) {
        if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
            return true;
        }
        if (/^192\.168\./.test(hostname)) return true;
        if (/^10\./.test(hostname)) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
        return false;
    }

    /** 公网 IP + HTTP：浏览器无 WebCodecs，且不应让手机发 H.264 */
    function isPublicHttpPage() {
        const loc = global.location;
        if (!loc) return false;
        return loc.protocol === "http:" && !isPrivateLanHost(loc.hostname);
    }

    function isHttpsPage() {
        const loc = global.location;
        return !!loc && loc.protocol === "https:";
    }

    function isSecurePageForWebCodecs() {
        if (global.isSecureContext === true) return true;
        return isHttpsPage();
    }

    function canUseWebCodecsH264() {
        if (isPublicHttpPage()) return false;
        return (
            typeof VideoDecoder !== "undefined" &&
            typeof EncodedVideoChunk !== "undefined" &&
            isSecurePageForWebCodecs()
        );
    }

    function getWebCodecsBlockReason() {
        if (isPublicHttpPage()) {
            return `HTTP 访问 ${global.location.host} 不可用 H.264，已固定 WebP`;
        }
        if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
            return "浏览器缺少 VideoDecoder（请用较新 Chrome/Edge）";
        }
        if (!isSecurePageForWebCodecs()) {
            return `当前为 ${global.location.protocol}//${global.location.host} 非安全上下文，H.264 需 HTTPS 或 localhost`;
        }
        return "";
    }

    /** 控制台 / 列表角标诊断 */
    function getDiagnostics() {
        return {
            protocol: global.location?.protocol,
            host: global.location?.host,
            isSecureContext: global.isSecureContext === true,
            isHttpsPage: isHttpsPage(),
            isPublicHttpPage: isPublicHttpPage(),
            hasVideoDecoder: typeof VideoDecoder !== "undefined",
            hasEncodedVideoChunk: typeof EncodedVideoChunk !== "undefined",
            preferredCodec: detectPreferredCodec(),
            blockReason: getWebCodecsBlockReason(),
        };
    }

    /** @returns {"h264"|"webp"} */
    function detectPreferredCodec() {
        return canUseWebCodecsH264() ? "h264" : "webp";
    }

    function getCodecCommand() {
        if (detectPreferredCodec() === "h264") {
            return { type: "allowH264" };
        }
        return { type: "preferWebp" };
    }

    /**
     * 检测并写入 sessionStorage，供列表页 → 控制页保持一致
     * @returns {{ codec: "h264"|"webp", reason: string, label: string }}
     */
    function detectAndPersist() {
        const codec = detectPreferredCodec();
        const reason = codec === "webp" ? getWebCodecsBlockReason() : "";
        try {
            global.sessionStorage.setItem(STORAGE_CODEC, codec);
            global.sessionStorage.setItem(STORAGE_CODEC_REASON, reason);
        } catch (_) {
            /* ignore */
        }
        const label =
            codec === "h264"
                ? "本页支持 H.264（HTTPS·控制页请选「清晰」）"
                : reason
                  ? `投屏：WebP（${reason}）`
                  : "投屏：WebP";
        return { codec, reason, label };
    }

    function readPersisted() {
        try {
            const cached = global.sessionStorage.getItem(STORAGE_CODEC);
            const reason = global.sessionStorage.getItem(STORAGE_CODEC_REASON) || "";
            if (cached === "h264" || cached === "webp") {
                const codec = cached;
                const label =
                    codec === "h264"
                        ? "本页支持 H.264（HTTPS·控制页请选「清晰」）"
                        : reason
                          ? `投屏：WebP（${reason}）`
                          : "投屏：WebP";
                return { codec, reason, label };
            }
        } catch (_) {
            /* ignore */
        }
        return detectAndPersist();
    }

    /**
     * 向单台或多台设备下发编码偏好（allowH264 / preferWebp）
     * @param {WebSocket} socket
     * @param {string[]} deviceIds
     */
    function pushCodecToDevices(socket, deviceIds) {
        if (!socket || socket.readyState !== 1) return;
        const ids = (deviceIds || []).filter(Boolean).map(String);
        if (!ids.length) return;
        const command = getCodecCommand();
        const preferred = detectPreferredCodec();
        console.info(
            `[codec] 通知 ${ids.length} 台 → ${command.type}（本页 ${preferred}）`,
            getDiagnostics()
        );
        socket.send(
            JSON.stringify({
                type: "control",
                deviceIds: ids,
                command,
            })
        );
        return { command, preferred, count: ids.length };
    }

    const CodecClient = {
        isPublicHttpPage,
        isHttpsPage,
        isSecurePageForWebCodecs,
        canUseWebCodecsH264,
        getWebCodecsBlockReason,
        getDiagnostics,
        detectPreferredCodec,
        getCodecCommand,
        detectAndPersist,
        readPersisted,
        pushCodecToDevices,
        STORAGE_CODEC,
    };

    global.CodecClient = CodecClient;
})(typeof window !== "undefined" ? window : globalThis);
