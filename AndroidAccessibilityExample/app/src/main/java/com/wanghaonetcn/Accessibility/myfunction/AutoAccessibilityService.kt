package com.wanghaonetcn.Accessibility.myfunction

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

class AutoAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(accessibilityEvent: AccessibilityEvent) {
        //任意事件触发都会调用该函数，因此可以在此实现辅助功能代码。
    }

    override fun onInterrupt() {
        //退出时调用。
    }
}
