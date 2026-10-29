package com.wanghaonetcn.Accessibility.myclass

import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

/**
 * 协程异常处理与安全运行扩展函数
 */

/**
 * 全局通用协程异常处理器
 */
val globalCoroutineExceptionHandler = CoroutineExceptionHandler { _, throwable ->
    CrashReporter.report(throwable, "Coroutine")
}

/**
 * 安全启动协程，内置异常处理
 */
fun CoroutineScope.safeLaunch(
    context: CoroutineContext = EmptyCoroutineContext,
    moduleName: String = "Coroutine",
    block: suspend CoroutineScope.() -> Unit
): Job {
    val exceptionHandler = CoroutineExceptionHandler { _, throwable ->
        CrashReporter.report(throwable, moduleName)
    }
    return this.launch(context + exceptionHandler) {
        block()
    }
}

/**
 * 安全运行代码块，捕获异常并上报，不会导致崩溃
 */
inline fun <T> safeRun(moduleName: String = "Common", block: () -> T): T? {
    return try {
        block()
    } catch (e: Throwable) {
        CrashReporter.report(e, moduleName)
        null
    }
}

/**
 * 文件操作安全封装示例
 */
fun safeWriteFile(moduleName: String = "FileIO", block: () -> Unit) {
    try {
        block()
    } catch (e: java.io.IOException) {
        CrashReporter.report(e, moduleName)
    } catch (e: Exception) {
        CrashReporter.report(e, moduleName)
    }
}
