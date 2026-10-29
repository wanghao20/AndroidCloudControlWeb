package com.wanghaonetcn.Accessibility.myactivity

import android.animation.LayoutTransition
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.DisplayMetrics
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.core.content.FileProvider
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonSyntaxException
import com.google.gson.reflect.TypeToken
import com.wanghaonetcn.Accessibility.BuildConfig
import com.wanghaonetcn.Accessibility.databinding.*
import com.wanghaonetcn.Accessibility.mybean.*
import com.wanghaonetcn.Accessibility.myclass.DataDao
import com.wanghaonetcn.Accessibility.myclass.MyApplication
import com.wanghaonetcn.Accessibility.myfunction.MyUtils
import org.apache.commons.codec.digest.DigestUtils
import org.apache.commons.io.FileUtils
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.*
import java.util.stream.Collectors

class EditDataActivity : BaseActivity() {

    companion object {
        @JvmField
        var appDescribe: AppDescribe? = null
    }

    private var context: Context? = null
    private var inflater: LayoutInflater? = null
    private var dataDao: DataDao? = null
    private var metrics: DisplayMetrics? = null
    private var dateFormatModify: SimpleDateFormat? = null
    private var dateFormatCreate: SimpleDateFormat? = null
    private lateinit var editDataBinding: ActivityEditDataBinding
    private var baseSettingBinding: ViewBaseSettingBinding? = null
    private var autoFinderBinding: ViewAutoFinderBinding? = null
    private var pkgSuggestNotOnList: Set<String>? = null
    private var myUtils: MyUtils? = null

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        inflater = layoutInflater
        editDataBinding = ActivityEditDataBinding.inflate(inflater!!)
        setContentView(editDataBinding.root)

        dataDao = MyApplication.dataDao
        myUtils = MyApplication.myUtils
        context = applicationContext
        dateFormatModify = SimpleDateFormat("HH:mm:ss a", Locale.getDefault())
        dateFormatCreate = SimpleDateFormat("yyyy-MM-dd HH:mm:ss a", Locale.getDefault())
        metrics = DisplayMetrics()
        windowManager.defaultDisplay.getRealMetrics(metrics)

