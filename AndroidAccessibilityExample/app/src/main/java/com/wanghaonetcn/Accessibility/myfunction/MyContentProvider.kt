package com.wanghaonetcn.Accessibility.myfunction

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import com.wanghaonetcn.Accessibility.mybean.AppDescribe
import com.wanghaonetcn.Accessibility.myclass.DataDao
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import java.util.*

class MyContentProvider : ContentProvider() {
    private val handler by lazy { Handler(Looper.getMainLooper()) }
    private val dataDao: DataDao? by lazy { MyApplication.dataDao }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int {
        return -1
    }

    override fun getType(uri: Uri): String? {
        return null
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? {
        return null
    }

    override fun onCreate(): Boolean {
        return true
    }

    override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor? {
        val isRunning = MyAccessibilityService.mainFunction != null || MyAccessibilityServiceNoGesture.mainFunction != null
        val matrixCursor = MatrixCursor(arrayOf("isRunning"))
        matrixCursor.addRow(arrayOf(if (isRunning) 1 else 0))
        return matrixCursor
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int {
        values?.let { v ->
            MyAccessibilityService.mainFunction?.let { mf ->
                updateData(mf.getAppDescribeMap(), v)
                updateAllDate(mf.getAppDescribeMap(), v)
                updateKeepAlive(mf, v)
                showDbClickSetting(mf, v)
                showDbClickFloating(mf, v)
                showAddDataWindow(mf, v)
                showLogFloating(mf, v)
            }
            MyAccessibilityServiceNoGesture.mainFunction?.let { mf ->
                updateData(mf.getAppDescribeMap(), v)
                updateAllDate(mf.getAppDescribeMap(), v)
                updateKeepAlive(mf, v)
                showDbClickSetting(mf, v)
                showDbClickFloating(mf, v)
                showAddDataWindow(mf, v)
                showLogFloating(mf, v)
            }
        }
        return 1
    }

    private fun updateData(appDescribeMap: MutableMap<String, AppDescribe>, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        val packageName = values.getAsString("packageName")
        if (updateScope.isNullOrEmpty() || packageName.isNullOrEmpty()) {
            return
        }
        when (updateScope) {
            "updateAppDescribe" -> {
                val appDescribe = appDescribeMap[packageName]
                if (appDescribe != null) {
                    val appDescribeNew = dataDao?.getAppDescribeByPackage(packageName)
                    if (appDescribeNew != null) {
                        appDescribeNew.autoFinder = appDescribe.autoFinder
                        appDescribeNew.widgetSetMap = appDescribe.widgetSetMap
                        appDescribeNew.coordinateMap = appDescribe.coordinateMap
                        appDescribeMap[packageName] = appDescribeNew
                    }
                }
            }
            "updateAutoFinder" -> {
                appDescribeMap[packageName]?.getAutoFinderFromDatabase(dataDao!!)
            }
            "updateWidget" -> {
                appDescribeMap[packageName]?.getWidgetSetMapFromDatabase(dataDao!!)
            }
            "updateCoordinate" -> {
                appDescribeMap[packageName]?.getCoordinateMapFromDatabase(dataDao!!)
            }
        }
    }

    private fun updateKeepAlive(mainFunction: MainFunction, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        val value = values.getAsBoolean("value")
        if (updateScope.isNullOrEmpty() || value == null) {
            return
        }
        if (updateScope == "keepAliveByNotification") {
            mainFunction.keepAliveByNotification(value)
        }
        if (updateScope == "keepAliveByFloatingWindow") {
            handler.post { mainFunction.keepAliveByFloatingWindow(value) }
        }
    }

    private fun updateAllDate(appDescribeMap: MutableMap<String, AppDescribe>, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        if (updateScope != "allDate") {
            return
        }
        val newAppDescribeMap = HashMap<String, AppDescribe>()
        for (e in appDescribeMap.keys) {
            val appDescribeTmp = dataDao?.getAppDescribeByPackage(e)
            if (appDescribeTmp != null) {
                appDescribeTmp.getOtherFieldsFromDatabase(dataDao!!)
                newAppDescribeMap[e] = appDescribeTmp
            }
        }
        appDescribeMap.putAll(newAppDescribeMap)
    }

    private fun showDbClickSetting(mainFunction: MainFunction, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        if (updateScope == "showDbClickSetting") {
            handler.post { mainFunction.showDbClickSetting() }
        }
    }

    private fun showDbClickFloating(mainFunction: MainFunction, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        val enable = values.getAsBoolean("value")
        if (updateScope == "showDbClickFloating" && enable != null) {
            handler.post { mainFunction.showDbClickFloating(enable) }
        }
    }

    private fun showAddDataWindow(mainFunction: MainFunction, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        if (updateScope == "showAddDataWindow") {
            handler.post { mainFunction.showAddDataWindow(false) }
        }
    }

    private fun showLogFloating(mainFunction: MainFunction, values: ContentValues) {
        val updateScope = values.getAsString("updateScope")
        val enable = values.getAsBoolean("value")
        if (updateScope == "showLogFloating" && enable != null) {
            handler.post { mainFunction.showLogFloating(enable) }
        }
    }
}
