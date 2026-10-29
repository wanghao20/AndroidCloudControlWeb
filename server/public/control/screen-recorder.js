/** @module control/screen-recorder — 录制投屏画面并导出 MP4 */
import { st } from "./state.js";
import { beginAudioRecordingTap, endAudioRecordingTap } from "./audio.js";

const FPS = 15;
const BITRATE = 2_500_000;

let activeRecorder = null;

function pad2(n) {
    return String(n).padStart(2, "0");
}

function buildFilename() {
    const d = new Date();
    const stamp =
        `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
        `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const id = (st.deviceId || "device").replace(/[^\w.-]+/g, "_");
    return `screen-record-${id}-${stamp}.mp4`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function setRecordStatus(text) {
    if (st.screenRecordStatus) {
        st.screenRecordStatus.textContent = text || "";
    }
}

function updateRecordingUi(recording, withAudio) {
    if (st.btnScreenRecord) {
        st.btnScreenRecord.textContent = recording ? "[ 结束录屏 ]" : "[ 开始录屏 ]";
        st.btnScreenRecord.classList.toggle("is-recording", recording);
        st.btnScreenRecord.setAttribute("aria-pressed", recording ? "true" : "false");
    }
    if (st.viewerFrame) {
        st.viewerFrame.classList.toggle("viewer-frame--recording", recording);
    }
    if (st.recordingIndicator) {
        st.recordingIndicator.classList.toggle("hidden", !recording);
    }
    if (recording) {
        setRecordStatus(withAudio ? "正在录屏（含设备音频）…" : "正在录屏（仅画面，无音频轨）…");
    }
}

class Mp4CanvasRecorder {
    constructor(canvas, width, height) {
        this.canvas = canvas;
        this.width = width;
        this.height = height;
        this.frameIndex = 0;
        this.timer = null;
        this.encoder = null;
        this.audioEncoder = null;
        this.muxer = null;
        this.target = null;
        this.recording = false;
        this.hasAudio = false;
        this.audioAbort = null;
        this.audioPumpPromise = null;
    }

    isActive() {
        return this.recording;
    }

    async start() {
        const support = await VideoEncoder.isConfigSupported({
            codec: "avc1.42E01E",
            width: this.width,
            height: this.height,
            bitrate: BITRATE,
            framerate: FPS,
        });
        if (!support.supported) {
            throw new Error("当前浏览器不支持 H.264 录屏编码");
        }

        const muxerMod = await import("https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm");
        const { Muxer, ArrayBufferTarget } = muxerMod;
        this.target = new ArrayBufferTarget();

        const audioStream = beginAudioRecordingTap();
        const audioTrack = audioStream?.getAudioTracks?.()[0] || null;
        const muxerOpts = {
            target: this.target,
            video: {
                codec: "avc",
                width: this.width,
                height: this.height,
            },
            fastStart: "in-memory",
        };

        if (audioTrack && typeof AudioEncoder !== "undefined") {
            const audioSupport = await AudioEncoder.isConfigSupported({
                codec: "mp4a.40.2",
                sampleRate: 44100,
                numberOfChannels: 2,
                bitrate: 128_000,
            });
            if (audioSupport.supported) {
                muxerOpts.audio = {
                    codec: "aac",
                    sampleRate: 44100,
                    numberOfChannels: 2,
                };
                this.hasAudio = true;
            }
        }

        this.muxer = new Muxer(muxerOpts);

        this.encoder = new VideoEncoder({
            output: (chunk, meta) => {
                this.muxer.addVideoChunk(chunk, meta);
            },
            error: (err) => {
                console.error("[ScreenRecord] encode error", err);
            },
        });
        this.encoder.configure({
            codec: "avc1.42E01E",
            width: this.width,
            height: this.height,
            bitrate: BITRATE,
            framerate: FPS,
        });

        if (this.hasAudio && audioTrack) {
            this.audioEncoder = new AudioEncoder({
                output: (chunk, meta) => {
                    this.muxer.addAudioChunk(chunk, meta);
                },
                error: (err) => {
                    console.error("[ScreenRecord] audio encode error", err);
                },
            });
            this.audioEncoder.configure({
                codec: "mp4a.40.2",
                sampleRate: 44100,
                numberOfChannels: 2,
                bitrate: 128_000,
            });
            this.audioAbort = new AbortController();
            this.audioPumpPromise = this.pumpAudioTrack(audioTrack, this.audioAbort.signal);
        }

        this.recording = true;
        this.frameIndex = 0;
        const frameDurationUs = Math.round(1_000_000 / FPS);
        this.timer = window.setInterval(() => {
            if (!this.recording || !this.canvas) return;
            if (this.canvas.width < 2 || this.canvas.height < 2) return;
            try {
                const ts = this.frameIndex * frameDurationUs;
                const frame = new VideoFrame(this.canvas, { timestamp: ts });
                this.encoder.encode(frame, { keyFrame: this.frameIndex % FPS === 0 });
                frame.close();
                this.frameIndex += 1;
            } catch (err) {
                console.warn("[ScreenRecord] frame skip", err);
            }
        }, frameDurationUs / 1000);
    }

    async pumpAudioTrack(track, signal) {
        if (!track || typeof MediaStreamTrackProcessor === "undefined") return;
        const processor = new MediaStreamTrackProcessor({ track });
        const reader = processor.readable.getReader();
        try {
            while (!signal.aborted) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value && this.audioEncoder && this.recording) {
                    this.audioEncoder.encode(value);
                }
                value?.close?.();
            }
        } catch (err) {
            if (!signal.aborted) {
                console.warn("[ScreenRecord] audio pump error", err);
            }
        } finally {
            try {
                reader.releaseLock();
            } catch (_) {
                /* ignore */
            }
        }
    }

    async stop() {
        this.recording = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.audioAbort) {
            this.audioAbort.abort();
            this.audioAbort = null;
        }
        if (this.audioPumpPromise) {
            await this.audioPumpPromise.catch(() => {});
            this.audioPumpPromise = null;
        }
        if (this.audioEncoder) {
            await this.audioEncoder.flush();
            this.audioEncoder.close();
            this.audioEncoder = null;
        }
        endAudioRecordingTap();
        if (this.encoder) {
            await this.encoder.flush();
            this.encoder.close();
            this.encoder = null;
        }
        if (this.muxer) {
            this.muxer.finalize();
            this.muxer = null;
        }
        if (!this.target?.buffer || this.frameIndex < 1) {
            throw new Error("录屏时长过短或未采集到画面");
        }
        const blob = new Blob([this.target.buffer], { type: "video/mp4" });
        downloadBlob(blob, buildFilename());
        this.savedFormat = "mp4";
        this.target = null;
    }
}

