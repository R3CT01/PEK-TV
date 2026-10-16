package com.pektv.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import dev.jdtech.mpv.MPVLib
import org.json.JSONObject

/**
 * libmpv engine for the Music tab (www/music_player.js, MpvEngine).
 *
 * Audio only: no video output and no surface, so it is separate from [MpvController] (the video player) and owns its
 * own mpv instance. One instance plays one song; loading the next song (or stopping) destroys it and starts a new
 * one, so nothing from a finished song can reach the page. The page owns the queue, shuffle and repeat; this class
 * only plays the file it is given and reports back through window.__pekMusicMpv(event, data):
 *   "time"  {position, duration}            about twice a second while playing
 *   "state" {playing, buffering, loaded}    whenever one of them changes
 *   "ended" {}                              the song played to its end
 *   "error" {}                              mpv could not open or decode the file
 *
 * Playing while the app is in the background is not done here yet (see MUSIC.md): [onActivityStop] pauses.
 */
class MpvAudioController(
    private val activity: Activity,
    private val webView: WebView
) : MPVLib.EventObserver {

    private val ui = Handler(Looper.getMainLooper())
    private var mpv: MPVLib? = null

    // Bumped every time an instance is created or destroyed. Events are handed to the UI thread from mpv's own
    // thread, so each one carries the number it was raised under and is dropped if the instance has since changed.
    @Volatile private var generation = 0

    private var loaded = false
    private var paused = false
    private var pausedForCache = false
    private var seeking = false
    private var position = 0.0
    private var duration = 0.0
    private var lastTimeEmit = 0L

    // ---------------- calls from the page (already on the UI thread) ----------------

    fun load(url: String, startSec: Double, autoplay: Boolean) {
        stopEngine()
        loaded = false
        paused = !autoplay
        pausedForCache = false
        seeking = false
        position = 0.0
        duration = 0.0
        try {
            val m = MPVLib.create(activity) ?: throw IllegalStateException("mpv create returned null")
            // Sound only. Each option is set on its own, so one this libmpv build does not know cannot stop playback.
            m.setOptionString("vo", "null")
            m.setOptionString("ao", "audiotrack,opensles")
            m.setOptionString("keep-open", "no")
            for ((key, value) in arrayOf(
                "vid" to "no",                 // never decode embedded cover art as video
                "audio-display" to "no",
                "force-window" to "no",
                "cache" to "yes",
                "cache-secs" to "30",
                "demuxer-max-bytes" to "16MiB",
                "demuxer-max-back-bytes" to "4MiB",
                "cache-pause-initial" to "no",
                "cache-pause-wait" to "2",
                "pause" to (if (autoplay) "no" else "yes"),
                "start" to (if (startSec > 1.0) startSec.toString() else "0")
            )) {
                try { m.setOptionString(key, value) } catch (t: Throwable) { Log.w("PEK", "mpv audio option $key not set", t) }
            }
            m.init()
            generation++
            m.addObserver(this)
            m.observeProperty("time-pos", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
            m.observeProperty("duration", MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
            m.observeProperty("pause", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            m.observeProperty("paused-for-cache", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            m.observeProperty("seeking", MPVLib.MpvFormat.MPV_FORMAT_FLAG)
            mpv = m
            emitState()
            m.command(arrayOf("loadfile", url))
        } catch (t: Throwable) {
            Log.e("PEK", "mpv (music) failed to start", t)
            stopEngine()
            emit("error", JSONObject())
        }
    }

    fun play() { mpv?.setPropertyBoolean("pause", false) }
    fun pause() { mpv?.setPropertyBoolean("pause", true) }

    fun seek(sec: Double) {
        val m = mpv ?: return
        m.command(arrayOf("seek", sec.toString(), "absolute"))
    }

    /** Stop and release the instance (the page keeps its queue). */
    fun stop() { stopEngine() }

    fun destroy() { stopEngine() }

    /** Called from the activity's onStop: no background playback yet, so the music waits. */
    fun onActivityStop() { mpv?.setPropertyBoolean("pause", true) }

    // ---------------- engine ----------------

    private fun stopEngine() {
        val m = mpv ?: return
        mpv = null
        generation++
        try {
            m.removeObserver(this)
            m.destroy()
        } catch (t: Throwable) { /* already gone */ }
    }

    // ---------------- mpv events (mpv's thread) -> UI thread ----------------

    override fun eventProperty(property: String) {}
    override fun eventProperty(property: String, value: Long) {}
    override fun eventProperty(property: String, value: String) {}

    override fun eventProperty(property: String, value: Double) {
        val g = generation
        ui.post {
            if (g != generation) return@post
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
        val g = generation
        ui.post {
            if (g != generation) return@post
            when (property) {
                "pause" -> { paused = value; emitState() }
                "paused-for-cache" -> { pausedForCache = value; emitState() }
                "seeking" -> { seeking = value; emitState() }
            }
        }
    }

    override fun event(eventId: Int) {
        val g = generation
        ui.post {
            if (g != generation) return@post
            when (eventId) {
                MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> { loaded = true; emitState() }
                MPVLib.MpvEvent.MPV_EVENT_END_FILE -> {
                    val finished = loaded
                    stopEngine()                    // the page loads the next song (or not) with a fresh instance
                    emit(if (finished) "ended" else "error", JSONObject())
                }
            }
        }
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
        o.put("buffering", !loaded || seeking || pausedForCache)
        o.put("loaded", loaded)
        emit("state", o)
    }

    private fun emit(event: String, data: JSONObject) {
        val js = "window.__pekMusicMpv && window.__pekMusicMpv('" + event + "'," + data.toString() + ")"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}
