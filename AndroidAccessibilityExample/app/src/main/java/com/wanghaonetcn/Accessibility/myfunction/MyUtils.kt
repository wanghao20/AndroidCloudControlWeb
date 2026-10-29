package com.wanghaonetcn.Accessibility.myfunction

import android.app.ActivityManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import com.wanghaonetcn.Accessibility.BuildConfig

/**
 * 工具类：提供全局通用的系统状态查询、偏好设置读写、及跳转功能
 */
class MyUtils private constructor(private val mContext: Context) {
    companion object {
        private const val contentProviderAuthority = "content://" + BuildConfig.APPLICATION_ID

        /**
         * 是否强制使用固定的服务器配置 (true=使用下方定义的 FIXED_SERVER_...，false=使用 App 设置页面的配置)
         * 设置为 true 以便在发布版和调试版中统一使用同一个服务器。
         */
        const val USE_FIXED_SERVER_CONFIG = true

//        /** 服务器 IP 或域名  */
       const val FIXED_SERVER_HOST = "192.168.3.100"

        /** 服务器端口 (Node.js 常用 3000, HTTPS 常用 443) */
        const val FIXED_SERVER_PORT = 3000

        /** 默认后台账号 (仅当主页未填写账号时使用) */
        const val DEFAULT_WS_USERNAME = "wh"

        /** 更新检测地址 (APK 热更新或版本检查) */
        const val FIXED_UPDATE_URL = "http://120.48.165.216:9095/common/hot-update/qk"

        @Volatile
        private var mInstance: MyUtils? = null

        @JvmStatic
        fun getInstance(context: Context): MyUtils {
            return mInstance ?: synchronized(this) {
                val appCtx = context.applicationContext ?: context
                mInstance ?: MyUtils(appCtx).also { mInstance = it }
            }
        }
    }

