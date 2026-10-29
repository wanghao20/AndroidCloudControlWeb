package com.wanghaonetcn.Accessibility.myactivity

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.wanghaonetcn.Accessibility.databinding.FragmentAboutBinding

class AboutFragment : Fragment() {
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return FragmentAboutBinding.inflate(inflater, container, false).root
    }
}
