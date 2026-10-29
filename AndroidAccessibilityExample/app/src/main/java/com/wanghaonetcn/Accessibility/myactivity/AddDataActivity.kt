package com.wanghaonetcn.Accessibility.myactivity

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Toast
import com.wanghaonetcn.Accessibility.databinding.ActivityAddDataBinding
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import com.wanghaonetcn.Accessibility.myfunction.MyUtils

class AddDataActivity : BaseActivity() {
    private var context: Context? = null
    private var myUtils: MyUtils? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val addDataBinding = ActivityAddDataBinding.inflate(layoutInflater)
        setContentView(addDataBinding.root)
        context = applicationContext
        myUtils = MyApplication.myUtils
        
        addDataBinding.dbClick.isChecked = myUtils?.getDbClickEnable() ?: false
        addDataBinding.dbClickSetting.visibility = if (myUtils?.getDbClickEnable() == true) View.VISIBLE else View.GONE

        addDataBinding.start.setOnClickListener {
            if (myUtils?.isServiceRunning() == false) {
                requestEnableAccessibility()
            }
            myUtils?.requestShowAddDataWindow()
        }

        addDataBinding.dbClick.setOnCheckedChangeListener { _, isChecked ->
            myUtils?.setDbClickEnable(isChecked)
            myUtils?.requestUpdateShowDbClickFloating(isChecked)
            addDataBinding.dbClickSetting.visibility = if (isChecked) View.VISIBLE else View.GONE
        }

        addDataBinding.dbClickSetting.setOnClickListener {
            if (myUtils?.isServiceRunning() == false) {
                requestEnableAccessibility()
                return@setOnClickListener
            }
            myUtils?.requestShowDbClickSetting()
        }
    }

    private fun requestEnableAccessibility() {
        val intentAccessibility = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        startActivity(intentAccessibility)
        Toast.makeText(context, "请先开启无障碍服务", Toast.LENGTH_SHORT).show()
    }
}
