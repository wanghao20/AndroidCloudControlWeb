package com.wanghaonetcn.Accessibility.myclass

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.wanghaonetcn.Accessibility.mybean.MyAppConfig
import com.wanghaonetcn.Accessibility.myfunction.MyUtils
import retrofit2.Retrofit
import retrofit2.adapter.rxjava3.RxJava3CallAdapterFactory
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.converter.scalars.ScalarsConverterFactory

class MyApplication : Application() {

    companion object {
        @JvmField
        var dataDao: DataDao? = null
        @JvmField
        var myAppConfig: MyAppConfig? = null
        @JvmField
        var myHttpRequest: MyHttpRequest? = null
        @JvmField
        var myUtils: MyUtils? = null
    }

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)

        // 提前初始化工具类，使用 base context 避免 null 检查
        myUtils = MyUtils.getInstance(base)

        if (dataDao == null) {
            val migration_1_2 = object : Migration(1, 2) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL("ALTER TABLE 'Coordinate' ADD 'comment' TEXT")
                    database.execSQL("ALTER TABLE 'Widget' ADD 'comment' TEXT")
                }
            }
            val migration_2_3 = object : Migration(2, 3) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL("ALTER TABLE 'MyAppConfig' ADD 'isVip' INTEGER NOT NULL DEFAULT 0")
                }
            }
            val migration_3_4 = object : Migration(3, 4) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL("ALTER TABLE 'Widget' ADD `noRepeat` INTEGER NOT NULL DEFAULT 0")
                }
            }
            val migration_4_5 = object : Migration(4, 5) {
                override fun migrate(database: SupportSQLiteDatabase) {
                    database.execSQL("ALTER TABLE 'AppDescribe' RENAME 'on_off' to 'onOff'")
                }
            }
            dataDao = Room.databaseBuilder(base, MyDatabase::class.java, "applicationData.db")
                .addMigrations(migration_1_2, migration_2_3, migration_3_4, migration_4_5)
                .fallbackToDestructiveMigration()
                .allowMainThreadQueries()
                .build().dataDao()
        }

        if (myAppConfig == null) {
            myAppConfig = dataDao?.getMyAppConfig()
            if (myAppConfig == null) {
                myAppConfig = MyAppConfig()
                myAppConfig?.let { dataDao?.insertMyAppConfig(it) }
            }
        }

        if (myHttpRequest == null) {
            val retrofit = Retrofit.Builder()
                .baseUrl("https://api.github.com/")
                .addConverterFactory(ScalarsConverterFactory.create())
                .addConverterFactory(GsonConverterFactory.create())
                .addCallAdapterFactory(RxJava3CallAdapterFactory.create())
                .build()
            myHttpRequest = retrofit.create(MyHttpRequest::class.java)
        }
    }

    override fun onCreate() {
        super.onCreate()
        // 初始化崩溃报告器
        CrashReporter.init()
        MyUncaughtExceptionHandler.getInstance(this).run()
    }
}
