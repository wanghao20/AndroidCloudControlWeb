package com.wanghaonetcn.Accessibility.myfunction

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.text.TextUtils
import android.util.DisplayMetrics
import android.util.Log
import android.view.*
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.view.ContextThemeWrapper
import com.wanghaonetcn.Accessibility.R
import com.wanghaonetcn.Accessibility.databinding.ViewControllerBinding
import com.wanghaonetcn.Accessibility.databinding.ViewLogBinding
import com.wanghaonetcn.Accessibility.myactivity.IntermediaryActivity
import com.wanghaonetcn.Accessibility.mybean.AppDescribe
import com.wanghaonetcn.Accessibility.myclass.DataDao
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import java.util.*
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 核心自动化功能控制器：整合悬浮窗交互、后台自动脚本、系统事件处理
 */
class MainFunction(private val service: AccessibilityService) {
    companion object {
        private const val TAG = "MainFunction"
    }

    // 辅助变量与组件初始化
    private val isScreenOffPre = "isScreenOffPre"
    private val windowManager: WindowManager = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val myUtils: MyUtils? = MyApplication.myUtils
    private val appDescribeMap: MutableMap<String, AppDescribe> = HashMap()
    
    // 执行器队列
    private val executorServiceKuaiShou: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    
    // 当前状态监控
    @Volatile private var currentPackage: String = "Initialize CurrentPackage"
    @Volatile private var currentPackageSub: String? = null
    @Volatile private var currentActivity: String = "Initialize CurrentActivity"
    
    // 异步任务句柄
    private var myBroadcastReceiver: MyBroadcastReceiver? = null
    private var myPackageReceiver: MyPackageReceiver? = null
    
    // 悬浮窗 UI 组件
    private var logViewLp: WindowManager.LayoutParams? = null
    var logBinding: ViewLogBinding? = null
    private var controllerBinding: ViewControllerBinding? = null
    private var controllerLp: WindowManager.LayoutParams? = null
    
    private var runNum = 0 // 执行计数
    private var hasAutoClickedSystemDialog = false // 记录是否已经自动点击过系统对话框
    private var projectionDialogClickAttempts = 0
    private var lastProjectionDialogClickAt = 0L
    /** 用户是否希望显示日志悬浮窗（与 logBinding 解耦，避免关掉后又被轮询/WS 顶开） */
    private var userWantsLogFloating = false

    /** 录屏授权弹窗常见确认文案（中英文 + 各厂商） */
    private val projectionConfirmKeywords = arrayOf(
        "立即开始", "立即启动", "现在开始", "开始录制", "开始投屏",
        "Start now", "Start recording", "允许", "确定"
    )
    private val workList = ArrayList<String>() // 已刷作品缓存
    private val lines = ArrayList<String>() // 日志行列表

    private var lastAutoStartTime = 0L // 记录上次发送自动启动广播的时间
    private var projectionRetryCount = 0 // 投屏重试计数

    init {
        currentPackageSub = currentPackage
    }

