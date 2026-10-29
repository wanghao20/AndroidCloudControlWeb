package com.wanghaonetcn.Accessibility.mybean

import androidx.room.Entity
import androidx.room.Ignore
import androidx.room.Index
import androidx.room.PrimaryKey
import com.wanghaonetcn.Accessibility.myclass.DataDao

@Entity(indices = [Index(value = ["appPackage"], unique = true)])
class AppDescribe {
    @PrimaryKey(autoGenerate = true)
    @JvmField
    var id: Int? = null
    
    @JvmField
    var appName: String = ""
    
    @JvmField
    var appPackage: String = ""
    
    @JvmField
    var onOff: Boolean = true
    
    @JvmField
    var autoFinderRetrieveTime: Int = 10000
    
    @JvmField
    var autoFinderRetrieveAllTime: Boolean = false
    
    @JvmField
    var coordinateRetrieveTime: Int = 20000
    
    @JvmField
    var coordinateRetrieveAllTime: Boolean = false
    
    @JvmField
    var widgetRetrieveTime: Int = 20000
    
    @JvmField
    var widgetRetrieveAllTime: Boolean = false
    
    @JvmField
    var autoFinderOnOFF: Boolean = true
    
    @JvmField
    var coordinateOnOff: Boolean = true
    
    @JvmField
    var widgetOnOff: Boolean = true

    @Ignore
    @Transient
    @JvmField
    var autoFinder: AutoFinder = AutoFinder()
    
    @Ignore
    @Transient
    @JvmField
    var coordinateMap: MutableMap<String, Coordinate> = HashMap()
    
    @Ignore
    @Transient
    @JvmField
    var widgetSetMap: MutableMap<String, MutableSet<Widget>> = HashMap()

    fun getOtherFieldsFromDatabase(dataDao: DataDao) {
        getAutoFinderFromDatabase(dataDao)
        getCoordinateMapFromDatabase(dataDao)
        getWidgetSetMapFromDatabase(dataDao)
    }

    fun getAutoFinderFromDatabase(dataDao: DataDao) {
        val autoFinderGet = dataDao.getAutoFinderByPackage(this.appPackage)
        autoFinder = autoFinderGet ?: autoFinder
    }

    fun getCoordinateMapFromDatabase(dataDao: DataDao) {
        coordinateMap.clear()
        for (e in dataDao.getCoordinatesByPackage(this.appPackage)) {
            coordinateMap[e.appActivity] = e
        }
    }

    fun getWidgetSetMapFromDatabase(dataDao: DataDao) {
        widgetSetMap.clear()
        val widgetList = dataDao.getWidgetsByPackage(this.appPackage)
        for (w in widgetList) {
            val widgetSet = this.widgetSetMap[w.appActivity]
            if (widgetSet == null) {
                val newSet = HashSet<Widget>()
                newSet.add(w)
                widgetSetMap[w.appActivity] = newSet
            } else {
                widgetSet.add(w)
            }
        }
    }

    override fun toString(): String {
        return "AppDescribe(id=$id, appName='$appName', appPackage='$appPackage', onOff=$onOff, autoFinderRetrieveTime=$autoFinderRetrieveTime, autoFinderRetrieveAllTime=$autoFinderRetrieveAllTime, coordinateRetrieveTime=$coordinateRetrieveTime, coordinateRetrieveAllTime=$coordinateRetrieveAllTime, widgetRetrieveTime=$widgetRetrieveTime, widgetRetrieveAllTime=$widgetRetrieveAllTime, autoFinderOnOFF=$autoFinderOnOFF, coordinateOnOff=$coordinateOnOff, widgetOnOff=$widgetOnOff, autoFinder=$autoFinder, coordinateMap=$coordinateMap, widgetSetMap=$widgetSetMap)"
    }
}
