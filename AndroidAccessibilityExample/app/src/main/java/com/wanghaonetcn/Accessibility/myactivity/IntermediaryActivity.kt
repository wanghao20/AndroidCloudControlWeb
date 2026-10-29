package com.wanghaonetcn.Accessibility.myactivity

import android.content.Intent
import android.os.Bundle
import com.wanghaonetcn.Accessibility.databinding.ActivityIntermediaryBinding

class IntermediaryActivity : BaseActivity() {
    private lateinit var binding: ActivityIntermediaryBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityIntermediaryBinding.inflate(layoutInflater)
        setContentView(binding.root)
    }

    override fun onResume() {
        super.onResume()
        val pkg = intent.getStringExtra("package")
        if (pkg.isNullOrEmpty()) {
            finishAndRemoveTask()
            return
        }
        binding.tvMsg.text = "预计4s后打开$pkg"
        binding.root.postDelayed({
            val launchIntent = packageManager.getLaunchIntentForPackage(pkg)
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(launchIntent)
            }
            finishAndRemoveTask()
        }, 4000)
    }
}