    /**
     * 当无障碍服务连接成功时触发：初始化监听器和周期任务
     */
    fun onServiceConnected() {
        val intentFilter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        myBroadcastReceiver = MyBroadcastReceiver()
        service.registerReceiver(myBroadcastReceiver, intentFilter)
        
        val filterPackage = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_FULLY_REMOVED)
            addDataScheme("package")
        }
        myPackageReceiver = MyPackageReceiver()
        service.registerReceiver(myPackageReceiver, filterPackage)
        
        if (myUtils?.autoTaskEnable == true) {
            showControllerFloating(true)
        }

        // 启动自动化主循环任务
        executorServiceKuaiShou.scheduleWithFixedDelay({
            try {
                // 如果开关关闭，仅尝试关闭日志窗，保留控制器球
                if (myUtils?.autoTaskEnable != true) {
                    if (!userWantsLogFloating && logBinding != null) {
                        Handler(Looper.getMainLooper()).post { showLogFloating(false) }
                    }
                    hasAutoClickedSystemDialog = false // 开关关闭时重置，下次开启可再次点击一次
                    return@scheduleWithFixedDelay
                }
                
                // 确保控制器存在
                if (controllerBinding == null) {
                    Handler(Looper.getMainLooper()).post { showControllerFloating(true) }
                }

                if (myUtils?.isServiceRunning(service, ScreenCaptureService::class.java) != true) {
                    val now = System.currentTimeMillis()
                    // 增加指数退避重试逻辑
                    val retryInterval = (Math.pow(2.0, projectionRetryCount.toDouble()) * 10000).toLong().coerceIn(30000L, 300000L)
                    
                    if (myUtils?.isProjectionEnabled == true && now - lastAutoStartTime > retryInterval && currentPackageSub != isScreenOffPre) {
                        
                        if (projectionRetryCount >= 5) { // 增加至 5 次重试
                            floatingLog("投屏重试失败次数过多，请手动检查权限")
                            // 不彻底关闭，但显著降低重试频率
                            lastAutoStartTime = now
                            return@scheduleWithFixedDelay
                        }

                        if (currentPackage == service.packageName) {
                            floatingLog("投屏重试 (${projectionRetryCount + 1}/5)，间隔 ${retryInterval/1000}s")
                            val intent = Intent("action.auto.start.projection").apply { setPackage(service.packageName) }
                            service.sendBroadcast(intent)
                            lastAutoStartTime = now
                            projectionRetryCount++
                        }
                    }
                    return@scheduleWithFixedDelay
                } else {
                    projectionRetryCount = 0
                }

                if (runNum >= 20) {
                    floatingLog("任务完成，停止脚本")
                    myUtils?.autoTaskEnable = false
                    return@scheduleWithFixedDelay
                }

                executeAutoStep() 

            } catch (e: Exception) {
                Log.e(TAG, "自动化任务异常", e)
            }
        }, 0, 1000, TimeUnit.MILLISECONDS)
    }

    /**
     * 业务逻辑核心：识别界面并执行操作
     */
    private fun executeAutoStep() {
        if (myUtils?.autoTaskEnable != true) return // 实时拦截

//        val page = detectionPage()
////        floatingLog("检测界面: $page")
//
//        when (page) {
//            "home" -> {
//                floatingLog("正在首页搜索...")
//                if (!clickText("搜索")) return
//                smartSleep(1000)
//                if (myUtils?.autoTaskEnable != true) return
//
//                inputByClz("android.widget.EditText", "搭子")
//                smartSleep(1000)
//                if (myUtils?.autoTaskEnable != true) return
//
//                clickText("搜索")
//                smartSleep(2000)
//            }
//            "work" -> processWorkList()
//            else -> {
//                if (expectCount++ > 5) {
////                    expectCount = 0; back()
//                }
//            }
//        }
    }

    private var expectCount = 0

    /**
     * 带开关自检的休眠：如果在休眠期间脚本被关闭，会立即停止
     */
    private fun smartSleep(ms: Long) {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < ms) {
            if (myUtils?.autoTaskEnable != true) return
            Thread.sleep(100)
        }
    }

    private fun processWorkList() {
        if (myUtils?.autoTaskEnable != true) return
        
        val nodes = getWorkNodes("搭子")
        if (nodes.isEmpty()) {
            switchLivec()
            return
        }
        for (node in nodes) {
            if (myUtils?.autoTaskEnable != true) return
            
            val title = node.text?.toString() ?: continue
            if (workList.contains(title)) continue
            
            clickNode(node)
            smartSleep(2000)
            if (myUtils?.autoTaskEnable != true) return
            
            workList.add(title)
            runNum++
            returnText("综合")
            break
        }
    }

    private fun returnText(text: String): Boolean {
        var num = 0
        while (!findNode("text", text, 1, 300)) {
            if (myUtils?.autoTaskEnable != true) return false
            if (num++ > 5) return false
            back()
            smartSleep(1000)
        }
        return true
    }

    /** 开启投屏前调用，重置自动点击计数 */
    fun prepareProjectionDialogAutoClick() {
        projectionDialogClickAttempts = 0
        lastProjectionDialogClickAt = 0L
    }

    fun onAccessibilityEvent(event: AccessibilityEvent) {
        handleProjectionPermissionDialog(event)

        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: ""
            val cls = event.className?.toString() ?: ""
            if (pkg.isNotEmpty()) {
                currentPackage = pkg
                if (!cls.startsWith("android.view.") && !cls.startsWith("android.widget.")) {
                    currentActivity = cls
                }
            }
        }
    }

    /**
     * 申请录屏权限时自动点击系统弹窗「立即开始」等按钮
     */
    private fun handleProjectionPermissionDialog(event: AccessibilityEvent) {
        if (myUtils?.isRequestingProjection != true) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) {
            return
        }

        val now = System.currentTimeMillis()
        if (now - lastProjectionDialogClickAt < 180L) return
        if (projectionDialogClickAttempts > 40) return

        lastProjectionDialogClickAt = now
        projectionDialogClickAttempts++

        val root = service.rootInActiveWindow ?: return
        try {
            for (keyword in projectionConfirmKeywords) {
                if (clickNodesByTextKeyword(root, keyword)) {
                    floatingLog("已自动点击投屏确认: $keyword")
                    hasAutoClickedSystemDialog = true
                    return
                }
            }
        } finally {
            root.recycle()
        }
    }

    private fun clickNodesByTextKeyword(root: AccessibilityNodeInfo, keyword: String): Boolean {
        val nodes = root.findAccessibilityNodeInfosByText(keyword) ?: return false
        for (node in nodes) {
            try {
                val label = node.text?.toString().orEmpty()
                val desc = node.contentDescription?.toString().orEmpty()
                if (!"$label $desc".contains(keyword)) continue
                if (performNodeClickAction(node)) return true
            } finally {
                node.recycle()
            }
        }
        return false
    }

    private fun performNodeClickAction(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo? = node
        var depth = 0
        while (current != null && depth < 8) {
            if (current.isClickable && current.isEnabled) {
                if (current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    if (current != node) current.recycle()
                    return true
                }
            }
            val parent = current.parent
            if (current != node) {
                current.recycle()
            }
            current = parent
            depth++
        }
        if (current != null && current != node) {
            current.recycle()
        }

        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (rect.width() > 8 && rect.height() > 8) {
            return click(rect.centerX(), rect.centerY())
        }
        return false
    }

    @SuppressLint("ClickableViewAccessibility")
    fun showLogFloating(enable: Boolean) {
        userWantsLogFloating = enable
        if (enable && logBinding == null) {
            try {
                val themedContext = ContextThemeWrapper(service, R.style.AppTheme)
                logBinding = ViewLogBinding.inflate(LayoutInflater.from(themedContext))
                val lp = WindowManager.LayoutParams().apply {
                    gravity = Gravity.TOP or Gravity.START
                    type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                    flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or 
                            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or 
                            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    format = PixelFormat.TRANSPARENT
                    
                    val metrics = DisplayMetrics()
                    windowManager.defaultDisplay.getRealMetrics(metrics)
                    width = (metrics.widthPixels * 0.9).toInt()
                    height = metrics.heightPixels / 4
                    x = (metrics.widthPixels - width) / 2
                    y = 150
                }
                logViewLp = lp
                windowManager.addView(logBinding?.root, lp)
            } catch (e: Exception) {
                Log.e(TAG, "日志窗显示失败", e)
            }
        } else if (!enable && logBinding != null) {
            windowManager.removeViewImmediate(logBinding?.root)
            logBinding = null
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    fun showControllerFloating(enable: Boolean) {
        if (enable && controllerBinding == null) {
            try {
                val themedContext = ContextThemeWrapper(service, R.style.AppTheme)
                controllerBinding = ViewControllerBinding.inflate(LayoutInflater.from(themedContext))
                val lp = WindowManager.LayoutParams().apply {
                    gravity = Gravity.TOP or Gravity.START
                    type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                    flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                    format = PixelFormat.TRANSPARENT
                    width = WindowManager.LayoutParams.WRAP_CONTENT
                    height = WindowManager.LayoutParams.WRAP_CONTENT
                    x = 20
                    y = 600
                }
                controllerLp = lp

                controllerBinding?.let { binding ->
                    setupControllerPanelClicks(binding)

                    binding.ivMenu.setOnTouchListener(object : View.OnTouchListener {
                        private var lastX = 0
                        private var lastY = 0
                        private var initialX = 0
                        private var initialY = 0
                        private var isMove = false
                        private var startTime = 0L

                        override fun onTouch(v: View, event: MotionEvent): Boolean {
                            when (event.action) {
                                MotionEvent.ACTION_DOWN -> {
                                    lastX = event.rawX.toInt()
                                    lastY = event.rawY.toInt()
                                    initialX = lp.x
                                    initialY = lp.y
                                    isMove = false
                                    startTime = System.currentTimeMillis()
                                    return true
                                }
                                MotionEvent.ACTION_MOVE -> {
                                    val dx = event.rawX.toInt() - lastX
                                    val dy = event.rawY.toInt() - lastY
                                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                                        isMove = true
                                        lp.x = initialX + dx
                                        lp.y = initialY + dy
                                        windowManager.updateViewLayout(binding.root, lp)
                                        binding.llPanel.visibility = View.GONE
                                    }
                                    return true
                                }
                                MotionEvent.ACTION_UP -> {
                                    if (!isMove && System.currentTimeMillis() - startTime < 400) {
                                        val visible = binding.llPanel.visibility == View.VISIBLE
                                        binding.llPanel.visibility =
                                            if (visible) View.GONE else View.VISIBLE
                                    }
                                    return true
                                }
                            }
                            return false
                        }
                    })
                }

                windowManager.addView(controllerBinding?.root, lp)
                updateControllerUI()
            } catch (e: Exception) {
                Log.e(TAG, "控制器显示失败", e)
            }
        } else if (!enable && controllerBinding != null) {
            windowManager.removeViewImmediate(controllerBinding?.root)
            controllerBinding = null
        }
    }

    private fun setupControllerPanelClicks(binding: ViewControllerBinding) {
        binding.ivRunToggle.setOnClickListener {
            binding.llPanel.visibility = View.GONE
            if (isGroupControlRunning()) {
                stopGroupControlFromFloating("已停止群控投屏")
            } else {
                startGroupControlFromFloating()
            }
            updateControllerUI()
        }

        binding.ivLogToggle.setOnClickListener {
            binding.llPanel.visibility = View.GONE
            userWantsLogFloating = !userWantsLogFloating
            showLogFloating(userWantsLogFloating)
        }

        binding.ivStopAll.setOnClickListener {
            binding.llPanel.visibility = View.GONE
            stopGroupControlFromFloating("全部服务已停止")
            userWantsLogFloating = false
            showLogFloating(false)
        }
    }

    private fun isGroupControlRunning(): Boolean {
        return ScreenCaptureService.instance != null ||
            myUtils?.isServiceRunning(service, ScreenCaptureService::class.java) == true
    }

    private fun stopGroupControlFromFloating(tip: String) {
        myUtils?.autoTaskEnable = false
        myUtils?.isProjectionEnabled = false
        myUtils?.isRequestingProjection = false
        try {
            service.stopService(Intent(service, ScreenCaptureService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "stopService: ${e.message}")
        }
        ScreenCaptureService.instance?.stopSelf()
        try {
            service.sendBroadcast(
                Intent("action.close.log.floating").apply { setPackage(service.packageName) }
            )
        } catch (e: Exception) {
            Log.w(TAG, "broadcast close switch: ${e.message}")
        }
        updateControllerUI()
        if (tip.isNotEmpty()) {
            if (userWantsLogFloating) floatingLog(tip) else lines.add(tip)
        }
    }

    private fun startGroupControlFromFloating() {
        if (myUtils?.effectiveWsUsername.isNullOrBlank()) {
            floatingLog("请先在 App 主页填写后台账号")
            try {
                val intent = service.packageManager.getLaunchIntentForPackage(service.packageName)
                intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                service.startActivity(intent)
            } catch (_: Exception) {
            }
            return
        }
        if (!myUtils!!.isServiceRunning()) {
            floatingLog("请先开启群控无障碍服务")
            myUtils?.openIntentAction(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)
            return
        }
        myUtils?.autoTaskEnable = true
        myUtils?.isProjectionEnabled = true
        prepareProjectionDialogAutoClick()
        myUtils?.isRequestingProjection = true
        try {
            val intent = Intent("action.auto.start.projection").apply {
                setPackage(service.packageName)
            }
            service.sendBroadcast(intent)
            floatingLog("正在申请投屏权限…")
        } catch (e: Exception) {
            Log.e(TAG, "启动投屏广播失败: ${e.message}")
            floatingLog("启动失败，请到 App 主页点开关")
        }
        updateControllerUI()
    }

    private fun updateControllerUI() {
        val binding = controllerBinding ?: return
        val isRunning = myUtils?.isServiceRunning(service, ScreenCaptureService::class.java) == true
        binding.ivRunToggle.setImageResource(if (isRunning) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play)
        binding.ivRunToggle.setColorFilter(if (isRunning) Color.parseColor("#EF595F") else Color.WHITE)
    }

    fun floatingLog(log: String) {
        lines.add(log)
        if (lines.size > 20) lines.removeAt(0)

        if (logBinding == null && userWantsLogFloating) {
            showLogFloating(true)
        }

        val binding = logBinding ?: return
        binding.tvLog.post {
            binding.tvLog.text = ""
            for (s in lines) { binding.tvLog.append("$s\n") }
        }
    }

    private fun clickText(text: String): Boolean {
        val root = service.rootInActiveWindow ?: return false
        for (node in findAllNode(root)) {
            if (node != null && (node.text?.toString() == text || node.contentDescription?.toString() == text)) {
                val rect = Rect(); node.getBoundsInScreen(rect)
                return click(rect.centerX(), rect.centerY())
            }
        }
        return false
    }

    private fun clickNode(nodeInfo: AccessibilityNodeInfo): Boolean {
        if (nodeInfo.refresh()) {
            val rect = Rect(); nodeInfo.getBoundsInScreen(rect)
            return click(rect.left + 25, rect.top + 25)
        }
        return false
    }

    private fun inputByClz(clz: String, input: String): Boolean {
        val root = service.rootInActiveWindow ?: return false
        for (node in findAllNode(root)) {
            if (node != null && node.className?.toString() == clz) {
                val bundle = Bundle()
                bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, input)
                return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
            }
        }
        return false
    }

    private fun back() { service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK) }

    private fun detectionPage(): String {
        if (findNode("text", "我", 1, 500) && findNode("text", "首页", 1, 500)) return "home"
        if (findNode("text", "全部", 1, 500) && findNode("text", "用户", 1, 500)) return "work"
        return "unknown"
    }

    private fun findNode(type: String, con: String, num: Int, ms: Int): Boolean {
        for (i in 0 until num) {
            val root = service.rootInActiveWindow ?: continue
            for (node in findAllNode(root)) {
                if (node == null) continue
                when (type) {
                    "clz" -> if (node.className?.toString() == con) return true
                    "text" -> if (node.text?.toString() == con) return true
                    "textMatch" -> if (node.text?.toString()?.contains(con) == true) return true
                }
            }
            smartSleep(ms.toLong())
        }
        return false
    }

    private fun switchLivec(): Boolean {
        val metrics = DisplayMetrics(); windowManager.defaultDisplay.getRealMetrics(metrics)
        val path = Path().apply {
            moveTo(metrics.widthPixels * 0.5f, metrics.heightPixels * 0.8f)
            lineTo(metrics.widthPixels * 0.5f, metrics.heightPixels * 0.3f)
        }
        val stroke = GestureDescription.StrokeDescription(path, 100L, 500L)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        service.dispatchGesture(gesture, null, null)
        smartSleep(1000)
        return true
    }

    private fun getWorkNodes(str: String): List<AccessibilityNodeInfo> {
        val root = service.rootInActiveWindow ?: return emptyList()
        val res = ArrayList<AccessibilityNodeInfo>()
        for (node in findAllNode(root)) {
            if (node != null && !node.isClickable && node.text?.toString()?.contains(str) == true) {
                res.add(node)
            }
        }
        return res
    }

    private fun findAllNode(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val list = ArrayList<AccessibilityNodeInfo>()
        val queue = LinkedList<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node != null) {
                list.add(node); for (i in 0 until node.childCount) { queue.add(node.getChild(i)) }
            }
        }
        return list
    }

    private fun click(X: Int, Y: Int): Boolean {
        val path = Path().apply { moveTo(X.toFloat(), Y.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 60)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return service.dispatchGesture(gesture, null, null)
    }

    fun keepAliveByNotification(enable: Boolean) {}
    fun keepAliveByFloatingWindow(enable: Boolean) {}
    fun showDbClickFloating(enable: Boolean) {}
    fun getAppDescribeMap(): MutableMap<String, AppDescribe> = appDescribeMap
    fun closeService() { service.disableSelf() }
    fun showDbClickSetting() {}
    fun showAddDataWindow(capture: Boolean) {}

    fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (logBinding != null || controllerBinding != null) {
                myUtils?.autoTaskEnable = false
                Handler(Looper.getMainLooper()).post {
                    showControllerFloating(false); showLogFloating(false)
                }
                return true
            }
        }
        return false
    }

    fun onConfigurationChanged(newConfig: Configuration) {}
    
    fun onUnbind(intent: Intent): Boolean { 
        Handler(Looper.getMainLooper()).post {
            showControllerFloating(false); showLogFloating(false)
        }
        return true 
    }

    inner class MyBroadcastReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_OFF) { currentPackageSub = isScreenOffPre }
        }
    }

    inner class MyPackageReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {}
    }
}
