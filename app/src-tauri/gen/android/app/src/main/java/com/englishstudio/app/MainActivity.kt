package com.englishstudio.app

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.view.ViewGroup
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 系统栏透明 + 深色图标；底色由下面的根视图背景（应用米色）提供。
    val bars = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
    super.onCreate(savedInstanceState)

    // 在原生侧留出 状态栏/刘海、底部手势条、输入法 的高度：网页不用再管安全区，
    // 弹窗、底部按钮也自然落在可见区域内；键盘弹出时 WebView 整体变矮，输入框和底部按钮都看得见。
    val content = findViewById<ViewGroup>(android.R.id.content)
    content.setBackgroundColor(Color.rgb(0xF5, 0xF4, 0xED)) // 和 index.css 的 --paper 一致
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val box = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(box.left, box.top, box.right, box.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  // 077 应用内更新：网页下载好并核对 sha256 的 APK 放在应用缓存目录，这里只负责调起系统安装。
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(UpdaterBridge(), "WorddripUpdater")
  }

  inner class UpdaterBridge {
    @JavascriptInterface
    fun canInstall(): Boolean =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

    // 第一次要用户在系统里允许本应用「安装未知应用」。
    @JavascriptInterface
    fun openInstallSettings() {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      startActivity(intent)
    }

    // 返回 "ok" 或失败原因。只允许安装缓存目录里的文件。
    @JavascriptInterface
    fun installApk(path: String): String {
      return try {
        val file = File(path).canonicalFile
        if (!file.path.startsWith(cacheDir.canonicalPath)) return "path outside cache"
        if (!file.isFile) return "file missing"
        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
        intent.setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
        "ok"
      } catch (e: Exception) {
        e.message ?: "error"
      }
    }
  }
}
