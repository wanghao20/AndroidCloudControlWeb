package com.wanghaonetcn.Accessibility.update

import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import android.util.Log
import android.view.WindowManager
import androidx.core.content.ContextCompat
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import com.wanghaonetcn.Accessibility.myfunction.MyUtils
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.File

/**
 * APK 更新管理类
 */
object UpdateManager {
    private const val TAG = "UpdateManager"
    private var isChecking = false
    private var isDownloading = false
    private var downloadId: Long = -1

    /**
     * 检查更新逻辑
     */
    fun checkUpdate(context: Context) {
        if (isChecking) return
        isChecking = true
        Log.i(TAG, "[Update] 开始检查更新...")

        CoroutineScope(Dispatchers.IO).launch {
            try {
                Log.d(TAG, "[Update] 正在构建 Retrofit...")
                
                // 从完整更新地址中提取 baseUrl (或者直接用一个占位符，因为 api 调用使用了 @Url)
                val updateUrl = MyUtils.FIXED_UPDATE_URL
                val uri = Uri.parse(updateUrl)
                val baseUrl = "${uri.scheme}://${uri.host}:${uri.port}/"

                val retrofit = Retrofit.Builder()
                    .baseUrl(baseUrl)
                    .addConverterFactory(GsonConverterFactory.create())
                    .build()
                val api = retrofit.create(UpdateApi::class.java)

                Log.d(TAG, "[Update] 正在请求接口: $updateUrl")
                val response = api.checkUpdate(updateUrl)
                Log.d(TAG, "[Update] 接口返回: $response")
                
                val localVersionName = VersionUtils.getVersionName(context)
                val remoteVersionName = response.version ?: ""
                val downloadUrl = response.download_url
                
                Log.i(TAG, "[Update] 当前版本: $localVersionName, 服务端版本: $remoteVersionName")

                if (remoteVersionName.isNotEmpty() && 
                    !downloadUrl.isNullOrEmpty() && 
                    VersionUtils.isNewerVersion(localVersionName, remoteVersionName)) {
                    Log.i(TAG, "[Update] 检测到新版本，准备弹窗")
                    withContext(Dispatchers.Main) {
                        showUpdateDialog(context, response)
                    }
                } else {
                    Log.i(TAG, "[Update] 当前已是最新版本或不满足更新条件")
                }
            } catch (e: Exception) {
                Log.e(TAG, "[Update] 检查更新过程中发生异常: ${Log.getStackTraceString(e)}")
            } finally {
                isChecking = false
            }
        }
    }

    /**
     * 显示更新弹窗
     */
    private fun showUpdateDialog(context: Context, response: UpdateResponse) {
        if (!response.dialog) return

        // 如果 context 是 Activity，直接使用它显示普通对话框
        // 否则优先使用无障碍服务的 Context，以确保 TYPE_ACCESSIBILITY_OVERLAY 生效
        val isActivity = context is android.app.Activity
        val dialogContext = if (isActivity) context else (com.wanghaonetcn.Accessibility.myfunction.MyAccessibilityService.instance ?: context)
        
        val builder = AlertDialog.Builder(dialogContext, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("发现新版本 v${response.version}")
            .setMessage(response.msg)
            .setPositiveButton("立即更新") { _, _ ->
                startDownload(context, response.download_url ?: "")
            }
            
        if (response.force) {
            builder.setCancelable(false)
        } else {
            builder.setNegativeButton("稍后再说", null)
        }

        try {
            val dialog = builder.create()
            
            // 如果不是 Activity，则需要设置窗口类型以在后台显示
            if (!isActivity) {
                if (com.wanghaonetcn.Accessibility.myfunction.MyAccessibilityService.instance != null) {
                    dialog.window?.setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
                } else {
                    // 否则回退到通用悬浮窗类型（需要悬浮窗权限）
                    val type = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    } else {
                        @Suppress("DEPRECATION")
                        WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
                    }
                    dialog.window?.setType(type)
                }
            }
            
            dialog.show()
            Log.i(TAG, "[Update] 弹出更新对话框")
        } catch (e: Exception) {
            Log.e(TAG, "[Update] 弹窗显示失败: ${e.message}")
        }
    }

    /**
     * 开始下载 APK
     */
    private fun startDownload(context: Context, url: String) {
        if (isDownloading) return
        isDownloading = true
        Log.i(TAG, "[Update] 开始下载 APK: $url")

        val request = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle("正在下载更新...")
            setDescription("APK 下载中")
            // 关键修复：移除对媒体扫描器的依赖，避免 MediaProvider 报错
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            
            // 存储路径：Android/data/包名/files/Download/update.apk
            // 确保目录存在
            val downloadDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            val file = File(downloadDir, "update.apk")
            if (file.exists()) file.delete()
            
            // 使用应用私有目录，不需要额外权限，但不能让系统扫描它
            setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "update.apk")
        }

        try {
            val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            downloadId = dm.enqueue(request)

            // 注册下载完成广播
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                    if (id == downloadId) {
                        isDownloading = false
                        Log.i(TAG, "[Update] APK 下载完成")
                        
                        // 下载完成后，再次确认文件路径并安装
                        val apkFile = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "update.apk")
                        if (apkFile.exists()) {
                            ApkInstallUtils.installApk(context, apkFile)
                        } else {
                            Log.e(TAG, "[Update] 下载完成但文件不存在: ${apkFile.absolutePath}")
                        }
                        
                        try {
                            context.unregisterReceiver(this)
                        } catch (e: Exception) {}
                    }
                }
            }
            
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_EXPORTED)
            } else {
                context.registerReceiver(receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE))
            }
        } catch (e: Exception) {
            isDownloading = false
            Log.e(TAG, "[Update] 提交下载任务失败: ${e.message}")
        }
    }
}
