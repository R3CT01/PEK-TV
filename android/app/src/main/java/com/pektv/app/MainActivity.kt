package com.pektv.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import android.view.WindowInsets
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
    private lateinit var musicMpv: MpvAudioController
    private lateinit var bridge: PekBridge

    // File picker for <input type="file"> in the web UI (used by "Install plugin from .zip").
    // WebView ignores file inputs unless the app answers onShowFileChooser. The WebView reads
    // the chosen file itself; PEK never needs storage permission for this.
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserRequest = 4711

    // ---- PEK splash (see SplashOverlay.kt) ----
    // Plays on top of the WebView while the app loads underneath. Controls are locked until the video
    // has finished (and the page is up), so the splash can't be skipped.
    private var splash: SplashOverlay? = null
    private var splashVideoDone = false
    private var pageReady = false
    private var splashDismissing = false
    private val ui = Handler(Looper.getMainLooper())
    private val splashHardCap = Runnable { splash?.forceDone(); pageReady = true; dismissSplashIfReady() }   // video never finished
    private val splashPageWait = Runnable { pageReady = true; dismissSplashIfReady() }                      // page never finished loading

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The launch theme paints the PEK splash colour for the first instant; behind the app itself
        // the window must be black again (mpv's video surface sits behind the transparent WebView).
        window.setBackgroundDrawable(ColorDrawable(Color.BLACK))

        // mpv draws on this surface, BEHIND the (transparent) WebView.
        val surfaceView = SurfaceView(this)
        surfaceView.visibility = View.GONE
        webView = WebView(this)
        webView.setBackgroundColor(Color.TRANSPARENT)
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        mpv = MpvController(this, surfaceView, webView)
        musicMpv = MpvAudioController(this, webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            // Phone layout must not be zoomable / pannable like a desktop page.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = false
            loadWithOverviewMode = false
        }
        // Android's autofill popup (saved emails under a field) steals the window focus on every key press, which
        // closes and reopens the keyboard while typing in the sign-in screen. The app has no use for it.
        webView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (!pageReady) { pageReady = true; dismissSplashIfReady() }
            }
        }
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
        bridge = PekBridge(this, mpv, musicMpv)
        webView.addJavascriptInterface(bridge, "PekAndroid")
        val layout = FrameLayout(this)
        layout.addView(surfaceView, FrameLayout.LayoutParams(-1, -1))
        layout.addView(webView, FrameLayout.LayoutParams(-1, -1))
        // Android 15+ forces edge-to-edge: the window runs under the system bars and display cutout.
        // Pad the layout by those insets so the UI keeps sitting inside the safe area, as before.
        // (Older Android versions already lay out inside the bars, so nothing is added there.)
        if (Build.VERSION.SDK_INT >= 35) {
            layout.setBackgroundColor(Color.BLACK)
            layout.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(layout)

        // Splash on top of everything. The app keeps loading below it (server start, page load).
        val overlay = SplashOverlay(this) { splashVideoDone = true; dismissSplashIfReady() }
        splash = overlay
        addContentView(overlay, FrameLayout.LayoutParams(-1, -1))
        overlay.requestFocus()
        overlay.start()
        ui.postDelayed(splashHardCap, 15000)   // safety net only; the video is 5 s

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


    // The splash is gone only when its video has finished AND the page has loaded underneath it. If the page is
    // slow, the last video frame is held (at most 8 s) instead of showing a blank screen.
    private fun dismissSplashIfReady() {
        val overlay = splash ?: return
        if (!splashVideoDone) return
        if (!pageReady) {
            ui.removeCallbacks(splashPageWait)
            ui.postDelayed(splashPageWait, 8000)
            return
        }
        if (splashDismissing) return
        splashDismissing = true
        ui.removeCallbacks(splashHardCap)
        ui.removeCallbacks(splashPageWait)
        overlay.animate().alpha(0f).setDuration(350).withEndAction {
            overlay.release()
            (overlay.parent as? android.view.ViewGroup)?.removeView(overlay)
            splash = null
            onSplashFinished()
        }.start()
    }

    // Controls are live from here on.
    private fun onSplashFinished() {
        webView.requestFocus()
        // First start: ask for storage access (held back until now so the prompt can't interrupt the splash).
        // If it is refused, the folder browsers ask again when opened.
        if (!hasStoragePermission() && !getSharedPreferences("pek", MODE_PRIVATE).getBoolean("asked_storage", false)) {
            requestStoragePermission(true)
        }
    }

    // While the splash is up every touch, key (remote / keyboard / gamepad) and Back press is swallowed here,
    // before it can reach the WebView.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        if (splash != null) true else super.dispatchKeyEvent(event)

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean =
        if (splash != null) true else super.dispatchTouchEvent(ev)

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean =
        if (splash != null) true else super.dispatchGenericMotionEvent(ev)

    override fun onResume() {
        super.onResume()
        splash?.resumeIfNeeded()
        // Back from Android's "All files access" screen: tell the web UI so the open file browser can refresh.
        if (waitingForAllFiles) {
            waitingForAllFiles = false
            webView.evaluateJavascript("window.__pekAllFiles&&window.__pekAllFiles(" + hasAllFilesAccess() + ");", null)
        }
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
    // Android 13+ replaced READ_EXTERNAL_STORAGE with per-type media permissions. PEK only scans video.
    private val storagePerm =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO
        else Manifest.permission.READ_EXTERNAL_STORAGE

    fun hasStoragePermission(): Boolean =
        checkSelfPermission(storagePerm) == PackageManager.PERMISSION_GRANTED

    /**
     * Shows the system prompt. Once Android stops showing it (refused with "don't ask again"), a deliberate
     * request from the web UI ([auto] = false) opens PEK's page in Android Settings instead.
     */
    fun requestStoragePermission(auto: Boolean) {
        runOnUiThread {
            if (hasStoragePermission()) { notifyStorage(true, false); return@runOnUiThread }
            val prefs = getSharedPreferences("pek", MODE_PRIVATE)
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

    // ---- "All files access" (lets the in-app file browser see .zip files) ----
    // READ_MEDIA_VIDEO / READ_EXTERNAL_STORAGE only expose media files on Android 11+, so plugin and skin .zip files
    // in Downloads etc. are invisible to PEK's own browser. Android 10 and older already show everything.
    private var waitingForAllFiles = false

    fun hasAllFilesAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= 30) android.os.Environment.isExternalStorageManager() else hasStoragePermission()

    /** Opens Android's "All files access" screen for PEK TV. Returns false when this device has no such screen. */
    fun requestAllFilesAccess(): Boolean {
        if (Build.VERSION.SDK_INT < 30) return false
        val attempts = listOf(
            Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        )
        for (intent in attempts) {
            try {
                if (intent.resolveActivity(packageManager) == null) continue
                waitingForAllFiles = true
                startActivity(intent)
                return true
            } catch (e: Throwable) { waitingForAllFiles = false }
        }
        return false
    }

    private fun notifyStorage(granted: Boolean, openedSettings: Boolean) {
        webView.evaluateJavascript(
            "window.__pekStorage&&window.__pekStorage($granted,$openedSettings);" +
            "window.__pekStorageAny&&window.__pekStorageAny($granted);", null)
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
    catch (e: Throwable) { Log.w("PEK", "could not open app", e); false }

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
                Log.e("PEK", "Python plugins failed", e)
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
        musicMpv.onActivityStop()
        super.onStop()
    }

    override fun onDestroy() {
        ui.removeCallbacks(splashHardCap)
        ui.removeCallbacks(splashPageWait)
        splash?.release()
        bridge.setMulticast(false)
        bridge.releaseNavSound()
        mpv.destroy()
        musicMpv.destroy()
        super.onDestroy()
    }

    // The web UI asks "Are you sure you want to exit?" itself (app.js goBack). This native question is only the
    // fallback for when the page is not there (e.g. the server failed to start) and Back would just leave.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (splash != null) return   // splash can't be skipped
        // Ask the page first (it closes plugin windows, dialogs, detail pages ... and shows its own exit
        // question). Only if the page is not there (null) do we fall back to history / the native question.
        webView.evaluateJavascript(
            "(function(){try{return window.__pekBack?window.__pekBack():null}catch(e){return null}})()"
        ) { result ->
            if (result == "true") return@evaluateJavascript
            if (result != "true" && webView.canGoBack()) { webView.goBack(); return@evaluateJavascript }
            showNativeExitDialog()
        }
    }

    private fun showNativeExitDialog() {
        AlertDialog.Builder(this)
            .setTitle("Are you sure you want to exit?")
            .setMessage("PEK TV will stop running and its temporary cache will be cleared.")
            .setPositiveButton("Yes, exit") { _, _ -> exitApp() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /**
     * Full exit: clears the app's cache (WebView cache + cache folders; favorites, watch progress and
     * settings are kept), stops playback and the background server / plugins, and ends the process
     * so nothing keeps running.
     */
    fun exitApp() {
        runOnUiThread {
            try { webView.clearCache(true); webView.clearHistory() } catch (e: Throwable) { Log.w("PEK", "clearCache failed", e) }
            try { mpv.destroy() } catch (e: Throwable) { /* already gone */ }
            try { musicMpv.destroy() } catch (e: Throwable) { /* already gone */ }
            Thread {
                try {
                    cacheDir.listFiles()?.forEach { it.deleteRecursively() }
                    externalCacheDir?.listFiles()?.forEach { it.deleteRecursively() }
                    codeCacheDir.listFiles()?.forEach { it.deleteRecursively() }
                } catch (e: Throwable) { Log.w("PEK", "cache cleanup failed", e) }
                runOnUiThread {
                    finishAndRemoveTask()
                    // The server and Python plugins run on their own threads; ending the process stops them all.
                    Handler(Looper.getMainLooper()).postDelayed({ Process.killProcess(Process.myPid()) }, 300)
                }
            }.start()
        }
    }
}

/** Exposed to the web UI as window.PekAndroid. */
class PekBridge(private val activity: MainActivity, private val mpv: MpvController, private val music: MpvAudioController) {

    // Navigation sounds, played natively so they are not tied to the page's frame rate (see NavSound.kt).
    private val nav = NavSound()
    @JavascriptInterface fun navSoundReady(): Boolean = nav.isReady()
    @JavascriptInterface fun navSound(kind: Int, volume: Double) { nav.play(kind, volume.toFloat()) }
    fun releaseNavSound() { nav.release() }

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

    // What this device can decode / show (JSON), so a plugin can rank releases for it. See DeviceProfile.kt.
    @JavascriptInterface fun deviceProfile(): String = try { DeviceProfile.json(activity) } catch (t: Throwable) { "{\"v\":1,\"unknown\":true}" }

    // "Yes, exit" in the web UI's exit question: clear cache, stop everything, close (see MainActivity.exitApp).
    @JavascriptInterface fun exitApp() { activity.exitApp() }

    // False on devices with no file picker (most TV boxes); the web UI uses it to avoid the picker.
    @JavascriptInterface fun canPickFiles(): Boolean = activity.canPickFiles()

    // Storage access (see app_storage.js): ask first start, and again when a file browser is opened.
    @JavascriptInterface fun hasStoragePermission(): Boolean = activity.hasStoragePermission()
    @JavascriptInterface fun requestStoragePermission(auto: Boolean) { activity.requestStoragePermission(auto) }
    // "All files access": without it the file browser cannot see .zip files (see MainActivity.hasAllFilesAccess).
    @JavascriptInterface fun hasAllFilesAccess(): Boolean = activity.hasAllFilesAccess()
    @JavascriptInterface fun requestAllFilesAccess(): Boolean {
        var ok = false
        val latch = java.util.concurrent.CountDownLatch(1)
        activity.runOnUiThread { ok = activity.requestAllFilesAccess(); latch.countDown() }
        latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
        return ok
    }

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
                    multicastLock = wifi?.createMulticastLock("pek-discovery")?.apply { setReferenceCounted(false) }
                }
                multicastLock?.let { if (!it.isHeld) it.acquire() }
            } else {
                multicastLock?.let { if (it.isHeld) it.release() }
            }
        } catch (e: Exception) {
            android.util.Log.w("PEK", "multicast lock failed", e)   // the port scan still works without it
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
    @JavascriptInterface fun mpvAddSubtitle(url: String, label: String) { activity.runOnUiThread { mpv.addSubtitle(url, label) } }
    @JavascriptInterface fun mpvDestroy() { activity.runOnUiThread { mpv.destroy() } }
    // libmpv backend for the Music tab (music_player.js MpvEngine; see MpvAudioController.kt).
    @JavascriptInterface fun musicLoad(url: String, startSec: Double, autoplay: Boolean) { activity.runOnUiThread { music.load(url, startSec, autoplay) } }
    @JavascriptInterface fun musicPlay() { activity.runOnUiThread { music.play() } }
    @JavascriptInterface fun musicPause() { activity.runOnUiThread { music.pause() } }
    @JavascriptInterface fun musicSeek(sec: Double) { activity.runOnUiThread { music.seek(sec) } }
    @JavascriptInterface fun musicStop() { activity.runOnUiThread { music.stop() } }

    @JavascriptInterface fun mpvSetLite(on: Boolean) { activity.runOnUiThread { mpv.setLite(on) } }
    @JavascriptInterface fun mpvIsLite(): Boolean = mpv.isLite()
    // Video output (Settings > Video output): refresh-rate matching and HDR.
    @JavascriptInterface fun mpvSetMatchRate(on: Boolean) { activity.runOnUiThread { mpv.setMatchRate(on) } }
    @JavascriptInterface fun mpvMatchRate(): Boolean = mpv.isMatchRate()
    @JavascriptInterface fun mpvSetHdr(on: Boolean) { activity.runOnUiThread { mpv.setHdr(on) } }
    @JavascriptInterface fun mpvHdr(): Boolean = mpv.isHdrOut()
    @JavascriptInterface fun mpvDisplayHdr(): Boolean = mpv.displayHdr()
    // Audio output (Settings > Audio output): passthrough of Dolby / DTS to a TV, soundbar or receiver.
    @JavascriptInterface fun mpvSetPassthrough(codec: String, on: Boolean) { activity.runOnUiThread { mpv.setPassthrough(codec, on) } }
    @JavascriptInterface fun mpvPassthrough(): String = mpv.passthroughJson()
    @JavascriptInterface fun mpvPassthroughSupport(): String = mpv.passthroughSupportJson()
}
