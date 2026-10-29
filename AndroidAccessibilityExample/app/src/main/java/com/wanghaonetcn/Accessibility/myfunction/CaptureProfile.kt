package com.wanghaonetcn.Accessibility.myfunction

/**
 * 投屏采集档位（自适应画质）
 */
data class CaptureProfile(
    val name: String,
    val scaleWidth: Int,
    val jpegQuality: Int,
    val intervalMs: Long
) {
    companion object {
        /** 列表缩略图：仅可见设备、低频小图 */
        val THUMB = CaptureProfile("thumb", 180, 14, 12000L)
        /** 兼容旧指令 */
        val LOW = CaptureProfile("low", 200, 16, 15000L)
        val MEDIUM = CaptureProfile("medium", 540, 40, 66L)
        /** 高刷控制：H.264 720 宽；WebP 在 ScreenCaptureService 内再压 */
        val HIGH = CaptureProfile("high", 720, 48, 50L)
        /** 流畅：WebP 固定，约 12fps，分辨率仍较高 */
        val SMOOTH = CaptureProfile("smooth", 540, 42, 80L)
        val REALTIME = HIGH

        fun fromName(name: String?): CaptureProfile? = when (name?.lowercase()) {
            "thumb", "thumbnail" -> THUMB
            "low", "idle" -> LOW
            "medium", "mid" -> MEDIUM
            "smooth" -> SMOOTH
            "high", "realtime" -> HIGH
            else -> null
        }

        fun stepDown(current: String): CaptureProfile? = when (current.lowercase()) {
            "high" -> MEDIUM
            "medium", "mid" -> LOW
            else -> null
        }

        fun stepUp(current: String): CaptureProfile? = when (current.lowercase()) {
            "low" -> MEDIUM
            "medium", "mid" -> HIGH
            else -> null
        }
    }
}

enum class CaptureMode {
    /** 跟随服务端 pong 建议 + 本机发送耗时微调 */
    AUTO,
    /** 控制页「清晰」：高帧，可 H.264 */
    MANUAL_HIGH,
    /** 控制页「流畅」：固定 WebP，忽略 pong 的 thumb/low */
    MANUAL_SMOOTH
}
