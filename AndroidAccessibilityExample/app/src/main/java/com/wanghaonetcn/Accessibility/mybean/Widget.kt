package com.wanghaonetcn.Accessibility.mybean

import android.graphics.Rect
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.util.Objects

@Entity(indices = [Index(value = ["appPackage", "appActivity", "widgetRect"], unique = true)])
class Widget {
    @PrimaryKey(autoGenerate = true)
    @JvmField var id: Int? = null
    @JvmField var createTime: Long = 0
    @JvmField var appPackage: String = ""
    @JvmField var appActivity: String = ""
    @JvmField var clickDelay: Int = 0
    @JvmField var noRepeat: Boolean = false
    @JvmField var clickOnly: Boolean = false
    @JvmField var widgetClickable: Boolean = false
    @JvmField var widgetRect: Rect? = null
    @JvmField var widgetId: String = ""
    @JvmField var widgetDescribe: String = ""
    @JvmField var widgetText: String = ""
    @JvmField var comment: String? = ""

    constructor() {
        this.createTime = System.currentTimeMillis()
    }

    constructor(widget: Widget) {
        this.createTime = widget.createTime
        this.appPackage = widget.appPackage
        this.appActivity = widget.appActivity
        this.clickDelay = widget.clickDelay
        this.noRepeat = widget.noRepeat
        this.clickOnly = widget.clickOnly
        this.widgetClickable = widget.widgetClickable
        this.widgetRect = widget.widgetRect
        this.widgetId = widget.widgetId
        this.widgetDescribe = widget.widgetDescribe
        this.widgetText = widget.widgetText
        this.comment = widget.comment
    }

    override fun equals(other: Any?): Boolean {
        if (other == null) return false
        if (this === other) return true
        if (other !is Widget) return false
        return this.appPackage == other.appPackage && 
               this.appActivity == other.appActivity && 
               this.widgetRect == other.widgetRect
    }

    override fun hashCode(): Int {
        return Objects.hash(this.appPackage, this.appActivity, this.widgetRect)
    }

    override fun toString(): String {
        return "Widget(id=$id, createTime=$createTime, appPackage='$appPackage', appActivity='$appActivity', clickDelay=$clickDelay, noRepeat=$noRepeat, clickOnly=$clickOnly, widgetClickable=$widgetClickable, widgetRect=$widgetRect, widgetId='$widgetId', widgetDescribe='$widgetDescribe', widgetText='$widgetText', comment='$comment')"
    }
}
