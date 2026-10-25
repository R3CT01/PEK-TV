package com.pektv.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The app's start-up work (copy the built-in files, start the C++ server and the Python plugins, wait for the server), done once
 * per process. SplashActivity starts it the moment the app opens, so all of this - and Flutter's own loading - happens while the
 * splash video plays. MainActivity then just waits for it (usually already done) and opens the Flutter screen.
 */
object Boot {
    private val lock = Object()
    private var thread: Thread? = null
    @Volatile private var finished = false
    @Volatile private var ok = false

    /** Starts the work if it is not running or done. Safe to call from every activity. */
    fun ensureStarted(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            if (thread != null) return
            finished = false
            ok = false
            thread = Thread {
                ok = run(app)
                synchronized(lock) { finished = true; lock.notifyAll() }
            }.also { it.start() }
        }
        warmFlutter(app)
    }

    /** Waits for the work to end. true = the server answers. A failed run is forgotten, so the next ensureStarted tries again. */
    fun await(): Boolean {
        synchronized(lock) {
            while (!finished) lock.wait()
            if (!ok) thread = null
            return ok
        }
    }

    private fun run(ctx: Context): Boolean {
        val root = File(ctx.filesDir, "hesper")
        File(root, "plugins/sample_counter").deleteRecursively()   // retired built-in; older installs still have a copy
        try {
            if (assetsNeedCopy(ctx, root)) {
                copyAssetDir(ctx, "hesper", root)
                markAssetsCopied(ctx, root)
            }
            NativeBridge.startServer(root.absolutePath)
            startPythonPlugins(ctx, File(root, "plugins"))
            for (i in 0 until 125) {
                try {
                    Socket().use { it.connect(InetSocketAddress("127.0.0.1", 8080), 200) }
                    return true
                } catch (e: Exception) {
                    Thread.sleep(40)
                }
            }
        } catch (e: Throwable) {
            Log.e("PEK", "start-up failed", e)
        }
        return false
    }

    // Flutter's own start-up (libflutter, the app snapshot) while the video plays. Reflection, because this file is also compiled
    // when the Flutter module is not wired in; any problem just means Flutter loads later, as before.
    private fun warmFlutter(app: Context) {
        try {
            val injector = Class.forName("io.flutter.FlutterInjector")
            val loader = injector.getMethod("instance").invoke(null).let { it!!.javaClass.getMethod("flutterLoader").invoke(it) }!!
            val c = loader.javaClass
            c.getMethod("startInitialization", Context::class.java).invoke(loader, app)
            c.getMethod("ensureInitializationCompleteAsync", Context::class.java, Array<String>::class.java, Handler::class.java, Runnable::class.java)
                .invoke(loader, app, null, Handler(Looper.getMainLooper()), Runnable { })
        } catch (e: Throwable) {
            Log.i("PEK", "Flutter pre-load skipped: ${e.javaClass.simpleName}")
        }
    }

    // Runs plugins/<name>/backend.py (the same job core.cpp does on desktop) through Chaquopy. Own thread, so a slow plugin
    // (network) never delays the UI.
    private fun startPythonPlugins(ctx: Context, pluginsDir: File) {
        Thread {
            try {
                if (!Python.isStarted()) Python.start(AndroidPlatform(ctx))
                Python.getInstance().getModule("hesper_runner")
                    .callAttr("run_all", pluginsDir.absolutePath)
            } catch (e: Throwable) {
                Log.e("PEK", "Python plugins failed", e)
            }
        }.start()
    }

    // The built-in plugins are copied from the app on every install. One the PEK Store updated to a NEWER version is left alone,
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

    private fun installedStockIsNewer(ctx: Context, assetPath: String, dest: File): Boolean {
        val id = assetPath.substringAfterLast('/')
        if (!assetPath.endsWith("/plugins/$id") || id !in stockPlugins) return false
        return try {
            val installed = File(dest, "plugin.json")
            if (!installed.isFile) return false
            val bundled = ctx.assets.open("$assetPath/plugin.json").use { it.readBytes().toString(Charsets.UTF_8) }
            newerThan(manifestVersion(installed.readText()), manifestVersion(bundled))
        } catch (e: Exception) { false }
    }

    // The built-in files (plugins, skins, cacert.pem) only change when the app itself is installed or updated, so they are
    // copied once per install instead of on every launch. A marker file next to them remembers which install they came from.
    // Any plugin the PEK Store installed lives in the same folder and is untouched.
    private fun installStamp(ctx: Context): String = try {
        "${ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime}"
    } catch (e: Exception) { "" }

    private fun assetsNeedCopy(ctx: Context, root: File): Boolean {
        val stamp = installStamp(ctx)
        if (stamp.isEmpty()) return true
        val marker = File(root, ".assets_stamp")
        return !(marker.isFile && File(root, "plugins").isDirectory && marker.readText().trim() == stamp)
    }

    private fun markAssetsCopied(ctx: Context, root: File) {
        try { File(root, ".assets_stamp").writeText(installStamp(ctx)) } catch (e: Exception) { /* copied again next time */ }
    }

    private fun copyAssetDir(ctx: Context, assetPath: String, dest: File) {
        if (installedStockIsNewer(ctx, assetPath, dest)) { Log.i("PEK", "keeping the store's newer copy of " + dest.name); return }
        val children = ctx.assets.list(assetPath) ?: return
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            ctx.assets.open(assetPath).use { input ->
                dest.outputStream().use { input.copyTo(it) }
            }
        } else {
            dest.mkdirs()
            for (name in children) copyAssetDir(ctx, "$assetPath/$name", File(dest, name))
        }
    }
}
