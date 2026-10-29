package com.wanghaonetcn.Accessibility.myfunction

import android.util.Log

/**
 * 投屏链路诊断日志（logcat 过滤 tag: StreamDiag）
 * 控制页排查时保持开启；稳定后可改 [enabled] = false
 */
object StreamDiag {
    private const val TAG = "StreamDiag"

    @JvmField
    var enabled: Boolean = true

    @JvmStatic
    fun log(message: String) {
        if (!enabled) return
        Log.i(TAG, message)
    }

    @JvmStatic
    fun warn(message: String) {
        if (!enabled) return
        Log.w(TAG, message)
    }

    @JvmStatic
    fun frameEncoded(profile: String, bytes: Int, intervalMs: Long, duplicate: Boolean) {
        if (!enabled) return
        log(
            "encode profile=$profile bytes=$bytes intervalMs=$intervalMs dup=$duplicate"
        )
    }

    @JvmStatic
    fun frameSent(kind: String, bytes: Int, queueLeft: Int, dropped: Int) {
        if (!enabled) return
        log("tx kind=$kind bytes=$bytes queueLeft=$queueLeft dropped=$dropped")
    }

    @JvmStatic
    fun profileChange(from: String, to: String, mode: String, h264: Boolean, reason: String) {
        if (!enabled) return
        log("profile $from -> $to mode=$mode h264=$h264 reason=$reason")
    }
}
