package com.wanghaonetcn.Accessibility.myactivity

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.wanghaonetcn.Accessibility.databinding.FragmentSettingsBinding
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import com.wanghaonetcn.Accessibility.myfunction.MyUtils

class SettingsFragment : Fragment() {

    private var binding: FragmentSettingsBinding? = null
    private var myUtils: MyUtils? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        binding = FragmentSettingsBinding.inflate(inflater, container, false)
        myUtils = MyApplication.myUtils
        
        initView()
        
        return binding?.root
    }

    private fun initView() {
        binding?.btnAuthority?.setOnClickListener {
            context?.let {
                startActivity(Intent(it, AuthorizationActivity::class.java))
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        binding = null
    }
}
