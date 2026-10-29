package com.wanghaonetcn.Accessibility.myclass

import okhttp3.RequestBody
import retrofit2.Call
import retrofit2.http.Body
import retrofit2.http.POST

/**
 * 日志上报接口
 */
interface LogApi {
    @POST("/common/mobile-logs")
    fun reportLog(@Body body: RequestBody): Call<Void>
}
