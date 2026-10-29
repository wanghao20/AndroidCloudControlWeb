package com.wanghaonetcn.Accessibility.myactivity

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import com.wanghaonetcn.Accessibility.R
import com.wanghaonetcn.Accessibility.myclass.MyApplication

open class BaseActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
    }

    override fun onStart() {
        super.onStart()
        if (MyApplication.myAppConfig?.isVip == false) {
            val noVip = findViewById<View>(R.id.no_vip) ?: return
            noVip.visibility = View.VISIBLE
        }
    }
}
