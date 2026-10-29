package com.wanghaonetcn.Accessibility.myclass

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Looper
import com.wanghaonetcn.Accessibility.BuildConfig
import com.wanghaonetcn.Accessibility.R
import com.wanghaonetcn.Accessibility.myactivity.KuaiShouMainActivity
import org.apache.commons.io.FileUtils
import java.io.File
import java.io.IOException
import java.io.PrintWriter
import java.io.StringWriter
import java.nio.charset.StandardCharsets

class MyUncaughtExceptionHandler(private val mContext: Context) : Thread.UncaughtExceptionHandler {
    companion object {
        private var instance: MyUncaughtExceptionHandler? = null
        @JvmStatic
        fun getInstance(context: Context): MyUncaughtExceptionHandler {
            if (instance == null) {
                instance = MyUncaughtExceptionHandler(context)
            }
            return instance!!
        }
    }

    fun run() {
        Thread.setDefaultUncaughtExceptionHandler(this)
        handleUiThreadException()
    }

    private fun handleUiThreadException() {
        while (true) {
            try {
                Looper.loop()
            } catch (e: Throwable) {
                // 上报异常
                CrashReporter.report(e, "UI_Thread")
                createExceptionNotification(e)
                e.printStackTrace()
            }
        }
    }

    override fun uncaughtException(thread: Thread, e: Throwable) {
        // 上报未捕获异常
        CrashReporter.report(e, "UncaughtException", "Thread: ${thread.name}")
        createExceptionNotification(e)
        e.printStackTrace()
    }

    fun createExceptionNotification(throwable: Throwable) {
        val stringWriter = StringWriter()
        val printWriter = PrintWriter(stringWriter)
        throwable.printStackTrace(printWriter)
        val message = """
            ${Build.FINGERPRINT}
            BuildTime: ${BuildConfig.BUILD_TIME}
            VersionCode: ${BuildConfig.VERSION_CODE}
            $stringWriter
            """.trimIndent()
        try {
            val file = File(mContext.filesDir, "exception.txt")
            FileUtils.writeStringToFile(file, message, StandardCharsets.UTF_8, false)
        } catch (e: IOException) {
            e.printStackTrace()
        }
        val notificationManager = mContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val intent = Intent(mContext, KuaiShouMainActivity::class.java)
        val builder: Notification.Builder
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channelId = mContext.packageName
            val channel = NotificationChannel(channelId, mContext.getString(R.string.app_name), NotificationManager.IMPORTANCE_DEFAULT)
            notificationManager.createNotificationChannel(channel)
            builder = Notification.Builder(mContext, channelId)
        } else {
            builder = Notification.Builder(mContext)
        }
        builder.setContentIntent(PendingIntent.getActivity(mContext, 0x01, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setAutoCancel(true)
            .setSmallIcon(R.drawable.app)
            .setContentTitle("${mContext.getText(R.string.app_name)}发生异常")
            .setContentText("${throwable.javaClass.simpleName}: ${throwable.message}")
        notificationManager.notify(0x02, builder.build())
    }
}
