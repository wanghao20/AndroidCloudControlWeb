package com.wanghaonetcn.Accessibility.myfunction

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.util.Base64
import android.hardware.HardwareBuffer
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.view.Surface
import android.media.projection.MediaProjectionManager
import android.os.*
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import com.wanghaonetcn.Accessibility.R
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 屏幕采集上传服务：针对 Android 14 进行了启动顺序优化
 */
class ScreenCaptureService : Service() {
    companion object {
        private const val TAG = "ScreenCaptureService"
        private const val NOTIFICATION_ID = 2001
        /** 非 H.264 采集最大宽度，降低 ImageReader 内存 */
        private const val BITMAP_CAPTURE_MAX_WIDTH = 960
        private const val IMAGE_READER_MAX_IMAGES = 2
        private const val H264_BITRATE = 2_800_000
        private const val H264_FPS = 24
        private const val H264_CONTROL_MAX_WIDTH = 720
        private const val H264_KEYFRAME_MIN_INTERVAL_MS = 150L
        /** 控制页 WebP（HTTPS 或局域网） */
        private const val WEBP_CONTROL_MAX_WIDTH = 640
        private const val WEBP_CONTROL_QUALITY = 45
        /** 流畅档位 WebP：均衡帧率，仍保持较高清晰度 */
        private const val WEBP_SMOOTH_MAX_WIDTH = 540
        private const val WEBP_SMOOTH_QUALITY = 40
        /** 流畅档 ImageReader 缓冲宽度 */
        private const val SMOOTH_CAPTURE_MAX_WIDTH = 600
        /** 流畅档单帧 WebP 体积上限（过小会二次缩小产生马赛克） */
        private const val SMOOTH_WEBP_MAX_BYTES = 45000
        /** 公网 HTTP 强制 WebP 时 */
        private const val WEBP_WAN_MAX_WIDTH = 480
        private const val WEBP_WAN_QUALITY = 38
        /** HTTP「清晰」 */
        private const val WEBP_HTTP_HIGH_MAX_WIDTH = 640
        private const val WEBP_HTTP_HIGH_QUALITY = 42
        private const val HTTP_HIGH_CAPTURE_MAX_WIDTH = 720
        private const val HTTP_HIGH_CAPTURE_INTERVAL_MS = 50L
        /** 公网 HTTP 清晰档单帧体积上限 */
        private const val HTTP_HIGH_WEBP_MAX_BYTES = 65000

        /** 旧版流畅 Base64 JSON（与历史 control.js 对齐） */
        private const val LEGACY_SPEED_LOW_MS = 4000L
        /** Base64 JSON 体积大，10fps 易致网页闪屏，高刷限制约 4fps */
        private const val LEGACY_SPEED_HIGH_MS = 250L
        private const val LEGACY_MIN_JSON_TX_MS = 280L
        private const val LEGACY_MAX_JPEG_BYTES = 48000
        private const val LEGACY_SCALE_LOW = 360
        private const val LEGACY_SCALE_HIGH = 480
        /** 仅 ImageReader 无新图时偶尔重发上一帧 */
        private const val LEGACY_STATIC_RESEND_MS = 2000L
        private const val LEGACY_JPEG_Q_LOW = 30
        private const val LEGACY_JPEG_Q_HIGH = 38
        
        @JvmStatic
        var instance: ScreenCaptureService? = null

        @JvmStatic
        fun getStartIntent(
            context: Context,
            resultCode: Int,
            data: Intent,
            deviceId: String,
            wsUrl: String,
            token: String,
            wsUsername: String
        ): Intent {
            return Intent(context, ScreenCaptureService::class.java).apply {
                putExtra("resultCode", resultCode)
                putExtra("data", data)
                putExtra("deviceId", deviceId)
                putExtra("wsUrl", wsUrl)
                putExtra("token", token)
                putExtra("wsUsername", wsUsername)
            }
        }

        /** 投屏最后一帧，供 UI 节点查看器在无无障碍截图时兜底 */
        @JvmStatic
        fun getInspectorFrameOrNull(): InspectorFrame? {
            val svc = instance ?: return null
            return svc.snapshotForUiInspector()
        }

        /** 获取截图：优先 ImageReader 全缓冲，避免误用 640px 投屏缩略图 */
        @JvmStatic
        fun getFullScreenshotFrameOrNull(): InspectorFrame? {
            val svc = instance ?: return null
            return svc.snapshotFullForScreenshot()
        }

        /** 获取截图：临时以逻辑分辨率（如 1440×3040）重建 VirtualDisplay 抓一帧 */
        fun captureOneFrameAtLogicalSize(onDone: (InspectorFrame?) -> Unit) {
            val svc = instance
            if (svc == null) {
                onDone(null)
                return
            }
            svc.captureOneFrameAtLogicalSize(onDone)
        }

        @JvmStatic
        fun getLogicalScreenSizeOrNull(): Pair<Int, Int>? {
            val svc = instance ?: return null
            if (svc.screenWidth <= 0 || svc.screenHeight <= 0) return null
            return Pair(svc.screenWidth, svc.screenHeight)
        }
    }

    class InspectorFrame(val base64: String, val width: Int, val height: Int)

    private data class CaptureRestoreState(
        var wasPaused: Boolean = true,
        var wasH264: Boolean = false,
        var interval: Long = CaptureProfile.LOW.intervalMs
    )
    
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var executor: ScheduledExecutorService? = null
    private var captureFuture: ScheduledFuture<*>? = null
    private var webSocketClient: DeviceWebSocketClient? = null
    private var audioCapture: ScreenAudioCapture? = null
    private var deviceId: String? = null
    private var wsUrl: String? = null
    private var wsToken: String? = null
    private var screenWidth = 0
    private var screenHeight = 0

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null

    private var lastResultCode = 0
    private var lastResultData: Intent? = null

    private val handler = Handler(Looper.getMainLooper())
    private var isReconstructing = false
    @Volatile private var capturePaused = false
    @Volatile private var captureMode = CaptureMode.AUTO
    private var currentProfileName = "low"
    private var currentCaptureInterval = CaptureProfile.LOW.intervalMs
    private var targetScaleWidth = CaptureProfile.LOW.scaleWidth
    private var jpegQuality = CaptureProfile.LOW.jpegQuality
    private var lastFrameSignature = 0
    private var lastBitmapQuickSignature = 0
    private var frameSequence = 0

    /** 动静分离：滑动/变化时高帧，静止时降频且不发重复帧 */
    private var activeCaptureIntervalMs = CaptureProfile.HIGH.intervalMs
    private val idleCaptureIntervalMs = 220L
    private var consecutiveStaticFrames = 0
    private var isCaptureIntervalIdle = false
    private var lastServerProfileSuggestion = ""
    private var serverSuggestionStreak = 0
    private val sendLatencies = ArrayDeque<Long>(24)
    private val sendLatencyLock = Any()
    private val captureLock = Any()
    private val frameSendLock = Any()
    @Volatile private var pendingH264Config: Pair<Int, ByteArray>? = null
    @Volatile private var pendingH264Video: Pair<Int, ByteArray>? = null

    private var encodeThread: HandlerThread? = null
    private var encodeHandler: Handler? = null
    private val encodeScheduleLock = Any()
    private var pendingEncodeSnapshot: Bitmap? = null
    private var pendingLogicalWidth = 0
    private var pendingLogicalHeight = 0
    private var pendingScaleWidth = 0
    private var pendingQuality = 0
    private val encodeDrainRunnable = Runnable { drainPendingEncode() }
    private val h264PumpRunnable = Runnable {
        webSocketClient?.let { pumpH264Outbound(it) }
    }

    private var h264Encoder: ScreenH264Encoder? = null
    @Volatile private var useHardwareH264 = false
    private var lastH264KeyframeRequestAt = 0L
    /** 控制页无 WebCodecs（如 HTTP）时强制 WebP */
    @Volatile private var forceWebpCapture = false
    /** Base64 JSON 模式：用 JPEG base64 通过 JSON 文本消息发帧 */
    @Volatile private var useBase64JsonMode = true
    @Volatile private var pausedByScreenOff = false
    private var captureSurfaceWidth = 0
    private var captureSurfaceHeight = 0
    private var lastSmoothEncodeAt = 0L
    private var lastImmediateFrameRequestAt = 0L
    private var smoothWebpQualityAdjust = 0
    /** 旧版 Base64 采集复用缓冲 */
    private var reuseBitmapLegacy: Bitmap? = null
    private var reuseScaledLegacy: Bitmap? = null

    /** 与旧版一致：纯 Base64 JSON，走 scheduled 采集 + setCaptureSpeed(low/high) */
    fun isLegacyBase64Capture(): Boolean =
        useBase64JsonMode && !useHardwareH264 && !forceWebpCapture

    override fun onCreate() {
        super.onCreate()
        instance = this
        encodeThread = HandlerThread("ScreenEncode").apply { start() }
        encodeHandler = Handler(encodeThread!!.looper)
        registerScreenReceiver()
    }

    private fun updateNetworkLocks() {
        if (!capturePaused) {
            acquireNetworkLocks()
        } else {
            releaseNetworkLocks()
        }
    }

    private fun acquireNetworkLocks() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (wakeLock == null) {
                wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Accessibility:ScreenCaptureWakeLock")
            }
            if (wakeLock?.isHeld != true) {
                // 为防止释放版被系统深度休眠，开启永久唤醒锁（直到服务销毁或手动暂停）
                wakeLock?.acquire()
                Log.d(TAG, "已获取基础唤醒锁 (Partial WakeLock)")
            }

