package com.wanghaonetcn.Accessibility.myfunction

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.hardware.HardwareBuffer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * 指令执行器：将从服务器收到的 JSON 指令转换为 Android 系统无障碍操作或信息查询
 */
object ControlExecutor {
    private const val TAG = "ControlExecutor"
    private var accessibilityService: AccessibilityService? = null
    private var appContext: Context? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    @JvmStatic
    fun init(service: AccessibilityService) {
        accessibilityService = service
        appContext = service.applicationContext
        Log.i(TAG, "已绑定无障碍服务: ${service.javaClass.simpleName}")
    }

    @JvmStatic
    fun clear() {
        accessibilityService = null
    }

    /** 优先使用当前存活的无障碍服务实例 */
    private fun resolveService(): AccessibilityService? {
        MyAccessibilityService.instance?.let { return it }
        return accessibilityService
    }

    @JvmStatic
    fun execute(message: JSONObject, client: DeviceWebSocketClient) {
        val type = message.optString("type")
        val interactive =
            type == "click" || type == "swipe" || type == "longClick" ||
                type == "press" || type == "input"
        if (interactive) {
            mainHandler.postAtFrontOfQueue { executeOnMain(message, client) }
        } else {
            mainHandler.post { executeOnMain(message, client) }
        }
    }

    @JvmStatic
    fun execute(message: JSONObject) {
        val type = message.optString("type")
        val interactive =
            type == "click" || type == "swipe" || type == "longClick" ||
                type == "press" || type == "input"
        val run = Runnable {
            val service = resolveService() ?: return@Runnable
            executeCommonCommand(service, message)
        }
        if (interactive) {
            mainHandler.postAtFrontOfQueue(run)
        } else {
            mainHandler.post(run)
        }
    }

    private fun executeOnMain(message: JSONObject, client: DeviceWebSocketClient) {
        val service = resolveService()
        if (service == null) {
            Log.e(TAG, "无障碍服务未就绪，忽略指令: ${message.optString("type")}")
            sendNodesError(client, "AccessibilityService 未初始化，请在系统设置中开启群控无障碍")
            return
        }

        try {
            val type = message.optString("type")

            // 收到指令，触发投屏加速
            if (type == "click" || type == "swipe" || type == "longClick" || type == "press" || type == "input") {
                ScreenCaptureService.instance?.notifyUserInteraction()
            }

            if ("fetchUiNodes" == type) {
                fetchAndSendUiNodes(service, client)
                return
            }

            if ("fetchScreenshot" == type) {
                fetchAndSendScreenshot(service, client)
                return
            }

            if ("getClipboard" == type) {
                fetchAndSendClipboard(client)
                return
            }

            executeCommonCommand(service, message)
        } catch (e: Exception) {
            Log.e(TAG, "指令执行异常: ${e.message}", e)
            sendNodesError(client, e.message ?: "Unknown error")
        }
    }

