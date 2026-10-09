package com.hesper.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import dev.jdtech.mpv.MPVLib
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * libmpv engine for the shared web player (player.js).
 *
 * The video is drawn on [surfaceView], which sits BEHIND the transparent WebView.
 * All the buttons, seek bar, menus and the exit prompt are the web player's own;
 * this class only plays the file and reports time / state / tracks / end back to
 * the page through window.__hesperMpv(event, data).
 *
 * If mpv can't start or can't open the file, the player is closed and the user is
 * told to restart (there is no second player to fall back to).
 */
class MpvController(
    private val activity: Activity,
    private val surfaceView: SurfaceView,
    private val webView: WebView
) : SurfaceHolder.Callback, MPVLib.EventObserver {

    private val ui = Handler(Looper.getMainLooper())
    private var mpv: MPVLib? = null
    private var surfaceReady = false

    private var pendingUrl: String? = null
    private var startSec = 0.0

    private var loaded = false
    private var paused = false
    private var buffering = true
    // What makes up "buffering": the file is still opening, a jump is under way, or mpv paused to refill its cache.
    // A jump into a part of a torrent that is not downloaded yet is the slow case: mpv sits in the read until the
    // pieces arrive, and the page has to know, so it can show how far the download is.
    private var seeking = false
    private var seekPending = false
    private var seekAt = 0L
    private var pausedForCache = false
    private var position = 0.0
    private var duration = 0.0
    private var lastTimeEmit = 0L

    init {
        surfaceView.holder.addCallback(this)
    }

    // ---------------- calls from the page (already on the UI thread) ----------------

    @Suppress("UNUSED_PARAMETER")
    fun load(url: String, startSec: Double, title: String, theme: String) {
        stopEngine()
        this.startSec = startSec
        loaded = false
        paused = false
        seeking = false
        seekPending = false
        pausedForCache = false
        buffering = true
        position = 0.0
        duration = 0.0
        pendingUrl = url
        setFullscreen()                     // a new video always starts full screen
        surfaceView.visibility = View.VISIBLE
        keepScreenOn(true)                    // no sleep / screensaver while a video is open, playing or paused
        if (surfaceReady) startPending()      // otherwise surfaceCreated() starts it
    }

    fun play() { mpv?.setPropertyBoolean("pause", false) }
    fun pause() { mpv?.setPropertyBoolean("pause", true) }
    fun seek(sec: Double) {
        val m = mpv ?: return
        // Say "buffering" right away (mpv's own flag can lag a moment behind); PLAYBACK_RESTART clears it.
        seekPending = true
        seekAt = SystemClock.uptimeMillis()
        updateBuffering()
        emitState()
        m.command(arrayOf("seek", sec.toString(), "absolute"))
        // If mpv never answers (a seek it refused), don't leave the page waiting for ever.
        ui.postDelayed({
            if (seekPending && SystemClock.uptimeMillis() - seekAt >= 60_000L) {
                seekPending = false
                updateBuffering()
                emitState()
            }
        }, 60_000L)
    }
    fun setAudio(id: Int) { mpv?.setPropertyString("aid", id.toString()) }
    fun setSubtitle(id: Int) { mpv?.setPropertyString("sid", if (id < 0) "no" else id.toString()) }

    // Mini player: shrink the picture into a rectangle given in the page's CSS px.
    // The surface sits in the same FrameLayout as the WebView, so the page's
    // coordinates line up with it directly (CSS px * density = device px).
    fun setMiniRect(left: Double, top: Double, width: Double, height: Double) {
        val d = activity.resources.displayMetrics.density.toDouble()
        val lp = FrameLayout.LayoutParams(
            (width * d).roundToInt().coerceAtLeast(1),
            (height * d).roundToInt().coerceAtLeast(1)
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.leftMargin = (left * d).roundToInt()
        lp.topMargin = (top * d).roundToInt()
        surfaceView.layoutParams = lp
    }

    fun setFullscreen() {
        surfaceView.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
    }

    fun destroy() {
        stopEngine()
        surfaceView.visibility = View.GONE
        keepScreenOn(false)
    }

    private fun keepScreenOn(on: Boolean) {
        val w = activity.window
        if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /** Called from the activity's onStop: don't keep playing in the background. */
    fun onActivityStop() { mpv?.setPropertyBoolean("pause", true) }

    // ---------------- engine ----------------

    private fun startPending() {
        val u = pendingUrl ?: return
        pendingUrl = null
        try {
            val m = MPVLib.create(activity) ?: throw IllegalStateException("mpv create returned null")
            m.setOptionString("vo", "gpu")
            m.setOptionString("gpu-context", "android")
            m.setOptionString("opengl-es", "yes")
            m.setOptionString("hwdec", "mediacodec,mediacodec-copy")
            m.setOptionString("ao", "audiotrack,opensles")
            m.setOptionString("keep-open", "no")
            // Smooth playback on weak TV chips: cheapest scalers, no extra video processing, and let every
            // codec the chip can decode use hardware. Each option is set on its own, so one this libmpv build
            // does not know cannot stop the player from starting.
            for ((key, value) in arrayOf(
                "hwdec-codecs" to "all",
                "scale" to "bilinear", "dscale" to "bilinear", "cscale" to "bilinear",
                "correct-downscaling" to "no", "sigmoid-upscaling" to "no",
                "deband" to "no", "interpolation" to "no", "dither-depth" to "no",
                "video-sync" to "audio", "framedrop" to "vo",
                "vd-lavc-fast" to "yes", "vd-lavc-skiploopfilter" to "nonref"
            )) {
                try { m.setOptionString(key, value) } catch (t: Throwable) { Log.w("Hesper", "mpv option $key not set", t) }
            }
            // Streaming from a torrent: keep a good stretch decoded-ahead AND behind, so scrubbing back and
            // forth inside it needs no new download, and wait for a few seconds after a stall before resuming
            // (resuming at once just stutters again).
            m.setOptionString("cache", "yes")
            m.setOptionString("cache-secs", "60")
            m.setOptionString("demuxer-max-bytes", "48MiB")
            m.setOptionString("demuxer-max-back-bytes", "16MiB")
            m.setOptionString("cache-pause-initial", "no")
            m.setOptionString("cache-pause-wait", "4")
            m.init()
            m.addObserver(this)
            m.observeProperty("time-pos", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
            m.observeProperty("duration", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
            m.observeProperty("pause", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            m.observeProperty("paused-for-cache", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            m.observeProperty("seeking", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            m.attachSurface(surfaceView.holder.surface)
            mpv = m
            m.command(arrayOf("loadfile", u))
        } catch (t: Throwable) {
            Log.e("Hesper", "mpv failed to start", t)
            fail()
        }
    }

    private fun stopEngine() {
        pendingUrl = null
        val m = mpv ?: return
        mpv = null
        try {
            m.removeObserver(this)
            m.detachSurface()
            m.destroy()
        } catch (t: Throwable) { /* already gone */ }
    }

    // mpv failed: close the player and tell the user. No second player to fall back to.
    private fun fail() {
        stopEngine()
        surfaceView.visibility = View.GONE
        keepScreenOn(false)
        Toast.makeText(activity, "Player has crashed - please restart", Toast.LENGTH_LONG).show()
        emit("ended", JSONObject())          // closes the web player layer
    }

    // ---------------- surface ----------------

    override fun surfaceCreated(holder: SurfaceHolder) {
        surfaceReady = true
        if (pendingUrl != null) {
            startPending()
        } else {
            // Coming back after the TV slept / the app was stopped: hand mpv the new surface
            // AND restart its video output, which surfaceDestroyed() switched off.
            mpv?.let {
                it.attachSurface(holder.surface)
                it.setPropertyString("force-window", "yes")
                it.setPropertyString("vo", "gpu")
            }
        }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
        mpv?.setPropertyString("android-surface-size", w.toString() + "x" + h.toString())
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        surfaceReady = false
        // Stop drawing BEFORE the surface goes away; otherwise the video output stays bound to a
        // dead surface and never recovers (black screen, audio only).
        mpv?.let {
            it.setPropertyString("vo", "null")
            it.setPropertyString("force-window", "no")
            it.detachSurface()
        }
    }

    // ---------------- mpv events (mpv's thread) -> UI thread ----------------

    override fun eventProperty(property: String) {}
    override fun eventProperty(property: String, value: Long) {}
    override fun eventProperty(property: String, value: String) {}

    override fun eventProperty(property: String, value: Double) {
        ui.post {
            when (property) {
                "time-pos" -> {
                    position = value
                    val now = SystemClock.uptimeMillis()
                    if (now - lastTimeEmit >= 500) { lastTimeEmit = now; emitTime() }
                }
                "duration" -> { duration = value; emitTime() }
            }
        }
    }

    override fun eventProperty(property: String, value: Boolean) {
        ui.post {
            when (property) {
                "pause" -> { paused = value; emitState() }
                "paused-for-cache" -> { pausedForCache = value; updateBuffering(); emitState() }
                "seeking" -> { seeking = value; updateBuffering(); emitState() }
            }
        }
    }

    override fun event(eventId: Int) {
        ui.post {
            when (eventId) {
                MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> onFileLoaded()
                MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART -> {
                    seeking = false
                    seekPending = false
                    updateBuffering()
                    emitState()
                }
                MPVLib.MpvEvent.MPV_EVENT_END_FILE -> {
                    if (mpv == null) return@post                       // we stopped it ourselves
                    if (loaded) emit("ended", JSONObject())
                    else fail()
                }
            }
        }
    }

    private fun onFileLoaded() {
        loaded = true
        updateBuffering()
        if (startSec > 1.0) seek(startSec)
        emit("tracks", readTracks())
        emitState()
    }

    private fun updateBuffering() {
        buffering = !loaded || seeking || seekPending || pausedForCache
    }

    // ---------------- reporting to the page ----------------

    private fun emitTime() {
        val o = JSONObject()
        o.put("position", if (position.isNaN()) 0.0 else position)
        o.put("duration", if (duration.isNaN()) 0.0 else duration)
        emit("time", o)
    }

    private fun emitState() {
        val o = JSONObject()
        o.put("playing", !paused)
        o.put("buffering", buffering)
        emit("state", o)
    }

    private fun readTracks(): JSONObject {
        val audio = JSONArray()
        val subs = JSONArray()
        val m = mpv
        if (m != null) {
            val n = m.getPropertyInt("track-list/count") ?: 0
            for (i in 0 until n) {
                val type = m.getPropertyString("track-list/$i/type") ?: continue
                if (type != "audio" && type != "sub") continue
                val id = m.getPropertyInt("track-list/$i/id") ?: continue
                val parts = ArrayList<String>()
                for (key in arrayOf("title", "lang", "codec")) {
                    val v = m.getPropertyString("track-list/$i/$key")
                    if (!v.isNullOrBlank()) parts.add(if (key == "codec") v.uppercase() else v)
                }
                val t = JSONObject()
                t.put("id", id)
                t.put("label", if (parts.isEmpty()) "Track $id" else parts.joinToString(" - "))
                t.put("selected", m.getPropertyBoolean("track-list/$i/selected") ?: false)
                if (type == "audio") audio.put(t) else subs.put(t)
            }
        }
        return JSONObject().put("audio", audio).put("subtitles", subs)
    }

    private fun emit(event: String, data: JSONObject) {
        val js = "window.__hesperMpv && window.__hesperMpv('" + event + "'," + data.toString() + ")"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}
