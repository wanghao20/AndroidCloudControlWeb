package com.wanghaonetcn.Accessibility.myfunction

import android.app.ActivityOptions
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.wanghaonetcn.Accessibility.myactivity.ClipboardReaderActivity

/**
 * Android 10+ 后台无法读剪切板；多 Context 尝试 + 前台 Activity + 超时兜底。
 */
object DeviceClipboardHelper {
    private const val TAG = "DeviceClipboardHelper"
    private const val READ_TIMEOUT_MS = 3500L

    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile private var cachedText: String = ""
    @Volatile private var pendingClient: DeviceWebSocketClient? = null
    @Volatile private var timeoutRunnable: Runnable? = null
    @Volatile private var listenerInstalled = false

    fun installListener(context: Context) {
        if (listenerInstalled) return
        listenerInstalled = true
        attachApplication(context)
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        try {
            val listener = ClipboardManager.OnPrimaryClipChangedListener {
                val text = readBestEffort()
                if (text.isNotEmpty()) {
                    cachedText = text
                    Log.d(TAG, "剪切板已缓存，长度=${text.length}")
                }
            }
            cm.addPrimaryClipChangedListener(listener)
            val current = readBestEffort()
            if (current.isNotEmpty()) {
                cachedText = current
            }
        } catch (e: Exception) {
            Log.w(TAG, "注册剪切板监听失败: ${e.message}")
        }
    }

    fun readDirect(context: Context): String {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
        if (!cm.hasPrimaryClip()) return ""
        val clip = cm.primaryClip ?: return ""
        if (clip.itemCount <= 0) return ""
        val sb = StringBuilder()
        for (i in 0 until clip.itemCount) {
            val item = clip.getItemAt(i) ?: continue
            val part = item.coerceToText(context)?.toString()?.trim().orEmpty()
            if (part.isNotEmpty()) {
                if (sb.isNotEmpty()) sb.append('\n')
                sb.append(part)
            }
        }
        return sb.toString()
    }

    /** 依次尝试应用 / 无障碍 / 投屏前台服务 Context */
    fun readBestEffort(): String {
        val contexts = linkedSetOf<Context>()
        appContext?.let { contexts.add(it) }
        MyAccessibilityService.instance?.let { contexts.add(it) }
        ScreenCaptureService.instance?.let { contexts.add(it) }
        for (ctx in contexts) {
            val text = readDirect(ctx)
            if (text.isNotEmpty()) return text
        }
        return ""
    }

    fun readCached(): String = cachedText

    fun requestForegroundRead(context: Context, client: DeviceWebSocketClient) {
        cancelPendingRead()
        pendingClient = client

        val launchContext = MyAccessibilityService.instance ?: context
        val intent = Intent(launchContext, ClipboardReaderActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_NO_ANIMATION or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
            )
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val opts = ActivityOptions.makeBasic()
                    .setPendingIntentBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                    )
                launchContext.startActivity(intent, opts.toBundle())
            } else {
                launchContext.startActivity(intent)
            }
            Log.i(TAG, "已启动剪切板读取 Activity")
        } catch (e: Exception) {
            Log.e(TAG, "启动剪切板读取界面失败: ${e.message}")
            pendingClient = null
            val fallback = readBestEffort().ifEmpty { cachedText }
            ControlExecutor.sendClipboardResult(
                client,
                fallback,
                source = "failed",
                restrictedHint = if (fallback.isEmpty()) {
                    "无法打开读取窗口（${e.message}）。请手动打开群控 App 到前台后再点刷新"
                } else {
                    "无法打开读取窗口，已显示缓存内容"
                }
            )
            return
        }

        val timeout = Runnable { finishPendingRead("timeout") }
        timeoutRunnable = timeout
        mainHandler.postDelayed(timeout, READ_TIMEOUT_MS)
    }

    fun completeForegroundRead(activity: Context) {
        val client = pendingClient ?: return
        cancelTimeoutOnly()

        var text = readDirect(activity)
        if (text.isEmpty()) {
            text = readBestEffort()
        }
        if (text.isNotEmpty()) {
            cachedText = text
        }

        pendingClient = null
        val hint = if (text.isEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            "读取失败：请先在手机上复制文字，若仍为空请打开群控 App 到前台后再点刷新"
        } else {
            null
        }
        ControlExecutor.sendClipboardResult(
            client,
            text,
            source = "foreground",
            restrictedHint = hint
        )
        Log.i(TAG, "前台读取完成 长度=${text.length}")
    }

    private fun finishPendingRead(reason: String) {
        val client = pendingClient ?: return
        pendingClient = null
        cancelTimeoutOnly()

        var text = readBestEffort()
        if (text.isEmpty()) text = cachedText
        Log.w(TAG, "剪切板读取超时/取消 reason=$reason 长度=${text.length}")
        ControlExecutor.sendClipboardResult(
            client,
            text,
            source = reason,
            restrictedHint = if (text.isEmpty()) {
                "读取超时：Android 10+ 需短暂打开 App 前台。请打开群控 App 后再点「刷新」"
            } else if (reason == "timeout") {
                "读取窗口未及时响应，已显示缓存/最后一次读到的内容"
            } else {
                null
            }
        )
    }

    fun cancelPendingRead() {
        cancelTimeoutOnly()
        pendingClient = null
    }

    fun abortPendingRead(reason: String) {
        if (pendingClient == null) return
        finishPendingRead(reason)
    }

    private fun cancelTimeoutOnly() {
        timeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        timeoutRunnable = null
    }

    private var appContext: Context? = null

    fun attachApplication(context: Context) {
        appContext = context.applicationContext
    }
}
