package com.pektv.app

import android.app.Activity
import android.content.Context
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
 * the page through window.__pekMpv(event, data).
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

    // "Smooth mode": video goes straight from MediaCodec to the screen (vo=mediacodec_embed) instead of
    // through mpv's OpenGL renderer. Far lighter on weak / 32-bit TV chips, but mpv cannot draw subtitles
    // that way, so it is dropped for any video that shows a subtitle. Switched on automatically when
    // frames are being dropped, and remembered.
    private val prefs = activity.getSharedPreferences("pek_player", Context.MODE_PRIVATE)
    private var lite = prefs.getBoolean("lite", false)
    private var liteSuspended = false          // a subtitle is showing: this video uses the normal renderer
    private var lastDrops = -1L
    private var watchUntil = 0L
    private val stutterCheck = Runnable { checkStutter() }

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
        liteSuspended = false
        ui.removeCallbacks(stutterCheck)
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
    fun setSubtitle(id: Int) {
        val m = mpv ?: return
        // Smooth mode cannot draw subtitles: use the normal renderer while one is chosen.
        if (lite) {
            if (id >= 0 && !liteSuspended) { liteSuspended = true; applyRenderer(m) }
            else if (id < 0 && liteSuspended) { liteSuspended = false; applyRenderer(m) }
        }
        m.setPropertyString("sid", if (id < 0) "no" else id.toString())
    }

    // Turn smooth mode on / off (also reachable from the page: mpvSetLite).
    fun setLite(on: Boolean) {
        lite = on
        liteSuspended = false
        prefs.edit().putBoolean("lite", on).apply()
        mpv?.let { applyRenderer(it) }
    }
    fun isLite(): Boolean = lite

    private fun useEmbed() = lite && !liteSuspended

    private fun applyRenderer(m: MPVLib) {
        try {
            if (useEmbed()) {
                m.setPropertyString("hwdec", "mediacodec")
                m.setPropertyString("vo", "mediacodec_embed")
            } else {
                m.setPropertyString("hwdec", "mediacodec,mediacodec-copy")
                m.setPropertyString("vo", "gpu")
            }
        } catch (t: Throwable) { Log.w("PEK", "could not switch renderer", t) }
    }

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
            m.setOptionString("vo", if (useEmbed()) "mediacodec_embed" else "gpu")
            m.setOptionString("gpu-context", "android")
            m.setOptionString("opengl-es", "yes")
            m.setOptionString("hwdec", if (useEmbed()) "mediacodec" else "mediacodec,mediacodec-copy")
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
                try { m.setOptionString(key, value) } catch (t: Throwable) { Log.w("PEK", "mpv option $key not set", t) }
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
            Log.e("PEK", "mpv failed to start", t)
            fail()
        }
    }

    private fun stopEngine() {
        pendingUrl = null
        ui.removeCallbacks(stutterCheck)
        watchUntil = 0L
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
                it.setPropertyString("vo", if (useEmbed()) "mediacodec_embed" else "gpu")
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
                    if (watchUntil == 0L) startStutterWatch()
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
        // A file whose subtitles show by default needs the normal renderer.
        if (lite && !liteSuspended) {
            val sid = mpv?.getPropertyString("sid")
            if (sid != null && sid != "no" && sid != "false") { liteSuspended = true; mpv?.let { applyRenderer(it) } }
        }
        watchUntil = 0L
        startStutterWatch()
    }

    // ---------------- dropped frames: log what the decoder is doing, switch to smooth mode if it struggles ----------------

    private fun startStutterWatch() {
        ui.removeCallbacks(stutterCheck)
        lastDrops = -1L
        watchUntil = SystemClock.uptimeMillis() + 45_000L
        ui.postDelayed(stutterCheck, 4_000L)
    }

    private fun checkStutter() {
        val m = mpv ?: return
        if (SystemClock.uptimeMillis() > watchUntil) return
        try {
            val drops = (m.getPropertyInt("frame-drop-count") ?: 0).toLong() +
                        (m.getPropertyInt("decoder-frame-drop-count") ?: 0).toLong()
            Log.i("PEK", "playback: vo=" + m.getPropertyString("current-vo") +
                " hwdec=" + m.getPropertyString("hwdec-current") +
                " codec=" + m.getPropertyString("video-format") +
                " " + m.getPropertyString("width") + "x" + m.getPropertyString("height") +
                " fps=" + m.getPropertyString("container-fps") +
                " drops=" + drops + " delayed=" + m.getPropertyString("vo-delayed-frame-count") +
                " lite=" + lite + (if (liteSuspended) "(subtitle)" else ""))
            if (!buffering && !paused && !seeking) {
                // 15 or more frames lost in 4 seconds of normal playback: the renderer cannot keep up.
                if (lastDrops >= 0 && drops - lastDrops >= 15 && !lite) {
                    val sid = m.getPropertyString("sid")
                    if (sid == null || sid == "no" || sid == "false") {
                        lite = true; liteSuspended = false
                        prefs.edit().putBoolean("lite", true).apply()
                        applyRenderer(m)
                        Toast.makeText(activity, "Smooth playback mode on", Toast.LENGTH_SHORT).show()
                        return
                    }
                }
                lastDrops = drops
            } else {
                lastDrops = -1L
            }
        } catch (t: Throwable) { Log.w("PEK", "playback check failed", t) }
        ui.postDelayed(stutterCheck, 4_000L)
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
        // Chapters (title + start second): the page turns "Intro" / "Opening" / "Recap" / "Previously on" ones into
        // Skip Intro / Skip Recap buttons (www/skip_segments.js). Works the same for library files and torrent streams.
        val chapters = JSONArray()
        if (m != null) {
            try {
                val cn = m.getPropertyInt("chapter-list/count") ?: 0
                for (i in 0 until minOf(cn, 200)) {
                    val time = m.getPropertyString("chapter-list/$i/time")?.toDoubleOrNull() ?: continue
                    val c = JSONObject()
                    c.put("title", m.getPropertyString("chapter-list/$i/title") ?: "")
                    c.put("time", time)
                    chapters.put(c)
                }
            } catch (t: Throwable) { Log.w("PEK", "chapter list unavailable", t) }
        }
        return JSONObject().put("audio", audio).put("subtitles", subs).put("chapters", chapters)
    }

    private fun emit(event: String, data: JSONObject) {
        val js = "window.__pekMpv && window.__pekMpv('" + event + "'," + data.toString() + ")"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}
