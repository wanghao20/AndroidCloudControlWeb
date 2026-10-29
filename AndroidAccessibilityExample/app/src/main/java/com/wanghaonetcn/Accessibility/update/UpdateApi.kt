package com.wanghaonetcn.Accessibility.update

import retrofit2.http.GET
import retrofit2.http.Url

/**
 * APK 更新接口定义
 */
interface UpdateApi {
    /**
     * 检查更新
     * 使用 @Url 支持动态传入完整地址，兼容现有 Retrofit 实例
     */
    @GET
    suspend fun checkUpdate(@Url url: String): UpdateResponse
}
