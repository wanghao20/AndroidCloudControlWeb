# --------------------------------------------------------
# 1. 基础 Android 核心组件保护
# --------------------------------------------------------
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Application
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.content.ContentProvider
-keep public class * extends android.accessibilityservice.AccessibilityService
-keep public class * extends android.view.View
-keep class android.support.v4.app.** { *; }
-keep interface android.support.v4.app.** { *; }
-keep class androidx.core.app.** { *; }

# --------------------------------------------------------
# 2. 数据库与数据模型保护 (防止打包后找不到类或解析失败)
# --------------------------------------------------------
-keep class androidx.room.** { *; }
-keep class * extends androidx.room.RoomDatabase
-keep class com.wanghaonetcn.Accessibility.myclass.** { *; }
-keep class com.wanghaonetcn.Accessibility.mybean.** { *; }
-keep class com.wanghaonetcn.Accessibility.myfunction.** { *; }
-keep class com.wanghaonetcn.Accessibility.update.** { *; }
-keepnames class com.wanghaonetcn.Accessibility.mybean.** { *; }
-keepnames class com.wanghaonetcn.Accessibility.update.** { *; }
-keepclassmembers class com.wanghaonetcn.Accessibility.mybean.** { *; }
-keepclassmembers class com.wanghaonetcn.Accessibility.update.** { *; }
-keep class * extends androidx.room.Entity
-keep class * extends androidx.room.Dao
-dontwarn androidx.room.**

# --------------------------------------------------------
# 3. 网络库与 JSON 解析保护 (Gson, OkHttp, Retrofit)
# --------------------------------------------------------
-keepattributes Signature, InnerClasses, EnclosingMethod, *Annotation*
-keep class com.google.gson.** { *; }
-keep class retrofit2.** { *; }
-keep class okhttp3.** { *; }
-dontwarn okio.**
-dontwarn retrofit2.**
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# --------------------------------------------------------
# 4. WebSocket 与 Kotlin 兼容
# --------------------------------------------------------
-keep class org.java_websocket.** { *; }
-keep class kotlin.** { *; }
-keep class kotlin.Metadata { *; }
-dontwarn kotlin.**

# --------------------------------------------------------
# 5. 其他组件
# --------------------------------------------------------
-keep class com.wanghaonetcn.Accessibility.databinding.** { *; }
-keep class com.wanghaonetcn.Accessibility.BuildConfig { *; }

# 忽略警告，确保编译通过
-ignorewarnings
-dontnote
