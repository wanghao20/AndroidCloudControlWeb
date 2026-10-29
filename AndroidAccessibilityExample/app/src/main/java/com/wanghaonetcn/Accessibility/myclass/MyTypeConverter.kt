package com.wanghaonetcn.Accessibility.myclass

import android.graphics.Rect
import androidx.room.TypeConverter
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

object MyTypeConverter {
    @TypeConverter
    @JvmStatic
    fun JsonToStringList(json: String?): List<String>? {
        if (json == null) return null
        return Gson().fromJson(json, object : TypeToken<List<String?>?>() {}.type)
    }

    @TypeConverter
    @JvmStatic
    fun StringListToJson(stringList: List<String?>?): String? {
        return Gson().toJson(stringList)
    }

    @TypeConverter
    @JvmStatic
    fun JsonToRect(json: String?): Rect? {
        if (json == null) return null
        return Gson().fromJson(json, Rect::class.java)
    }

    @TypeConverter
    @JvmStatic
    fun RectToJson(rect: Rect?): String? {
        return Gson().toJson(rect)
    }
}
