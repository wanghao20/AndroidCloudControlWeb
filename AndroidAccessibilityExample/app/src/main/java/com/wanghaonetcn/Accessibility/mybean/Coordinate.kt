package com.wanghaonetcn.Accessibility.mybean

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.util.Objects

@Entity(indices = [Index(value = ["appPackage", "appActivity"], unique = true)])
class Coordinate {
    @PrimaryKey(autoGenerate = true)
    @JvmField
    var id: Int? = null
    
    @JvmField
    var createTime: Long = 0
    
    @JvmField
    var appPackage: String = ""
    
    @JvmField
    var appActivity: String = ""
    
    @JvmField
    var xPosition: Int = 0
    
    @JvmField
    var yPosition: Int = 0
    
    @JvmField
    var clickDelay: Int = 2000
    
    @JvmField
    var clickInterval: Int = 500
    
    @JvmField
    var clickNumber: Int = 1
    
    @JvmField
    var comment: String? = ""

    constructor() {
        this.createTime = System.currentTimeMillis()
    }

    constructor(coordinate: Coordinate) {
        this.createTime = coordinate.createTime
        this.appPackage = coordinate.appPackage
        this.appActivity = coordinate.appActivity
        this.xPosition = coordinate.xPosition
        this.yPosition = coordinate.yPosition
        this.clickDelay = coordinate.clickDelay
        this.clickInterval = coordinate.clickInterval
        this.clickNumber = coordinate.clickNumber
        this.comment = coordinate.comment
    }

    override fun equals(other: Any?): Boolean {
        if (other == null) return false
        if (this === other) return true
        if (other !is Coordinate) return false
        return this.appPackage == other.appPackage && this.appActivity == other.appActivity
    }

    override fun hashCode(): Int {
        return Objects.hash(this.appPackage, this.appActivity)
    }

    override fun toString(): String {
        return "Coordinate(id=$id, createTime=$createTime, appPackage='$appPackage', appActivity='$appActivity', xPosition=$xPosition, yPosition=$yPosition, clickDelay=$clickDelay, clickInterval=$clickInterval, clickNumber=$clickNumber, comment='$comment')"
    }
}
