package com.pektv.app.flutter

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
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.view.SurfaceView
import android.view.View
import android.widget.ImageView
import android.widget.FrameLayout
import com.pektv.app.MainActivity
import com.pektv.app.MediaPermissions
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.pektv.app.MpvController
import io.flutter.embedding.android.DrawableSplashScreen
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.android.FlutterActivityLaunchConfigs.BackgroundMode
import io.flutter.embedding.android.RenderMode
import io.flutter.embedding.android.SplashScreen
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Hosts the Flutter UI (flutter_ui/). MainActivity has already copied the assets, started the C++ server on
 * 127.0.0.1:8080 and the Python plugins by the time this opens, so the Flutter side only talks HTTP to that server
 * (exactly like the web UI did) and drives libmpv through the channels below.
 *
 * Video: the same MpvController as the web UI. Its SurfaceView sits BEHIND the (transparent) Flutter surface, so the
 * Flutter player screen simply draws its controls over a transparent background.
 *
 * Channels
 *   pek/mpv         (MethodChannel)  load, play, pause, seek, setAudio, setSubtitle, addSubtitle, setMiniRect,
 *                                    fullscreen, destroy
 *   pek/mpv/events  (EventChannel)   {event: time|state|tracks|ended, data: {...}}  - same payloads the web UI got
 *   pek/host        (MethodChannel)  classicUi (switch back to the web UI), exit, isPhone, setMulticast
 *   pek/output      (MethodChannel)  Settings > Video / Audio output: video, setMatchRate, setHdr, audio, setPassthrough
 *   pek/music       (MethodChannel)  meta, state, end -> FlutterMusic (background play, lock-screen controls);
 *                                    remote {action} comes back the other way (next, prev, stop)
 *   pek/plugins     (MethodChannel)  call(json) -> json: a plugin's Python screen (plugins/<id>/screen.py, run by
 *                                    python/pek_flutter.py through Chaquopy); openUrl(url): an https link in the
 *                                    YouTube app or the browser; openApp({packages, url}): a streaming app. See FLUTTER_PLUGINS.md.
 */
class FlutterHostActivity : FlutterActivity() {

    private var mpv: MpvController? = null
    private var events: EventChannel.EventSink? = null
    private var music: FlutterMusic? = null
    private var musicChannel: MethodChannel? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    // Plugin screens: each call can wait on the network inside Python, so they never run on the UI thread.
    private val pluginPool = Executors.newCachedThreadPool()

    private fun pythonCall(json: String): String = try {
        // MainActivity starts Python on its own thread at boot; start it here too if that has not happened yet.
        synchronized(Python::class.java) {
            if (!Python.isStarted()) {
                try { Python.start(AndroidPlatform(applicationContext)) } catch (e: IllegalStateException) { /* started meanwhile */ }
            }
        }
        val req = JSONObject(json)
        if (!req.has("pluginsDir")) req.put("pluginsDir", File(File(filesDir, "hesper"), "plugins").absolutePath)
        Python.getInstance().getModule("pek_flutter").callAttr("call", req.toString()).toString()
    } catch (t: Throwable) {
        android.util.Log.w("PEK", "plugin call failed", t)
        JSONObject().put("ok", false).put("error", "Python is not ready: ${t.message}").toString()
    }

    // Streaming apps a plugin's "Watch on ..." button may open. Generated from www/providers.js by tools/sync_providers.js
    // (the same list as MainActivity.streamingPackages and the manifest <queries>).
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
    catch (e: Throwable) { android.util.Log.w("PEK", "could not open app", e); false }

    /**
     * A streaming app: first on the title's page (the app's own handler for [url]), else just the app itself, else
     * (not installed) the website. [packagesCsv] is a comma list of candidates; only allow-listed packages are used.
     */
    private fun openStreamingApp(packagesCsv: String, url: String): Boolean {
        val web = url.takeIf { it.length <= 2000 && it.startsWith("https://") }
        val pkgs = packagesCsv.split(',').map { it.trim() }.filter { it in streamingPackages }
        for (pkg in pkgs) {
            if (web != null && tryStart(Intent(Intent.ACTION_VIEW, Uri.parse(web)).setPackage(pkg))) return true
            val launch = packageManager.getLeanbackLaunchIntentForPackage(pkg) ?: packageManager.getLaunchIntentForPackage(pkg)
            if (launch != null && tryStart(launch)) return true
        }
        return web != null && openUrl(web)
    }

