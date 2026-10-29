package com.wanghaonetcn.Accessibility.mybean

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(indices = [Index("id")])
class MyAppConfig {
    @PrimaryKey
    @JvmField
    var id: Int? = 0
    @JvmField
    var autoHideOnTaskList: Boolean = true
    @JvmField
    var forUpdate: String = ""
    @JvmField
    var isVip: Boolean = false
}