    private fun executeCommonCommand(service: AccessibilityService, message: JSONObject) {
        val type = message.optString("type")
        if (type.isEmpty()) {
            Log.w(TAG, "控制指令缺少 type 字段: $message")
            return
        }
        try {
            when (type) {
                "click" -> click(service, message.getInt("x"), message.getInt("y"))
                "press", "longClick" -> longClick(service, message.getInt("x"), message.getInt("y"), message.optInt("duration", 1000))
                "swipe" -> swipe(service, message.getInt("x1"), message.getInt("y1"),
                    message.getInt("x2"), message.getInt("y2"),
                    message.optInt("duration", 300))
                "input" -> input(service, message.getString("text"))
                "setClipboard" -> setClipboardOnly(message.optString("text", ""))
                "setCaptureSpeed" -> {
                    val speed = message.optString("speed", "low")
                    val svc = ScreenCaptureService.instance
                    StreamDiag.log("control setCaptureSpeed=$speed")
                    if (svc != null && shouldIgnoreRemoteCaptureSpeed(svc, speed)) {
                        StreamDiag.warn("ignore setCaptureSpeed=$speed mode=${svc.getCaptureModeName()}")
                        return
                    }
                    when (speed) {
                        "high" -> svc?.updateUploadSpeed(true)
                        "smooth" -> svc?.applySmoothCapture()
                        "thumb" -> svc?.applyListThumbCapture()
                        "medium", "mid" -> svc?.applyCaptureProfile("medium", fromAuto = false)
                        else -> svc?.updateUploadSpeed(false)
                    }
                }
                "setCaptureProfile" -> {
                    val profile = message.optString("profile", message.optString("speed", "low"))
                    val svc = ScreenCaptureService.instance
                    if (svc != null && shouldIgnoreRemoteCaptureProfile(svc, profile)) {
                        StreamDiag.warn("ignore setCaptureProfile=$profile mode=${svc.getCaptureModeName()}")
                        return
                    }
                    svc?.applyCaptureProfile(profile, fromAuto = false)
                }
                "preferWebp", "forceWebp" -> ScreenCaptureService.instance?.setForceWebpCapture(true)
                "allowH264", "preferH264" -> ScreenCaptureService.instance?.setForceWebpCapture(false)
                "setCodecMode" -> {
                    val mode = message.optString("mode", "base64")
                    StreamDiag.log("control setCodecMode=$mode")
                    ScreenCaptureService.instance?.setCodecMode(mode)
                }
                "pauseCapture" -> ScreenCaptureService.instance?.pauseCapture()
                "resumeCapture" -> ScreenCaptureService.instance?.resumeCapture()
                "startAudio" -> ScreenCaptureService.instance?.startAudioCapture()
                "stopAudio" -> ScreenCaptureService.instance?.stopAudioCapture()
                "requestFrame", "refreshFrame" ->
                    ScreenCaptureService.instance?.requestImmediateFrame(forceKeyframe = false)
                "back" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                "home" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
                "recents" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS)
                else -> Log.w(TAG, "未知控制类型: $type")
            }
        } catch (e: JSONException) {
            Log.e(TAG, "控制参数解析失败 type=$type msg=$message", e)
        }
    }

    private fun fetchAndSendUiNodes(service: AccessibilityService, client: DeviceWebSocketClient) {
        Log.i(TAG, "正在抓取界面截图与节点树...")
        ScreenCaptureService.instance?.requestImmediateFrame(forceKeyframe = true)
        captureUiScreenshot(service) { shot ->
            val root = service.rootInActiveWindow
            if (root == null) {
                sendNodesError(client, "无法获取当前活动窗口的根节点")
                return@captureUiScreenshot
            }
            try {
                val (screenW, screenH) = getScreenSize(service)
                val rootTree = buildNodeTree(root)
                val nodeCount = countTreeNodes(rootTree)

                val response = JSONObject().apply {
                    put("type", "ui_nodes")
                    put("deviceId", client.deviceId)
                    put("screenWidth", screenW)
                    put("screenHeight", screenH)
                    put("root", rootTree)
                    put("timestamp", System.currentTimeMillis())
                    if (shot != null) {
                        put("image", shot.base64)
                        put("imageWidth", shot.width)
                        put("imageHeight", shot.height)
                        put("imageSource", shot.source)
                    }
                }

                client.send(response.toString())
                Log.i(
                    TAG,
                    "UI 节点与截图已发送，节点数=$nodeCount 截图=${shot != null} source=${shot?.source}"
                )
            } catch (e: Exception) {
                Log.e(TAG, "UI 节点抓取失败: ${e.message}")
                sendNodesError(client, e.message ?: "Unknown error")
            } finally {
                root.recycle()
            }
        }
    }

    private fun fetchAndSendScreenshot(service: AccessibilityService, client: DeviceWebSocketClient) {
        Log.i(TAG, "正在抓取设备原图截图...")
        ScreenCaptureService.instance?.requestImmediateFrame(forceKeyframe = false)
        mainHandler.postDelayed({
            captureFullScreenshot(service) { shot ->
                if (shot == null) {
                    sendScreenshotError(client, "无法获取设备截图，请确认无障碍截图权限已开启")
                    return@captureFullScreenshot
                }
                try {
                    val (screenW, screenH) = getScreenSize(service)
                    val response = JSONObject().apply {
                        put("type", "screenshot")
                        put("deviceId", client.deviceId)
                        put("screenWidth", screenW)
                        put("screenHeight", screenH)
                        put("image", shot.base64)
                        put("imageWidth", shot.width)
                        put("imageHeight", shot.height)
                        put("imageSource", shot.source)
                        put("timestamp", System.currentTimeMillis())
                    }
                    client.send(response.toString())
                    Log.i(
                        TAG,
                        "截图已发送 ${shot.width}x${shot.height} source=${shot.source} screen=${screenW}x${screenH}"
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "原图截图发送失败: ${e.message}")
                    sendScreenshotError(client, e.message ?: "Unknown error")
                }
            }
        }, 350)
    }

    private data class UiScreenshot(
        val base64: String,
        val width: Int,
        val height: Int,
        val source: String = "stream"
    )

    private fun captureFullScreenshot(service: AccessibilityService, onDone: (UiScreenshot?) -> Unit) {
        val activeService = MyAccessibilityService.instance ?: service
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            tryTakeScreenshotFull(activeService, attempt = 0, onDone)
            return
        }
        fallbackFullScreenshotAsync(onDone)
    }

    private fun tryTakeScreenshotFull(
        service: AccessibilityService,
        attempt: Int,
        onDone: (UiScreenshot?) -> Unit
    ) {
        try {
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                mainHandler::post,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        var bitmap: Bitmap? = null
                        try {
                            val buffer: HardwareBuffer = result.hardwareBuffer
                            bitmap = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                            buffer.close()
                            val shot = bitmap?.let {
                                compressBitmapForUi(it, maxWidth = Int.MAX_VALUE, quality = 92)
                                    .copy(source = "accessibility")
                            }
                            if (shot != null) {
                                onDone(shot)
                            } else {
                                fallbackFullScreenshotAsync(onDone)
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "无障碍全屏截图处理失败: ${e.message}")
                            fallbackFullScreenshotAsync(onDone)
                        } finally {
                            bitmap?.recycle()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "无障碍全屏截图失败 code=$errorCode attempt=$attempt")
                        val intervalTooSoon =
                            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                                errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT
                        if (intervalTooSoon && attempt < 4) {
                            mainHandler.postDelayed(
                                { tryTakeScreenshotFull(service, attempt + 1, onDone) },
                                900L
                            )
                        } else {
                            fallbackFullScreenshotAsync(onDone)
                        }
                    }
                }
            )
        } catch (e: Exception) {
            Log.w(TAG, "takeScreenshot 原图不可用: ${e.message}")
            fallbackFullScreenshotAsync(onDone)
        }
    }

    private fun fallbackFullScreenshotAsync(onDone: (UiScreenshot?) -> Unit) {
        ScreenCaptureService.captureOneFrameAtLogicalSize { logicalFrame ->
            mainHandler.post {
                if (logicalFrame != null) {
                    Log.i(
                        TAG,
                        "截图回退逻辑全分辨率 ${logicalFrame.width}x${logicalFrame.height}"
                    )
                    onDone(
                        UiScreenshot(
                            logicalFrame.base64,
                            logicalFrame.width,
                            logicalFrame.height,
                            "logical_projection"
                        )
                    )
                    return@post
                }
                val buffer = ScreenCaptureService.getFullScreenshotFrameOrNull()
                if (buffer != null) {
                    Log.i(TAG, "截图回退投屏缓冲 ${buffer.width}x${buffer.height}")
                    onDone(
                        UiScreenshot(buffer.base64, buffer.width, buffer.height, "capture_buffer")
                    )
                    return@post
                }
                val stream = fallbackProjectionScreenshot()
                if (stream != null) {
                    Log.w(TAG, "截图回退投屏缩略图 ${stream.width}x${stream.height}")
                    onDone(stream.copy(source = "stream"))
                    return@post
                }
                onDone(null)
            }
        }
    }

    private fun captureUiScreenshot(service: AccessibilityService, onDone: (UiScreenshot?) -> Unit) {
        val activeService = MyAccessibilityService.instance ?: service
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            tryTakeScreenshotUi(activeService, attempt = 0, onDone)
            return
        }
        fallbackUiScreenshotAsync(onDone)
    }

    /** UI 节点弹窗：优先实时无障碍截图，避免误用投屏旧缓存 */
    private fun tryTakeScreenshotUi(
        service: AccessibilityService,
        attempt: Int,
        onDone: (UiScreenshot?) -> Unit
    ) {
        try {
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                mainHandler::post,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        var bitmap: Bitmap? = null
                        try {
                            val buffer: HardwareBuffer = result.hardwareBuffer
                            bitmap = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                            buffer.close()
                            val shot = bitmap?.let {
                                compressBitmapForUi(it).copy(source = "accessibility")
                            }
                            if (shot != null) {
                                Log.i(TAG, "UI 截图使用实时无障碍 ${shot.width}x${shot.height}")
                                onDone(shot)
                            } else {
                                fallbackUiScreenshotAsync(onDone)
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "UI 无障碍截图处理失败: ${e.message}")
                            fallbackUiScreenshotAsync(onDone)
                        } finally {
                            bitmap?.recycle()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        Log.w(TAG, "UI 无障碍截图失败 code=$errorCode attempt=$attempt")
                        val intervalTooSoon =
                            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                                errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT
                        if (intervalTooSoon && attempt < 4) {
                            mainHandler.postDelayed(
                                { tryTakeScreenshotUi(service, attempt + 1, onDone) },
                                900L
                            )
                        } else {
                            fallbackUiScreenshotAsync(onDone)
                        }
                    }
                }
            )
        } catch (e: Exception) {
            Log.w(TAG, "takeScreenshot UI 不可用: ${e.message}")
            fallbackUiScreenshotAsync(onDone)
        }
    }

    private fun fallbackUiScreenshotAsync(onDone: (UiScreenshot?) -> Unit) {
        ScreenCaptureService.captureOneFrameAtLogicalSize { logicalFrame ->
            mainHandler.post {
                if (logicalFrame != null) {
                    Log.i(
                        TAG,
                        "UI 截图回退逻辑全分辨率 ${logicalFrame.width}x${logicalFrame.height}"
                    )
                    onDone(
                        UiScreenshot(
                            logicalFrame.base64,
                            logicalFrame.width,
                            logicalFrame.height,
                            "logical_projection"
                        )
                    )
                    return@post
                }
                val buffer = ScreenCaptureService.getFullScreenshotFrameOrNull()
                if (buffer != null) {
                    Log.i(TAG, "UI 截图回退投屏缓冲 ${buffer.width}x${buffer.height}")
                    onDone(
                        UiScreenshot(buffer.base64, buffer.width, buffer.height, "capture_buffer")
                    )
                    return@post
                }
                val stream = fallbackProjectionScreenshot()
                if (stream != null) {
                    Log.w(TAG, "UI 截图回退投屏缩略图 ${stream.width}x${stream.height}")
                    onDone(stream.copy(source = "stream"))
                    return@post
                }
                onDone(null)
            }
        }
    }

    private fun fallbackProjectionScreenshot(): UiScreenshot? {
        val frame = ScreenCaptureService.getInspectorFrameOrNull() ?: return null
        return UiScreenshot(frame.base64, frame.width, frame.height, "stream")
    }

    private fun sendScreenshotError(client: DeviceWebSocketClient, errorMsg: String) {
        try {
            val error = JSONObject().apply {
                put("type", "screenshot_error")
                put("deviceId", client.deviceId)
                put("error", errorMsg)
            }
            client.send(error.toString())
        } catch (ignored: JSONException) {}
    }

    private fun compressBitmapForUi(
        source: Bitmap,
        maxWidth: Int = 720,
        quality: Int = 78
    ): UiScreenshot {
        val src = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && source.config == Bitmap.Config.HARDWARE) {
            source.copy(Bitmap.Config.ARGB_8888, false) ?: source
        } else {
            source
        }
        val needRecycleSrc = src !== source
        val scaled = if (src.width > maxWidth) {
            val h = (src.height.toFloat() * maxWidth / src.width).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(src, maxWidth, h, true)
        } else {
            src
        }
        val needRecycleScaled = scaled !== src
        val outW = scaled.width
        val outH = scaled.height
        val stream = java.io.ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(50, 100), stream)
        if (needRecycleScaled) scaled.recycle()
        if (needRecycleSrc) src.recycle()
        return UiScreenshot(
            Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP),
            outW,
            outH
        )
    }

    private fun getScreenSize(service: AccessibilityService): Pair<Int, Int> {
        val projection = ScreenCaptureService.getLogicalScreenSizeOrNull()
        if (projection != null && projection.first > 0 && projection.second > 0) {
            return projection
        }
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            service.display
        } else {
            (service.getSystemService(Context.WINDOW_SERVICE) as? android.view.WindowManager)
                ?.defaultDisplay
        }
        display?.getRealMetrics(metrics)
        return Pair(
            metrics.widthPixels.coerceAtLeast(1),
            metrics.heightPixels.coerceAtLeast(1)
        )
    }

    private fun buildNodeTree(node: AccessibilityNodeInfo?): JSONObject {
        val obj = JSONObject()
        if (node == null) return obj

        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        obj.put("text", node.text?.toString() ?: "")
        obj.put("desc", node.contentDescription?.toString() ?: "")
        obj.put("id", node.viewIdResourceName ?: "")
        obj.put("className", node.className?.toString() ?: "")
        obj.put("packageName", node.packageName?.toString() ?: "")
        obj.put("bounds", "${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}")
        obj.put("x", bounds.centerX())
        obj.put("y", bounds.centerY())
        obj.put("clickable", node.isClickable)
        obj.put("scrollable", node.isScrollable)
        obj.put("editable", node.isEditable)
        obj.put("enabled", node.isEnabled)
        obj.put("focused", node.isFocused)
        obj.put("selected", node.isSelected)
        obj.put("checked", node.isChecked)

        val children = JSONArray()
        for (i in 0 until node.childCount) {
            val child = node.getChild(i)
            if (child != null) {
                children.put(buildNodeTree(child))
                child.recycle()
            }
        }
        obj.put("children", children)
        return obj
    }

    private fun countTreeNodes(node: JSONObject): Int {
        var n = 1
        val children = node.optJSONArray("children") ?: return n
        for (i in 0 until children.length()) {
            n += countTreeNodes(children.getJSONObject(i))
        }
        return n
    }

    private fun sendNodesError(client: DeviceWebSocketClient, errorMsg: String) {
        try {
            val error = JSONObject().apply {
                put("type", "ui_nodes_error")
                put("deviceId", client.deviceId)
                put("error", errorMsg)
            }
            client.send(error.toString())
        } catch (ignored: JSONException) {}
    }

    private fun fetchAndSendClipboard(client: DeviceWebSocketClient) {
        val context = appContext
        if (context == null) {
            sendClipboardError(client, "应用上下文不可用")
            return
        }
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                val direct = DeviceClipboardHelper.readBestEffort()
                sendClipboardResult(client, direct, "direct", null)
                return
            }
            // Android 10+：每次刷新都拉起前台窗口读取最新剪切板（后台 read 恒为空）
            Log.i(TAG, "启动前台窗口读取剪切板")
            MyAccessibilityService.mainFunction?.floatingLog("正在读取剪切板…")
            DeviceClipboardHelper.requestForegroundRead(context, client)
        } catch (e: Exception) {
            Log.e(TAG, "读取剪切板失败: ${e.message}")
            sendClipboardError(client, e.message ?: "读取剪切板失败")
        }
    }

    @JvmStatic
    fun sendClipboardResult(
        client: DeviceWebSocketClient,
        text: String,
        source: String,
        restrictedHint: String?
    ) {
        try {
            val response = JSONObject().apply {
                put("type", "clipboard")
                put("deviceId", client.deviceId)
                put("text", text)
                put("source", source)
                put("timestamp", System.currentTimeMillis())
                if (!restrictedHint.isNullOrBlank()) {
                    put("restrictedHint", restrictedHint)
                }
            }
            client.send(response.toString())
            Log.i(TAG, "设备剪切板已上报 source=$source 长度=${text.length}")
        } catch (e: Exception) {
            sendClipboardError(client, e.message ?: "上报剪切板失败")
        }
    }

    private fun sendClipboardError(client: DeviceWebSocketClient, errorMsg: String) {
        try {
            val error = JSONObject().apply {
                put("type", "clipboard_error")
                put("deviceId", client.deviceId)
                put("error", errorMsg)
            }
            client.send(error.toString())
        } catch (ignored: JSONException) {}
    }

    private fun readClipboardText(): String {
        val context = appContext ?: return ""
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
        val clip = cm.primaryClip ?: return ""
        if (clip.itemCount <= 0) return ""
        return clip.getItemAt(0).coerceToText(context)?.toString().orEmpty()
    }

    private fun setClipboardOnly(text: String) {
        val context = appContext ?: return
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        cm.setPrimaryClip(ClipData.newPlainText("remote", text))
        Log.i(TAG, "设备剪切板已设置，长度=${text.length}")
    }

    private fun dispatchControlGesture(
        service: AccessibilityService,
        gesture: GestureDescription,
        label: String
    ) {
        val dispatched = service.dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    Log.i(TAG, "$label 手势完成")
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    Log.w(TAG, "$label 手势被取消")
                }
            },
            null
        )
        if (!dispatched) {
            Log.e(TAG, "$label 手势派发失败（dispatchGesture 返回 false）")
        } else {
            Log.i(TAG, "$label 手势已派发")
        }
    }

    private fun click(service: AccessibilityService, x: Int, y: Int) {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 80)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchControlGesture(service, gesture, "click($x,$y)")
    }

    private fun longClick(service: AccessibilityService, x: Int, y: Int, duration: Int) {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, duration.toLong())
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchControlGesture(service, gesture, "longClick($x,$y)")
    }

    private fun swipe(service: AccessibilityService, x1: Int, y1: Int, x2: Int, y2: Int, duration: Int) {
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, duration.toLong())
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        dispatchControlGesture(service, gesture, "swipe")
    }

    private fun input(service: AccessibilityService, text: String) {
        val context = appContext ?: return
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (cm != null) {
            val clip = ClipData.newPlainText("text", text)
            cm.setPrimaryClip(clip)
            val root = service.rootInActiveWindow
            if (root != null) {
                val focusNode = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                focusNode?.let {
                    it.performAction(AccessibilityNodeInfo.ACTION_PASTE)
                    it.recycle()
                }
                root.recycle()
            }
        }
    }
}

/** 列表/省电策略档位，控制页手动档位（smooth/high）之间允许互切 */
private val REMOTE_POLICY_CAPTURE_SPEEDS = setOf(
    "thumb", "low", "idle", "medium", "mid"
)

private fun shouldIgnoreRemoteCaptureSpeed(
    svc: ScreenCaptureService,
    speed: String
): Boolean {
    if (svc.isLegacyBase64Capture()) return false
    if (!svc.isManualControlCapture()) return false
    return speed.lowercase() in REMOTE_POLICY_CAPTURE_SPEEDS
}

private fun shouldIgnoreRemoteCaptureProfile(
    svc: ScreenCaptureService,
    profile: String
): Boolean {
    if (svc.isLegacyBase64Capture()) return false
    if (!svc.isManualControlCapture()) return false
    return profile.lowercase() in REMOTE_POLICY_CAPTURE_SPEEDS
}
