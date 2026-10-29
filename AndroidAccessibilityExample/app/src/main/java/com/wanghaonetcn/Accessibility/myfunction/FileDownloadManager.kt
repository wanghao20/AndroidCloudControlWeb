package com.wanghaonetcn.Accessibility.myfunction

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import com.wanghaonetcn.Accessibility.myclass.CrashReporter
import com.wanghaonetcn.Accessibility.myclass.ExceptionInterceptor
import okhttp3.*
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URLDecoder

object FileDownloadManager {
    private const val TAG = "FileDownloadManager"
    private val client = OkHttpClient.Builder()
        .addInterceptor(ExceptionInterceptor())
        .build()

    @JvmStatic
    fun download(context: Context, url: String?, fileName: String?) {
        if (url.isNullOrEmpty()) return
        
        if (url.contains("localhost") || url.contains("127.0.0.1")) {
            Log.e(TAG, "下载中止: 请将服务器地址 localhost 改为局域网 IP (如 192.168.x.x)")
            return
        }

        var decodedFileName = fileName
        try {
            if (decodedFileName.isNullOrEmpty()) {
                val rawName = url.substring(url.lastIndexOf("/") + 1)
                decodedFileName = URLDecoder.decode(rawName, "UTF-8")
            }
        } catch (e: Exception) {
            decodedFileName = "downloaded_file_${System.currentTimeMillis()}"
        }

        val request = Request.Builder().url(url).build()
        val finalFileName = decodedFileName ?: "file_${System.currentTimeMillis()}"
        
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e(TAG, "网络连接失败: ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    val body = resp.body
                    if (!resp.isSuccessful || body == null) {
                        Log.e(TAG, "下载失败: 服务器响应 ${resp.code}")
                        return
                    }

                    val contentType = body.contentType()?.toString() ?: ""
                    var extension = MimeTypeMap.getFileExtensionFromUrl(url)
                    if (extension.isEmpty()) {
                        extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(contentType) ?: ""
                    }
                    
                    val isImage = isImageExtension(extension) || contentType.startsWith("image/")

                    saveToMediaStore(context, body.byteStream(), finalFileName, contentType, isImage)
                }
            }
        })
    }

    private fun isImageExtension(ext: String?): Boolean {
        if (ext == null) return false
        val e = ext.lowercase()
        return e == "jpg" || e == "jpeg" || e == "png" || e == "webp" || e == "gif"
    }

    private fun saveToMediaStore(context: Context, inputStream: InputStream, fileName: String, mimeType: String?, isImage: Boolean) {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            if (!mimeType.isNullOrEmpty()) {
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            }
        }
        
        val relativePath: String
        val collection: Uri

        if (isImage) {
            relativePath = "${Environment.DIRECTORY_PICTURES}/GroupControl"
            collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                relativePath = "${Environment.DIRECTORY_DOWNLOADS}/GroupControl"
                collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
            } else {
                saveLegacyFile(inputStream, fileName)
                return
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
            values.put(MediaStore.MediaColumns.IS_PENDING, 1)
        }

        val itemUri = context.contentResolver.insert(collection, values)

        if (itemUri != null) {
            try {
                context.contentResolver.openOutputStream(itemUri)?.use { os ->
                    val buffer = ByteArray(8192)
                    var len: Int
                    while (inputStream.read(buffer).also { len = it } != -1) {
                        os.write(buffer, 0, len)
                    }
                    
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        values.clear()
                        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                        context.contentResolver.update(itemUri, values, null, null)
                    }
                    Log.i(TAG, "成功保存到${if (isImage) "相册" else "下载目录"}: $fileName")
                } ?: throw IOException("无法获取输出流")
            } catch (e: IOException) {
                Log.e(TAG, "写入文件失败: ${e.message}")
                context.contentResolver.delete(itemUri, null, null)
            }
        } else {
            Log.e(TAG, "创建 MediaStore 记录失败，请检查文件名或磁盘空间")
        }
    }

    private fun saveLegacyFile(inputStream: InputStream, fileName: String) {
        val downloadDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val subDir = File(downloadDir, "GroupControl")
        if (!subDir.exists()) subDir.mkdirs()
        
        val targetFile = File(subDir, fileName)
        try {
            FileOutputStream(targetFile).use { fos ->
                val buffer = ByteArray(8192)
                var len: Int
                while (inputStream.read(buffer).also { len = it } != -1) {
                    fos.write(buffer, 0, len)
                }
                Log.i(TAG, "成功保存(旧版): ${targetFile.absolutePath}")
            }
        } catch (e: IOException) {
            Log.e(TAG, "保存旧版文件失败: ${e.message}")
        }
    }
}
