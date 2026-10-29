package com.wanghaonetcn.Accessibility.myfunction

import android.util.Log
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.InputStreamReader

/**
 * Shell 工具类：支持 Root 权限检测及指令执行
 */
object ShellUtils {
    private const val TAG = "ShellUtils"

    /**
     * 检查设备是否有 Root 权限
     */
    fun hasRoot(): Boolean {
        return try {
            val process = Runtime.getRuntime().exec("su")
            val os = DataOutputStream(process.outputStream)
            os.writeBytes("exit\n")
            os.flush()
            val exitValue = process.waitFor()
            exitValue == 0
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 执行带 su 的指令
     */
    fun sudo(command: String): Boolean {
        return sudo(arrayOf(command))
    }

    /**
     * 执行多条带 su 的指令
     */
    fun sudo(commands: Array<String>): Boolean {
        var process: Process? = null
        var os: DataOutputStream? = null
        try {
            process = Runtime.getRuntime().exec("su")
            os = DataOutputStream(process.outputStream)
            for (command in commands) {
                Log.d(TAG, "Executing Shell: $command")
                os.writeBytes("$command\n")
            }
            os.writeBytes("exit\n")
            os.flush()
            val result = process.waitFor()
            Log.d(TAG, "Shell execution result: $result")
            return result == 0
        } catch (e: Exception) {
            Log.e(TAG, "Shell execution failed: ${e.message}")
            return false
        } finally {
            try {
                os?.close()
                process?.destroy()
            } catch (e: Exception) {}
        }
    }
    
    /**
     * 执行普通指令并获取输出
     */
    fun exec(command: String): String {
        val output = StringBuilder()
        try {
            val process = Runtime.getRuntime().exec(command)
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            var line: String?
            while (reader.readLine().also { line = it } != null) {
                output.append(line).append("\n")
            }
            process.waitFor()
        } catch (e: Exception) {
            Log.e(TAG, "Exec failed: ${e.message}")
        }
        return output.toString().trim()
    }
}
