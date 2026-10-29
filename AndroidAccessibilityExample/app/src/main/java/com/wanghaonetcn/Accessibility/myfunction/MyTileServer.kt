package com.wanghaonetcn.Accessibility.myfunction

import android.content.Intent
import android.provider.Settings
import android.service.quicksettings.TileService
import android.widget.Toast
import com.wanghaonetcn.Accessibility.myclass.MyApplication

class MyTileServer : TileService() {

    override fun onClick() {
        if (MyApplication.myUtils?.isServiceRunning() == true) {
            MyApplication.myUtils?.requestShowAddDataWindow()
        } else {
            val intentAccessibility = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivityAndCollapse(intentAccessibility)
            Toast.makeText(applicationContext, "请先开启无障碍服务", Toast.LENGTH_SHORT).show()
        }
    }
}
