package com.wanghaonetcn.Accessibility.myclass

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * OkHttp 拦截器：捕获网络请求中的异常并上报
 */
class ExceptionInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        try {
            return chain.proceed(chain.request())
        } catch (e: IOException) {
            // 捕获网络连接超时、断开等异常
            CrashReporter.report(e, "Network", "URL: ${chain.request().url}")
            throw e
        } catch (e: Exception) {
            // 捕获其他运行时异常
            CrashReporter.report(e, "Network", "URL: ${chain.request().url}")
            throw e
        }
    }
}
