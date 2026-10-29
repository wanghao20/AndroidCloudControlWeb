package com.wanghaonetcn.Accessibility.myactivity

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.wanghaonetcn.Accessibility.databinding.FragmentHomeBinding
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import com.wanghaonetcn.Accessibility.myfunction.*

/**
 * 首页 Fragment：负责控制台交互
 */
class HomeFragment : Fragment() {

    private var binding: FragmentHomeBinding? = null
    private var myUtils: MyUtils? = null
    private var isRequestingProjection = false // 防止重复请求
    private var rootEnableRetryCount = 0 // Root 开启重试计数

    companion object {
        const val REQUEST_MEDIA_PROJECTION = 1002
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        binding = FragmentHomeBinding.inflate(inflater, container, false)
        myUtils = MyApplication.myUtils
        initView()
        return binding?.root
    }

    private fun initView() {
        myUtils?.let {
            binding?.etWsUsername?.setText(it.wsUsername)
        }

        binding?.scState?.setOnClickListener {
            val isChecked = binding?.scState?.isChecked == true
            if (isChecked) {
                if (!persistWsUsernameFromView()) {
                    context?.let { Toast.makeText(it, "请输入后台账号", Toast.LENGTH_SHORT).show() }
                    binding?.scState?.isChecked = false
                    return@setOnClickListener
                }
                startGroupControl()
            } else {
                stopGroupControl()
            }
        }
    }

    /** 从输入框写入 SharedPreferences，确保 WS 连接使用最新账号 */
    private fun persistWsUsernameFromView(): Boolean {
        val context = context ?: return false
        val fromView = binding?.etWsUsername?.text?.toString()?.trim().orEmpty()
        val username = fromView.ifEmpty { myUtils?.wsUsername?.trim().orEmpty() }
        if (username.isEmpty()) return false
        val previous = myUtils?.wsUsername?.trim().orEmpty()
        myUtils?.wsUsername = username
        binding?.etWsUsername?.setText(username)
        if (previous.isNotEmpty() && previous != username &&
            myUtils?.isServiceRunning(context, ScreenCaptureService::class.java) == true
        ) {
            ScreenCaptureService.instance?.reconnectWebSocketWithCurrentAccount()
        }
        return true
    }

    override fun onResume() {
        super.onResume()
        updateSwitchState()
    }

    fun updateSwitchState() {
        val context = context ?: return
        if (myUtils != null && binding != null) {
            val isRunning = myUtils!!.isServiceRunning(context, ScreenCaptureService::class.java)
            binding!!.scState.isChecked = isRunning
        }
    }

    /**
     * 处理自动启动：增加 Android 14 前台检查
     */
    fun handleAutoStart() {
        if (!isResumed) return // 仅在 Fragment 可见时处理
        val context = context ?: return

        if (myUtils?.isServiceRunning(context, ScreenCaptureService::class.java) == false) {
            if (!persistWsUsernameFromView()) {
                Toast.makeText(context, "请先在主页填写后台账号", Toast.LENGTH_SHORT).show()
                return
            }
            startGroupControl()
        }
    }