        val pkgSysSet = packageManager.getInstalledPackages(PackageManager.MATCH_SYSTEM_ONLY)
            .stream().map { it.packageName }
            .collect(Collectors.toSet())
        val pkgInputMethodSet = getSystemService(InputMethodManager::class.java)
            .inputMethodList
            .stream()
            .map { it.packageName }
            .collect(Collectors.toSet())
        val pkgHasHomeSet = packageManager
            .queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_ALL)
            .stream()
            .map { it.activityInfo.packageName }
            .collect(Collectors.toSet())
        
        val suggestSet = HashSet<String>()
        suggestSet.addAll(pkgSysSet)
        suggestSet.addAll(pkgInputMethodSet)
        suggestSet.addAll(pkgHasHomeSet)
        pkgSuggestNotOnList = suggestSet

        val transition = LayoutTransition()
        transition.enableTransitionType(LayoutTransition.CHANGING)
        editDataBinding.rootLayout.layoutTransition = transition
        editDataBinding.baseSettingLayout.layoutTransition = transition
        editDataBinding.autoFinderLayout.layoutTransition = transition
        editDataBinding.coordinateLayout.layoutTransition = transition
        editDataBinding.widgetLayout.layoutTransition = transition

        editDataBinding.scrollView.setOnTouchListener { _, event ->
            if (event.action != MotionEvent.ACTION_MOVE) {
                editDataBinding.root.requestFocus()
            }
            false
        }
    }

    override fun onStart() {
        super.onStart()
        val extraStr = intent.getStringExtra("packageName")
        if (!extraStr.isNullOrEmpty()) {
            val appDescribeTemp = dataDao?.getAppDescribeByPackage(extraStr)
            if (appDescribeTemp != null) {
                appDescribeTemp.getOtherFieldsFromDatabase(dataDao!!)
                appDescribe = appDescribeTemp
            }
        }
        val currentApp = appDescribe
        if (currentApp == null) {
            finishAndRemoveTask()
            return
        }
        
        baseSettingBinding?.let { editDataBinding.baseSettingLayout.removeView(it.root) }
        
        val bsBinding = ViewBaseSettingBinding.inflate(inflater!!)
        baseSettingBinding = bsBinding
        bsBinding.onOffName.setText(currentApp.appName)
        bsBinding.onOffSwitch.isChecked = currentApp.onOff

        bsBinding.autoFinderSwitch.isChecked = currentApp.autoFinderOnOFF
        bsBinding.autoFinderSustainTime.setText(currentApp.autoFinderRetrieveTime.toString())
        bsBinding.autoFinderRetrieveAllTime.isChecked = currentApp.autoFinderRetrieveAllTime

        bsBinding.coordinateSwitch.isChecked = currentApp.coordinateOnOff
        bsBinding.coordinateSustainTime.setText(currentApp.coordinateRetrieveTime.toString())
        bsBinding.coordinateRetrieveAllTime.isChecked = currentApp.coordinateRetrieveAllTime

        bsBinding.widgetSwitch.isChecked = currentApp.widgetOnOff
        bsBinding.widgetSustainTime.setText(currentApp.widgetRetrieveTime.toString())
        bsBinding.widgetRetrieveAllTime.isChecked = currentApp.widgetRetrieveAllTime

        val baseSettingSaveRun = Runnable {
            val autoFinderTime = bsBinding.autoFinderSustainTime.text.toString()
            val coordinateTime = bsBinding.coordinateSustainTime.text.toString()
            val widgetTime = bsBinding.widgetSustainTime.text.toString()
            editDataBinding.baseSettingModify.setTextColor(-0x10000)
            if (autoFinderTime.isEmpty() || coordinateTime.isEmpty() || widgetTime.isEmpty()) {
                editDataBinding.baseSettingModify.text = "内容不能为空"
                return@Runnable
            }
            currentApp.onOff = bsBinding.onOffSwitch.isChecked
            currentApp.autoFinderOnOFF = bsBinding.autoFinderSwitch.isChecked
            currentApp.autoFinderRetrieveTime = autoFinderTime.toInt()
            currentApp.autoFinderRetrieveAllTime = bsBinding.autoFinderRetrieveAllTime.isChecked
            currentApp.coordinateOnOff = bsBinding.coordinateSwitch.isChecked
            currentApp.coordinateRetrieveTime = coordinateTime.toInt()
            currentApp.coordinateRetrieveAllTime = bsBinding.coordinateRetrieveAllTime.isChecked
            currentApp.widgetOnOff = bsBinding.widgetSwitch.isChecked
            currentApp.widgetRetrieveTime = widgetTime.toInt()
            currentApp.widgetRetrieveAllTime = bsBinding.widgetRetrieveAllTime.isChecked
            dataDao?.updateAppDescribe(currentApp)
            editDataBinding.baseSettingModify.setTextColor(-0x1000000)
            editDataBinding.baseSettingModify.text = "${dateFormatModify?.format(Date())} (修改成功)"
        }

        bsBinding.onOffSwitch.setOnClickListener {
            val isChecked = bsBinding.onOffSwitch.isChecked
            val runnable = Runnable {
                bsBinding.onOffSwitch.isChecked = isChecked
                bsBinding.autoFinderSwitch.isChecked = isChecked
                bsBinding.widgetSwitch.isChecked = isChecked
                bsBinding.coordinateSwitch.isChecked = isChecked
                baseSettingSaveRun.run()
            }
            if (isChecked && pkgSuggestNotOnList?.contains(currentApp.appPackage) == true) {
                bsBinding.onOffSwitch.isChecked = false
                val view = ViewOnOffWarningBinding.inflate(layoutInflater).root
                AlertDialog.Builder(this)
                    .setView(view)
                    .setNegativeButton("取消", null)
                    .setPositiveButton("确定") { _, _ -> runnable.run() }
                    .create().show()
            } else {
                runnable.run()
            }
        }

        val onOffClickListener = View.OnClickListener { baseSettingSaveRun.run() }
        bsBinding.autoFinderSwitch.setOnClickListener(onOffClickListener)
        bsBinding.widgetSwitch.setOnClickListener(onOffClickListener)
        bsBinding.coordinateSwitch.setOnClickListener(onOffClickListener)

        val sustainTimeTextWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { baseSettingSaveRun.run() }
        }
        bsBinding.autoFinderSustainTime.addTextChangedListener(sustainTimeTextWatcher)
        bsBinding.widgetSustainTime.addTextChangedListener(sustainTimeTextWatcher)
        bsBinding.coordinateSustainTime.addTextChangedListener(sustainTimeTextWatcher)

        val allTimeClickListener = View.OnClickListener { baseSettingSaveRun.run() }
        bsBinding.autoFinderRetrieveAllTime.setOnClickListener(allTimeClickListener)
        bsBinding.widgetRetrieveAllTime.setOnClickListener(allTimeClickListener)
        bsBinding.coordinateRetrieveAllTime.setOnClickListener(allTimeClickListener)
        editDataBinding.baseSettingLayout.addView(bsBinding.root)

        autoFinderBinding?.let { editDataBinding.autoFinderLayout.removeView(it.root) }
        val afBinding = ViewAutoFinderBinding.inflate(inflater!!)
        autoFinderBinding = afBinding
        afBinding.retrieveKeyword.setText(if (currentApp.autoFinder.keywordList.isEmpty()) "" else Gson().toJson(currentApp.autoFinder.keywordList))
        afBinding.retrieveNumber.setText(currentApp.autoFinder.retrieveNumber.toString())
        afBinding.clickDelay.setText(currentApp.autoFinder.clickDelay.toString())
        afBinding.clickOnly.isChecked = currentApp.autoFinder.clickOnly

        val autoFinderSaveRun = Runnable {
            val keywordList = afBinding.retrieveKeyword.text.toString().trim()
            val retrieveNumber = afBinding.retrieveNumber.text.toString()
            val clickDelay = afBinding.clickDelay.text.toString()
            editDataBinding.autoFinderModify.setTextColor(-0x10000)
            val temKeyword: MutableList<String>
            try {
                val json = if (keywordList.isEmpty() || keywordList.equals("null", true)) "[]" else keywordList
                temKeyword = Gson().fromJson(json, object : TypeToken<MutableList<String>>() {}.type)
            } catch (jse: JsonSyntaxException) {
                editDataBinding.autoFinderModify.text = "关键词格式填写错误"
                return@Runnable
            }
            if (retrieveNumber.isEmpty() || clickDelay.isEmpty()) {
                editDataBinding.autoFinderModify.text = "内容不能为空"
                return@Runnable
            }
            val rNum = retrieveNumber.toInt()
            val cDelay = clickDelay.toInt()
            if (rNum !in 1..100) {
                editDataBinding.autoFinderModify.text = "检索次数应为1~100次之间"
                return@Runnable
            }
            if (cDelay > 8000) {
                editDataBinding.autoFinderModify.text = "点击延迟应为0~8000(ms)之间"
                return@Runnable
            }
            currentApp.autoFinder.keywordList = temKeyword
            currentApp.autoFinder.retrieveNumber = rNum
            currentApp.autoFinder.clickDelay = cDelay
            currentApp.autoFinder.clickOnly = afBinding.clickOnly.isChecked
            dataDao?.updateAutoFinder(currentApp.autoFinder)
            editDataBinding.autoFinderModify.setTextColor(-0x1000000)
            editDataBinding.autoFinderModify.text = "${dateFormatModify?.format(Date())} (修改成功)"
        }

        val autoFinderTextWatcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { autoFinderSaveRun.run() }
        }
        afBinding.retrieveKeyword.addTextChangedListener(autoFinderTextWatcher)
        afBinding.retrieveNumber.addTextChangedListener(autoFinderTextWatcher)
        afBinding.clickDelay.addTextChangedListener(autoFinderTextWatcher)
        afBinding.clickOnly.setOnClickListener { autoFinderSaveRun.run() }
        editDataBinding.autoFinderLayout.addView(afBinding.root)

        val coordinateList = ArrayList(currentApp.coordinateMap.values)
        editDataBinding.coordinateLayout.visibility = if (coordinateList.isEmpty()) View.GONE else View.VISIBLE
        coordinateList.sortByDescending { it.createTime }
        
        if (editDataBinding.coordinateLayout.childCount > 2) {
            editDataBinding.coordinateLayout.removeViews(2, editDataBinding.coordinateLayout.childCount - 2)
        }
        
        for (e in coordinateList) {
            val coordBinding = ViewCoordinateBinding.inflate(inflater!!)
            coordBinding.coordinateActivity.text = e.appActivity
            coordBinding.coordinateXPosition.setText(e.xPosition.toString())
            coordBinding.coordinateYPosition.setText(e.yPosition.toString())
            coordBinding.coordinateClickDelay.setText(e.clickDelay.toString())
            coordBinding.coordinateClickInterval.setText(e.clickInterval.toString())
            coordBinding.coordinateClickNumber.setText(e.clickNumber.toString())
            coordBinding.coordinateComment.setText(e.comment)
            coordBinding.coordinateCreateTime.setText(dateFormatCreate?.format(Date(e.createTime)))

            val coordinateSaveRun = Runnable {
                val sX = coordBinding.coordinateXPosition.text.toString()
                val sY = coordBinding.coordinateYPosition.text.toString()
                val sDelay = coordBinding.coordinateClickDelay.text.toString()
                val sInterval = coordBinding.coordinateClickInterval.text.toString()
                val sNumber = coordBinding.coordinateClickNumber.text.toString()
                val sComment = coordBinding.coordinateComment.text.toString().trim()
                coordBinding.coordinateModify.setTextColor(-0x10000)
                if (sX.isEmpty() || sY.isEmpty() || sDelay.isEmpty() || sInterval.isEmpty() || sNumber.isEmpty()) {
                    coordBinding.coordinateModify.text = "内容不能为空"
                    return@Runnable
                }
                val x = sX.toInt()
                val y = sY.toInt()
                val d = sDelay.toInt()
                val i = sInterval.toInt()
                val n = sNumber.toInt()
                
                metrics?.let {
                    if (x > it.widthPixels) {
                        coordBinding.coordinateModify.text = "X坐标超出屏幕寸"
                        return@Runnable
                    }
                    if (y > it.heightPixels) {
                        coordBinding.coordinateModify.text = "Y坐标超出屏幕寸"
                        return@Runnable
                    }
                }
                if (d > 8000) {
                    coordBinding.coordinateModify.text = "点击延迟应为0~8000(ms)之间"
                    return@Runnable
                }
                if (i !in 100..2000) {
                    coordBinding.coordinateModify.text = "点击间隔应为100~2000(ms)之间"
                    return@Runnable
                }
                if (n !in 1..20) {
                    coordBinding.coordinateModify.text = "点击次数应为1~20次之间"
                    return@Runnable
                }
                
                e.xPosition = x
                e.yPosition = y
                e.clickDelay = d
                e.clickInterval = i
                e.clickNumber = n
                e.comment = sComment
                
                dataDao?.updateCoordinate(e)
                coordBinding.coordinateModify.setTextColor(-0x1000000)
                coordBinding.coordinateModify.text = "${dateFormatModify?.format(Date())} (修改成功)"
            }

            val coordTextWatcher = object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { coordinateSaveRun.run() }
            }
            coordBinding.coordinateXPosition.addTextChangedListener(coordTextWatcher)
            coordBinding.coordinateYPosition.addTextChangedListener(coordTextWatcher)
            coordBinding.coordinateClickDelay.addTextChangedListener(coordTextWatcher)
            coordBinding.coordinateClickInterval.addTextChangedListener(coordTextWatcher)
            coordBinding.coordinateClickNumber.addTextChangedListener(coordTextWatcher)
            coordBinding.coordinateComment.addTextChangedListener(coordTextWatcher)

            coordBinding.coordinateShare.setOnClickListener {
                val coordinateShare = CoordinateShare()
                coordinateShare.coordinate = e
                coordinateShare.basicContent = BasicContent()
                coordinateShare.basicContent?.fingerPrint = Build.FINGERPRINT
                coordinateShare.basicContent?.displayMetrics = DisplayMetrics()
                windowManager.defaultDisplay.getRealMetrics(coordinateShare.basicContent?.displayMetrics)
                coordinateShare.basicContent?.packageName = e.appPackage
                try {
                    val packageInfo = packageManager.getPackageInfo(e.appPackage, PackageManager.GET_META_DATA)
                    coordinateShare.basicContent?.versionCode = packageInfo.versionCode
                    coordinateShare.basicContent?.versionName = packageInfo.versionName
                } catch (ex: PackageManager.NameNotFoundException) {
                    ex.printStackTrace()
                }
                val gson = GsonBuilder().setPrettyPrinting().create()
                val strRule = "\"${CoordinateShare::class.java.simpleName}\": ${gson.toJson(coordinateShare)}"
                showEditShareFileNameDialog(strRule)
            }

            coordBinding.coordinateDelete.setOnClickListener {
                AlertDialog.Builder(this)
                    .setTitle("确定删除？")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("确定") { _, _ ->
                        dataDao?.deleteCoordinate(e)
                        currentApp.coordinateMap.remove(e.appActivity)
                        editDataBinding.coordinateLayout.removeView(coordBinding.root)
                        if (currentApp.coordinateMap.isEmpty()) {
                            editDataBinding.coordinateLayout.visibility = View.GONE
                        }
                    }.create().show()
            }
            editDataBinding.coordinateLayout.addView(coordBinding.root)
        }

        val widgetSetList = ArrayList(currentApp.widgetSetMap.values)
        editDataBinding.widgetLayout.visibility = if (widgetSetList.isEmpty()) View.GONE else View.VISIBLE
        if (editDataBinding.widgetLayout.childCount > 2) {
            editDataBinding.widgetLayout.removeViews(2, editDataBinding.widgetLayout.childCount - 2)
        }
        
        for (widgetSet in widgetSetList) {
            val widgetList = ArrayList(widgetSet)
            widgetList.sortByDescending { it.createTime }
            for (e in widgetList) {
                val wBinding = ViewWidgetBinding.inflate(inflater!!)
                wBinding.widgetActivity.text = e.appActivity
                wBinding.widgetClickable.setText(e.widgetClickable.toString())
                wBinding.widgetRect.setText(e.widgetRect?.toShortString() ?: "")
                wBinding.widgetId.setText(e.widgetId)
                wBinding.widgetDescribe.setText(e.widgetDescribe)
                wBinding.widgetText.setText(e.widgetText)
                wBinding.widgetClickDelay.setText(e.clickDelay.toString())
                wBinding.widgetNoRepeat.isChecked = e.noRepeat
                wBinding.widgetClickOnly.isChecked = e.clickOnly
                wBinding.widgetComment.setText(e.comment)
                wBinding.widgetCreateTime.setText(dateFormatCreate?.format(Date(e.createTime)))

                val widgetSaveRun = Runnable {
                    val cDelayStr = wBinding.widgetClickDelay.text.toString()
                    wBinding.widgetModify.setTextColor(-0x10000)
                    if (cDelayStr.isEmpty()) {
                        wBinding.widgetModify.text = "延迟点击不能为空"
                        return@Runnable
                    }
                    val cDelay = cDelayStr.toInt()
                    if (cDelay > 8000) {
                        wBinding.widgetModify.text = "点击延迟应为0~8000(ms)之间"
                        return@Runnable
                    }
                    e.widgetId = wBinding.widgetId.text.toString().trim()
                    e.widgetDescribe = wBinding.widgetDescribe.text.toString().trim()
                    e.widgetText = wBinding.widgetText.text.toString().trim()
                    e.clickDelay = cDelay
                    e.noRepeat = wBinding.widgetNoRepeat.isChecked
                    e.clickOnly = wBinding.widgetClickOnly.isChecked
                    e.comment = wBinding.widgetComment.text.toString().trim()
                    dataDao?.updateWidget(e)
                    wBinding.widgetModify.setTextColor(-0x1000000)
                    wBinding.widgetModify.text = "${dateFormatModify?.format(Date())} (修改成功)"
                }

                val wTextWatcher = object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                    override fun afterTextChanged(s: Editable?) { widgetSaveRun.run() }
                }
                wBinding.widgetId.addTextChangedListener(wTextWatcher)
                wBinding.widgetDescribe.addTextChangedListener(wTextWatcher)
                wBinding.widgetText.addTextChangedListener(wTextWatcher)
                wBinding.widgetClickDelay.addTextChangedListener(wTextWatcher)
                wBinding.widgetComment.addTextChangedListener(wTextWatcher)

                val wClickListener = View.OnClickListener { widgetSaveRun.run() }
                wBinding.widgetNoRepeat.setOnClickListener(wClickListener)
                wBinding.widgetClickOnly.setOnClickListener(wClickListener)

                wBinding.widgetShare.setOnClickListener {
                    val widgetShare = WidgetShare()
                    widgetShare.widget = e
                    widgetShare.basicContent = BasicContent()
                    widgetShare.basicContent?.fingerPrint = Build.FINGERPRINT
                    widgetShare.basicContent?.displayMetrics = DisplayMetrics()
                    windowManager.defaultDisplay.getRealMetrics(widgetShare.basicContent?.displayMetrics)
                    widgetShare.basicContent?.packageName = e.appPackage
                    try {
                        val packageInfo = packageManager.getPackageInfo(e.appPackage, PackageManager.GET_META_DATA)
                        widgetShare.basicContent?.versionCode = packageInfo.versionCode
                        widgetShare.basicContent?.versionName = packageInfo.versionName
                    } catch (ex: PackageManager.NameNotFoundException) {
                        ex.printStackTrace()
                    }
                    val gson = GsonBuilder().setPrettyPrinting().create()
                    val strRule = "\"${WidgetShare::class.java.simpleName}\": ${gson.toJson(widgetShare)}"
                    showEditShareFileNameDialog(strRule)
                }

                wBinding.widgetDelete.setOnClickListener {
                    AlertDialog.Builder(this)
                        .setTitle("确定删除？")
                        .setNegativeButton("取消", null)
                        .setPositiveButton("确定") { _, _ ->
                            dataDao?.deleteWidget(e)
                            widgetSet.remove(e)
                            widgetList.remove(e)
                            editDataBinding.widgetLayout.removeView(wBinding.root)
                            if (widgetSet.isEmpty()) {
                                currentApp.widgetSetMap.remove(e.appActivity)
                            }
                            if (currentApp.widgetSetMap.isEmpty()) {
                                editDataBinding.widgetLayout.visibility = View.GONE
                            }
                        }.create().show()
                }
                editDataBinding.widgetLayout.addView(wBinding.root)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        val pkg = appDescribe?.appPackage
        if (!pkg.isNullOrEmpty()) {
            myUtils?.requestUpdateAppDescribe(pkg)
            myUtils?.requestUpdateAutoFinder(pkg)
            myUtils?.requestUpdateCoordinate(pkg)
            myUtils?.requestUpdateWidget(pkg)
        }
    }

    private fun showEditShareFileNameDialog(strRegulation: String) {
        val dialogBinding = ViewEditFileNameBinding.inflate(inflater!!)
        dialogBinding.fileName.hint = DigestUtils.md5Hex(strRegulation)
        AlertDialog.Builder(this)
            .setView(dialogBinding.root)
            .setCancelable(false)
            .setTitle("编辑文件名称")
            .setNegativeButton("取消", null)
            .setPositiveButton("确定") { _, _ ->
                try {
                    FileUtils.cleanDirectory(cacheDir)
                    val fileNameInput = dialogBinding.fileName.text.toString()
                    val fileName = if (fileNameInput.isEmpty()) dialogBinding.fileName.hint.toString() else fileNameInput
                    val file = File(cacheDir, "$fileName.txt")
                    FileUtils.writeStringToFile(file, strRegulation, StandardCharsets.UTF_8)
                    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        setDataAndType(uri, contentResolver.getType(uri))
                        putExtra(Intent.EXTRA_TEXT, strRegulation)
                        putExtra(Intent.EXTRA_STREAM, uri)
                        clipData = ClipData.newUri(contentResolver, "regulation", uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(intent, "分享"))
                } catch (ex: IOException) {
                    Toast.makeText(this, "生成分享文件时发生错误", Toast.LENGTH_SHORT).show()
                }
            }.create().show()
    }
}
