package com.wanghaonetcn.Accessibility.myclass

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import com.wanghaonetcn.Accessibility.mybean.*

@Database(
    version = 6,
    entities = [AppDescribe::class, AutoFinder::class, Coordinate::class, Widget::class, MyAppConfig::class],
    exportSchema = false
)
@TypeConverters(MyTypeConverter::class)
abstract class MyDatabase : RoomDatabase() {
    abstract fun dataDao(): DataDao
}