            // 高性能模式下额外开启 WiFi 锁
            if (captureMode == CaptureMode.MANUAL_HIGH) {
                if (wifiLock?.isHeld != true) {
                    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
                    wifiLock = wm?.createWifiLock(
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                            android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
                        else
                            @Suppress("DEPRECATION") android.net.wifi.WifiManager.WIFI_MODE_FULL,
                        "Accessibility:WifiLock"
                    )
                    wifiLock?.acquire()
                    Log.d(TAG, "高帧模式：已开启 WiFi 高性能锁")
                }
            } else {
                if (wifiLock?.isHeld == true) {
                    wifiLock?.release()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "获取唤醒锁失败: ${e.message}")
        }
    }

    private fun releaseNetworkLocks() {
        try {
            if (wifiLock?.isHeld == true) {
                wifiLock?.release()
                Log.d(TAG, "已释放 WiFi 高性能锁")
            }
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release locks: ${e.message}")
        }
    }

    private fun registerScreenReceiver() {
        val filter = android.content.IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        registerReceiver(screenReceiver, filter)
    }

    private val screenReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    Log.i(TAG, "Screen OFF - 暂停采集与高性能锁")
                    if (!capturePaused) {
                        pausedByScreenOff = true
                        pauseCapture()
                    }
                    releaseNetworkLocks()
                }
                Intent.ACTION_USER_PRESENT, Intent.ACTION_SCREEN_ON -> {
                    Log.d(TAG, "Screen ON/User Present - verifying projection & WS")
                    pausedByScreenOff = false
                    checkAndReconstructVirtualDisplay()
                    handler.postDelayed({
                        webSocketClient?.reconnectIfNeeded()
                    }, 800)
                }
            }
        }
    }

    private fun checkAndReconstructVirtualDisplay() {
        if (isReconstructing) return
        if (virtualDisplay == null || mediaProjection == null) {
            Log.w(TAG, "VirtualDisplay or MediaProjection is null, attempting reconstruction")
            reconstructProjection()
        }
    }

    private fun reconstructProjection() {
        if (lastResultData == null) return
        isReconstructing = true
        handler.postDelayed({
            try {
                Log.i(TAG, "Reconstructing MediaProjection and VirtualDisplay...")
                initScreenCapture()
                Log.i(TAG, "Reconstruction successful")
            } catch (e: Exception) {
                Log.e(TAG, "Reconstruction failed: ${e.message}")
            } finally {
                isReconstructing = false
            }
        }, 1000)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY

        // 诊断电池优化状态
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val isIgnoring = pm?.isIgnoringBatteryOptimizations(packageName) == true
        Log.i(TAG, "ScreenCaptureService onStartCommand - Ignoring Battery Optimizations: $isIgnoring")

        try {
            startForegroundNotification()
        } catch (e: Exception) {
            Log.e(TAG, "启动前台通知失败: ${e.message}")
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "ScreenCapture", "startForegroundNotification failed")
            stopSelf()
            return START_NOT_STICKY
        }

        val resultCode = intent.getIntExtra("resultCode", 0)
        val data = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra("data", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Intent>("data")
        }
        
        if (resultCode == Activity.RESULT_OK && data != null) {
            lastResultCode = resultCode
            lastResultData = data
        }

        deviceId = intent.getStringExtra("deviceId")
        wsUrl = intent.getStringExtra("wsUrl")
        wsToken = intent.getStringExtra("token")
        intent.getStringExtra("wsUsername")?.trim()?.takeIf { it.isNotEmpty() }?.let { username ->
            com.wanghaonetcn.Accessibility.myclass.MyApplication.myUtils?.wsUsername = username
            Log.i(TAG, "使用后台账号连接 WS: $username")
        }

        if (mediaProjection != null) {
            Log.i(TAG, "投屏服务已在运行，跳过重复 MediaProjection 授权")
            webSocketClient?.reconnectIfNeeded()
            return START_REDELIVER_INTENT
        }

        if (resultCode != Activity.RESULT_OK || data == null) {
            Log.e(TAG, "未携带有效的录屏授权数据 (resultCode: $resultCode)")
            stopSelf()
            return START_NOT_STICKY
        }

        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager

        try {
            mediaProjection = mpm?.getMediaProjection(resultCode, data)

            if (mediaProjection != null) {
                mediaProjection?.registerCallback(object : MediaProjection.Callback() {
                    override fun onStop() {
                        val msg = "MediaProjection 会话已停止 (原因可能包括: 用户手动停止、系统强制回收、或前台服务类型不匹配)"
                        Log.w(TAG, msg)
                        com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(Exception(msg), "ScreenCapture", "CurrentProfile: $currentProfileName, Mode: $captureMode")
                        handler.post {
                            Toast.makeText(applicationContext, "投屏会话已停止，请重新开启", Toast.LENGTH_LONG).show()
                        }
                        stopSelf()
                    }
                }, Handler(Looper.getMainLooper()))

                initScreenCapture()
                updateNetworkLocks() // 启动时立即获取唤醒锁
                
                // Android 14 增强：如果已有录音权限，启动时就预热音频采集，避免中途开启导致 Session 撤销
                if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    handler.postDelayed({ 
                        if (mediaProjection != null) {
                            Log.i(TAG, "Android 14 预热音频采集...")
                            startAudioCapture() 
                        }
                    }, 500)
                }

                webSocketClient = DeviceWebSocketClient(this, deviceId ?: "")
                webSocketClient?.connect(wsUrl ?: "", wsToken ?: "")
                if (useBase64JsonMode) {
                    applyLegacyBase64Speed(true)
                } else {
                    startCaptureTask(CaptureProfile.MEDIUM.intervalMs)
                }
            } else {
                val msg = "获取 MediaProjection 实例失败: 返回为 null"
                Log.e(TAG, msg)
                com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(Exception(msg), "ScreenCapture")
                stopSelf()
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "MediaProjection 权限异常 (Android 14 严限时序): ${e.message}")
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "ScreenCapture", "SecurityException on getMediaProjection")
            stopSelf()
        } catch (e: Exception) {
            Log.e(TAG, "MediaProjection 启动异常: ${e.message}")
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "ScreenCapture", "General projection start exception")
            stopSelf()
        }

        return START_REDELIVER_INTENT
    }

    private fun startForegroundNotification() {
        val channelId = "screen_capture_channel"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.createNotificationChannel(NotificationChannel(channelId, "屏幕传输", NotificationManager.IMPORTANCE_LOW))
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) 
            Notification.Builder(this, channelId) else Notification.Builder(this)
        
        val notificationBuilder = builder.setContentTitle("投屏已启动")
            .setContentText("正在实时同步画面与音频...")
            .setSmallIcon(R.drawable.app)
            .setOngoing(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            notificationBuilder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        
        val notification = notificationBuilder.build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            try {
                startForeground(NOTIFICATION_ID, notification, type)
            } catch (e: Exception) {
                Log.e(TAG, "startForeground 失败: ${e.message}")
                // 回退到普通类型
                startForeground(NOTIFICATION_ID, notification)
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    fun updateUploadSpeed(highSpeed: Boolean) {
        if (isLegacyBase64Capture()) {
            applyLegacyBase64Speed(highSpeed)
            return
        }
        capturePaused = false
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        consecutiveStaticFrames = 0
        isCaptureIntervalIdle = false
        handler.removeCallbacks(resetProfileRunnable)
        if (highSpeed) {
            if (captureMode == CaptureMode.MANUAL_HIGH &&
                currentProfileName == "high" &&
                useHardwareH264
            ) {
                updateNetworkLocks()
                scheduleH264StartupKeyframes()
                Log.i(TAG, "已在 high + H.264，跳过重复 setCaptureSpeed")
                return
            }
            captureMode = CaptureMode.MANUAL_HIGH
            applyCaptureProfile("high", fromAuto = false)
            if (forceWebpCapture) {
                handler.post { applyHttpWebpHighTuning() }
            }
        } else {
            captureMode = CaptureMode.AUTO
            useHardwareH264 = false
            applyCaptureProfile("low", fromAuto = false)
        }
        updateNetworkLocks()
    }

    /** 列表页可见区缩略图：低频小图，不参与网络自适应升档 */
    fun applyListThumbCapture() {
        capturePaused = false
        captureMode = CaptureMode.AUTO
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        consecutiveStaticFrames = 0
        isCaptureIntervalIdle = false
        handler.removeCallbacks(resetProfileRunnable)
        useHardwareH264 = false
        applyCaptureProfile("thumb", fromAuto = false)
        updateNetworkLocks()
    }

    /** 控制页「流畅」：固定 WebP，帧率略低但保持较高分辨率 */
    fun applySmoothCapture() {
        capturePaused = false
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        consecutiveStaticFrames = 0
        isCaptureIntervalIdle = false
        handler.removeCallbacks(resetProfileRunnable)
        forceWebpCapture = true
        captureMode = CaptureMode.MANUAL_SMOOTH
        if (currentProfileName == "smooth" && !useHardwareH264) {
            activeCaptureIntervalMs = CaptureProfile.SMOOTH.intervalMs
            currentCaptureInterval = activeCaptureIntervalMs
            targetScaleWidth = CaptureProfile.SMOOTH.scaleWidth
            jpegQuality = CaptureProfile.SMOOTH.jpegQuality
            startCaptureTask(activeCaptureIntervalMs)
            updateNetworkLocks()
            requestImmediateFrameDebounced()
            StreamDiag.log(
                "已在 smooth + WebP，间隔=${activeCaptureIntervalMs}ms surface=${captureSurfaceWidth}px"
            )
            return
        }
        smoothWebpQualityAdjust = 0
        useHardwareH264 = false
        applyCaptureProfile("smooth", fromAuto = false)
        updateNetworkLocks()
    }

    /**
     * 应用采集档位。fromAuto=true 时仅在 AUTO 模式下生效（全屏 MANUAL_HIGH 时不覆盖）
     */
    fun applyCaptureProfile(name: String, fromAuto: Boolean = true) {
        if (capturePaused) return
        if (fromAuto && captureMode != CaptureMode.AUTO) return

        val profile = CaptureProfile.fromName(name) ?: return
        if (
            !fromAuto &&
            captureMode == CaptureMode.MANUAL_SMOOTH &&
            profile.name !in setOf("smooth", "high")
        ) {
            StreamDiag.warn("ignore profile ${profile.name} (MANUAL_SMOOTH)")
            return
        }
        if (
            !fromAuto &&
            captureMode == CaptureMode.MANUAL_HIGH &&
            profile.name in setOf("thumb", "low", "medium")
        ) {
            StreamDiag.warn("ignore profile ${profile.name} (MANUAL_HIGH)")
            return
        }
        val wantH264 = shouldUseHardwareH264(profile.name)
        if (fromAuto && profile.name == currentProfileName && wantH264 == useHardwareH264) return
        if (!fromAuto &&
            profile.name == currentProfileName &&
            wantH264 == useHardwareH264
        ) {
            if (!useHardwareH264) {
                startCaptureTask(activeCaptureIntervalMs)
            } else {
                scheduleH264StartupKeyframes()
            }
            return
        }

        val prevProfile = currentProfileName
        currentProfileName = profile.name
        activeCaptureIntervalMs = profile.intervalMs
        currentCaptureInterval = activeCaptureIntervalMs
        StreamDiag.profileChange(
            prevProfile,
            profile.name,
            captureMode.name,
            useHardwareH264,
            if (fromAuto) "server/auto" else "control"
        )
        targetScaleWidth = profile.scaleWidth
        jpegQuality = profile.jpegQuality
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        consecutiveStaticFrames = 0
        isCaptureIntervalIdle = false

        if (wantH264 != useHardwareH264) {
            useHardwareH264 = wantH264
            updateNetworkLocks()
            Log.i(
                TAG,
                "采集档位 → ${profile.name}，切换管线 h264=$useHardwareH264"
            )
            handler.post { rebuildCapturePipeline() }
            return
        }

        if (!useHardwareH264) {
            startCaptureTask(activeCaptureIntervalMs)
        } else {
            startH264CaptureLoop()
        }
        updateNetworkLocks()
        Log.i(
            TAG,
            "采集档位 → ${profile.name} (${profile.scaleWidth}px q${profile.jpegQuality} ${profile.intervalMs}ms) " +
                "h264=$useHardwareH264 auto=$fromAuto mode=$captureMode surface=${captureSurfaceWidth}px"
        )
    }

    private fun shouldUseHardwareH264(profileName: String): Boolean {
        if (forceWebpCapture) return false
        if (useBase64JsonMode) return false
        return profileName == "high" && captureMode == CaptureMode.MANUAL_HIGH
    }

    private fun effectiveWebpScaleWidth(base: Int): Int {
        if (useHardwareH264) return base
        if (captureMode == CaptureMode.MANUAL_SMOOTH || currentProfileName == "smooth") {
            return minOf(base, WEBP_SMOOTH_MAX_WIDTH)
        }
        if (forceWebpCapture && captureMode == CaptureMode.MANUAL_HIGH) {
            return minOf(base, WEBP_HTTP_HIGH_MAX_WIDTH)
        }
        if (forceWebpCapture) return minOf(base, WEBP_WAN_MAX_WIDTH)
        if (captureMode == CaptureMode.MANUAL_HIGH) {
            return minOf(base, WEBP_CONTROL_MAX_WIDTH)
        }
        return base
    }

    private fun effectiveWebpQuality(base: Int): Int {
        if (useHardwareH264) return base
        if (captureMode == CaptureMode.MANUAL_SMOOTH || currentProfileName == "smooth") {
            return minOf(base, WEBP_SMOOTH_QUALITY)
        }
        if (forceWebpCapture && captureMode == CaptureMode.MANUAL_HIGH) {
            return minOf(base, WEBP_HTTP_HIGH_QUALITY)
        }
        if (forceWebpCapture) return minOf(base, WEBP_WAN_QUALITY)
        if (captureMode == CaptureMode.MANUAL_HIGH) {
            return minOf(base, WEBP_CONTROL_QUALITY)
        }
        return base
    }

    /** 控制页声明无法解码 H.264 时改走 WebP */
    fun setForceWebpCapture(force: Boolean) {
        val wasForce = forceWebpCapture
        if (force == wasForce && (!force || !useHardwareH264)) {
            if (force && !capturePaused && !useHardwareH264) {
                requestImmediateFrame(forceKeyframe = false)
            }
            return
        }
        forceWebpCapture = force
        if (force) {
            useBase64JsonMode = false
            useHardwareH264 = false
            stopH264Encoder()
            if (
                currentCaptureInterval >= LEGACY_SPEED_LOW_MS ||
                currentProfileName == "low"
            ) {
                capturePaused = false
                captureMode = CaptureMode.MANUAL_HIGH
                applyCaptureProfile("high", fromAuto = false)
                handler.post { applyHttpWebpHighTuning() }
                Log.i(TAG, "preferWebp → 退出 Base64/low，切 high WebP interval=${activeCaptureIntervalMs}ms")
            }
        }
        Log.i(TAG, "投屏编码偏好 → ${if (force) "WebP（网页无 WebCodecs）" else "按档位自动"}")
        if (force && useHardwareH264) {
            useHardwareH264 = false
            handler.post { rebuildCapturePipeline() }
        } else if (force && !capturePaused) {
            handler.post {
                if (!useHardwareH264) {
                    if (captureMode == CaptureMode.MANUAL_HIGH) {
                        applyHttpWebpHighTuning()
                    }
                    requestImmediateFrame(forceKeyframe = false)
                }
            }
        } else if (!force && currentProfileName == "smooth") {
            requestImmediateFrame(forceKeyframe = false)
        } else if (!force && captureMode == CaptureMode.MANUAL_HIGH && currentProfileName == "high") {
            val want = shouldUseHardwareH264("high")
            if (want != useHardwareH264) {
                useHardwareH264 = want
                handler.post { rebuildCapturePipeline() }
            } else if (!capturePaused) {
                scheduleH264StartupKeyframes()
            }
        }
    }

    /** 旧版 Base64：100ms/512/40 与 4000ms/320/25；high 静止时周期性重发上一帧 */
    private fun applyLegacyBase64Speed(highSpeed: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (!highSpeed) {
            legacyHighPinnedUntil = 0L
            if (
                currentProfileName == "low" &&
                currentCaptureInterval == LEGACY_SPEED_LOW_MS
            ) {
                return
            }
        } else {
            legacyHighPinnedUntil = now + 120_000L
            if (
                currentProfileName == "high" &&
                currentCaptureInterval == LEGACY_SPEED_HIGH_MS &&
                targetScaleWidth == LEGACY_SCALE_HIGH
            ) {
                return
            }
        }
        capturePaused = false
        pausedByScreenOff = false
        captureMode = CaptureMode.AUTO
        useBase64JsonMode = true
        useHardwareH264 = false
        forceWebpCapture = false
        isCaptureIntervalIdle = false
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        consecutiveStaticFrames = 0
        handler.removeCallbacks(resetProfileRunnable)
        stopH264Encoder()
        if (highSpeed) {
            currentCaptureInterval = LEGACY_SPEED_HIGH_MS
            activeCaptureIntervalMs = LEGACY_SPEED_HIGH_MS
            targetScaleWidth = LEGACY_SCALE_HIGH
            jpegQuality = LEGACY_JPEG_Q_HIGH
            currentProfileName = "high"
        } else {
            currentCaptureInterval = LEGACY_SPEED_LOW_MS
            activeCaptureIntervalMs = LEGACY_SPEED_LOW_MS
            targetScaleWidth = LEGACY_SCALE_LOW
            jpegQuality = LEGACY_JPEG_Q_LOW
            currentProfileName = "low"
        }
        startCaptureTask(currentCaptureInterval)
        updateNetworkLocks()
        Log.i(
            TAG,
            "Legacy Base64 档位=${currentProfileName} interval=${currentCaptureInterval}ms scale=$targetScaleWidth q=$jpegQuality"
        )
    }

    /** 切换编码模式：base64 / webp / h264 */
    fun setCodecMode(mode: String) {
        when (mode.lowercase()) {
            "base64" -> {
                useBase64JsonMode = true
                forceWebpCapture = false
                useHardwareH264 = false
                stopH264Encoder()
                val highSpeed =
                    captureMode == CaptureMode.MANUAL_HIGH ||
                        captureMode == CaptureMode.MANUAL_SMOOTH ||
                        currentProfileName == "high"
                if (highSpeed) {
                    currentCaptureInterval = LEGACY_SPEED_HIGH_MS
                    activeCaptureIntervalMs = LEGACY_SPEED_HIGH_MS
                    targetScaleWidth = LEGACY_SCALE_HIGH
                    jpegQuality = LEGACY_JPEG_Q_HIGH
                    currentProfileName = "high"
                    legacyHighPinnedUntil = SystemClock.elapsedRealtime() + 120_000L
                } else {
                    currentCaptureInterval = LEGACY_SPEED_LOW_MS
                    activeCaptureIntervalMs = LEGACY_SPEED_LOW_MS
                    targetScaleWidth = LEGACY_SCALE_LOW
                    jpegQuality = LEGACY_JPEG_Q_LOW
                    currentProfileName = "low"
                }
                captureMode = CaptureMode.AUTO
                lastFrameSignature = 0
                lastBitmapQuickSignature = 0
                consecutiveStaticFrames = 0
                isCaptureIntervalIdle = false
                Log.i(
                    TAG,
                    "编码模式 → Base64 JSON interval=${currentCaptureInterval}ms " +
                        "scale=$targetScaleWidth q=$jpegQuality"
                )
                handler.post { rebuildCapturePipeline() }
            }
            "webp" -> {
                useBase64JsonMode = false
                forceWebpCapture = true
                useHardwareH264 = false
                Log.i(TAG, "编码模式 → WebP 二进制")
                handler.post { rebuildCapturePipeline() }
            }
            "h264" -> {
                useBase64JsonMode = false
                forceWebpCapture = false
                Log.i(TAG, "编码模式 → H.264 硬编码")
                handler.post { rebuildCapturePipeline() }
            }
        }
    }

    /** 服务端 pong 建议（带连续两次相同才切换，防抖） */
    fun onServerCaptureProfileSuggestion(profileName: String) {
        if (profileName.isEmpty()) return
        if (isLegacyBase64Capture()) return

        if (captureMode == CaptureMode.MANUAL_SMOOTH) {
            StreamDiag.log(
                "ignore pong profile=$profileName (MANUAL_SMOOTH, current=$currentProfileName)"
            )
            return
        }

        if (profileName == lastServerProfileSuggestion) {
            serverSuggestionStreak++
        } else {
            lastServerProfileSuggestion = profileName
            serverSuggestionStreak = 1
        }

        // 服务端无控制观众时会连续建议 low/idle：退出 MANUAL_HIGH
        if (profileName == "low" || profileName == "idle") {
            if (serverSuggestionStreak >= 2) {
                if (captureMode == CaptureMode.MANUAL_HIGH) {
                    updateUploadSpeed(false)
                } else if (captureMode == CaptureMode.AUTO && currentProfileName != "low") {
                    applyCaptureProfile("low", fromAuto = true)
                }
            }
            return
        }
        // thumb 仅由服务端 setCaptureProfile 指令下发（列表缩略图），勿跟 pong 自动切
        if (profileName == "thumb") {
            StreamDiag.log(
                "ignore pong thumb (current=$currentProfileName mode=$captureMode)"
            )
            return
        }
        // MANUAL_HIGH / MANUAL_SMOOTH：忽略 medium/high 建议
        if (captureMode != CaptureMode.AUTO) {
            StreamDiag.log("ignore pong profile=$profileName mode=$captureMode")
            return
        }
        if (currentProfileName == "thumb") return
        if (serverSuggestionStreak >= 2 && profileName != currentProfileName) {
            applyCaptureProfile(profileName, fromAuto = true)
        }
    }

    /**
     * 交互感知加速：收到控制指令时临时提升帧率，提升响应灵敏度
     */
    /** 用户操作后强制下一帧上传，并尽量拉高采集（高帧模式下也生效） */
    fun notifyUserInteraction() {
        if (capturePaused) return
        if (isLegacyBase64Capture()) {
            lastFrameSignature = 0
            interactionBoostUntil = SystemClock.elapsedRealtime() + INTERACTION_BOOST_MS
            lastLegacyStaticResendAt = 0L
            // 仅抓一帧新图，勿连发/勿重复 applyLegacy（否则网页双缓冲连闪）
            postCaptureFrame()
            return
        }
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        consecutiveStaticFrames = 0
        interactionBoostUntil = SystemClock.elapsedRealtime() + INTERACTION_BOOST_MS
        lastStaticResendAt = 0L
        synchronized(frameSendLock) {
            pendingH264Video = null
        }
        resumeActiveCaptureInterval()
        // 立刻推送上一帧，滑动动画期间 ImageReader 常无新图，避免网页等 800ms 才重发
        lastEncodedFrame?.let { cached ->
            sendFrame(cached)
        }
        if (captureMode == CaptureMode.MANUAL_SMOOTH) {
            requestImmediateFrame(forceKeyframe = false)
            schedulePostInteractionFrames()
            return
        }
        requestImmediateFrame(forceKeyframe = false)
        schedulePostInteractionFrames()
        if (captureMode == CaptureMode.MANUAL_HIGH) return
        boostFps()
    }

    /** 在采集线程抓帧，避免在主线程做 ImageReader/Bitmap 阻塞无障碍手势 */
    private fun postCaptureFrame() {
        if (useHardwareH264 || capturePaused) return
        val ex = executor
        if (ex != null && !ex.isShutdown) {
            ex.execute { captureFrame() }
        } else {
            encodeHandler?.post { captureFrame() }
        }
    }

    /** 操作后连抓/连发关键帧，缩短网页画面反馈延迟 */
    private fun schedulePostInteractionFrames() {
        if (useHardwareH264) {
            val delays = longArrayOf(20, 60, 120, 200)
            for (delay in delays) {
                handler.postDelayed({
                    if (!capturePaused && useHardwareH264) {
                        lastH264KeyframeRequestAt = SystemClock.elapsedRealtime()
                        h264Encoder?.requestKeyframe()
                    }
                }, delay)
            }
            return
        }
        val delays =
            if (useBase64JsonMode || isLegacyBase64Capture()) {
                // Base64 JSON 体积大，连发多帧会导致控制页闪屏
                longArrayOf(120, 350)
            } else {
                longArrayOf(15, 50, 100, 180, 320, 520)
            }
        for (delay in delays) {
            handler.postDelayed({
                if (!capturePaused && !useHardwareH264) postCaptureFrame()
            }, delay)
        }
    }

    private fun requestImmediateFrameDebounced(minGapMs: Long = 400L) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastImmediateFrameRequestAt < minGapMs) return
        lastImmediateFrameRequestAt = now
        requestImmediateFrame(forceKeyframe = false)
    }

    /** 控制/滑动后立即抓一帧，避免静止去重导致网页长时间不刷新 */
    fun requestImmediateFrame(forceKeyframe: Boolean = false) {
        lastFrameSignature = 0
        consecutiveStaticFrames = 0
        encodeHandler?.removeCallbacks(encodeDrainRunnable)
        resumeActiveCaptureInterval()
        if (useHardwareH264) {
            val now = SystemClock.elapsedRealtime()
            if (forceKeyframe || now - lastH264KeyframeRequestAt >= H264_KEYFRAME_MIN_INTERVAL_MS) {
                lastH264KeyframeRequestAt = now
                h264Encoder?.requestKeyframe()
            }
        } else {
            postCaptureFrame()
        }
    }

    private fun usesMotionAdaptiveCapture(): Boolean {
        return captureMode == CaptureMode.MANUAL_HIGH ||
            (captureMode == CaptureMode.AUTO && currentProfileName == "high")
    }

    private fun resumeActiveCaptureInterval() {
        if (!usesMotionAdaptiveCapture()) return
        if (!isCaptureIntervalIdle) return
        isCaptureIntervalIdle = false
        consecutiveStaticFrames = 0
        Log.i(TAG, "动静分离 → 活动高帧 ${activeCaptureIntervalMs}ms")
        startCaptureTask(activeCaptureIntervalMs)
    }

    private fun maybeEnterIdleCaptureInterval() {
        if (!usesMotionAdaptiveCapture()) return
        // 控制页全屏：保持高采集间隔，仅跳过重复帧，避免静止时降到 650ms 导致操作后卡顿
        if (captureMode == CaptureMode.MANUAL_HIGH) return
        if (consecutiveStaticFrames < 3) return
        if (isCaptureIntervalIdle) return
        isCaptureIntervalIdle = true
        Log.i(TAG, "动静分离 → 静止省流 ${idleCaptureIntervalMs}ms（重复帧不上传）")
        startCaptureTask(idleCaptureIntervalMs)
    }

    fun boostFps() {
        if (captureMode != CaptureMode.AUTO || capturePaused) return
        if (currentProfileName == "thumb" || currentProfileName == "low") return
        handler.removeCallbacks(resetProfileRunnable)
        applyCaptureProfile("high", fromAuto = true)
        handler.postDelayed(resetProfileRunnable, 3000) // 3秒后恢复
    }

    private val resetProfileRunnable = Runnable {
        applyCaptureProfile("low", fromAuto = true)
    }

    private fun recordSendLatency(ms: Long) {
        if (captureMode != CaptureMode.AUTO) return
        synchronized(sendLatencyLock) {
            sendLatencies.addLast(ms)
            while (sendLatencies.size > 20) sendLatencies.removeFirst()
        }
        if (sendLatencies.size >= 8) {
            evaluateLocalNetworkAdaptive()
        }
    }

    private fun evaluateLocalNetworkAdaptive() {
        if (captureMode != CaptureMode.AUTO || capturePaused) return
        if (currentProfileName == "thumb" || currentProfileName == "low") return
        val avg: Double
        synchronized(sendLatencyLock) {
            if (sendLatencies.size < 8) return
            avg = sendLatencies.average()
        }
        when {
            avg > 450 -> CaptureProfile.stepDown(currentProfileName)?.let {
                applyCaptureProfile(it.name, fromAuto = true)
            }
            avg < 100 && currentProfileName != "high" -> CaptureProfile.stepUp(currentProfileName)?.let {
                applyCaptureProfile(it.name, fromAuto = true)
            }
        }
    }

    private fun cancelLegacyB64Flush() {
        legacyB64FlushRunnable?.let { handler.removeCallbacks(it) }
        legacyB64FlushRunnable = null
        pendingLegacyB64Tx = null
    }

    fun pauseCapture() {
        capturePaused = true
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        captureFuture?.cancel(false)
        stopH264Encoder()
        cancelLegacyB64Flush()
        synchronized(frameSendLock) {
            pendingH264Config = null
            pendingH264Video = null
        }
        lastLegacyBase64Payload = null
        updateNetworkLocks()
        Log.i(TAG, "屏幕采集已暂停")
    }

    fun resumeCapture() {
        capturePaused = false
        pausedByScreenOff = false
        lastFrameSignature = 0
        lastBitmapQuickSignature = 0
        if (isLegacyBase64Capture()) {
            startCaptureTask(currentCaptureInterval)
        } else if (useHardwareH264) {
            rebuildCapturePipeline()
        } else {
            startCaptureTask(currentCaptureInterval)
        }
        updateNetworkLocks()
        Log.i(TAG, "屏幕采集已恢复")
    }

    /** 控制页接入时同步设备播放音频到网页 */
    fun startAudioCapture() {
        val projection = mediaProjection ?: run {
            val msg = "startAudioCapture: MediaProjection 不可用"
            Log.w(TAG, msg)
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(Exception(msg), "AudioCapture")
            return
        }
        val client = webSocketClient ?: return
        val devId = deviceId ?: return
        if (audioCapture?.isRunning() == true) return
        
        Log.i(TAG, "正在启动音频采集...")
        audioCapture = ScreenAudioCapture(this, projection) { pcm, sampleRate, channels ->
            client.sendAudioPcm(pcm, sampleRate, channels, devId)
        }
        try {
            if (!audioCapture!!.start()) {
                Log.e(TAG, "音频采集启动返回失败")
                audioCapture = null
            }
        } catch (e: Exception) {
            Log.e(TAG, "音频采集启动抛出异常: ${e.message}")
            com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "AudioCapture", "Start failed")
            audioCapture = null
        }
    }

    fun stopAudioCapture() {
        audioCapture?.stop()
        audioCapture = null
    }

    /** 屏幕旋转：重建采集并通知服务端更新分辨率 */
    fun getCurrentProfileName(): String = currentProfileName

    fun isManualControlCapture(): Boolean =
        captureMode == CaptureMode.MANUAL_HIGH || captureMode == CaptureMode.MANUAL_SMOOTH

    fun getCaptureModeName(): String = captureMode.name

    /** 供保活广播调用：解锁/网络恢复时尝试恢复 WS */
    fun ensureWsConnected() {
        handler.post { webSocketClient?.reconnectIfNeeded() }
    }

    /** 主页修改后台账号后，用新账号重新 register（更新列表中的绑定账号） */
    fun reconnectWebSocketWithCurrentAccount() {
        handler.post {
            val url = wsUrl ?: return@post
            val token = wsToken ?: return@post
            webSocketClient?.close()
            webSocketClient = DeviceWebSocketClient(this, deviceId ?: "")
            webSocketClient?.connect(url, token)
            MyAccessibilityService.mainFunction?.floatingLog(
                "已切换账号: ${com.wanghaonetcn.Accessibility.myclass.MyApplication.myUtils?.effectiveWsUsername ?: ""}"
            )
        }
    }

    fun onDisplayChanged() {
        lastFrameSignature = 0
        consecutiveStaticFrames = 0
        resumeActiveCaptureInterval()
        handler.post {
            webSocketClient?.sendDisplayUpdate()
            checkAndReconstructVirtualDisplay()
        }
    }

    private fun startCaptureTask(interval: Long) {
        if (capturePaused || instance == null) return
        currentCaptureInterval = interval
        val exec = executor ?: Executors.newScheduledThreadPool(1).also { executor = it }
        if (exec.isShutdown) return
        
        captureFuture?.cancel(false)
        try {
            captureFuture = exec.scheduleWithFixedDelay({ 
                try {
                    captureFrame() 
                } catch (t: Throwable) {
                    Log.e(TAG, "Capture task error: ${t.message}")
                }
            }, 0, interval, TimeUnit.MILLISECONDS)
        } catch (e: RejectedExecutionException) {
            Log.w(TAG, "Task rejected: service might be shutting down")
        }
    }

    private fun rebuildCapturePipeline() {
        if (mediaProjection == null) return
        initScreenCapture()
        if (!capturePaused) {
            if (useHardwareH264) startH264CaptureLoop() else startCaptureTask(currentCaptureInterval)
        }
    }

    private fun bitmapCaptureMaxWidth(): Int {
        if (useHardwareH264) {
            return minOf(CaptureProfile.HIGH.scaleWidth, H264_CONTROL_MAX_WIDTH)
        }
        if (captureMode == CaptureMode.MANUAL_SMOOTH || currentProfileName == "smooth") {
            return SMOOTH_CAPTURE_MAX_WIDTH
        }
        if (forceWebpCapture && captureMode == CaptureMode.MANUAL_HIGH) {
            return HTTP_HIGH_CAPTURE_MAX_WIDTH
        }
        return BITMAP_CAPTURE_MAX_WIDTH
    }

    private fun applyHttpWebpHighTuning() {
        if (!forceWebpCapture || captureMode != CaptureMode.MANUAL_HIGH || useHardwareH264) return
        activeCaptureIntervalMs = HTTP_HIGH_CAPTURE_INTERVAL_MS
        currentCaptureInterval = activeCaptureIntervalMs
        if (!capturePaused) {
            // 勿重建 VirtualDisplay：同一 MediaProjection 二次 createVirtualDisplay 会触发 SecurityException
            startCaptureTask(activeCaptureIntervalMs)
        }
        StreamDiag.log(
            "HTTP WebP 清晰 tuned interval=${activeCaptureIntervalMs}ms surface=${captureSurfaceWidth}px (软件缩放)"
        )
    }

    private fun computeCaptureSize(logicalW: Int, logicalH: Int, maxWidth: Int): Pair<Int, Int> {
        val lw = logicalW.coerceAtLeast(2)
        val lh = logicalH.coerceAtLeast(2)
        val tw = if (lw <= maxWidth) lw else maxWidth
        val th = (lh * tw / lw).coerceAtLeast(2)
        return alignEven(tw) to alignEven(th)
    }

    private fun alignEven(n: Int): Int {
        val v = n.coerceAtLeast(2)
        return if (v % 2 == 0) v else v - 1
    }

    private fun stopH264Encoder() {
        h264Encoder?.stop()
        h264Encoder = null
    }

    private fun startH264CaptureLoop() {
        captureFuture?.cancel(false)
        scheduleH264StartupKeyframes()
    }

    /** VirtualDisplay 就绪后多次请求 IDR（OMX 首帧可能较慢） */
    private fun scheduleH264StartupKeyframes() {
        if (!useHardwareH264) return
        val delays = longArrayOf(0, 40, 100, 200, 450)
        for ((idx, delay) in delays.withIndex()) {
            handler.postDelayed({
                try {
                    lastH264KeyframeRequestAt = SystemClock.elapsedRealtime()
                    h264Encoder?.requestKeyframe()
                    if (idx == 0) Log.i(TAG, "H.264 已请求首帧 IDR (${delay}ms)")
                } catch (_: Exception) {
                }
            }, delay)
        }
    }

    private fun initScreenCapture() {
        synchronized(captureLock) {
            val wm = getSystemService(Context.WINDOW_SERVICE) as? WindowManager
            val metrics = resources.displayMetrics

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val windowMetrics = wm?.maximumWindowMetrics
                screenWidth = windowMetrics?.bounds?.width() ?: 0
                screenHeight = windowMetrics?.bounds?.height() ?: 0
            } else {
                @Suppress("DEPRECATION")
                wm?.defaultDisplay?.getRealMetrics(metrics)
                screenWidth = metrics.widthPixels
                screenHeight = metrics.heightPixels
            }

            if (screenWidth <= 0 || screenHeight <= 0) {
                screenWidth = metrics.widthPixels
                screenHeight = metrics.heightPixels
            }

            val density = if (metrics.densityDpi > 0) metrics.densityDpi else DisplayMetrics.DENSITY_DEFAULT
            val maxW = bitmapCaptureMaxWidth()
            val (capW, capH) = computeCaptureSize(screenWidth, screenHeight, maxW)
            
            // 只有当分辨率或编码模式发生质变时才记录日志
            if (captureSurfaceWidth != capW || captureSurfaceHeight != capH) {
                Log.i(TAG, "配置屏幕采集: ${screenWidth}x${screenHeight} → 缓冲${capW}x${capH} h264=$useHardwareH264")
            }
            
            captureSurfaceWidth = capW
            captureSurfaceHeight = capH

            // 准备新的 Surface，但不立即 release VirtualDisplay
            val displaySurface: Surface? = if (useHardwareH264) {
                stopH264Encoder()
                val encoder = ScreenH264Encoder(capW, capH, H264_BITRATE, H264_FPS) { frameType, data -> sendH264Packet(frameType, data) }
                h264Encoder = encoder
                val surface = encoder.start()
                if (surface == null) {
                    useHardwareH264 = false
                    h264Encoder = null
                    Log.w(TAG, "H.264 启动失败，回退位图采集")
                    prepareImageReaderSurface(capW, capH)
                } else {
                    imageReader?.close()
                    imageReader = null
                    surface
                }
            } else {
                stopH264Encoder()
                prepareImageReaderSurface(capW, capH)
            }

            if (displaySurface != null && mediaProjection != null) {
                try {
                    val currentVD = virtualDisplay
                    if (currentVD != null) {
                        // Android 14 关键优化：复用 VirtualDisplay 实例，仅调整 Surface 和大小
                        // 避免因 release() -> create() 导致的会话撤销
                        currentVD.resize(capW, capH, density)
                        currentVD.surface = displaySurface
                        Log.i(TAG, "已复用并调整 VirtualDisplay 状态")
                    } else {
                        virtualDisplay = mediaProjection?.createVirtualDisplay(
                            "ScreenCapture", capW, capH, density,
                            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                            displaySurface, null, handler
                        )
                    }
                    if (useHardwareH264) {
                        scheduleH264StartupKeyframes()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "VirtualDisplay 操作失败: ${e.message}")
                    com.wanghaonetcn.Accessibility.myclass.CrashReporter.report(e, "ScreenCapture", "VirtualDisplay Op Failed")
                }
            }
            handler.post { webSocketClient?.sendDisplayUpdate() }
        }
    }

    private fun prepareImageReaderSurface(capW: Int, capH: Int): Surface? {
        val currentReader = imageReader
        if (currentReader != null && currentReader.width == capW && currentReader.height == capH) {
            return currentReader.surface
        }
        currentReader?.close()
        imageReader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, IMAGE_READER_MAX_IMAGES, HardwareBuffer.USAGE_CPU_READ_OFTEN)
        } else {
            ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, IMAGE_READER_MAX_IMAGES)
        }
        return imageReader?.surface
    }

    private fun sendH264Packet(frameType: Int, data: ByteArray) {
        val client = webSocketClient ?: return
        if (!client.isOpen() || capturePaused) return
        if (data.isEmpty()) return
        synchronized(frameSendLock) {
            when (frameType) {
                ScreenH264Encoder.FRAME_CONFIG ->
                    pendingH264Config = frameType to data
                else ->
                    pendingH264Video = frameType to data
            }
        }
        // 编码器一次 drain 可能吐出多包，合并为一次 pump，避免网页 rx 暴增
        encodeHandler?.removeCallbacks(h264PumpRunnable)
        encodeHandler?.post(h264PumpRunnable)
    }

    /** 只保留最新 CONFIG/视频，连续入队发送，不再等 onComplete 串联（避免 1～2s 积压） */
    private fun pumpH264Outbound(client: DeviceWebSocketClient) {
        val frameDeviceId = deviceId ?: return
        val config: Pair<Int, ByteArray>?
        val video: Pair<Int, ByteArray>?
        synchronized(frameSendLock) {
            config = pendingH264Config?.also { pendingH264Config = null }
            video = pendingH264Video?.also { pendingH264Video = null }
        }
        if (config == null && video == null) return
        val t0 = SystemClock.elapsedRealtime()
        if (config != null) {
            client.sendH264Frame(config.first, config.second, frameDeviceId, null)
        }
        if (video != null) {
            client.sendH264Frame(video.first, video.second, frameDeviceId, null)
            val ms = SystemClock.elapsedRealtime() - t0
            recordSendLatency(ms)
            StreamDiag.log(
                "h264 tx type=${video.first} bytes=${video.second.size} pumpMs=$ms profile=$currentProfileName"
            )
        }
        synchronized(frameSendLock) {
            if (pendingH264Config != null || pendingH264Video != null) {
                pumpH264Outbound(client)
            }
        }
    }

    /** 采集写入缓冲；交给编码后即置空，下一帧再分配，避免 bitmap.copy() */
    private var writeBitmap: Bitmap? = null
    /** 上一帧的编码结果，用于静止时重发 */
    @Volatile private var lastEncodedFrame: ByteArray? = null
    @Volatile private var lastEncodedOutWidth = 0
    @Volatile private var lastEncodedOutHeight = 0
    private var lastEncodedFrameAt = 0L
    /** 静止时重发间隔（公网保持画面刷新感） */
    private val STATIC_RESEND_INTERVAL_MS = 800L
    /** 用户操作后短时内更密重发/补帧，避免网页端「卡几秒」 */
    private val INTERACTION_BOOST_MS = 2800L
    private val STATIC_RESEND_BOOST_MS = 400L
    @Volatile private var interactionBoostUntil = 0L
    @Volatile private var lastStaticResendAt = 0L
    /** 近期已拉高帧则忽略误发的 low（网页 setCodecMode / 滑动降档等） */
    @Volatile private var legacyHighPinnedUntil = 0L
    @Volatile private var lastLegacyBase64Payload: String? = null
    private var lastLegacyStaticResendAt = 0L
    private var lastLegacyJsonTxAt = 0L
    @Volatile private var pendingLegacyB64Tx: String? = null
    private var legacyB64FlushRunnable: Runnable? = null

    private fun captureFrame() {
        if (capturePaused || useHardwareH264) return
        if (isLegacyBase64Capture()) {
            captureFrameLegacy()
            return
        }
        synchronized(captureLock) {
            val reader = imageReader ?: return
            if (reader.surface?.isValid != true || mediaProjection == null) return
            
            var latestImage: Image? = null
            try {
                while (true) {
                    val img = reader.acquireNextImage() ?: break
                    latestImage?.close()
                    latestImage = img
                }
            } catch (e: Exception) {
                Log.w(TAG, "ImageReader 同步异常 (ion/ioctl): ${e.message}")
                if (e is IllegalStateException) {
                    checkAndReconstructVirtualDisplay()
                }
                latestImage?.close()
                return
            }

            val image = latestImage
            if (image == null) {
                // 画面静止/滑动动画中 ImageReader 无新图：控制模式下重发上一帧
                if ((captureMode == CaptureMode.MANUAL_HIGH || captureMode == CaptureMode.MANUAL_SMOOTH)) {
                    val cached = lastEncodedFrame
                    val now = SystemClock.elapsedRealtime()
                    val inBoost = now < interactionBoostUntil
                    val interval =
                        if (inBoost) STATIC_RESEND_BOOST_MS else STATIC_RESEND_INTERVAL_MS
                    if (cached != null && now - lastStaticResendAt >= interval) {
                        lastStaticResendAt = now
                        sendFrame(cached)
                    }
                }
                return
            }

            try {
                val width = image.width
                val height = image.height
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val bufferWidth = rowStride / pixelStride

                if (writeBitmap == null || writeBitmap!!.width != bufferWidth || writeBitmap!!.height != height) {
                    writeBitmap?.recycle()
                    writeBitmap = Bitmap.createBitmap(bufferWidth, height, Bitmap.Config.ARGB_8888)
                }

                writeBitmap?.copyPixelsFromBuffer(buffer)
                image.close()
                latestImage = null

                val raw = writeBitmap ?: return
                writeBitmap = null
                val toEncode = cropBitmapToImageSize(raw, width, height)
                if (toEncode !== raw) {
                    raw.recycle()
                }
                val quickSig = quickBitmapSignature(toEncode)
                val allowQuickSkip =
                    captureMode != CaptureMode.MANUAL_HIGH &&
                        captureMode != CaptureMode.MANUAL_SMOOTH
                if (allowQuickSkip && !usesMotionAdaptiveCapture() && quickSig == lastBitmapQuickSignature) {
                    toEncode.recycle()
                    return
                }
                lastBitmapQuickSignature = quickSig
                scheduleEncode(toEncode, toEncode.width, toEncode.height, targetScaleWidth, jpegQuality)
            } catch (t: Throwable) {
                Log.e(TAG, "采集处理失败: ${t.message}")
                try {
                    image.close()
                } catch (_: Exception) {
                }
            }
        }
    }

    /**
     * 只保留最新一帧进入编码队列，避免 Handler 积压导致网页显示 2～3 秒前的画面。
     */
    private fun scheduleEncode(
        snapshot: Bitmap,
        logicalWidth: Int,
        logicalHeight: Int,
        scaleWidth: Int,
        quality: Int
    ) {
        val handler = encodeHandler
        if (handler == null) {
            snapshot.recycle()
            return
        }
        synchronized(encodeScheduleLock) {
            pendingEncodeSnapshot?.recycle()
            pendingEncodeSnapshot = snapshot
            pendingLogicalWidth = logicalWidth
            pendingLogicalHeight = logicalHeight
            pendingScaleWidth = scaleWidth
            pendingQuality = quality
        }
        handler.removeCallbacks(encodeDrainRunnable)
        handler.post(encodeDrainRunnable)
    }

    private fun drainPendingEncode() {
        val snapshot: Bitmap?
        val lw: Int
        val lh: Int
        val sw: Int
        val q: Int
        synchronized(encodeScheduleLock) {
            snapshot = pendingEncodeSnapshot
            pendingEncodeSnapshot = null
            lw = pendingLogicalWidth
            lh = pendingLogicalHeight
            sw = pendingScaleWidth
            q = pendingQuality
        }
        if (snapshot == null) return
        try {
            encodeAndSendFrame(
                snapshot,
                lw,
                lh,
                effectiveWebpScaleWidth(sw),
                effectiveWebpQuality(q)
            )
        } finally {
            synchronized(encodeScheduleLock) {
                if (pendingEncodeSnapshot != null) {
                    encodeHandler?.post(encodeDrainRunnable)
                }
            }
        }
    }

    private fun encodeAndSendFrame(
        snapshot: Bitmap,
        logicalWidth: Int,
        logicalHeight: Int,
        scaleWidth: Int,
        quality: Int
    ) {
        if (captureMode == CaptureMode.MANUAL_SMOOTH && !useBase64JsonMode) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastSmoothEncodeAt < 50) {
                snapshot.recycle()
                return
            }
        }
        try {
            var outQuality = quality
            if (captureMode == CaptureMode.MANUAL_SMOOTH && !useBase64JsonMode) {
                outQuality = (quality - smoothWebpQualityAdjust).coerceAtLeast(22)
            }
            val scaledBitmap = scaleBitmapCorrectly(snapshot, logicalWidth, logicalHeight, scaleWidth)
            val bytes: ByteArray
            if (useBase64JsonMode) {
                // Base64 JPEG 模式：使用 jpegQuality 变量（由 setCodecMode 设置为 40）
                val stream = java.io.ByteArrayOutputStream()
                scaledBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, jpegQuality, stream)
                bytes = stream.toByteArray()
            } else {
                val maxBytes = when {
                    captureMode == CaptureMode.MANUAL_SMOOTH -> SMOOTH_WEBP_MAX_BYTES
                    forceWebpCapture && captureMode == CaptureMode.MANUAL_HIGH -> HTTP_HIGH_WEBP_MAX_BYTES
                    else -> Int.MAX_VALUE
                }
                val (compBytes, usedQ) = compressWebpCapped(scaledBitmap, outQuality, maxBytes)
                bytes = compBytes
                outQuality = usedQ
            }
            val outW = scaledBitmap.width
            val outH = scaledBitmap.height
            lastEncodedOutWidth = outW
            lastEncodedOutHeight = outH
            scaledBitmap.recycle()

            val signature = frameSignature(bytes)
            val isDuplicate = signature == lastFrameSignature

            // 控制页（清晰/流畅）：不跳重复帧，避免静止时几乎不上传
            if (captureMode != CaptureMode.MANUAL_HIGH && captureMode != CaptureMode.MANUAL_SMOOTH) {
                if (usesMotionAdaptiveCapture()) {
                    if (isDuplicate) {
                        consecutiveStaticFrames++
                        maybeEnterIdleCaptureInterval()
                        return
                    }
                    consecutiveStaticFrames = 0
                    if (isCaptureIntervalIdle) {
                        isCaptureIntervalIdle = false
                        Log.i(TAG, "动静分离 → 画面变化，恢复 ${activeCaptureIntervalMs}ms")
                        startCaptureTask(activeCaptureIntervalMs)
                    }
                } else if (isDuplicate) {
                    return
                }
            }

            synchronized(frameSendLock) {
                lastFrameSignature = signature
                frameSequence++
            }

            if (captureMode == CaptureMode.MANUAL_SMOOTH) {
                lastSmoothEncodeAt = SystemClock.elapsedRealtime()
                when {
                    bytes.size > 38000 ->
                        smoothWebpQualityAdjust = (smoothWebpQualityAdjust + 1).coerceAtMost(5)
                    bytes.size < 18000 ->
                        smoothWebpQualityAdjust = (smoothWebpQualityAdjust - 1).coerceAtLeast(0)
                }
                if (bytes.size > 50000) {
                    StreamDiag.warn(
                        "smooth 大帧 ${bytes.size}B ${outW}x${outH} q=$outQuality surface=${captureSurfaceWidth}px"
                    )
                }
            }
            StreamDiag.log(
                "encode profile=$currentProfileName ${outW}x${outH} q=$outQuality bytes=${bytes.size} " +
                    "intervalMs=$currentCaptureInterval dup=$isDuplicate"
            )
            sendFrame(bytes)
        } catch (t: Throwable) {
            Log.e(TAG, "编码发送失败: ${t.message}")
        } finally {
            snapshot.recycle()
        }
    }

    private fun quickBitmapSignature(bitmap: Bitmap): Int {
        val w = bitmap.width
        val h = bitmap.height
        if (w < 2 || h < 2) return w xor h
        return bitmap.getPixel(w / 2, h / 2) xor
            bitmap.getPixel(w / 4, h / 4) xor
            bitmap.getPixel(3 * w / 4, h / 4) xor
            bitmap.getPixel(w / 2, 3 * h / 4) xor
            (w shl 16) xor h
    }

    /** 轻量签名：画面静止时跳过重复上传 */
    private fun frameSignature(bytes: ByteArray): Int {
        var h = bytes.size
        val step = maxOf(1, bytes.size / 64)
        var i = 0
        while (i < bytes.size) {
            h = h * 31 + bytes[i].toInt()
            i += step
        }
        return h
    }

    /** ImageReader 行跨度常大于 image.width，必须先裁切再缩放编码 */
    private fun cropBitmapToImageSize(src: Bitmap, imageWidth: Int, imageHeight: Int): Bitmap {
        val cw = imageWidth.coerceIn(1, src.width)
        val ch = imageHeight.coerceIn(1, src.height)
        if (src.width == cw && src.height == ch) return src
        StreamDiag.warn(
            "crop stride bitmap ${src.width}x${src.height} -> ${cw}x${ch}"
        )
        return Bitmap.createBitmap(src, 0, 0, cw, ch)
    }

    private fun webpCompressFormat(): Bitmap.CompressFormat {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Bitmap.CompressFormat.WEBP_LOSSY
        } else {
            @Suppress("DEPRECATION")
            Bitmap.CompressFormat.WEBP
        }
    }

    /**
     * 复杂界面 WebP 体积可能反常偏大，超限时逐步缩小再压。
     * @return bytes to quality used
     */
    private fun compressWebpCapped(
        source: Bitmap,
        initialQuality: Int,
        maxBytes: Int
    ): Pair<ByteArray, Int> {
        var q = initialQuality.coerceIn(5, 100)
        var current = source
        val derived = ArrayList<Bitmap>(2)
        val format = webpCompressFormat()
        try {
            for (attempt in 0..3) {
                val baos = ByteArrayOutputStream()
                current.compress(format, q, baos)
                val bytes = baos.toByteArray()
                if (bytes.size <= maxBytes || attempt == 3) {
                    return bytes to q
                }
                val nw = (current.width * 0.9f).toInt().coerceIn(160, current.width - 1)
                val nh = (current.height * nw / current.width.coerceAtLeast(1)).coerceAtLeast(2)
                val smaller = Bitmap.createScaledBitmap(current, nw, nh, true)
                if (current !== source) {
                    derived.add(current)
                }
                current = smaller
                q = (q - 1).coerceAtLeast(12)
            }
            val baos = ByteArrayOutputStream()
            current.compress(format, q, baos)
            return baos.toByteArray() to q
        } finally {
            for (b in derived) {
                b.recycle()
            }
            if (current !== source) {
                current.recycle()
            }
        }
    }

    private fun scaleBitmapCorrectly(src: Bitmap, logicalWidth: Int, logicalHeight: Int, targetWidth: Int): Bitmap {
        val ratio = targetWidth.toFloat() / logicalWidth
        val targetHeight = (logicalHeight * ratio).toInt().coerceAtLeast(2)
        return Bitmap.createScaledBitmap(src, targetWidth, targetHeight, true)
    }

    /** 旧版 Canvas 缩放（与历史 ScreenCaptureService 一致） */
    private fun scaleBitmapLegacyCanvas(
        src: Bitmap,
        logicalWidth: Int,
        logicalHeight: Int,
        targetWidth: Int
    ): Bitmap {
        val ratio = targetWidth.toFloat() / logicalWidth
        val targetHeight = (logicalHeight * ratio).toInt().coerceAtLeast(2)
        val result = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val srcRect = Rect(0, 0, logicalWidth, logicalHeight)
        val dstRect = Rect(0, 0, targetWidth, targetHeight)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(src, srcRect, dstRect, paint)
        return result
    }

    /** 旧版 Base64：executor 直采 + 静止跳帧 + JSON 合并发送 */
    private fun captureFrameLegacy() {
        if (capturePaused) return
        synchronized(captureLock) {
            val reader = imageReader ?: return
            if (reader.surface?.isValid != true || mediaProjection == null) return

            var latestImage: Image? = null
            try {
                while (true) {
                    val img = reader.acquireNextImage() ?: break
                    latestImage?.close()
                    latestImage = img
                }
            } catch (e: Exception) {
                Log.w(TAG, "Legacy ImageReader 异常: ${e.message}")
                if (e is IllegalStateException) {
                    checkAndReconstructVirtualDisplay()
                }
                latestImage?.close()
                return
            }

            val image = latestImage
            val now = SystemClock.elapsedRealtime()
            val isHigh = currentProfileName == "high"
            if (image == null) {
                if (isHigh) maybeLegacyStaticResend(now)
                return
            }
            try {
                val width = image.width
                val height = image.height
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val bufferWidth = rowStride / pixelStride

                if (
                    reuseBitmapLegacy == null ||
                    reuseBitmapLegacy!!.width != bufferWidth ||
                    reuseBitmapLegacy!!.height != height
                ) {
                    reuseBitmapLegacy?.recycle()
                    reuseBitmapLegacy = Bitmap.createBitmap(bufferWidth, height, Bitmap.Config.ARGB_8888)
                }

                reuseBitmapLegacy?.copyPixelsFromBuffer(buffer)

                val ratio = targetScaleWidth.toFloat() / width
                val targetHeight = (height * ratio).toInt().coerceAtLeast(2)
                if (
                    reuseScaledLegacy == null ||
                    reuseScaledLegacy!!.width != targetScaleWidth ||
                    reuseScaledLegacy!!.height != targetHeight
                ) {
                    reuseScaledLegacy?.recycle()
                    reuseScaledLegacy =
                        Bitmap.createBitmap(targetScaleWidth, targetHeight, Bitmap.Config.ARGB_8888)
                }
                val scaled = reuseScaledLegacy!!
                val canvas = Canvas(scaled)
                val srcRect = Rect(0, 0, width, height)
                val dstRect = Rect(0, 0, targetScaleWidth, targetHeight)
                canvas.drawBitmap(reuseBitmapLegacy!!, srcRect, dstRect, Paint(Paint.FILTER_BITMAP_FLAG))

                val bytes = encodeLegacyJpeg(scaled)

                val signature = frameSignature(bytes)
                if (signature == lastFrameSignature) {
                    return
                }
                lastFrameSignature = signature
                lastEncodedOutWidth = targetScaleWidth
                lastEncodedOutHeight = targetHeight
                sendFrame(bytes)
            } catch (t: Throwable) {
                Log.e(TAG, "Legacy 采集失败: ${t.message}")
            } finally {
                image.close()
            }
        }
    }

    /** 限制单帧 JPEG 体积，避免 Base64 JSON 突增到 40KB+ 导致网页闪屏 */
    private fun encodeLegacyJpeg(scaled: Bitmap): ByteArray {
        var q = jpegQuality.coerceIn(16, 85)
        var last = ByteArray(0)
        repeat(8) {
            val baos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, q, baos)
            last = baos.toByteArray()
            if (last.size <= LEGACY_MAX_JPEG_BYTES) return last
            q = (q - 4).coerceAtLeast(16)
        }
        return last
    }

    private fun maybeLegacyStaticResend(now: Long) {
        val b64 = lastLegacyBase64Payload ?: return
        if (now - lastLegacyStaticResendAt < LEGACY_STATIC_RESEND_MS) return
        lastLegacyStaticResendAt = now
        transmitLegacyBase64Json(b64, "resend")
    }

    private fun transmitLegacyBase64Json(b64: String, reason: String) {
        val client = webSocketClient ?: return
        val frameDeviceId = deviceId ?: return
        if (!client.isOpen()) return
        val now = SystemClock.elapsedRealtime()
        val boost = now < interactionBoostUntil
        val minGap = if (boost) 150L else LEGACY_MIN_JSON_TX_MS
        pendingLegacyB64Tx = b64
        if (now - lastLegacyJsonTxAt < minGap) {
            if (legacyB64FlushRunnable != null) return
            val delay = minGap - (now - lastLegacyJsonTxAt)
            legacyB64FlushRunnable = Runnable {
                legacyB64FlushRunnable = null
                val payload = pendingLegacyB64Tx ?: return@Runnable
                pendingLegacyB64Tx = null
                flushLegacyBase64Json(payload, reason)
            }
            handler.postDelayed(legacyB64FlushRunnable!!, delay.coerceAtLeast(16L))
            return
        }
        flushLegacyBase64Json(b64, reason)
    }

    private fun flushLegacyBase64Json(b64: String, reason: String) {
        val client = webSocketClient ?: return
        val frameDeviceId = deviceId ?: return
        if (!client.isOpen()) return
        lastLegacyJsonTxAt = SystemClock.elapsedRealtime()
        val t0 = lastLegacyJsonTxAt
        client.sendJsonFrame(b64, frameDeviceId) {
            val ms = SystemClock.elapsedRealtime() - t0
            recordSendLatency(ms)
            StreamDiag.log(
                "base64 $reason ${b64.length}B profile=$currentProfileName interval=${currentCaptureInterval}ms sendMs=$ms"
            )
        }
    }

    /**
     * 获取截图专用：从 ImageReader / 采集缓冲取当前最大分辨率帧（非 WebP 640 输出）。
     */
    fun snapshotFullForScreenshot(): InspectorFrame? {
        synchronized(captureLock) {
            acquireLatestBitmapFromReader()?.let { bmp ->
                try {
                    return bitmapToInspectorFrame(bmp, 92)
                } finally {
                    bmp.recycle()
                }
            }
            val legacy = reuseBitmapLegacy
            if (legacy != null && !legacy.isRecycled && legacy.width > 0 && legacy.height > 0) {
                val copy = legacy.copy(Bitmap.Config.ARGB_8888, false)
                if (copy != null) {
                    try {
                        return bitmapToInspectorFrame(copy, 92)
                    } finally {
                        copy.recycle()
                    }
                }
            }
        }
        synchronized(encodeScheduleLock) {
            val pending = pendingEncodeSnapshot
            if (pending != null && !pending.isRecycled && pending.width > 0 && pending.height > 0) {
                val copy = pending.copy(Bitmap.Config.ARGB_8888, false)
                if (copy != null) {
                    try {
                        return bitmapToInspectorFrame(copy, 92)
                    } finally {
                        copy.recycle()
                    }
                }
            }
        }
        return null
    }

    private fun bitmapToInspectorFrame(bmp: Bitmap, quality: Int): InspectorFrame? {
        val stream = java.io.ByteArrayOutputStream()
        bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality.coerceIn(70, 100), stream)
        val bytes = stream.toByteArray()
        if (bytes.isEmpty()) return null
        return InspectorFrame(
            android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
            bmp.width,
            bmp.height
        )
    }

    private fun acquireLatestBitmapFromReader(reader: ImageReader? = imageReader): Bitmap? {
        if (reader == null) return null
        if (reader.surface?.isValid != true || mediaProjection == null) return null
        var latestImage: Image? = null
        try {
            while (true) {
                val img = reader.acquireNextImage() ?: break
                latestImage?.close()
                latestImage = img
            }
            val image = latestImage ?: return null
            try {
                val width = image.width
                val height = image.height
                val planes = image.planes
                val buffer = planes[0].buffer
                val pixelStride = planes[0].pixelStride
                val rowStride = planes[0].rowStride
                val bufferWidth = rowStride / pixelStride
                val raw = Bitmap.createBitmap(bufferWidth, height, Bitmap.Config.ARGB_8888)
                raw.copyPixelsFromBuffer(buffer)
                val cropped = cropBitmapToImageSize(raw, width, height)
                if (cropped !== raw) raw.recycle()
                return cropped
            } finally {
                image.close()
            }
        } catch (e: Exception) {
            Log.w(TAG, "snapshotFull acquire 失败: ${e.message}")
            latestImage?.close()
            return null
        }
    }

    /**
     * 临时以逻辑屏分辨率抓一帧（用于「获取截图」全分辨率，投屏缓冲仅 960 宽不够时使用）。
     * 会短暂中断投屏约 0.5s，完成后自动恢复。
     */
    fun captureOneFrameAtLogicalSize(onDone: (InspectorFrame?) -> Unit) {
        handler.post {
            val restore = CaptureRestoreState()
            synchronized(captureLock) {
                val projection = mediaProjection
                if (projection == null || screenWidth <= 0 || screenHeight <= 0) {
                    handler.post { onDone(null) }
                    return@post
                }
                restore.wasPaused = capturePaused
                restore.wasH264 = useHardwareH264
                restore.interval = currentCaptureInterval
                captureFuture?.cancel(false)
                capturePaused = true
                releaseCaptureSurfacesOnly()

                val (capW, capH) = computeCaptureSize(screenWidth, screenHeight, screenWidth)
                val density = resources.displayMetrics.densityDpi
                    .coerceAtLeast(DisplayMetrics.DENSITY_DEFAULT)
                Log.i(TAG, "逻辑全分辨率截图: ${screenWidth}x${screenHeight} → 缓冲${capW}x${capH}")

                var snapReader: ImageReader? = null
                var snapDisplay: VirtualDisplay? = null
                try {
                    snapReader = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ImageReader.newInstance(
                            capW,
                            capH,
                            PixelFormat.RGBA_8888,
                            IMAGE_READER_MAX_IMAGES,
                            HardwareBuffer.USAGE_CPU_READ_OFTEN
                        )
                    } else {
                        ImageReader.newInstance(
                            capW,
                            capH,
                            PixelFormat.RGBA_8888,
                            IMAGE_READER_MAX_IMAGES
                        )
                    }
                    val surface = snapReader.surface
                    snapDisplay = projection.createVirtualDisplay(
                        "FullLogicalSnap",
                        capW,
                        capH,
                        density,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                        surface,
                        null,
                        handler
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "逻辑全分辨率 VirtualDisplay 失败: ${e.message}")
                    restoreCapturePipeline(restore)
                    handler.post { onDone(null) }
                    return@post
                }

                val readerRef = snapReader
                val displayRef = snapDisplay
                handler.postDelayed({
                    var frame: InspectorFrame? = null
                    try {
                        val bmp = acquireLatestBitmapFromReader(readerRef)
                        if (bmp != null) {
                            try {
                                frame = bitmapToInspectorFrame(bmp, 92)
                            } finally {
                                bmp.recycle()
                            }
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "逻辑全分辨率读帧失败: ${e.message}")
                    }
                    try {
                        displayRef?.release()
                        readerRef?.close()
                    } catch (_: Exception) {
                    }
                    restoreCapturePipeline(restore)
                    Log.i(
                        TAG,
                        "逻辑全分辨率截图完成 ${frame?.width ?: 0}x${frame?.height ?: 0}"
                    )
                    onDone(frame)
                }, 450)
            }
        }
    }

    private fun releaseCaptureSurfacesOnly() {
        try {
            virtualDisplay?.surface = null
            virtualDisplay?.release()
        } catch (_: Exception) {
        }
        virtualDisplay = null
        try {
            imageReader?.setOnImageAvailableListener(null, null)
            imageReader?.close()
        } catch (_: Exception) {
        }
        imageReader = null
        stopH264Encoder()
    }

    private fun restoreCapturePipeline(restore: CaptureRestoreState) {
        synchronized(captureLock) {
            useHardwareH264 = restore.wasH264
            initScreenCapture()
            capturePaused = restore.wasPaused
            if (!capturePaused) {
                if (useHardwareH264) {
                    startH264CaptureLoop()
                } else {
                    startCaptureTask(restore.interval)
                }
            }
        }
    }

    /**
     * UI 节点查看器截图：优先用 Legacy 缩放缓冲（与当前投屏一致），否则用最近编码帧。
     */
    fun snapshotForUiInspector(): InspectorFrame? {
        synchronized(captureLock) {
            val scaled = reuseScaledLegacy
            if (scaled != null && !scaled.isRecycled && scaled.width > 0 && scaled.height > 0) {
                val stream = java.io.ByteArrayOutputStream()
                scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 78, stream)
                val bytes = stream.toByteArray()
                if (bytes.isNotEmpty()) {
                    return InspectorFrame(
                        android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
                        scaled.width,
                        scaled.height
                    )
                }
            }
        }
        val bytes = lastEncodedFrame
        if (bytes != null && bytes.isNotEmpty()) {
            var w = lastEncodedOutWidth
            var h = lastEncodedOutHeight
            if (w <= 0 || h <= 0) {
                w = targetScaleWidth
                h = if (screenWidth > 0 && screenHeight > 0) {
                    (screenHeight * w / screenWidth).coerceAtLeast(1)
                } else {
                    0
                }
            }
            if (w > 0 && h > 0) {
                return InspectorFrame(
                    android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
                    w,
                    h
                )
            }
        }
        val legacyB64 = lastLegacyBase64Payload
        if (!legacyB64.isNullOrEmpty() && targetScaleWidth > 0) {
            val w = targetScaleWidth
            val h = if (screenWidth > 0 && screenHeight > 0) {
                (screenHeight * w / screenWidth).coerceAtLeast(1)
            } else {
                w
            }
            return InspectorFrame(legacyB64, w, h)
        }
        return null
    }

    /** WebP/Base64：发送最新帧 */
    private fun sendFrame(jpegBytes: ByteArray) {
        val client = webSocketClient ?: return
        val frameDeviceId = deviceId ?: return
        if (!client.isOpen()) return
        lastEncodedFrame = jpegBytes
        lastEncodedFrameAt = SystemClock.elapsedRealtime()

        if (useBase64JsonMode) {
            val b64 = android.util.Base64.encodeToString(jpegBytes, android.util.Base64.NO_WRAP)
            lastLegacyBase64Payload = b64
            transmitLegacyBase64Json(b64, "tx")
            return
        }

        client.sendBinaryFrame(jpegBytes, frameDeviceId, onComplete = {
            val ms = SystemClock.elapsedRealtime()
            recordSendLatency(ms)
            StreamDiag.log(
                "webp tx ${jpegBytes.size}B profile=$currentProfileName interval=${currentCaptureInterval}ms sendMs=$ms"
            )
        })
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        cancelLegacyB64Flush()
        captureFuture?.cancel(true)
        executor?.shutdownNow()
        executor = null
        encodeThread?.quitSafely()
        encodeThread = null
        encodeHandler = null
        
        synchronized(captureLock) {
            virtualDisplay?.release()
            virtualDisplay = null
            imageReader?.close()
            imageReader = null
            stopH264Encoder()
            stopAudioCapture()
            mediaProjection?.stop()
            mediaProjection = null
        }

        webSocketClient?.close()

        try {
            unregisterReceiver(screenReceiver)
            releaseNetworkLocks()
        } catch (e: Exception) {}
        
        writeBitmap?.recycle()
        writeBitmap = null
        reuseBitmapLegacy?.recycle()
        reuseBitmapLegacy = null
        reuseScaledLegacy?.recycle()
        reuseScaledLegacy = null
        lastLegacyBase64Payload = null
        lastEncodedFrame = null
        synchronized(encodeScheduleLock) {
            pendingEncodeSnapshot?.recycle()
            pendingEncodeSnapshot = null
        }
        encodeHandler?.removeCallbacks(encodeDrainRunnable)
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
