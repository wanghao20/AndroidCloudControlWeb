package com.wanghaonetcn.Accessibility.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

/**
 * APK 安装工具类
 */
object ApkInstallUtils {
    private const val TAG = "ApkInstallUtils"

    /**
     * 调用系统安装界面安装 APK
     */
    fun installApk(context: Context, apkFile: File) {
        if (!apkFile.exists()) {
            Log.e(TAG, "[Update] 安装失败：APK 文件不存在 ${apkFile.absolutePath}")
            return
        }

        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                
                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    FileProvider.getUriForFile(
                        context,
                        "${context.packageName}.fileprovider",
                        apkFile
                    )
                } else {
                    Uri.fromFile(apkFile)
                }
                
                setDataAndType(uri, "application/vnd.android.package-archive")
            }
            context.startActivity(intent)
            Log.i(TAG, "[Update] 已调起系统安装界面")
        } catch (e: Exception) {
            Log.e(TAG, "[Update] 安装异常: ${e.message}")
        }
    }
}
