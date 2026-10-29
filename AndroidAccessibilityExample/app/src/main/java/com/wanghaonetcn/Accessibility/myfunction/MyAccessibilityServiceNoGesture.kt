package com.wanghaonetcn.Accessibility.myfunction

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

class MyAccessibilityServiceNoGesture : AccessibilityService() {

    companion object {
        @SuppressLint("StaticFieldLeak")
        @JvmField
        var mainFunction: MainFunction? = null
    }

    override fun onCreate() {
        super.onCreate()
        mainFunction = MainFunction(this)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        mainFunction?.onServiceConnected()
        // 不再关闭带手势的主服务：网页群控依赖 MyAccessibilityService 执行点击/滑动
        if (ScreenCaptureService.instance != null) {
            android.util.Log.w(
                "NoGesture",
                "检测到群控投屏运行中，请使用「群控无障碍」服务，无手势版无法远程点击"
            )
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        mainFunction?.onAccessibilityEvent(event)
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        return mainFunction?.onKeyEvent(event) ?: super.onKeyEvent(event)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        mainFunction?.onConfigurationChanged(newConfig)
    }

    override fun onUnbind(intent: Intent): Boolean {
        mainFunction?.onUnbind(intent)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        mainFunction = null
    }

    override fun onInterrupt() {
    }
}
