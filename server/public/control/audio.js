/** @module control/audio */
import { st } from "./state.js";

const DEVICE_AUDIO_MAGIC = 0xf3;

let audioCtx = null;
let nextPlayTime = 0;
let recordMixDest = null;

export { DEVICE_AUDIO_MAGIC };

export function parseAudioPacket(u8) {
    if (!u8 || u8.length < 9 || u8[0] !== DEVICE_AUDIO_MAGIC) return null;
    const sampleRate =
        ((u8[1] << 24) | (u8[2] << 16) | (u8[3] << 8) | u8[4]) >>> 0;
    const channels = u8[5] || 1;
    const idLen = (u8[6] << 8) | u8[7];
    const headerLen = 8 + idLen;
    if (headerLen >= u8.length) return null;
    const deviceId = new TextDecoder().decode(u8.subarray(8, headerLen));
    const pcm = u8.subarray(headerLen);
    if (!pcm.length) return null;
    return { deviceId, sampleRate, channels, pcm };
}

function ensureAudioContext(sampleRate) {
    if (audioCtx && audioCtx.state !== "closed") {
        return audioCtx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx({ sampleRate: sampleRate || 44100 });
    nextPlayTime = 0;
    return audioCtx;
}

export function resumeControlAudio() {
    const ctx = ensureAudioContext(44100);
    if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
    }
}

/** 录屏时把设备音频同时送入 MediaStream，供录屏模块采集 */
export function beginAudioRecordingTap() {
    const ctx = ensureAudioContext(44100);
    if (!ctx || typeof ctx.createMediaStreamDestination !== "function") {
        return null;
    }
    resumeControlAudio();
    if (!recordMixDest) {
        recordMixDest = ctx.createMediaStreamDestination();
    }
    return recordMixDest.stream;
}

export function endAudioRecordingTap() {
    recordMixDest = null;
}

export function stopControlAudio() {
    if (audioCtx) {
        try {
            audioCtx.close();
        } catch (_) {
            /* ignore */
        }
        audioCtx = null;
    }
    nextPlayTime = 0;
}

function playPcmChunk(pcm, sampleRate, channels) {
    const ctx = ensureAudioContext(sampleRate);
    if (!ctx || !pcm?.length) return;
    const ch = Math.max(1, channels || 1);
    const sampleCount = Math.floor(pcm.length / 2 / ch);
    if (sampleCount <= 0) return;

    const buffer = ctx.createBuffer(ch, sampleCount, sampleRate);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let c = 0; c < ch; c++) {
        const channel = buffer.getChannelData(c);
        for (let i = 0; i < sampleCount; i++) {
            channel[i] = view.getInt16((i * ch + c) * 2, true) / 32768;
        }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    if (recordMixDest) {
        source.connect(recordMixDest);
    }
    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.03, nextPlayTime || now + 0.03);
    source.start(startAt);
    nextPlayTime = startAt + buffer.duration;
}

export function handleAudioBinary(arrayBuffer) {
    if (!st.controlSessionActive || !st.deviceAudioEnabled) return;
    const parsed = parseAudioPacket(new Uint8Array(arrayBuffer));
    if (!parsed || String(parsed.deviceId) !== String(st.deviceId)) return;
    resumeControlAudio();
    playPcmChunk(parsed.pcm, parsed.sampleRate, parsed.channels);
}
