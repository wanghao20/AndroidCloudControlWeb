package com.wanghaonetcn.Accessibility.myclass

import com.wanghaonetcn.Accessibility.mybean.GameReportBean
import com.wanghaonetcn.Accessibility.mybean.LatestMessage
import io.reactivex.rxjava3.core.Observable
import retrofit2.Call
import retrofit2.http.HTTP
import retrofit2.http.QueryMap

interface MyHttpRequest {


    @HTTP(method = "GET", path = "http://43.138.126.114:9095/game/verificationKey")
    fun getGameReport(@QueryMap queryMap: Map<String, String>): Call<GameReportBean>
}
