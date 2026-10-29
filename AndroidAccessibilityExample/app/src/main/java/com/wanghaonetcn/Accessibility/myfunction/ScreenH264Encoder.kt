package com.wanghaonetcn.Accessibility.myfunction

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 屏幕 H.264 硬件编码（MediaCodec Surface 输入，VirtualDisplay 直连）
 */
class ScreenH264Encoder(
    private val width: Int,
    private val height: Int,
    private val bitRate: Int,
    private val frameRate: Int,
    private val onPacket: (frameType: Int, data: ByteArray) -> Unit
) {
    companion object {
        private const val TAG = "ScreenH264Encoder"
        const val FRAME_CONFIG = 0
        const val FRAME_KEY = 1
        const val FRAME_DELTA = 2
    }

    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var drainThread: HandlerThread? = null
    private var drainHandler: Handler? = null
    private val running = AtomicBoolean(false)
    private var configSent = false

    fun start(): Surface? {
        stopInternal()
        val evenW = alignEven(width)
        val evenH = alignEven(height)
        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, evenW, evenH).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
                )
                setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
                setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR
                )
            }
            val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            enc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = enc.createInputSurface()
            enc.start()
            codec = enc
            running.set(true)
            configSent = false
            drainThread = HandlerThread("H264Drain").apply { start() }
            drainHandler = Handler(drainThread!!.looper)
            drainHandler?.post(drainRunnable)
            Log.i(TAG, "H.264 编码已启动 ${evenW}x${evenH} ${bitRate / 1000}kbps ${frameRate}fps")
            return inputSurface
        } catch (e: Exception) {
            Log.e(TAG, "H.264 编码启动失败: ${e.message}")
            stopInternal()
            return null
        }
    }

    fun stop() {
        running.set(false)
        stopInternal()
    }

    fun requestKeyframe() {
        val c = codec ?: return
        try {
            val params = android.os.Bundle()
            params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            c.setParameters(params)
        } catch (e: Exception) {
            Log.w(TAG, "请求关键帧失败: ${e.message}")
        }
    }

    private val drainRunnable = object : Runnable {
        override fun run() {
            if (!running.get()) return
            drainOutput()
            drainHandler?.post(this)
        }
    }

    private fun drainOutput() {
        val c = codec ?: return
        val bufferInfo = MediaCodec.BufferInfo()
        while (running.get()) {
            val index = try {
                c.dequeueOutputBuffer(bufferInfo, 0)
            } catch (e: IllegalStateException) {
                Log.w(TAG, "dequeueOutputBuffer: ${e.message}")
                break
            }
            when {
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> break
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val newFormat = c.outputFormat
                    sendCodecConfig(newFormat)
                }
                index >= 0 -> {
                    val out = c.getOutputBuffer(index) ?: continue
                    if (bufferInfo.size > 0) {
                        val chunk = ByteArray(bufferInfo.size)
                        out.position(bufferInfo.offset)
                        out.limit(bufferInfo.offset + bufferInfo.size)
                        out.get(chunk)
                        when {
                            bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0 -> {
                                trySendConfigFromCodecData(chunk)
                            }
                            else -> {
                                val frameType = resolveVideoFrameType(bufferInfo, chunk)
                                emitVideoPacket(frameType, chunk)
                            }
                        }
                    }
                    c.releaseOutputBuffer(index, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
        }
    }

    private fun sendCodecConfig(format: MediaFormat) {
        if (configSent) return
        val spsBuf = format.getByteBuffer("csd-0") ?: return
        val ppsBuf = format.getByteBuffer("csd-1")
        val pair = extractSpsPps(byteArrayFromBuffer(spsBuf), ppsBuf?.let { byteArrayFromBuffer(it) })
        if (pair == null) {
            Log.w(TAG, "无法从 csd 解析 SPS/PPS，等待 CODEC_CONFIG 输出缓冲")
            return
        }
        emitConfigPacket(pair.first, pair.second)
    }

    /** 部分机型仅在 CODEC_CONFIG 输出缓冲里带 SPS/PPS */
    private fun trySendConfigFromCodecData(data: ByteArray) {
        if (configSent) return
        val pair = extractSpsPpsFromAnnexB(data)
            ?: extractSpsPpsFromAvcc(data)
            ?: return
        emitConfigPacket(pair.first, pair.second)
    }

    private fun emitConfigPacket(sps: ByteArray, pps: ByteArray) {
        if (configSent) return
        val packet = packConfigPayload(sps, pps) ?: return
        configSent = true
        onPacket(FRAME_CONFIG, packet)
        Log.i(TAG, "已发送 H.264 CONFIG SPS=${sps.size} PPS=${pps.size}")
    }

    /**
     * 高通等 OMX 编码器常不把 BUFFER_FLAG_KEY_FRAME 置位，需扫描 NAL 类型 5（IDR）。
     */
    private fun resolveVideoFrameType(info: MediaCodec.BufferInfo, chunk: ByteArray): Int {
        if (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) return FRAME_KEY
        if (containsIdrNal(chunk)) return FRAME_KEY
        return FRAME_DELTA
    }

    private fun containsIdrNal(data: ByteArray): Boolean {
        if (data.isEmpty()) return false
        var i = 0
        while (i + 4 < data.size) {
            val len = ((data[i].toInt() and 0xFF) shl 24) or
                ((data[i + 1].toInt() and 0xFF) shl 16) or
                ((data[i + 2].toInt() and 0xFF) shl 8) or
                (data[i + 3].toInt() and 0xFF)
            if (len <= 0 || len > data.size - i - 4) break
            val nalStart = i + 4
            if (nalStart < data.size && (data[nalStart].toInt() and 0x1F) == 5) {
                return true
            }
            i = nalStart + len
        }
        return splitAnnexBNals(data).any { nalType(it) == 5 }
    }

    private fun emitVideoPacket(frameType: Int, chunk: ByteArray) {
        val label = if (frameType == FRAME_KEY) "KEY" else "DELTA"
        val annexB = avccToAnnexB(chunk)
        if (frameType == FRAME_KEY || annexB.size > 200) {
            Log.i(TAG, "H.264 $label 上行 ${annexB.size}B")
        }
        onPacket(frameType, annexB)
    }

    private fun byteArrayFromBuffer(buf: ByteBuffer): ByteArray {
        val dup = buf.duplicate()
        return ByteArray(dup.remaining()).also { dup.get(it) }
    }

    /** 去掉 00 00 01 / 00 00 00 01 起始码，供网页 WebCodecs avcC 使用 */
    private fun stripStartCode(data: ByteArray): ByteArray {
        var i = 0
        while (i + 3 < data.size) {
            if (data[i] == 0.toByte() && data[i + 1] == 0.toByte()) {
                if (data[i + 2] == 1.toByte()) return data.copyOfRange(i + 3, data.size)
                if (i + 3 < data.size && data[i + 2] == 0.toByte() && data[i + 3] == 1.toByte()) {
                    return data.copyOfRange(i + 4, data.size)
                }
            }
            i++
        }
        return data
    }

    private fun nalType(nal: ByteArray): Int {
        if (nal.isEmpty()) return -1
        return nal[0].toInt() and 0x1F
    }

    private fun splitAnnexBNals(data: ByteArray): List<ByteArray> {
        val nals = mutableListOf<ByteArray>()
        var i = 0
        while (i < data.size - 3) {
            var scLen = 0
            if (data[i] == 0.toByte() && data[i + 1] == 0.toByte()) {
                when {
                    data[i + 2] == 1.toByte() -> scLen = 3
                    i + 3 < data.size && data[i + 2] == 0.toByte() && data[i + 3] == 1.toByte() -> scLen = 4
                }
            }
            if (scLen == 0) {
                i++
                continue
            }
            val nalStart = i + scLen
            var next = nalStart
            while (next < data.size - 3) {
                if (data[next] == 0.toByte() && data[next + 1] == 0.toByte() &&
                    (data[next + 2] == 1.toByte() ||
                        (next + 3 < data.size && data[next + 2] == 0.toByte() && data[next + 3] == 1.toByte()))
                ) {
                    break
                }
                next++
            }
            if (next > nalStart) nals.add(data.copyOfRange(nalStart, next))
            i = if (next > nalStart) next else i + 1
        }
        return nals
    }

    private fun extractSpsPpsFromAnnexB(data: ByteArray): Pair<ByteArray, ByteArray>? {
        val nals = splitAnnexBNals(data)
        val sps = nals.firstOrNull { nalType(it) == 7 }?.let { stripStartCode(it) }
        val pps = nals.firstOrNull { nalType(it) == 8 }?.let { stripStartCode(it) }
        return if (sps != null && pps != null) sps to pps else null
    }

    /** MediaFormat csd-0 有时为 avcC 记录（首字节 0x01） */
    private fun extractSpsPpsFromAvcc(data: ByteArray): Pair<ByteArray, ByteArray>? {
        if (data.size < 11 || data[0] != 1.toByte()) return null
        var o = 5
        val numSps = data[o++].toInt() and 0x1F
        if (numSps < 1 || o + 2 > data.size) return null
        val spsLen = ((data[o].toInt() and 0xFF) shl 8) or (data[o + 1].toInt() and 0xFF)
        o += 2
        if (o + spsLen > data.size) return null
        val sps = data.copyOfRange(o, o + spsLen)
        o += spsLen
        if (o >= data.size) return null
        val numPps = data[o++].toInt() and 0xFF
        if (numPps < 1 || o + 2 > data.size) return null
        val ppsLen = ((data[o].toInt() and 0xFF) shl 8) or (data[o + 1].toInt() and 0xFF)
        o += 2
        if (o + ppsLen > data.size) return null
        val pps = data.copyOfRange(o, o + ppsLen)
        return sps to pps
    }

    private fun extractSpsPps(csd0: ByteArray, csd1: ByteArray?): Pair<ByteArray, ByteArray>? {
        if (csd1 != null && csd1.isNotEmpty()) {
            val sps = stripStartCode(csd0)
            val pps = stripStartCode(csd1)
            if (sps.isNotEmpty() && pps.isNotEmpty() && nalType(sps) == 7 && nalType(pps) == 8) {
                return sps to pps
            }
        }
        extractSpsPpsFromAnnexB(csd0)?.let { return it }
        extractSpsPpsFromAvcc(csd0)?.let { return it }
        return null
    }

    private fun packConfigPayload(sps: ByteArray, pps: ByteArray): ByteArray? {
        if (sps.isEmpty() || pps.isEmpty()) return null
        val packet = ByteArray(4 + sps.size + 4 + pps.size)
        var o = 0
        packet[o++] = ((sps.size shr 24) and 0xFF).toByte()
        packet[o++] = ((sps.size shr 16) and 0xFF).toByte()
        packet[o++] = ((sps.size shr 8) and 0xFF).toByte()
        packet[o++] = (sps.size and 0xFF).toByte()
        System.arraycopy(sps, 0, packet, o, sps.size)
        o += sps.size
        packet[o++] = ((pps.size shr 24) and 0xFF).toByte()
        packet[o++] = ((pps.size shr 16) and 0xFF).toByte()
        packet[o++] = ((pps.size shr 8) and 0xFF).toByte()
        packet[o++] = (pps.size and 0xFF).toByte()
        System.arraycopy(pps, 0, packet, o, pps.size)
        return packet
    }

    private fun stopInternal() {
        drainHandler?.removeCallbacksAndMessages(null)
        drainThread?.quitSafely()
        drainThread = null
        drainHandler = null
        try {
            codec?.stop()
        } catch (_: Exception) {
        }
        try {
            codec?.release()
        } catch (_: Exception) {
        }
        codec = null
        try {
            inputSurface?.release()
        } catch (_: Exception) {
        }
        inputSurface = null
        configSent = false
    }

    private fun alignEven(n: Int): Int {
        val v = n.coerceAtLeast(2)
        return if (v % 2 == 0) v else v - 1
    }

    /** MediaCodec 输出 AVCC → WebCodecs 需要的 Annex-B */
    private fun avccToAnnexB(avcc: ByteArray): ByteArray {
        if (avcc.size < 5) return avcc
        if (avcc[0] == 0.toByte() && avcc[1] == 0.toByte()) return avcc

        val out = ArrayList<Byte>(avcc.size + 16)
        var i = 0
        while (i + 4 <= avcc.size) {
            val len = ((avcc[i].toInt() and 0xFF) shl 24) or
                ((avcc[i + 1].toInt() and 0xFF) shl 16) or
                ((avcc[i + 2].toInt() and 0xFF) shl 8) or
                (avcc[i + 3].toInt() and 0xFF)
            i += 4
            if (len <= 0 || i + len > avcc.size) break
            out.add(0); out.add(0); out.add(0); out.add(1)
            for (j in 0 until len) out.add(avcc[i + j])
            i += len
        }
        return out.toByteArray()
    }

    private fun stripStartCodes(data: ByteArray): ByteArray {
        if (data.size >= 4 &&
            data[0] == 0.toByte() && data[1] == 0.toByte() &&
            data[2] == 0.toByte() && data[3] == 1.toByte()
        ) {
            return data.copyOfRange(4, data.size)
        }
        if (data.size >= 3 &&
            data[0] == 0.toByte() && data[1] == 0.toByte() && data[2] == 1.toByte()
        ) {
            return data.copyOfRange(3, data.size)
        }
        return data
    }
}
