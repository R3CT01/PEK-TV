package com.hesper.app

import android.app.Activity
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.app.AlertDialog
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.webViewClient = WebViewClient()
        setContentView(webView)

        Thread {
            val root = File(filesDir, "hesper")
            copyAssetDir("hesper", root)
            NativeBridge.startServer(root.absolutePath)

            var ready = false
            for (i in 0 until 50) {
                try {
                    Socket().use { it.connect(InetSocketAddress("127.0.0.1", 8080), 200) }
                    ready = true
                    break
                } catch (e: Exception) {
                    Thread.sleep(100)
                }
            }
            runOnUiThread {
                if (ready) webView.loadUrl("http://127.0.0.1:8080/")
                else webView.loadData("Server failed to start", "text/plain", "utf-8")
            }

            // TEMPORARY: show the HTTPS test result on screen
            val diag = NativeBridge.tlsDiag()
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("TLS test (v3)").setMessage(diag).setPositiveButton("OK", null).show()
            }
        }.start()
    }

    private fun copyAssetDir(assetPath: String, dest: File) {
        val children = assets.list(assetPath) ?: return
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            assets.open(assetPath).use { input ->
                dest.outputStream().use { input.copyTo(it) }
            }
        } else {
            dest.mkdirs()
            for (name in children) copyAssetDir("$assetPath/$name", File(dest, name))
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
