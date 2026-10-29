package com.wanghaonetcn.Accessibility.myactivity

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.wanghaonetcn.Accessibility.R
import com.wanghaonetcn.Accessibility.databinding.ActivityKuaiShouMainBinding

class KuaiShouMainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainUI"
        private const val REQUEST_CODE_PERMISSIONS = 2001
    }

    private lateinit var binding: ActivityKuaiShouMainBinding
    private var homeFragment: HomeFragment? = null
    private var settingsFragment: SettingsFragment? = null
    private var aboutFragment: AboutFragment? = null

    /**
     * 应用程序主入口：初始化 UI 布局、权限申请及 Fragment 导航
     */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // 1. 初始化 ViewBinding 并设置布局
        binding = ActivityKuaiShouMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 2. 检查并申请运行时权限 (存储、通知等)
        checkAndRequestPermissions()

        // 3. 设置沉浸式状态栏颜色
        window.statusBarColor = ContextCompat.getColor(this, R.color.tg_background)
        window.decorView.systemUiVisibility = 0

        // 4. 配置底部导航栏点击事件
        binding.navHome.setOnClickListener { showFragment(0) }
        binding.navSettings.setOnClickListener { showFragment(1) }
        binding.navAbout.setOnClickListener { showFragment(2) }

        // 5. 首次进入默认加载首页 Fragment
        if (savedInstanceState == null) {
            showFragment(0)
            
            // 启动时自动检查更新
            com.wanghaonetcn.Accessibility.update.UpdateManager.checkUpdate(this)
        }

        // 6. 注册广播接收器：监听自动化指令和界面更新通知
        val filter = IntentFilter().apply {
            addAction("action.close.log.floating")
            addAction("action.auto.start.projection")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(statusReceiver, filter)
        }
    }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val action = intent.action
            if ("action.close.log.floating" == action) {
                homeFragment?.updateSwitchState()
            } else if ("action.auto.start.projection" == action) {
                homeFragment?.handleAutoStart()
            }
        }
    }

    private fun checkAndRequestPermissions() {
        val permissions = mutableListOf<String>()
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.READ_MEDIA_IMAGES)
            permissions.add(Manifest.permission.READ_MEDIA_VIDEO)
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
        permissions.add(Manifest.permission.RECORD_AUDIO)

        val listToRequest = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (listToRequest.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, listToRequest.toTypedArray(), REQUEST_CODE_PERMISSIONS)
        }
    }

    private fun showFragment(index: Int) {
        val transaction = supportFragmentManager.beginTransaction()
        val fragment: Fragment = when (index) {
            1 -> {
                if (settingsFragment == null) settingsFragment = SettingsFragment()
                settingsFragment!!
            }
            2 -> {
                if (aboutFragment == null) aboutFragment = AboutFragment()
                aboutFragment!!
            }
            else -> {
                if (homeFragment == null) homeFragment = HomeFragment()
                homeFragment!!
            }
        }

        transaction.replace(R.id.main_fragment_container, fragment)
        transaction.commitAllowingStateLoss()
        updateDockUI(index)
    }

    private fun updateDockUI(index: Int) {
        val activeColor = ContextCompat.getColor(this, R.color.tg_accent)
        val inactiveColor = ContextCompat.getColor(this, R.color.tg_text_secondary)

        binding.ivNavHome.setColorFilter(if (index == 0) activeColor else inactiveColor)
        binding.tvNavHome.setTextColor(if (index == 0) activeColor else inactiveColor)

        binding.ivNavSettings.setColorFilter(if (index == 1) activeColor else inactiveColor)
        binding.tvNavSettings.setTextColor(if (index == 1) activeColor else inactiveColor)

        binding.ivNavAbout.setColorFilter(if (index == 2) activeColor else inactiveColor)
        binding.tvNavAbout.setTextColor(if (index == 2) activeColor else inactiveColor)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == HomeFragment.REQUEST_MEDIA_PROJECTION) {
            homeFragment?.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(statusReceiver)
        } catch (ignored: Exception) {}
    }
}
