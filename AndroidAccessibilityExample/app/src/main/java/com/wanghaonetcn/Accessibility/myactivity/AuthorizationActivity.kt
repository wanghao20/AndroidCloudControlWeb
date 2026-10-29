package com.wanghaonetcn.Accessibility.myactivity

import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.wanghaonetcn.Accessibility.R
import com.wanghaonetcn.Accessibility.databinding.ActivityAuthorizationBinding
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import com.wanghaonetcn.Accessibility.myfunction.MyDeviceAdminReceiver
import com.wanghaonetcn.Accessibility.myfunction.MyAccessibilityService
import com.wanghaonetcn.Accessibility.myfunction.MyUtils
import com.wanghaonetcn.Accessibility.myfunction.ScreenCaptureService

class AuthorizationActivity : AppCompatActivity() {

    private lateinit var binding: ActivityAuthorizationBinding
    private var myUtils: MyUtils? = null
    private val handler = Handler(Looper.getMainLooper())
    private val REQUEST_MEDIA_PROJECTION = 1001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAuthorizationBinding.inflate(layoutInflater)
        setContentView(binding.root)
        
        myUtils = MyApplication.myUtils

        val onOffClickListener = View.OnClickListener { v ->
            when (v.id) {
                R.id.accessibility_on_off -> {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
                R.id.device_admin_on_off -> toggleDeviceAdmin()
                R.id.batteryIgnore_on_off -> toggleBatteryIgnore()
                R.id.notification_on_off -> toggleNotification()
                R.id.floating_window_on_off -> toggleFloatingWindow()
                R.id.system_alert_on_off -> toggleSystemAlert()
                R.id.group_control_on_off -> toggleGroupControl()
                R.id.test_exception_report -> testExceptionReport()
            }
        }

        binding.accessibilityOnOff.setOnClickListener(onOffClickListener)
        binding.deviceAdminOnOff.setOnClickListener(onOffClickListener)
        binding.batteryIgnoreOnOff.setOnClickListener(onOffClickListener)
        binding.notificationOnOff.setOnClickListener(onOffClickListener)
        binding.floatingWindowOnOff.setOnClickListener(onOffClickListener)
        binding.systemAlertOnOff.setOnClickListener(onOffClickListener)
        binding.groupControlOnOff.setOnClickListener(onOffClickListener)
        binding.testExceptionReport.setOnClickListener(onOffClickListener)
    }

    private fun testExceptionReport() {
        Toast.makeText(this, "正在触发测试异常...", Toast.LENGTH_SHORT).show()
        // 触发一个空指针异常，看是否被 MyUncaughtExceptionHandler 捕获并由 CrashReporter 上报
        val nullString: String? = null
        nullString!!.length
    }

    private fun toggleDeviceAdmin() {
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        val compName = ComponentName(this, MyDeviceAdminReceiver::class.java)
        if (dpm != null && !dpm.isAdminActive(compName)) {
            val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
            intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, compName)
            startActivity(intent)
        } else {
            Toast.makeText(this, "设备管理器权限已开启", Toast.LENGTH_SHORT).show()
        }
    }

    private fun toggleBatteryIgnore() {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            @SuppressLint("BatteryLife")
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            startActivity(intent)
        } else {
            Toast.makeText(this, "忽略电池优化权限已开启", Toast.LENGTH_SHORT).show()
        }
    }

    private fun toggleNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        if (nm != null && nm.areNotificationsEnabled()) {
            val current = myUtils?.getKeepAliveByNotification() ?: false
            myUtils?.setKeepAliveByNotification(!current)
            myUtils?.requestUpdateKeepAliveByNotification(!current)
            updateStatus()
        } else {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                }
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:$packageName")
                }
            }
            startActivity(intent)
        }
    }

    private fun toggleFloatingWindow() {
        val current = myUtils?.getKeepAliveByFloatingWindow() ?: false
        myUtils?.setKeepAliveByFloatingWindow(!current)
        myUtils?.requestUpdateKeepAliveByFloatingWindow(!current)
        updateStatus()
    }

    private fun toggleSystemAlert() {
        val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
        startActivity(intent)
    }

    private fun toggleGroupControl() {
        if (myUtils?.isServiceRunning(this, ScreenCaptureService::class.java) == true) {
            myUtils?.isProjectionEnabled = false
            stopService(Intent(this, ScreenCaptureService::class.java))
            Toast.makeText(this, "群控系统已关闭", Toast.LENGTH_SHORT).show()
        } else {
            // 校验后台账号
            if (myUtils?.effectiveWsUsername.isNullOrEmpty()) {
                Toast.makeText(this, "请先在首页填写后台账号", Toast.LENGTH_SHORT).show()
                return
            }

            if (myUtils?.isServiceRunning() == false) {
                Toast.makeText(this, "请开启无障碍服务", Toast.LENGTH_SHORT).show()
                myUtils?.openIntentAction(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                return
            }
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
            if (mpm != null) {
                myUtils?.isRequestingProjection = true
                MyAccessibilityService.mainFunction?.prepareProjectionDialogAutoClick()
                startActivityForResult(mpm.createScreenCaptureIntent(), REQUEST_MEDIA_PROJECTION)
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_MEDIA_PROJECTION) {
            myUtils?.isRequestingProjection = false
        }
        if (requestCode == REQUEST_MEDIA_PROJECTION && resultCode == Activity.RESULT_OK && data != null) {
            myUtils?.let {
                it.autoTaskEnable = true
                it.isProjectionEnabled = true
                it.requestUpdateShowLogFloating(false)
            }

            val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            val wsUrl = myUtils?.wsFullUrl ?: ""
            val token = myUtils?.deviceToken ?: ""

            if (wsUrl.isEmpty() || token.isEmpty()) {
                Toast.makeText(this, "配置加载失败，请重试", Toast.LENGTH_SHORT).show()
                return
            }

            val wsUsername = myUtils?.effectiveWsUsername?.trim().orEmpty()
            val serviceIntent = ScreenCaptureService.getStartIntent(
                this, resultCode, data, deviceId, wsUrl, token, wsUsername
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            Toast.makeText(this, "群控系统已启动", Toast.LENGTH_SHORT).show()
        }
    }

    private fun updateStatus() {
        val utils = myUtils ?: return

        fun setStatus(img: android.widget.ImageView, ok: Boolean) {
            img.setImageResource(if (ok) R.drawable.ic_ok else R.drawable.ic_error)
            img.imageTintList = android.content.res.ColorStateList.valueOf(
                androidx.core.content.ContextCompat.getColor(this, if (ok) R.color.ch_success else R.color.ch_danger)
            )
        }

        setStatus(binding.accessibilityOnOffImg, utils.isServiceRunning())

        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        val isAdmin = dpm?.isAdminActive(ComponentName(this, MyDeviceAdminReceiver::class.java)) == true
        setStatus(binding.deviceAdminOnOffImg, isAdmin)

        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val isIgnoring = pm?.isIgnoringBatteryOptimizations(packageName) == true
        setStatus(binding.batteryIgnoreOnOffImg, isIgnoring)

        setStatus(binding.notificationOnOffImg, utils.getKeepAliveByNotification())
        setStatus(binding.floatingWindowOnOffImg, utils.getKeepAliveByFloatingWindow())
        setStatus(binding.systemAlertOnOffImg, Settings.canDrawOverlays(this))
        setStatus(binding.groupControlOnOffImg, utils.isServiceRunning(this, ScreenCaptureService::class.java))
    }

    private val statusRunnable = object : Runnable {
        override fun run() {
            updateStatus()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(statusRunnable)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(statusRunnable)
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
    }
}
