package com.wanghaonetcn.Accessibility.myfunction

import android.content.Context
import android.provider.Settings
import android.text.TextUtils
import android.util.Log

/**
 * 无障碍服务工具类：实现状态检测与 Root 下的自动开启
 */
object AccessibilityUtils {
    private const val TAG = "AccessibilityUtils"

    /**
     * 检测无障碍服务是否已开启
     */
    fun isAccessibilitySettingsOn(context: Context, serviceClass: Class<*>): Boolean {
        val serviceName = context.packageName + "/" + serviceClass.canonicalName
        var accessibilityEnabled = 0
        try {
            accessibilityEnabled = Settings.Secure.getInt(
                context.applicationContext.contentResolver,
                Settings.Secure.ACCESSIBILITY_ENABLED
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error reading accessibility status: ${e.message}")
        }

        if (accessibilityEnabled == 1) {
            val settingValue = Settings.Secure.getString(
                context.applicationContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )
            if (settingValue != null) {
                val splitter = TextUtils.SimpleStringSplitter(':')
                splitter.setString(settingValue)
                while (splitter.hasNext()) {
                    val accessibilityService = splitter.next()
                    if (accessibilityService.equals(serviceName, ignoreCase = true)) {
                        return true
                    }
                }
            }
        }
        return false
    }

    /**
     * Root 模式下尝试自动开启无障碍服务
     */
    fun autoEnableAccessibility(context: Context, serviceClass: Class<*>): Boolean {
        if (!ShellUtils.hasRoot()) {
            Log.w(TAG, "No root permission, cannot enable accessibility automatically.")
            return false
        }

        val serviceName = context.packageName + "/" + serviceClass.canonicalName
        Log.i(TAG, "Attempting to auto-enable accessibility for: $serviceName")

        return try {
            // 获取当前已开启的服务列表，避免覆盖其他服务（如 TalkBack）
            val currentServices = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            
            val newServices = if (currentServices.isEmpty()) {
                serviceName
            } else if (currentServices.contains(serviceName)) {
                currentServices
            } else {
                "$currentServices:$serviceName"
            }

            val commands = mutableListOf<String>()
            
            // 解决三星及 Android 13+ 的“受限设置”或“设备管理器策略”拦截问题
            // 1. 尝试授予 WRITE_SECURE_SETTINGS 权限（虽然 sudo 不需要，但有益于某些系统校验）
            commands.add("pm grant ${context.packageName} android.permission.WRITE_SECURE_SETTINGS")
            
            // 2. 解除 Android 13+ 对非商店安装 App 的无障碍限制 (受限设置)
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                commands.add("appops set ${context.packageName} ACCESS_RESTRICTED_SETTINGS allow")
            }
            
            // 3. 核心修复：移除三星等系统可能存在的“许可无障碍服务列表”限制
            // 如果该设置非空，系统会跳过列表外的服务。直接删除该限制确保所有服务可开启。
            commands.add("settings delete secure permitted_accessibility_services")
            
            // 4. 开启服务
            commands.add("settings put secure enabled_accessibility_services $newServices")
            commands.add("settings put secure accessibility_enabled 1")

            val result = ShellUtils.sudo(commands.toTypedArray())
            Log.i(TAG, "Auto-enable accessibility result: $result")
            result
        } catch (e: Exception) {
            Log.e(TAG, "Failed to auto-enable accessibility: ${e.message}")
            false
        }
    }
}
