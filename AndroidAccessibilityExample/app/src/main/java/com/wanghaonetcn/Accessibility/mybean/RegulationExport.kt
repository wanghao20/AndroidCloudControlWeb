package com.wanghaonetcn.Accessibility.mybean

import android.util.DisplayMetrics

class RegulationExport {
    @JvmField var fingerPrint: String? = null
    @JvmField var displayMetrics: DisplayMetrics? = null
    @JvmField var regulationList: MutableList<Regulation> = ArrayList()
}
