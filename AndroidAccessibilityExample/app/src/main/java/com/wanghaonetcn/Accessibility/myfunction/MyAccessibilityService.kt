package com.wanghaonetcn.Accessibility.myfunction

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.wanghaonetcn.Accessibility.myclass.safeRun

/**
 * 无障碍服务主类：负责监听系统事件、处理按键拦截及指令初始化
 */
class MyAccessibilityService : AccessibilityService() {

    companion object {
        @SuppressLint("StaticFieldLeak")
        @JvmField
        var instance: MyAccessibilityService? = null

        @SuppressLint("StaticFieldLeak")
        @JvmField
        var mainFunction: MainFunction? = null
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        DeviceClipboardHelper.attachApplication(this)
        ControlExecutor.init(this)
        mainFunction = MainFunction(this)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        safeRun("Accessibility") {
            ControlExecutor.init(this)
            mainFunction?.onServiceConnected()
            DeviceClipboardHelper.installListener(applicationContext)

            // 群控需手势能力：若用户误开无手势版，尝试关闭以免抢占
            if (MyAccessibilityServiceNoGesture.mainFunction != null) {
                MyAccessibilityServiceNoGesture.mainFunction?.closeService()
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        safeRun("Accessibility") {
            // 分发无障碍事件（窗口变化、内容改变等）
            mainFunction?.onAccessibilityEvent(event)
        }
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        // 拦截并处理物理按键（如音量键控制开关）
        return mainFunction?.onKeyEvent(event) ?: super.onKeyEvent(event)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        mainFunction?.onConfigurationChanged(newConfig)
        ScreenCaptureService.instance?.onDisplayChanged()
    }

    override fun onUnbind(intent: Intent): Boolean {
        mainFunction?.onUnbind(intent)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance == this) {
            instance = null
            ControlExecutor.clear()
        }
        mainFunction = null
    }

    override fun onInterrupt() {
        // 服务中断回调
    }
}
