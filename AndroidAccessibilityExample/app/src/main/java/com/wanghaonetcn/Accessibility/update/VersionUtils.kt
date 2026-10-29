package com.wanghaonetcn.Accessibility.update

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * 版本信息工具类
 */
object VersionUtils {

    /**
     * 获取当前应用的 VersionCode
     */
    fun getVersionCode(context: Context): Int {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo.longVersionCode.toInt()
            } else {
                @Suppress("DEPRECATION")
                packageInfo.versionCode
            }
        } catch (e: Exception) {
            0
        }
    }

    /**
     * 获取当前应用的 VersionName (例如 "1.0.3")
     */
    fun getVersionName(context: Context): String {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            packageInfo.versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }
    }

    /**
     * 比较语义化版本号
     * @param current 当前版本，如 "1.0.3"
     * @param target 目标版本，如 "1.0.4"
     * @return 如果 target > current 返回 true
     */
    fun isNewerVersion(current: String, target: String): Boolean {
        if (current == target) return false
        try {
            val currArray = current.split(".").map { it.toIntOrNull() ?: 0 }
            val targetArray = target.split(".").map { it.toIntOrNull() ?: 0 }

            val maxLength = maxOf(currArray.size, targetArray.size)
            for (i in 0 until maxLength) {
                val currV = if (i < currArray.size) currArray[i] else 0
                val targetV = if (i < targetArray.size) targetArray[i] else 0
                if (targetV > currV) return true
                if (targetV < currV) return false
            }
        } catch (e: Exception) {
            return false
        }
        return false
    }
}
