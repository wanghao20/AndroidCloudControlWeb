package com.wanghaonetcn.Accessibility.update

import com.google.gson.annotations.SerializedName

/**
 * APK 更新接口返回数据模型
 * 使用可空类型和默认值提高解析健壮性
 */
data class UpdateResponse(
    @SerializedName("download_url")
    val download_url: String? = null,
    
    @SerializedName("version")
    val version: String? = null,
    
    @SerializedName("raw_version")
    val raw_version: Int = 0,
    
    @SerializedName("dialog")
    val dialog: Boolean = false,
    
    @SerializedName("msg")
    val msg: String? = "",
    
    @SerializedName("force")
    val force: Boolean = false
)
