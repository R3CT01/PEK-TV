package com.pektv.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Button
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The start-up activity. PEK TV has one UI, the Flutter one (FlutterHostActivity), so all this does is get the app ready and hand
 * over: copy the built-in plugins and files from the app, start the C++ server and the Python plugins, wait until the server
 * answers, open the Flutter screen and finish. There is no web view and no fallback UI any more. If the server cannot start or the
 * Flutter screen cannot open, a plain message with a Try again button is shown instead of a blank screen.
 */
class MainActivity : Activity() {

    private var status: TextView? = null
    private var retry: Button? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The launch theme paints the PEK splash colour for the first instant; behind the app itself the window is black.
        window.setBackgroundDrawable(ColorDrawable(getColor(R.color.pek_splash_bg)))
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(getColor(R.color.pek_splash_bg))
            setPadding(48, 48, 48, 48)
        }
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            text = ""   // empty while it starts: the splash video is just ending, so no text flashes
        }
        retry = Button(this).apply {
            text = "Try again"
            visibility = android.view.View.GONE
            setOnClickListener { start() }
        }
        column.addView(status)
        column.addView(retry)
        setContentView(FrameLayout(this).apply { addView(column, FrameLayout.LayoutParams(-1, -1)) })
        hideStatusBar()
        start()
    }

    private fun start() {
        retry?.visibility = android.view.View.GONE
        status?.text = ""
        Thread {
            val root = File(filesDir, "hesper")
            File(root, "plugins/sample_counter").deleteRecursively()   // retired built-in; older installs still have a copy
            var ready = false
            try {
                if (assetsNeedCopy(root)) {
                    copyAssetDir("hesper", root)
                    markAssetsCopied(root)
                }
                NativeBridge.startServer(root.absolutePath)
                startPythonPlugins(File(root, "plugins"))
                for (i in 0 until 125) {
                    try {
                        Socket().use { it.connect(InetSocketAddress("127.0.0.1", 8080), 200) }
                        ready = true
                        break
                    } catch (e: Exception) {
                        Thread.sleep(40)
                    }
                }
            } catch (e: Throwable) {
                Log.e("PEK", "start-up failed", e)
            }
            runOnUiThread {
                if (ready && launchFlutterUi()) return@runOnUiThread
                showProblem(if (ready) "PEK TV could not open its screen." else "PEK TV's server did not start.")
            }
        }.start()
    }

    private fun showProblem(text: String) {
        status?.text = text
        retry?.visibility = android.view.View.VISIBLE
        retry?.requestFocus()
    }

    /** The server is up: open the Flutter screen and leave. */
    private fun launchFlutterUi(): Boolean {
        return try {
            startActivity(Intent(this, Class.forName("com.pektv.app.flutter.FlutterHostActivity")))
            finish()
            true
        } catch (e: Throwable) {
            Log.e("PEK", "The Flutter UI failed to start", e)
            false
        }
    }

    // The status bar (clock, notification icons, battery) stays hidden. The navigation bar is left alone.
    private fun hideStatusBar() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideStatusBar()
    }

    // ---- notifications (Android 13+): the music notification / lock-screen controls need it. Asked once, on first play.
    fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("pek", Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked_notif", false)) return
        prefs.edit().putBoolean("asked_notif", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4713)
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

    // The built-in plugins are copied from the app on every launch. One the PEK Store updated to a NEWER version is left alone,
    // otherwise the older copy inside the app would undo the update each time the app starts.
    private val stockPlugins = setOf("weather", "tmdb-discover", "skin-maker")

    private fun versionParts(v: String): List<Int> = v.trim().trimStart('v', 'V').split('.', '-', '+').map { it.takeWhile { c -> c.isDigit() }.toIntOrNull() ?: 0 }

    /** true when version [a] is newer than [b] (1.10.0 > 1.9.2; a missing version counts as 0). */
    private fun newerThan(a: String, b: String): Boolean {
        val x = versionParts(a); val y = versionParts(b)
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = (x.getOrElse(i) { 0 }) - (y.getOrElse(i) { 0 })
            if (d != 0) return d > 0
        }
        return false
    }

    private fun manifestVersion(text: String): String = try { org.json.JSONObject(text).optString("version", "") } catch (e: Exception) { "" }

    private fun installedStockIsNewer(assetPath: String, dest: File): Boolean {
        val id = assetPath.substringAfterLast('/')
        if (!assetPath.endsWith("/plugins/$id") || id !in stockPlugins) return false
        return try {
            val installed = File(dest, "plugin.json")
            if (!installed.isFile) return false
            val bundled = assets.open("$assetPath/plugin.json").use { it.readBytes().toString(Charsets.UTF_8) }
            newerThan(manifestVersion(installed.readText()), manifestVersion(bundled))
        } catch (e: Exception) { false }
    }

    // The built-in files (www, plugins, skins, cacert.pem) only change when the app itself is installed or updated, so they are
    // copied once per install instead of on every launch (that copy was most of the black start-up screen). A marker file next to
    // them remembers which install they came from. Any plugin the PEK Store installed lives in the same folder and is untouched.
    private fun installStamp(): String = try {
        val pi = packageManager.getPackageInfo(packageName, 0)
        "${pi.lastUpdateTime}"
    } catch (e: Exception) { "" }

    private fun assetsNeedCopy(root: File): Boolean {
        val stamp = installStamp()
        if (stamp.isEmpty()) return true
        val marker = File(root, ".assets_stamp")
        return !(marker.isFile && File(root, "plugins").isDirectory && marker.readText().trim() == stamp)
    }

    private fun markAssetsCopied(root: File) {
        try { File(root, ".assets_stamp").writeText(installStamp()) } catch (e: Exception) { /* copied again next time */ }
    }

    private fun copyAssetDir(assetPath: String, dest: File) {
        if (installedStockIsNewer(assetPath, dest)) { Log.i("PEK", "keeping the store's newer copy of " + dest.name); return }
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
}
