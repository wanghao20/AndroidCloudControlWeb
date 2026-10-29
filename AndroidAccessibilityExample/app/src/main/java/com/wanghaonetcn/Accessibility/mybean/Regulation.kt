package com.wanghaonetcn.Accessibility.mybean

class Regulation {
    @JvmField var appDescribe: AppDescribe? = null
    @JvmField var autoFinder: AutoFinder? = null
    @JvmField var coordinateList: MutableList<Coordinate> = ArrayList()
    @JvmField var widgetList: MutableList<Widget> = ArrayList()
}
