package com.wanghaonetcn.Accessibility.myfunction

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject

object DisplayMetricsHelper {

    data class Snapshot(
        val width: Int,
        val height: Int,
        val orientation: Int
    )

    /**
     * 与 [ScreenCaptureService] / 无障碍手势坐标系一致，避免网页换算 Y 轴整体偏移。
     * 优先使用投屏服务已初始化的逻辑分辨率，其次 maximumWindowMetrics，最后 getRealMetrics。
     */
    fun capture(context: Context): Snapshot {
        val orientation = context.resources.configuration.orientation
        ScreenCaptureService.getLogicalScreenSizeOrNull()?.let { (w, h) ->
            return Snapshot(w, h, orientation)
        }
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm?.maximumWindowMetrics?.bounds
            if (bounds != null) {
                val w = bounds.width()
                val h = bounds.height()
                if (w > 0 && h > 0) {
                    return Snapshot(w, h, orientation)
                }
            }
        }
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm?.defaultDisplay?.getRealMetrics(metrics)
        return Snapshot(
            width = metrics.widthPixels.coerceAtLeast(1),
            height = metrics.heightPixels.coerceAtLeast(1),
            orientation = orientation
        )
    }

    fun toJson(deviceId: String, snapshot: Snapshot): JSONObject {
        return JSONObject().apply {
            put("type", "display_update")
            put("deviceId", deviceId)
            put("width", snapshot.width)
            put("height", snapshot.height)
            put("orientation", snapshot.orientation)
        }
    }
}
