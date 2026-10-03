package com.hesper.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.webkit.WebView
import android.widget.Toast
import dev.jdtech.mpv.MPVLib
import org.json.JSONArray
import org.json.JSONObject

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
        buffering = true
        position = 0.0
        duration = 0.0
        pendingUrl = url
        surfaceView.visibility = View.VISIBLE
        if (surfaceReady) startPending()      // otherwise surfaceCreated() starts it
    }

    fun play() { mpv?.setPropertyBoolean("pause", false) }
    fun pause() { mpv?.setPropertyBoolean("pause", true) }
    fun seek(sec: Double) { mpv?.command(arrayOf("seek", sec.toString(), "absolute")) }
    fun setAudio(id: Int) { mpv?.setPropertyString("aid", id.toString()) }
    fun setSubtitle(id: Int) { mpv?.setPropertyString("sid", if (id < 0) "no" else id.toString()) }

    fun destroy() {
        stopEngine()
        surfaceView.visibility = View.GONE
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
            m.init()
            m.addObserver(this)
            m.observeProperty("time-pos", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
            m.observeProperty("duration", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
            m.observeProperty("pause", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            m.observeProperty("paused-for-cache", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
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
        Toast.makeText(activity, "Player has crashed - please restart", Toast.LENGTH_LONG).show()
        emit("ended", JSONObject())          // closes the web player layer
    }

    // ---------------- surface ----------------

    override fun surfaceCreated(holder: SurfaceHolder) {
        surfaceReady = true
        if (pendingUrl != null) startPending() else mpv?.attachSurface(holder.surface)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
        mpv?.setPropertyString("android-surface-size", w.toString() + "x" + h.toString())
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        surfaceReady = false
        mpv?.detachSurface()
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
                "paused-for-cache" -> { buffering = value; emitState() }
            }
        }
    }

    override fun event(eventId: Int) {
        ui.post {
            when (eventId) {
                MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> onFileLoaded()
                MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART -> { buffering = false; emitState() }
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
        buffering = false
        if (startSec > 1.0) seek(startSec)
        emit("tracks", readTracks())
        emitState()
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
