package com.wanghaonetcn.Accessibility.myfunction

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * 设备管理器接收器：用于增强权限控制，解决三星等系统的策略拦截
 */
class MyDeviceAdminReceiver : DeviceAdminReceiver() {
    
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        val admin = ComponentName(context, MyDeviceAdminReceiver::class.java)
        try {
            // 当 App 获得设备管理器权限时，立即设置允许所有无障碍服务。
            // 解决三星报错：“Skipping enabling service disallowed by device admin policy”
            dpm?.setPermittedAccessibilityServices(admin, null)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
