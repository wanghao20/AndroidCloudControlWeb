package com.wanghaonetcn.Accessibility.mybean

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(indices = [Index(value = ["appPackage"], unique = true)])
class AutoFinder {
    @PrimaryKey(autoGenerate = true)
    @JvmField
    var id: Int? = null
    
    @JvmField
    var appPackage: String = ""
    
    @JvmField
    var clickOnly: Boolean = false
    
    @JvmField
    var clickDelay: Int = 0
    
    @JvmField
    var retrieveNumber: Int = 1
    
    @JvmField
    var keywordList: MutableList<String> = ArrayList()

    override fun toString(): String {
        return "AutoFinder(id=$id, appPackage='$appPackage', clickOnly=$clickOnly, clickDelay=$clickDelay, retrieveNumber=$retrieveNumber, keywordList=$keywordList)"
    }
}