    private fun startGroupControl() {
        if (!isAdded) return
        val context = context ?: return
        
        if (isRequestingProjection) return
        if (!persistWsUsernameFromView()) {
            Toast.makeText(context, "请输入后台账号", Toast.LENGTH_SHORT).show()
            binding?.scState?.isChecked = false
            return
        }

        // 尝试 Root 自动开启无障碍
        if (myUtils != null && !myUtils!!.isServiceRunning()) {
            if (ShellUtils.hasRoot()) {
                // 如果设置里已经开了，但服务还没跑起来，就再等会
                if (AccessibilityUtils.isAccessibilitySettingsOn(context, MyAccessibilityService::class.java)) {
                    if (rootEnableRetryCount < 10) { 
                        rootEnableRetryCount++
                        if (rootEnableRetryCount % 3 == 0) {
                            Log.i("HomeFragment", "无障碍已在设置中开启，等待服务初始化 ($rootEnableRetryCount/10)...")
                        }
                        view?.postDelayed({ startGroupControl() }, 1000)
                    } else {
                        rootEnableRetryCount = 0
                        Toast.makeText(context, "无障碍服务启动超时，请尝试手动开关", Toast.LENGTH_SHORT).show()
                        binding?.scState?.isChecked = false
                    }
                    return
                }

                // 仅在第一次尝试或重试时显示 Toast
                if (rootEnableRetryCount == 0) {
                    Toast.makeText(context, "正在尝试通过 Root 自动开启服务...", Toast.LENGTH_SHORT).show()
                }
                
                val success = AccessibilityUtils.autoEnableAccessibility(context, MyAccessibilityService::class.java)
                if (success) {
                    rootEnableRetryCount = 1 // 标记已发送指令，开始进入等待初始化逻辑
                    view?.postDelayed({ startGroupControl() }, 1200)
                    return
                }
            }
            
            Toast.makeText(context, "请开启无障碍服务", Toast.LENGTH_SHORT).show()
            myUtils!!.openIntentAction(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            binding?.scState?.isChecked = false
            return
        }
        
        rootEnableRetryCount = 0 // 成功启动后重置计数
        
        // 如果有 Root，尝试执行一键保活优化
        if (ShellUtils.hasRoot()) {
            val pkg = context.packageName
            val commands = arrayOf(
                "pm grant $pkg android.permission.WRITE_SECURE_SETTINGS",
                "appops set $pkg RUN_IN_BACKGROUND allow",
                "appops set $pkg RUN_ANY_IN_BACKGROUND allow",
                "dumpsys deviceidle whitelist +$pkg",
                "am set-standby-bucket $pkg active"
            )
            ShellUtils.sudo(commands)
        }

        val mpm = activity?.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        mpm?.let {
            try {
                isRequestingProjection = true
                myUtils?.isRequestingProjection = true
                MyAccessibilityService.mainFunction?.prepareProjectionDialogAutoClick()
                startActivityForResult(it.createScreenCaptureIntent(), REQUEST_MEDIA_PROJECTION)
            } catch (e: Exception) {
                isRequestingProjection = false
                myUtils?.isRequestingProjection = false
                Log.e("HomeFragment", "启动权限申请失败: ${e.message}")
            }
        }
    }

    private fun stopGroupControl() {
        val context = context ?: return
        myUtils?.let {
            it.autoTaskEnable = false
            it.isProjectionEnabled = false
            it.requestUpdateShowLogFloating(false)
        }
        activity?.stopService(Intent(context, ScreenCaptureService::class.java))
        Toast.makeText(context, "群控系统已关闭", Toast.LENGTH_SHORT).show()
    }


    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val context = context ?: return
        if (requestCode == REQUEST_MEDIA_PROJECTION) {
            isRequestingProjection = false
            myUtils?.isRequestingProjection = false
            if (resultCode == Activity.RESULT_OK && data != null) {
                val deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                val wsUrl = myUtils?.wsFullUrl ?: ""
                val token = myUtils?.deviceToken ?: ""

                if (wsUrl.isEmpty()) {
                    Toast.makeText(context, "WebSocket 地址配置异常", Toast.LENGTH_SHORT).show()
                    binding?.scState?.isChecked = false
                    return
                }

                myUtils?.let {
                    it.autoTaskEnable = true
                    it.isProjectionEnabled = true
                    it.requestUpdateShowLogFloating(false)
                }

                val wsUsername = myUtils?.effectiveWsUsername?.trim().orEmpty()
                if (wsUsername.isEmpty()) {
                    Toast.makeText(context, "后台账号为空，请重新填写", Toast.LENGTH_SHORT).show()
                    binding?.scState?.isChecked = false
                    return
                }
                val serviceIntent = ScreenCaptureService.getStartIntent(
                    context, resultCode, data, deviceId, wsUrl, token, wsUsername
                )
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        activity?.startForegroundService(serviceIntent)
                    } else {
                        activity?.startService(serviceIntent)
                    }
                    Toast.makeText(context, "投屏已建立，正在连接后台...", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Log.e("HomeFragment", "启动服务失败: ${e.message}")
                    Toast.makeText(context, "启动异常: ${e.message}", Toast.LENGTH_LONG).show()
                }
            } else {
                binding?.scState?.isChecked = false
                Toast.makeText(context, "未授予录屏权限", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        binding = null
    }
}
