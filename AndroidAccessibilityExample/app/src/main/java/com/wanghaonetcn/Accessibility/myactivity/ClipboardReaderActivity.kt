package com.wanghaonetcn.Accessibility.myactivity

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import com.wanghaonetcn.Accessibility.myfunction.DeviceClipboardHelper

/** 临时前台 Activity，用于 Android 10+ 读取系统剪切板 */
class ClipboardReaderActivity : Activity() {
    private var delivered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        window.addFlags(
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || delivered) return
        delivered = true
        window.decorView.postDelayed({
            DeviceClipboardHelper.completeForegroundRead(this@ClipboardReaderActivity)
            if (!isFinishing) finish()
        }, 120)
    }

    override fun onResume() {
        super.onResume()
        if (delivered) return
        window.decorView.postDelayed({
            if (delivered || isFinishing) return@postDelayed
            if (hasWindowFocus()) return@postDelayed
            delivered = true
            DeviceClipboardHelper.completeForegroundRead(this@ClipboardReaderActivity)
            finish()
        }, 800)
    }

    override fun onDestroy() {
        if (!delivered) {
            DeviceClipboardHelper.abortPendingRead("cancelled")
        }
        super.onDestroy()
    }
}