class MediaRecorderFallback {
    constructor(canvas) {
        this.canvas = canvas;
        this.recorder = null;
        this.chunks = [];
        this.mimeType = "";
        this.recording = false;
        this.hasAudio = false;
    }

    isActive() {
        return this.recording;
    }

    async start() {
        const videoStream = this.canvas.captureStream(FPS);
        const audioStream = beginAudioRecordingTap();
        const tracks = [...videoStream.getVideoTracks()];
        if (audioStream?.getAudioTracks?.().length) {
            tracks.push(...audioStream.getAudioTracks());
            this.hasAudio = true;
        }
        const stream = new MediaStream(tracks);
        const candidates = this.hasAudio
            ? [
                "video/webm;codecs=vp9,opus",
                "video/webm;codecs=vp8,opus",
                "video/webm",
                "video/mp4;codecs=avc1,mp4a",
                "video/mp4",
            ]
            : [
                "video/mp4;codecs=avc1",
                "video/mp4",
                "video/webm;codecs=vp9",
                "video/webm;codecs=vp8",
                "video/webm",
            ];
        this.mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
        if (!this.mimeType) {
            endAudioRecordingTap();
            throw new Error("当前浏览器不支持 MediaRecorder 录屏");
        }
        this.chunks = [];
        this.recorder = new MediaRecorder(stream, {
            mimeType: this.mimeType,
            videoBitsPerSecond: BITRATE,
        });
        this.recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        this.recorder.start(1000);
        this.recording = true;
    }

    async stop() {
        if (!this.recorder) return;
        const recorder = this.recorder;
        await new Promise((resolve, reject) => {
            recorder.onstop = resolve;
            recorder.onerror = () => reject(new Error("MediaRecorder 停止失败"));
            if (recorder.state !== "inactive") recorder.stop();
            else resolve();
        });
        this.recording = false;
        this.recorder = null;
        endAudioRecordingTap();
        if (!this.chunks.length) {
            throw new Error("录屏时长过短或未采集到画面");
        }
        const blob = new Blob(this.chunks, { type: this.mimeType });
        const ext = this.mimeType.includes("mp4") ? "mp4" : "webm";
        const name = buildFilename().replace(/\.mp4$/, `.${ext}`);
        downloadBlob(blob, name);
        this.savedFormat = ext;
    }
}

async function createRecorder(canvas) {
    const width = Math.max(2, canvas.width & ~1);
    const height = Math.max(2, canvas.height & ~1);
    if (typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined") {
        try {
            const mp4 = new Mp4CanvasRecorder(canvas, width, height);
            return mp4;
        } catch (err) {
            console.warn("[ScreenRecord] WebCodecs path failed, fallback", err);
        }
    }
    return new MediaRecorderFallback(canvas);
}

async function startRecording() {
    const canvas = st.deviceCanvas;
    if (!canvas || canvas.width < 2 || canvas.height < 2) {
        setRecordStatus("请先等待画面加载后再录屏");
        return;
    }
    if (activeRecorder?.isActive()) return;
    try {
        activeRecorder = await createRecorder(canvas);
        await activeRecorder.start();
        updateRecordingUi(true, !!activeRecorder.hasAudio);
    } catch (err) {
        endAudioRecordingTap();
        activeRecorder = null;
        updateRecordingUi(false);
        setRecordStatus(`录屏启动失败：${err.message}`);
    }
}

async function stopRecording() {
    if (!activeRecorder?.isActive()) {
        updateRecordingUi(false);
        return;
    }
    setRecordStatus("正在保存录屏文件…");
    try {
        await activeRecorder.stop();
        const fmt = activeRecorder.savedFormat === "webm" ? "WebM" : "MP4";
        const audioHint = activeRecorder.hasAudio ? "（含音频）" : "（仅画面）";
        setRecordStatus(`录屏已保存为 ${fmt} 文件${audioHint}`);
        setTimeout(() => {
            if (!activeRecorder?.isActive?.()) setRecordStatus("");
        }, 3200);
    } catch (err) {
        setRecordStatus(err.message || "保存录屏失败");
    } finally {
        activeRecorder = null;
        updateRecordingUi(false);
    }
}

export function initScreenRecorder() {
    if (!st.btnScreenRecord) return;
    st.btnScreenRecord.addEventListener("click", () => {
        if (activeRecorder?.isActive()) {
            stopRecording();
        } else {
            startRecording();
        }
    });
    window.addEventListener("beforeunload", () => {
        if (activeRecorder?.isActive()) {
            try {
                activeRecorder.recording = false;
            } catch (_) {
                /* ignore */
            }
        }
    });
}
