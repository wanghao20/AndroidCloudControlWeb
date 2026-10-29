package com.wanghaonetcn.Accessibility.myclass

import android.content.Context
import android.os.Build
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.wanghaonetcn.Accessibility.BuildConfig
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ConcurrentHashMap

/**
 * 日志上传模块：负责异常信息的收集、封装与异步上报
 */
object CrashReporter {
    private const val TAG = "CrashReporter"
    private const val BASE_URL = "http://120.48.165.216:9095"
    private val gson = Gson()
    private var logApi: LogApi? = null
    
    // 用于记录异常上报时间，实现 5 秒内去重
    private val lastReportTimes = ConcurrentHashMap<String, Long>()
    private const val REPORT_INTERVAL = 5000L

    /**
     * 初始化 Retrofit
     */
    fun init() {
        try {
            val retrofit = Retrofit.Builder()
                .baseUrl(BASE_URL)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
            logApi = retrofit.create(LogApi::class.java)
        } catch (e: Exception) {
            Log.e(TAG, "初始化 CrashReporter 失败: ${e.message}")
        }
    }

    /**
     * 上报异常信息
     * @param throwable 异常对象
     * @param module 触发模块名
     * @param extraInfo 额外信息
     */
    fun report(throwable: Throwable, module: String = "Unknown", extraInfo: String = "") {
        val stackTrace = getStackTrace(throwable)
        val exceptionMessage = throwable.message ?: "No message"
        
        // 简单以异常类名作为去重 Key
        val key = throwable.javaClass.name + module
        val now = System.currentTimeMillis()
        val lastTime = lastReportTimes[key] ?: 0L
        
        if (now - lastTime < REPORT_INTERVAL) {
            Log.d(TAG, "5秒内重复异常，跳过上报: $key")
            return
        }
        lastReportTimes[key] = now

        val contentMap = mutableMapOf<String, String>()
        contentMap["message"] = exceptionMessage
        contentMap["stackTrace"] = stackTrace
        contentMap["threadName"] = Thread.currentThread().name
        contentMap["time"] = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
        contentMap["androidVersion"] = Build.VERSION.RELEASE
        contentMap["appVersion"] = "${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})"
        contentMap["brand"] = Build.BRAND
        contentMap["model"] = Build.MODEL
        contentMap["module"] = module
        contentMap["extra"] = extraInfo
        
        // 限制内容长度，防止 OOM 或上传失败
        val contentJson = gson.toJson(contentMap)
        val safeContent = if (contentJson.length > 10000) contentJson.substring(0, 10000) + "..." else contentJson

        val rootJson = JsonObject()
        rootJson.addProperty("scriptName", Build.MODEL)
        rootJson.addProperty("level", "1")
        rootJson.addProperty("content", safeContent)

        val requestBody = rootJson.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())

        logApi?.reportLog(requestBody)?.enqueue(object : retrofit2.Callback<Void> {
            override fun onResponse(call: retrofit2.Call<Void>, response: retrofit2.Response<Void>) {
                if (response.isSuccessful) {
                    Log.d(TAG, "异常日志上报成功")
                } else {
                    Log.e(TAG, "异常日志上报失败: ${response.code()}")
                }
            }

            override fun onFailure(call: retrofit2.Call<Void>, t: Throwable) {
                Log.e(TAG, "异常日志上报网络异常: ${t.message}")
            }
        })
    }

    /**
     * 获取完整的堆栈信息
     */
    private fun getStackTrace(throwable: Throwable): String {
        val sw = StringWriter()
        val pw = PrintWriter(sw)
        throwable.printStackTrace(pw)
        return sw.toString()
    }
}
