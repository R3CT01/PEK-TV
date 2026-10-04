package com.hesper.app

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Log
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var mpv: MpvController
    private lateinit var bridge: HesperBridge

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // mpv draws on this surface, BEHIND the (transparent) WebView.
        val surfaceView = SurfaceView(this)
        surfaceView.visibility = View.GONE
        webView = WebView(this)
        webView.setBackgroundColor(Color.TRANSPARENT)
        mpv = MpvController(this, surfaceView, webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.webViewClient = WebViewClient()
        bridge = HesperBridge(this, mpv)
        webView.addJavascriptInterface(bridge, "HesperAndroid")
        val layout = FrameLayout(this)
        layout.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        layout.addView(webView, FrameLayout.LayoutParams(-1, -1))
        setContentView(layout)
        webView.requestFocus()

        Thread {
            val root = File(filesDir, "hesper")
            copyAssetDir("hesper", root)
            NativeBridge.startServer(root.absolutePath)
            startPythonPlugins(File(root, "plugins"))

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
        }.start()
    }

    // Runs plugins/<name>/backend.py (the same job core.cpp does on desktop) through
    // Chaquopy. Own thread, so a slow plugin (network) never delays the UI.
    private fun startPythonPlugins(pluginsDir: File) {
        Thread {
            try {
                if (!Python.isStarted()) Python.start(AndroidPlatform(applicationContext))
                Python.getInstance().getModule("hesper_runner")
                    .callAttr("run_all", pluginsDir.absolutePath)
            } catch (e: Throwable) {
                Log.e("Hesper", "Python plugins failed", e)
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

    override fun onStop() {
        mpv.onActivityStop()
        super.onStop()
    }

    override fun onDestroy() {
        bridge.setMulticast(false)
        mpv.destroy()
        super.onDestroy()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}

/** Exposed to the web UI as window.HesperAndroid. */
class HesperBridge(private val activity: Activity, private val mpv: MpvController) {

    // libmpv backend for the web player (player.js MpvBackend). JS calls arrive on a
    // background thread, so each one hops to the UI thread.
    @JavascriptInterface
    fun mpvLoad(url: String, startSec: Double, title: String, theme: String) {
        activity.runOnUiThread { mpv.load(url, startSec, title, theme) }
    }

    // True on a phone / tablet, false on Android TV and other no-touch leanback boxes.
    // The web player only offers the mini player when this is true.
    private val phone: Boolean by lazy {
        val ui = activity.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        val pm = activity.packageManager
        val isTv = ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
        !isTv && pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
    }

    @JavascriptInterface fun isPhone(): Boolean = phone

    // Network folder discovery (mDNS) only works while Wi-Fi multicast is allowed.
    // The web UI turns this on while it searches and off again afterwards.
    private var multicastLock: WifiManager.MulticastLock? = null

    @JavascriptInterface
    @Synchronized
    fun setMulticast(on: Boolean) {
        try {
            if (on) {
                if (multicastLock == null) {
                    val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                    multicastLock = wifi?.createMulticastLock("hesper-discovery")?.apply { setReferenceCounted(false) }
                }
                multicastLock?.let { if (!it.isHeld) it.acquire() }
            } else {
                multicastLock?.let { if (it.isHeld) it.release() }
            }
        } catch (e: Exception) {
            android.util.Log.w("Hesper", "multicast lock failed", e)   // the port scan still works without it
        }
    }

    // Mini player: park the video surface under the mini bar's see-through thumbnail
    // cell (CSS px, converted in MpvController), or send it back to full screen.
    @JavascriptInterface
    fun mpvSetRect(left: Double, top: Double, width: Double, height: Double) {
        activity.runOnUiThread { mpv.setMiniRect(left, top, width, height) }
    }
    @JavascriptInterface fun mpvFullscreen() { activity.runOnUiThread { mpv.setFullscreen() } }

    @JavascriptInterface fun mpvPlay() { activity.runOnUiThread { mpv.play() } }
    @JavascriptInterface fun mpvPause() { activity.runOnUiThread { mpv.pause() } }
    @JavascriptInterface fun mpvSeek(sec: Double) { activity.runOnUiThread { mpv.seek(sec) } }
    @JavascriptInterface fun mpvSetAudio(id: Int) { activity.runOnUiThread { mpv.setAudio(id) } }
    @JavascriptInterface fun mpvSetSubtitle(id: Int) { activity.runOnUiThread { mpv.setSubtitle(id) } }
    @JavascriptInterface fun mpvDestroy() { activity.runOnUiThread { mpv.destroy() } }
}
