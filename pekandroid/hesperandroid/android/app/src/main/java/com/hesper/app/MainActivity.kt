package com.hesper.app

import android.Manifest
import android.app.Activity
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
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

    // File picker for <input type="file"> in the web UI (used by "Install plugin from .zip").
    // WebView ignores file inputs unless the app answers onShowFileChooser. The WebView reads
    // the chosen file itself; Hesper never needs storage permission for this.
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserRequest = 4711

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // mpv draws on this surface, BEHIND the (transparent) WebView.
        val surfaceView = SurfaceView(this)
        surfaceView.visibility = View.GONE
        webView = WebView(this)
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        mpv = MpvController(this, surfaceView, webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                // A new request replaces an unfinished one; the old callback must still be answered.
                filePathCallback?.onReceiveValue(null)
                filePathCallback = null
                // Google TV / Android TV boxes usually ship no file picker at all. Launching a
                // chooser with nothing behind it hangs or crashes there, so check first and
                // simply cancel when no app can pick a file.
                val intent = pickerIntent() ?: run {
                    callback.onReceiveValue(null)
                    return true
                }
                filePathCallback = callback
                return try {
                    startActivityForResult(intent, fileChooserRequest)
                    true
                } catch (e: Throwable) {
                    filePathCallback = null
                    callback.onReceiveValue(null)
                    true
                }
            }
        }
        bridge = HesperBridge(this, mpv)
        webView.addJavascriptInterface(bridge, "HesperAndroid")
        val layout = FrameLayout(this)
        layout.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        layout.addView(webView, FrameLayout.LayoutParams(-1, -1))
        setContentView(layout)
        webView.requestFocus()

        // First start: ask for storage access straight away. (If it is refused, the folder browsers ask again when opened.)
        if (!hasStoragePermission() && !getSharedPreferences("hesper", MODE_PRIVATE).getBoolean("asked_storage", false)) {
            requestStoragePermission(true)
        }

        Thread {
            val root = File(filesDir, "hesper")
            File(root, "plugins/sample_counter").deleteRecursively()   // retired built-in; older installs still have a copy
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


    // The picker intent, or null when this device has no app that can answer it (typical on TV).
    // No createChooser(): on TV firmware the chooser itself can freeze or crash.
    private fun pickerIntent(): Intent? {
        val candidates = listOf(Intent.ACTION_OPEN_DOCUMENT, Intent.ACTION_GET_CONTENT)
        for (action in candidates) {
            val intent = Intent(action).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                // Pickers often label .zip files as application/octet-stream, so accept those too.
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
                    "application/zip", "application/x-zip-compressed", "application/octet-stream"))
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
            }
            if (intent.resolveActivity(packageManager) != null) return intent
        }
        return null
    }

    fun canPickFiles(): Boolean = pickerIntent() != null

    // ---- storage permission ----
    private val storageRequest = 4712
    private val storagePerm = Manifest.permission.READ_EXTERNAL_STORAGE

    fun hasStoragePermission(): Boolean =
        checkSelfPermission(storagePerm) == PackageManager.PERMISSION_GRANTED

    /**
     * Shows the system prompt. Once Android stops showing it (refused with "don't ask again"), a deliberate
     * request from the web UI ([auto] = false) opens Hesper's page in Android Settings instead.
     */
    fun requestStoragePermission(auto: Boolean) {
        runOnUiThread {
            if (hasStoragePermission()) { notifyStorage(true, false); return@runOnUiThread }
            val prefs = getSharedPreferences("hesper", MODE_PRIVATE)
            val asked = prefs.getBoolean("asked_storage", false)
            if (asked && !shouldShowRequestPermissionRationale(storagePerm)) {
                if (!auto) {
                    try {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                        notifyStorage(false, true)
                    } catch (e: Throwable) { notifyStorage(false, false) }
                }
                return@runOnUiThread
            }
            prefs.edit().putBoolean("asked_storage", true).apply()
            requestPermissions(arrayOf(storagePerm), storageRequest)
        }
    }

    private fun notifyStorage(granted: Boolean, openedSettings: Boolean) {
        webView.evaluateJavascript(
            "window.__hesperStorage&&window.__hesperStorage($granted,$openedSettings);" +
            "window.__hesperStorageAny&&window.__hesperStorageAny($granted);", null)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == storageRequest) {
            notifyStorage(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED, false)
        }
    }

    // ---- "Watch on Netflix / Hulu / ..." buttons ----
    // The web UI names a service; providers.js turns that into Android package names and an https link.
    // Only packages in this list can be opened (it is generated from www/providers.js by tools/sync_providers.js).
    private val streamingPackages = setOf(
        // PKGS-START
        "air.com.vudu.air.DownloaderTablet",
        "com.amazon.amazonvideo.livingroom",
        "com.amazon.avod.thirdpartyclient",
        "com.amazon.imdb.tv.android.app",
        "com.apple.atve.androidtv.appletv",
        "com.bydeluxe.d3.android.program.starz",
        "com.cbs.app",
        "com.cbs.ott",
        "com.criterionchannel",
        "com.crunchyroll.crunchyroid",
        "com.disney.disneyplus",
        "com.google.android.videos",
        "com.google.android.youtube",
        "com.google.android.youtube.tv",
        "com.hbo.hbonow",
        "com.hoopladigital.android",
        "com.hulu.livingroomplus",
        "com.hulu.plus",
        "com.kanopy",
        "com.mubi",
        "com.netflix.mediaclient",
        "com.netflix.ninja",
        "com.peacocktv.peacockandroid",
        "com.plexapp.android",
        "com.roku.web.trc",
        "com.showtime.standalone",
        "com.tubitv",
        "com.wbd.stream",
        "tv.pluto.android"
        // PKGS-END
    )

    private fun tryStart(intent: Intent): Boolean = try {
        startActivity(intent); true
    } catch (e: ActivityNotFoundException) { false }
    catch (e: Throwable) { Log.w("Hesper", "could not open app", e); false }

    /**
     * Opens a streaming app: first on the title's page (the app's own handler for [url]), else just the app
     * itself, else (not installed) the website in the browser. [packagesCsv] is a comma list of candidates.
     */
    fun openStreamingApp(packagesCsv: String, url: String) {
        val web = url.takeIf { it.length <= 2000 && it.startsWith("https://") }
        val pkgs = packagesCsv.split(',').map { it.trim() }.filter { it in streamingPackages }
        runOnUiThread {
            for (pkg in pkgs) {
                if (web != null && tryStart(Intent(Intent.ACTION_VIEW, Uri.parse(web)).setPackage(pkg))) return@runOnUiThread
                val launch = packageManager.getLeanbackLaunchIntentForPackage(pkg)
                    ?: packageManager.getLaunchIntentForPackage(pkg)
                if (launch != null && tryStart(launch)) return@runOnUiThread
            }
            if (web != null) tryStart(Intent(Intent.ACTION_VIEW, Uri.parse(web)))
        }
    }

    /** A plain https link in the browser (providers that have no app to open). */
    fun openWebUrl(url: String) {
        if (url.length > 2000 || !url.startsWith("https://")) return
        runOnUiThread { tryStart(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
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

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == fileChooserRequest) {
            // Always answer the callback exactly once, also when the user backed out.
            val result = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            filePathCallback?.onReceiveValue(result)
            filePathCallback = null
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
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
class HesperBridge(private val activity: MainActivity, private val mpv: MpvController) {

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

    // False on devices with no file picker (most TV boxes); the web UI uses it to avoid the picker.
    @JavascriptInterface fun canPickFiles(): Boolean = activity.canPickFiles()

    // Storage access (see app_storage.js): ask first start, and again when a file browser is opened.
    @JavascriptInterface fun hasStoragePermission(): Boolean = activity.hasStoragePermission()
    @JavascriptInterface fun requestStoragePermission(auto: Boolean) { activity.requestStoragePermission(auto) }

    // "Watch on <service>" buttons: open the service's app (or its website). See providers.js.
    @JavascriptInterface fun openStreamingApp(packages: String, url: String) { activity.openStreamingApp(packages, url) }
    @JavascriptInterface fun openUrl(url: String) { activity.openWebUrl(url) }

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
