package com.wanghaonetcn.Accessibility.myfunction

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.util.Log
import com.wanghaonetcn.Accessibility.myclass.MyApplication

/**
 * 保活广播接收器：处理开机、应用更新及网络变化
 */
class KeepAliveReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "KeepAliveReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        Log.i(TAG, "Received broadcast: $action")

        when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.i(TAG, "Device boot or package replaced. Checking root and accessibility.")
                // 1. 如果有 Root，尝试静默开启无障碍
                if (ShellUtils.hasRoot()) {
                    AccessibilityUtils.autoEnableAccessibility(context, MyAccessibilityService::class.java)
                }
                
                // 2. 引导用户进入主界面（如果必要，这里通常不强制弹窗，但可以发通知）
            }
            ConnectivityManager.CONNECTIVITY_ACTION,
            Intent.ACTION_USER_PRESENT -> {
                Log.i(TAG, "Network restored or User present. Checking service status.")
                if (ShellUtils.hasRoot() && !AccessibilityUtils.isAccessibilitySettingsOn(context, MyAccessibilityService::class.java)) {
                    AccessibilityUtils.autoEnableAccessibility(context, MyAccessibilityService::class.java)
                }
                ScreenCaptureService.instance?.ensureWsConnected()
            }
        }
    }
}