    // https links only (a plugin never supplies the address of an app, and file:/intent: links are refused).
    private fun openUrl(url: String): Boolean {
        if (url.length > 2000 || !url.startsWith("https://")) return false
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Throwable) {
            android.util.Log.w("PEK", "could not open link", e)
            false
        }
    }

    // Wi-Fi drops multicast packets unless Android is told to let them through; held only while searching the network.
    private fun setMulticast(on: Boolean) {
        try {
            if (on) {
                if (multicastLock == null) {
                    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                    multicastLock = wifi?.createMulticastLock("pek-discovery")?.apply { setReferenceCounted(false) }
                }
                multicastLock?.let { if (!it.isHeld) it.acquire() }
            } else {
                multicastLock?.let { if (it.isHeld) it.release() }
            }
        } catch (e: Exception) {
            android.util.Log.w("PEK", "multicast lock failed", e)   // the port scan still finds hosts without it
        }
    }

    override fun getBackgroundMode(): BackgroundMode = BackgroundMode.transparent

    // A transparent Flutter activity defaults to a TextureView, which costs frames on weak TV boxes. A SurfaceView
    // (drawn above mpv's surface, transparent where nothing is painted) is the fast path.
    override fun getRenderMode(): RenderMode = RenderMode.surface

    // Until Flutter has drawn its first frame, cover the (still empty) Flutter surface with the PEK splash colour and
    // fade it out. Without this the screen is black for the moment the engine and Dart need to start.
    override fun provideSplashScreen(): SplashScreen? =
        DrawableSplashScreen(ColorDrawable(getColor(com.pektv.app.R.color.pek_splash_bg)), ImageView.ScaleType.CENTER, 250L)

    // Behind the app the window is black (mpv's surface shows through where the Flutter surface is transparent).
    // It turns black only once Flutter is on screen; the launch theme's splash colour stays until then.
    override fun onFlutterUiDisplayed() {
        super.onFlutterUiDisplayed()
        window.setBackgroundDrawable(ColorDrawable(Color.BLACK))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val surface = SurfaceView(this)
        surface.visibility = View.GONE
        surface.isFocusable = false
        surface.isFocusableInTouchMode = false
        addContentView(surface, FrameLayout.LayoutParams(-1, -1))

        val c = MpvController(this, surface, null)
        c.eventSink = { event, data ->
            events?.success(mapOf("event" to event, "data" to data.toMap()))
        }
        mpv = c
        music = FlutterMusic(this, c) { name, args ->
            runOnUiThread { musicChannel?.invokeMethod(name, args) }
        }
        hideSystemBars()
        // MainActivity's own prompt never runs when it hands over to this screen, so ask here: video + audio, once.
        MediaPermissions.askOnce(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Scans that ran before the permission was given found no files: scan again so Movies and Music fill in.
        if (requestCode == MediaPermissions.REQUEST && grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
            MediaPermissions.rescan()
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        MethodChannel(messenger, "pek/mpv").setMethodCallHandler { call, result ->
            val c = mpv
            if (c == null) {
                result.error("no_player", "The player is not ready yet", null)
                return@setMethodCallHandler
            }
            try {
                when (call.method) {
                    "load" -> c.load(
                        call.argument<String>("url") ?: "",
                        call.argument<Number>("startSec")?.toDouble() ?: 0.0,
                        call.argument<String>("title") ?: "",
                        "{}"
                    )
                    "play" -> c.play()
                    "pause" -> c.pause()
                    "seek" -> c.seek(call.argument<Number>("sec")?.toDouble() ?: 0.0)
                    "setAudio" -> c.setAudio(call.argument<Number>("id")?.toInt() ?: 0)
                    "setSubtitle" -> c.setSubtitle(call.argument<Number>("id")?.toInt() ?: -1)
                    "addSubtitle" -> c.addSubtitle(call.argument<String>("url") ?: "", call.argument<String>("label") ?: "")
                    "setMiniRect" -> c.setMiniRect(
                        call.argument<Number>("left")?.toDouble() ?: 0.0,
                        call.argument<Number>("top")?.toDouble() ?: 0.0,
                        call.argument<Number>("width")?.toDouble() ?: 1.0,
                        call.argument<Number>("height")?.toDouble() ?: 1.0
                    )
                    "fullscreen" -> c.setFullscreen()
                    "destroy" -> c.destroy()
                    else -> { result.notImplemented(); return@setMethodCallHandler }
                }
                result.success(null)
            } catch (t: Throwable) {
                result.error("mpv_error", t.message, null)
            }
        }

        // Settings > Video output / Audio output: the same MpvController switches the web UI's PekAndroid.mpv* methods used.
        MethodChannel(messenger, "pek/output").setMethodCallHandler { call, result ->
            val c = mpv
            if (c == null) {
                result.error("no_player", "The player is not ready yet", null)
                return@setMethodCallHandler
            }
            try {
                when (call.method) {
                    "video" -> result.success(mapOf(
                        "matchRate" to c.isMatchRate(),
                        "hdr" to c.isHdrOut(),
                        "displayHdr" to c.displayHdr()
                    ))
                    "setMatchRate" -> { c.setMatchRate(call.argument<Boolean>("on") ?: false); result.success(null) }
                    "setHdr" -> { c.setHdr(call.argument<Boolean>("on") ?: false); result.success(null) }
                    "audio" -> {
                        val support = JSONObject(c.passthroughSupportJson())
                        result.success(mapOf(
                            "on" to toPlain(JSONArray(c.passthroughJson())),
                            "known" to support.optBoolean("known", false),
                            "formats" to toPlain(support.optJSONArray("formats") ?: JSONArray())
                        ))
                    }
                    "setPassthrough" -> {
                        c.setPassthrough(call.argument<String>("codec") ?: "", call.argument<Boolean>("on") ?: false)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (t: Throwable) {
                result.error("output_error", t.message, null)
            }
        }

        musicChannel = MethodChannel(messenger, "pek/music").also { ch ->
            ch.setMethodCallHandler { call, result ->
                val m = music
                if (m == null) { result.success(null); return@setMethodCallHandler }
                try {
                    when (call.method) {
                        "meta" -> m.meta(
                            call.argument<String>("title") ?: "",
                            call.argument<String>("artist") ?: "",
                            call.argument<String>("album") ?: "",
                            call.argument<String>("art") ?: ""
                        )
                        "state" -> m.state(
                            call.argument<Boolean>("active") ?: false,
                            call.argument<Boolean>("buffering") ?: false,
                            call.argument<Number>("positionMs")?.toLong() ?: 0L,
                            call.argument<Number>("durationMs")?.toLong() ?: 0L
                        )
                        "end" -> m.end()
                        else -> { result.notImplemented(); return@setMethodCallHandler }
                    }
                    result.success(null)
                } catch (t: Throwable) {
                    result.error("music_error", t.message, null)
                }
            }
        }

        MethodChannel(messenger, "pek/plugins").setMethodCallHandler { call, result ->
            when (call.method) {
                "call" -> {
                    val json = call.arguments as? String ?: "{}"
                    pluginPool.execute {
                        val answer = pythonCall(json)
                        runOnUiThread { result.success(answer) }
                    }
                }
                "openUrl" -> result.success(openUrl(call.arguments as? String ?: ""))
                "openApp" -> result.success(openStreamingApp(call.argument<String>("packages") ?: "", call.argument<String>("url") ?: ""))
                else -> result.notImplemented()
            }
        }

        EventChannel(messenger, "pek/mpv/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) { events = sink }
            override fun onCancel(arguments: Any?) { events = null }
        })

        MethodChannel(messenger, "pek/host").setMethodCallHandler { call, result ->
            when (call.method) {
                // The same test as MainActivity.phone: false on Android TV / leanback boxes (html.pek-tv in the web UI).
                "isPhone" -> {
                    val ui = getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
                    val isTv = ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
                        packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                    result.success(!isTv && packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN))
                }
                "setMulticast" -> {
                    setMulticast(call.argument<Boolean>("on") ?: false)
                    result.success(null)
                }
                "classicUi" -> {
                    // Escape hatch while the Flutter UI is still being filled in: open the web UI for this session only
                    // (add sources, plugins, settings there). The next normal launch starts the Flutter UI again.
                    mpv?.destroy()
                    startActivity(Intent(this, MainActivity::class.java).putExtra("pek_classic", true))
                    finish()
                    result.success(null)
                }
                "exit" -> {
                    mpv?.destroy()
                    result.success(null)
                    finishAndRemoveTask()
                    // The server and the Python plugins run on their own threads; ending the process stops them.
                    Handler(Looper.getMainLooper()).postDelayed({ Process.killProcess(Process.myPid()) }, 300)
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun onStop() {
        mpv?.onActivityStop()
        super.onStop()
    }

    override fun onDestroy() {
        pluginPool.shutdown()
        events = null
        setMulticast(false)
        music?.destroy()          // also stops MusicService: without this activity there is no queue to control
        music = null
        mpv?.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
    }
}

// JSONObject -> plain Map / List for the Flutter standard codec.
private fun JSONObject.toMap(): Map<String, Any?> {
    val out = HashMap<String, Any?>()
    for (k in keys()) out[k] = toPlain(opt(k))
    return out
}

private fun toPlain(v: Any?): Any? = when {
    v == null || v === JSONObject.NULL -> null
    v is JSONObject -> v.toMap()
    v is JSONArray -> (0 until v.length()).map { toPlain(v.opt(it)) }
    else -> v
}