    fun requestShowAddDataWindow(): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "showAddDataWindow")
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    // 检查基础无障碍服务是否运行中
    fun isServiceRunning(): Boolean {
        return try {
            mContext.contentResolver.query(Uri.parse(contentProviderAuthority), null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex("isRunning")
                    index != -1 && cursor.getInt(index) == 1
                } else false
            } ?: false
        } catch (e: Exception) {
            false
        }
    }

    // 检查特定 Service 类是否正在运行（如录屏服务）
    fun isServiceRunning(context: Context, serviceClass: Class<*>): Boolean {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        @Suppress("DEPRECATION")
        for (service in manager.getRunningServices(Int.MAX_VALUE)) {
            if (serviceClass.name == service.service.className) {
                return true
            }
        }
        return false
    }

    fun requestUpdateAppDescribe(packageName: String): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "updateAppDescribe")
            put("packageName", packageName)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    fun requestUpdateAutoFinder(packageName: String): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "updateAutoFinder")
            put("packageName", packageName)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    fun requestUpdateWidget(packageName: String): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "updateWidget")
            put("packageName", packageName)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    fun requestUpdateCoordinate(packageName: String): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "updateCoordinate")
            put("packageName", packageName)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    // 更新无障碍服务的通知保活状态
    fun requestUpdateKeepAliveByNotification(enable: Boolean): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "keepAliveByNotification")
            put("value", enable)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    // 更新无障碍服务的悬浮窗保活状态
    fun requestUpdateKeepAliveByFloatingWindow(enable: Boolean): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "keepAliveByFloatingWindow")
            put("value", enable)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    // 获取保活通知开关状态
    fun getKeepAliveByNotification(): Boolean {
        val preferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        return preferences.getBoolean("keepAliveByNotification", false)
    }

    // 设置保活通知开关状态
    fun setKeepAliveByNotification(enable: Boolean): Boolean {
        val preferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        preferences.edit().putBoolean("keepAliveByNotification", enable).apply()
        return true
    }

    // 获取悬浮窗保活开关状态
    fun getKeepAliveByFloatingWindow(): Boolean {
        val preferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        return preferences.getBoolean("keepAliveByFloatingWindow", false)
    }

    // 设置悬浮窗保活开关状态
    fun setKeepAliveByFloatingWindow(enable: Boolean): Boolean {
        val preferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        preferences.edit().putBoolean("keepAliveByFloatingWindow", enable).apply()
        return true
    }

    fun requestShowDbClickSetting(): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "showDbClickSetting")
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    fun requestUpdateShowDbClickFloating(enable: Boolean): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "showDbClickFloating")
            put("value", enable)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    fun getDbClickEnable(): Boolean {
        val preferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        return preferences.getBoolean("dbClickEnable", false)
    }

    fun setDbClickEnable(enable: Boolean): Boolean {
        val preferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        preferences.edit().putBoolean("dbClickEnable", enable).apply()
        return true
    }

    fun getDbClickPosition(): Rect {
        val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        val displayMetrics = DisplayMetrics()
        (mContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(displayMetrics)
        return Rect().apply {
            left = sharedPreferences.getInt("dbClickPositionLeft", displayMetrics.widthPixels - 150)
            top = sharedPreferences.getInt("dbClickPositionTop", 0)
            right = sharedPreferences.getInt("dbClickPositionRight", displayMetrics.widthPixels)
            bottom = sharedPreferences.getInt("dbClickPositionBottom", 100)
        }
    }

    fun setDbClickPosition(rect: Rect): Boolean {
        val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
        sharedPreferences.edit().apply {
            putInt("dbClickPositionLeft", rect.left)
            putInt("dbClickPositionTop", rect.top)
            putInt("dbClickPositionRight", rect.right)
            putInt("dbClickPositionBottom", rect.bottom)
        }.apply()
        return true
    }

    // 获取设备自定义名称
    var deviceName: String?
        get() {
            val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sharedPreferences.getString("deviceName", Build.BRAND)
        }
        set(deviceName) {
            val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            sharedPreferences.edit().putString("deviceName", deviceName).apply()
        }

    // 服务器 IP（局域网直连时用，Cloudflare 域名场景见 serverWsBase）
    var serverIp: String
        get() {
            val sp = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sp.getString("serverIp", "whnetcn.top") ?: "whnetcn.top"
        }
        set(value) {
            mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
                .edit().putString("serverIp", value).apply()
        }

    // 服务器端口（Cloudflare HTTPS 用 443，局域网 Node 用 3000）
    var serverPort: String
        get() {
            val sp = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sp.getString("serverPort", "443") ?: "443"
        }
        set(value) {
            mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
                .edit().putString("serverPort", value).apply()
        }

    /**
     * WebSocket 基址（推荐填完整地址，与网页 https://whnetcn.top 对应）
     * 示例：wss://whnetcn.top/ws
     */
    var serverWsBase: String
        get() {
            val sp = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sp.getString("serverWsBase", "wss://whnetcn.top/ws") ?: "wss://whnetcn.top/ws"
        }
        set(value) {
            mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
                .edit().putString("serverWsBase", value.trim()).apply()
        }

    // 设备鉴权 Token
    var deviceToken: String
        get() {
            val sp = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sp.getString("deviceToken", "wanghaonet-device-token") ?: "wanghaonet-device-token"
        }
        set(value) {
            mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
                .edit().putString("deviceToken", value).apply()
        }

    // 后台账号 (Owner)
    var wsUsername: String
        get() {
            val sp = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sp.getString("ws_username", "") ?: ""
        }
        set(value) {
            mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
                .edit().putString("ws_username", value).apply()
        }

    /**
     * 实际上报给后台的账号：优先使用手机主页填写的 [wsUsername]；
     * 仅当未填写且开启强制固定配置时，才回退到 [DEFAULT_WS_USERNAME]。
     */
    val effectiveWsUsername: String
        get() {
            val fromUser = wsUsername.trim()
            if (fromUser.isNotEmpty()) return fromUser
            if (USE_FIXED_SERVER_CONFIG && DEFAULT_WS_USERNAME.isNotBlank()) {
                return DEFAULT_WS_USERNAME
            }
            return fromUser
        }

    // 获取基础 WebSocket URL（DeviceWebSocketClient 会追加 ?clientType=device&token=...）
    val wsFullUrl: String
        get() {
            if (USE_FIXED_SERVER_CONFIG) {
                // 如果是强制固定配置，则直接构造 URL
                return "ws://$FIXED_SERVER_HOST:$FIXED_SERVER_PORT/ws"
            }
            val custom = serverWsBase.trim()
            if (custom.isNotEmpty()) return normalizeWsEndpoint(custom)
            return buildWsUrlFromHostPort(serverIp.trim(), serverPort.trim())
        }

    private fun normalizeWsEndpoint(raw: String): String {
        var url = raw.trim().removeSuffix("/")
        if (url.startsWith("https://", ignoreCase = true)) {
            url = "wss://" + url.removePrefix("https://")
        } else if (url.startsWith("http://", ignoreCase = true)) {
            url = "ws://" + url.removePrefix("http://")
        }
        if (!url.endsWith("/ws", ignoreCase = true)) {
            url += "/ws"
        }
        return url
    }

    private fun buildWsUrlFromHostPort(host: String, port: String): String {
        if (host.startsWith("ws://", ignoreCase = true) || host.startsWith("wss://", ignoreCase = true)) {
            return normalizeWsEndpoint(host)
        }
        val useTls = port.isEmpty() || port == "443" || port.equals("https", ignoreCase = true)
        val scheme = if (useTls) "wss" else "ws"
        val portPart = when {
            useTls && (port.isEmpty() || port == "443") -> ""
            port.isEmpty() -> ":3000"
            else -> ":$port"
        }
        return "$scheme://$host$portPart/ws"
    }

    // 请求开启日志悬浮窗
    fun requestUpdateShowLogFloating(enable: Boolean): Boolean {
        val contentValues = ContentValues().apply {
            put("updateScope", "showLogFloating")
            put("value", enable)
        }
        val re = mContext.contentResolver.update(Uri.parse(contentProviderAuthority), contentValues, null, null)
        return re > 0
    }

    // 获取自动化脚本开启状态
    var autoTaskEnable: Boolean
        get() {
            val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sharedPreferences.getBoolean("autoTaskEnable", false)
        }
        set(enable) {
            val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            sharedPreferences.edit().putBoolean("autoTaskEnable", enable).apply()
        }

    /** 正在申请 MediaProjection 权限（系统「立即开始」弹窗阶段） */
    @Volatile
    var isRequestingProjection: Boolean = false

    // 录屏投屏开启状态 (用户意图)
    var isProjectionEnabled: Boolean
        get() {
            val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            return sharedPreferences.getBoolean("isProjectionEnabled", false)
        }
        set(enable) {
            val sharedPreferences = mContext.getSharedPreferences(mContext.packageName, Context.MODE_PRIVATE)
            sharedPreferences.edit().putBoolean("isProjectionEnabled", enable).apply()
        }

    /**
     * 通用跳转 Intent 方法
     */
    fun openIntentAction(action: String): Boolean {
        return try {
            val intent = Intent(action).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            mContext.startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }
}
