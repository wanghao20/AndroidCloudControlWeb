package com.wanghaonetcn.Accessibility.myfunction

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONException
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException
import java.util.LinkedList
import kotlin.math.pow
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class DeviceWebSocketClient(private val context: Context, val deviceId: String) {
    companion object {
        private const val TAG = "DeviceWebSocketClient"
        private const val FRAME_MAGIC: Int = 0xF1
        /** 与 server/ws/frameProtocol.js DEVICE_AUDIO_MAGIC 一致 */
        private const val AUDIO_MAGIC: Int = 0xF3
        /** 与 server/ws/frameProtocol.js IMAGE_FORMAT 一致 */
        private const val FORMAT_WEBP: Int = 0x01
        const val FORMAT_H264: Int = 0x02
    }

    private var wsClient: WebSocketClient? = null
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    /** 所有 WS 发送走单线程，避免与采集线程并发 send 导致断连 */
    private val sendExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingSendLock = Any()
    private val binarySendQueue = LinkedList<QueuedBinary>()
    private val audioSendQueue = LinkedList<ByteArray>()
    private val controlSendQueue = LinkedList<String>()
    @Volatile private var sendDrainPosted = false

    private data class QueuedBinary(
        val packet: ByteArray,
        val onComplete: (() -> Unit)?,
        /** CONFIG 等必须优先发出，不可被新帧覆盖 */
        val urgent: Boolean
    )
    private var serverUrl: String? = null
    private var token: String? = null
    private var reconnectCount = 0
    private val maxReconnectDelay = 30000L
    @Volatile private var reconnectScheduled = false
    @Volatile private var released = false
    private var connectionEpoch = 0
    private var heartbeatFuture: ScheduledFuture<*>? = null
    private var reconnectRunnable: Runnable? = null

    fun connect(serverUrl: String, token: String) {
        if (released) {
            Log.w(TAG, "客户端已释放，忽略 connect")
            return
        }
        this.serverUrl = serverUrl
        this.token = token
        val epoch = ++connectionEpoch

        val baseUrl = serverUrl.removeSuffix("/")
        val username = MyApplication.myUtils?.effectiveWsUsername?.trim().orEmpty()
        if (username.isEmpty()) {
            Log.e(TAG, "后台账号为空，取消 WS 连接")
            MyAccessibilityService.mainFunction?.floatingLog("WS失败: 未设置后台账号")
            return
        }
        val encodedUser = java.net.URLEncoder.encode(username, Charsets.UTF_8.name())
        val wsUrl = "$baseUrl?clientType=device&token=$token&username=$encodedUser"
        Log.i(TAG, "开始尝试连接 WebSocket: $baseUrl 用户=$username")
        MyAccessibilityService.mainFunction?.floatingLog("WS连接: $baseUrl 用户=$username")
        Handler(Looper.getMainLooper()).post {
//            Toast.makeText(context, "连接至: $baseUrl", Toast.LENGTH_SHORT).show()
        }
        
        try {
            cancelReconnect()
            wsClient?.let {
                if (!it.isClosed) {
                    it.close()
                }
            }

            wsClient = object : WebSocketClient(URI(wsUrl)) {
                private val bornEpoch = epoch
                override fun onOpen(handshake: ServerHandshake) {
                    Log.i(TAG, ">>> WebSocket 连接成功 <<<")
                    reconnectScheduled = false
                    MyAccessibilityService.mainFunction?.floatingLog("WS已连接")
                    reconnectCount = 0
                    sendRegister()
                    startHeartbeat()
                    
                    // 连接成功后检查更新
                    com.wanghaonetcn.Accessibility.update.UpdateManager.checkUpdate(context)
                }
                
                override fun onMessage(message: String) {
                    val isControl = try {
                        JSONObject(message).optString("type") == "control"
                    } catch (_: Exception) {
                        false
                    }
                    if (isControl) {
                        mainHandler.postAtFrontOfQueue { handleMessage(message) }
                    } else {
                        mainHandler.post { handleMessage(message) }
                    }
                }

                override fun onMessage(bytes: java.nio.ByteBuffer) {
                    Log.w(TAG, "收到二进制 WS 消息（设备端仅处理文本控制指令），已忽略")
                }
                
                override fun onClose(code: Int, reason: String, remote: Boolean) {
                    if (bornEpoch != connectionEpoch || released) return
                    Log.w(TAG, "WebSocket 已断开 (code: $code, reason: $reason, remote: $remote)")
                    stopHeartbeat()
                    if (MyApplication.myUtils?.autoTaskEnable == true) {
                        MyAccessibilityService.mainFunction?.floatingLog("WS断开，重连中…")
                        scheduleReconnect()
                    }
                }
                
                override fun onError(ex: Exception) {
                    Log.e(TAG, "WebSocket 异常报错: ${ex.message}")
                    MyAccessibilityService.mainFunction?.floatingLog("WS报错: ${ex.message}")
                    // 连接类异常仅本地日志，不上报远程服务器
                }
            }
            wsClient?.connectionLostTimeout = 60
            // 公网场景减少 TCP 发送缓冲延迟
            wsClient?.setTcpNoDelay(true)
            wsClient?.connect()
        } catch (e: Exception) {
            Log.e(TAG, "创建 WebSocket 客户端失败: ${e.message}")
            scheduleReconnect()
        }
    }

    private fun sendRegister() {
        try {
            val snap = DisplayMetricsHelper.capture(context)
            val register = JSONObject().apply {
                put("type", "register")
                put("deviceId", deviceId)
                put("owner", MyApplication.myUtils?.effectiveWsUsername ?: "")
                put("brand", Build.BRAND)
                put("model", Build.MODEL)
                put("android", Build.VERSION.RELEASE)
                put("width", snap.width)
                put("height", snap.height)
                put("orientation", snap.orientation)
            }
            send(register.toString())
        } catch (e: JSONException) {
            Log.e(TAG, "注册信息封装失败", e)
        }
    }

    /** 屏幕旋转后上报最新分辨率，供网页端坐标换算 */
    fun sendDisplayUpdate() {
        if (wsClient?.isOpen != true) return
        try {
            val snap = DisplayMetricsHelper.capture(context)
            send(DisplayMetricsHelper.toJson(deviceId, snap).toString())
            Log.i(TAG, "已上报屏幕变更: ${snap.width}x${snap.height} orientation=${snap.orientation}")
        } catch (e: JSONException) {
            Log.e(TAG, "屏幕信息上报失败", e)
        }
    }

    private fun stopHeartbeat() {
        heartbeatFuture?.cancel(false)
        heartbeatFuture = null
    }

    private fun startHeartbeat() {
        if (released || scheduler.isShutdown) return
        stopHeartbeat()
        heartbeatFuture = scheduler.scheduleWithFixedDelay({
            if (released || wsClient?.isOpen != true) return@scheduleWithFixedDelay
            if (wsClient?.isOpen == true) {
                try {
                    val ping = JSONObject().apply {
                        put("type", "ping")
                        put("deviceId", deviceId)
                        put("clientTs", System.currentTimeMillis())
                        put("captureProfile", ScreenCaptureService.instance?.getCurrentProfileName() ?: "low")
                        ScreenCaptureService.getLogicalScreenSizeOrNull()?.let { (w, h) ->
                            put("screenWidth", w)
                            put("screenHeight", h)
                        }
                    }
                    send(ping.toString())
                } catch (e: JSONException) {
                    Log.e(TAG, "心跳包封装失败", e)
                }
            }
        }, 10, 10, TimeUnit.SECONDS)
    }

    private fun handleMessage(message: String) {
        Log.i(TAG, "收到服务端消息: $message")
        try {
            val msg = JSONObject(message)
            val type = msg.optString("type")
            val errorMsg = msg.optString("message")

            if ("error" == type) {
                if ("设备数量达到上限" == errorMsg) {
                    Handler(Looper.getMainLooper()).post {
                        Toast.makeText(context, "设备数量达到上限", Toast.LENGTH_LONG).show()
                    }
                    MyApplication.myUtils?.autoTaskEnable = false
                    ScreenCaptureService.instance?.stopSelf()
                    return
                }
                val tip = when (errorMsg) {
                    "missing username in ws query" -> "WS缺少用户名(需与后台账号一致)"
                    "user not found" -> "WS用户名在后台不存在"
                    "register.owner must equal username" -> "owner 与 username 不一致"
                    else -> errorMsg.ifEmpty { "WS 错误" }
                }
                Log.e(TAG, "服务端错误: $errorMsg")
                MyAccessibilityService.mainFunction?.floatingLog("WS失败: $tip")
                return
            }
            
            if ("pong" == type) {
                val profile = msg.optString("captureProfile", "")
                if (profile.isNotEmpty()) {
                    ScreenCaptureService.instance?.onServerCaptureProfileSuggestion(profile)
                }
                return
            }

            if ("control" == type) {
                val command = msg.optJSONObject("command")
                if (command != null) {
                    Log.i(TAG, "执行控制指令: ${command.optString("type")} $command")
                    ControlExecutor.execute(command, this)
                } else {
                    Log.w(TAG, "control 消息缺少 command 字段: $message")
                    ControlExecutor.execute(msg, this)
                }
            } else if ("download" == type) {
                val url = msg.optString("url")
                val fileName = msg.optString("fileName")
                if (url.isNotEmpty()) {
                    FileDownloadManager.download(context, url, fileName)
                }
            } else if (msg.has("type")) {
                ControlExecutor.execute(msg)
            }
        } catch (e: JSONException) {
            Log.e(TAG, "消息解析失败: ${e.message}")
        }
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        reconnectRunnable = null
        reconnectScheduled = false
    }

    private fun scheduleReconnect() {
        if (released) return
        if (MyApplication.myUtils?.autoTaskEnable != true) return
        if (reconnectScheduled) return
        reconnectScheduled = true

        reconnectCount++
        val delay = (2.0.pow(reconnectCount.toDouble()) * 1000).toLong()
            .coerceIn(1000L, maxReconnectDelay)

        Log.i(TAG, "将在 ${delay / 1000} 秒后尝试重新连接 ($reconnectCount)...")
        MyAccessibilityService.mainFunction?.floatingLog("WS ${delay / 1000}s 后重连")

        val runnable = Runnable {
            reconnectScheduled = false
            reconnectRunnable = null
            if (released || MyApplication.myUtils?.autoTaskEnable != true) return@Runnable
            if (wsClient?.isOpen != true) {
                serverUrl?.let { url -> token?.let { t -> connect(url, t) } }
            }
        }
        reconnectRunnable = runnable
        mainHandler.postDelayed(runnable, delay)
    }

    fun isOpen(): Boolean = wsClient?.isOpen == true

    fun send(text: String) {
        // 控制/心跳优先：丢弃排队中的旧 Base64 大帧，避免滑动指令被 send 线程拖住
        synchronized(pendingSendLock) {
            jsonFramePending?.onComplete?.let { cb -> sendExecutor.execute { cb() } }
            jsonFramePending = null
        }
        try {
            if (wsClient?.isOpen == true) {
                wsClient?.send(text)
                return
            }
        } catch (_: Exception) {}
        // 发送失败时入队重试
        synchronized(pendingSendLock) {
            dropNonUrgentBinaryFramesLocked()
            controlSendQueue.addLast(text)
            if (sendDrainPosted) return
            sendDrainPosted = true
        }
        sendExecutor.execute { drainSendQueues() }
    }

    /**
     * 控制 JSON 入队时丢弃排队中的普通画面帧。
     * 必须触发被丢帧的 onComplete，否则 ScreenCaptureService.isSendingFrame 会永久卡住。
     */
    /** 控制指令优先：丢弃排队中的旧画面，但保留最新一帧待发送 */
    private fun dropNonUrgentBinaryFramesLocked() {
        val callbacks = ArrayList<() -> Unit>()
        var lastNonUrgent: QueuedBinary? = null
        val keep = ArrayDeque<QueuedBinary>()
        for (item in binarySendQueue) {
            if (item.urgent) {
                keep.addLast(item)
            } else {
                lastNonUrgent?.onComplete?.let { callbacks.add(it) }
                lastNonUrgent = item
            }
        }
        if (lastNonUrgent != null) keep.addLast(lastNonUrgent)
        val dropped = binarySendQueue.size - keep.size
        binarySendQueue.clear()
        binarySendQueue.addAll(keep)
        if (dropped > 0) {
            StreamDiag.log("dropNonUrgent dropped=$dropped kept=${keep.size}")
        }
        for (cb in callbacks) {
            sendExecutor.execute { cb() }
        }
    }

    /**
     * 二进制画面帧 V2: [0xF1][format][uint16 idLen][deviceId][image]
     * @param onComplete 发送结束回调（主线程），用于串联下一帧
     */
    fun sendH264Frame(
        frameType: Int,
        data: ByteArray,
        frameDeviceId: String,
        onComplete: (() -> Unit)? = null
    ) {
        if (data.isEmpty()) {
            onComplete?.let { mainHandler.post(it) }
            return
        }
        val payload = ByteArray(1 + data.size)
        payload[0] = (frameType and 0xFF).toByte()
        System.arraycopy(data, 0, payload, 1, data.size)
        val urgent =
            frameType == ScreenH264Encoder.FRAME_CONFIG ||
                frameType == ScreenH264Encoder.FRAME_KEY
        sendBinaryFrame(payload, frameDeviceId, FORMAT_H264, onComplete, urgent)
    }

    fun sendBinaryFrame(
        imageBytes: ByteArray,
        frameDeviceId: String,
        format: Int = FORMAT_WEBP,
        onComplete: (() -> Unit)? = null,
        urgent: Boolean = false
    ) {
        if (imageBytes.isEmpty()) {
            onComplete?.let { mainHandler.post(it) }
            return
        }
        val idBytes = frameDeviceId.toByteArray(Charsets.UTF_8)
        if (idBytes.size > 65535) {
            Log.e(TAG, "deviceId 过长，无法发送二进制帧")
            onComplete?.let { mainHandler.post(it) }
            return
        }
        val packet = ByteArray(4 + idBytes.size + imageBytes.size)
        packet[0] = FRAME_MAGIC.toByte()
        packet[1] = (format and 0xFF).toByte()
        packet[2] = ((idBytes.size shr 8) and 0xFF).toByte()
        packet[3] = (idBytes.size and 0xFF).toByte()
        System.arraycopy(idBytes, 0, packet, 4, idBytes.size)
        System.arraycopy(imageBytes, 0, packet, 4 + idBytes.size, imageBytes.size)

        synchronized(pendingSendLock) {
            if (urgent) {
                binarySendQueue.addFirst(QueuedBinary(packet, onComplete, true))
            } else {
                while (binarySendQueue.isNotEmpty()) {
                    val dropped = binarySendQueue.pollFirst()
                    dropped?.onComplete?.let { cb ->
                        sendExecutor.execute { cb() }
                    }
                }
                binarySendQueue.addLast(QueuedBinary(packet, onComplete, false))
            }
            if (sendDrainPosted) return
            sendDrainPosted = true
        }
        sendExecutor.execute { drainSendQueues() }
    }

    /**
     * 音频 PCM 二进制: [0xF3][sampleRate:4 BE][channels:1][idLen:2 BE][deviceId][pcm]
     */
    fun sendAudioPcm(
        pcm: ByteArray,
        sampleRate: Int,
        channels: Int,
        frameDeviceId: String
    ) {
        if (pcm.isEmpty()) return
        val idBytes = frameDeviceId.toByteArray(Charsets.UTF_8)
        if (idBytes.size > 65535) return
        val packet = ByteArray(8 + idBytes.size + pcm.size)
        packet[0] = AUDIO_MAGIC.toByte()
        packet[1] = ((sampleRate shr 24) and 0xFF).toByte()
        packet[2] = ((sampleRate shr 16) and 0xFF).toByte()
        packet[3] = ((sampleRate shr 8) and 0xFF).toByte()
        packet[4] = (sampleRate and 0xFF).toByte()
        packet[5] = (channels and 0xFF).toByte()
        packet[6] = ((idBytes.size shr 8) and 0xFF).toByte()
        packet[7] = (idBytes.size and 0xFF).toByte()
        System.arraycopy(idBytes, 0, packet, 8, idBytes.size)
        System.arraycopy(pcm, 0, packet, 8 + idBytes.size, pcm.size)

        synchronized(pendingSendLock) {
            while (audioSendQueue.size >= 6) {
                audioSendQueue.pollFirst()
            }
            audioSendQueue.addLast(packet)
            if (sendDrainPosted) return
            sendDrainPosted = true
        }
        sendExecutor.execute { drainSendQueues() }
    }

    /** Base64 JSON 帧：通过 JSON 文本消息发送 JPEG base64 图像 */
    fun sendJsonFrame(
        base64Image: String,
        frameDeviceId: String,
        onComplete: (() -> Unit)? = null
    ) {
        val json = """{"type":"frame","image":"$base64Image","deviceId":"$frameDeviceId"}"""
        synchronized(pendingSendLock) {
            // 被覆盖的旧帧不再回调 onComplete，避免连发日志与统计干扰
            jsonFramePending = QueuedJsonFrame(json, onComplete)
            if (sendDrainPosted) return
            sendDrainPosted = true
        }
        sendExecutor.execute { drainSendQueues() }
    }

    private data class QueuedJsonFrame(val json: String, val onComplete: (() -> Unit)?)
    @Volatile private var jsonFramePending: QueuedJsonFrame? = null

    /**
     * 控制 JSON 优先、画面二进制每次只发一帧，避免 while 连发占满 send 线程导致主线程 onComplete 堆积。
     */
    private fun drainSendQueues() {
        while (true) {
            val text: String?
            val audioPacket: ByteArray?
            synchronized(pendingSendLock) {
                text = controlSendQueue.pollFirst()
                audioPacket = if (text == null) audioSendQueue.pollFirst() else null
            }
            if (text != null) {
                try {
                    if (wsClient?.isOpen == true) wsClient?.send(text)
                } catch (e: Exception) {
                    Log.e(TAG, "Control send failed: ${e.message}")
                }
                continue
            }
            if (audioPacket != null) {
                try {
                    if (wsClient?.isOpen == true) wsClient?.send(audioPacket)
                } catch (e: Exception) {
                    Log.e(TAG, "Audio send failed: ${e.message}")
                }
                continue
            }

            val item: QueuedBinary?
            val jsonFrame: QueuedJsonFrame?
            synchronized(pendingSendLock) {
                // JSON 帧优先于二进制帧（base64 模式）
                jsonFrame = jsonFramePending
                jsonFramePending = null
                if (jsonFrame == null && binarySendQueue.isEmpty() && audioSendQueue.isEmpty()) {
                    sendDrainPosted = false
                    return
                }
                if (jsonFrame != null) {
                    item = null
                } else {
                    while (binarySendQueue.size > 1) {
                        val dropped = binarySendQueue.pollFirst()
                        dropped?.onComplete?.let { cb ->
                            sendExecutor.execute { cb() }
                        }
                    }
                    item = binarySendQueue.pollFirst()
                }
            }
            if (jsonFrame != null) {
                try {
                    if (wsClient?.isOpen == true) {
                        wsClient?.send(jsonFrame.json)
                        StreamDiag.frameSent("frame", jsonFrame.json.length, 0, 0)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "JSON frame send failed: ${e.message}")
                }
                jsonFrame.onComplete?.let { mainHandler.post(it) }
                continue
            }
            try {
                if (wsClient?.isOpen == true) {
                    val currentItem = item!!
                    wsClient?.send(currentItem.packet)
                    StreamDiag.frameSent(
                        if (currentItem.urgent) "urgent" else "frame",
                        currentItem.packet.size,
                        synchronized(pendingSendLock) { binarySendQueue.size },
                        0
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Binary frame send failed: ${e.message}")
            } finally {
                item?.onComplete?.let { cb ->
                    sendExecutor.execute { cb() }
                }
            }
            synchronized(pendingSendLock) {
                if (controlSendQueue.isNotEmpty() || audioSendQueue.isNotEmpty() || binarySendQueue.isNotEmpty()) {
                    sendExecutor.execute { drainSendQueues() }
                } else {
                    sendDrainPosted = false
                }
            }
            return
        }
    }

    /** 解锁/亮屏后若通道已断，立即尝试重连（配合指数退避） */
    fun reconnectIfNeeded() {
        if (released) return
        if (wsClient?.isOpen == true) return
        if (MyApplication.myUtils?.autoTaskEnable != true) return
        cancelReconnect()
        reconnectCount = 0
        serverUrl?.let { url -> token?.let { t -> connect(url, t) } }
    }

    fun close() {
        released = true
        connectionEpoch++
        cancelReconnect()
        stopHeartbeat()
        try {
            wsClient?.close()
        } catch (_: Exception) {
        }
        wsClient = null
        scheduler.shutdownNow()
        sendExecutor.shutdownNow()
    }
}
