package com.wanghaonetcn.Accessibility.myfunction

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 通过 MediaProjection 抓取设备播放音频（API 29+），PCM16 单声道上行。
 */
class ScreenAudioCapture(
    private val context: android.content.Context,
    private val mediaProjection: MediaProjection,
    private val onPcmChunk: (ByteArray, Int, Int) -> Unit
) {
    companion object {
        private const val TAG = "ScreenAudioCapture"
        const val SAMPLE_RATE = 44100
        const val CHANNELS = 1
    }

    private var audioRecord: AudioRecord? = null
    private var captureThread: Thread? = null
    private val running = AtomicBoolean(false)

    fun isRunning(): Boolean = running.get()

    fun start(): Boolean {
        if (running.get()) return true
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            Log.w(TAG, "AudioPlaybackCapture 需要 Android 10+")
            return false
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "缺少 RECORD_AUDIO 权限，无法采集音频")
            return false
        }

        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, channelMask, encoding)
        if (minBuf <= 0) {
            Log.e(TAG, "AudioRecord 最小缓冲无效: $minBuf")
            return false
        }
        val bufferSize = minBuf * 2

        return try {
            val playbackConfig = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()

            val audioFormat = AudioFormat.Builder()
                .setEncoding(encoding)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(channelMask)
                .build()

            val record = AudioRecord.Builder()
                .setAudioFormat(audioFormat)
                .setBufferSizeInBytes(bufferSize)
                .setAudioPlaybackCaptureConfig(playbackConfig)
                .build()

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                val msg = "AudioRecord 初始化失败: 状态未就绪"
                Log.e(TAG, msg)
                com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(Exception(msg), "AudioCapture")
                record.release()
                return false
            }

            audioRecord = record
            running.set(true)
            record.startRecording()
            captureThread = Thread({
                val buf = ByteArray(bufferSize)
                while (running.get()) {
                    val read = try {
                        record.read(buf, 0, buf.size)
                    } catch (e: Exception) {
                        Log.w(TAG, "AudioRecord.read 异常: ${e.message}")
                        com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "AudioCapture", "Read loop exception")
                        break
                    }
                    if (read > 0) {
                        onPcmChunk(buf.copyOf(read), SAMPLE_RATE, CHANNELS)
                    } else if (read < 0) {
                        Log.w(TAG, "AudioRecord.read 错误码: $read")
                        if (read == AudioRecord.ERROR_INVALID_OPERATION) {
                             com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(Exception("AudioRecord ERROR_INVALID_OPERATION"), "AudioCapture")
                        }
                        break
                    }
                }
            }, "ScreenAudioCapture").also { it.start() }
            Log.i(TAG, "音频采集已启动 ${SAMPLE_RATE}Hz mono PCM16")
            true
        } catch (e: SecurityException) {
            Log.e(TAG, "音频采集权限不足 (Android 14 需前台服务类型 microphone): ${e.message}")
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "AudioCapture", "SecurityException - check foreground service type")
            false
        } catch (e: Exception) {
            Log.e(TAG, "音频采集启动失败: ${e.message}")
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "AudioCapture", "General start exception")
            false
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        captureThread?.interrupt()
        captureThread = null
        try {
            audioRecord?.stop()
        } catch (_: Exception) {
        }
        try {
            audioRecord?.release()
        } catch (_: Exception) {
        }
        audioRecord = null
        Log.i(TAG, "音频采集已停止")
    }
}
