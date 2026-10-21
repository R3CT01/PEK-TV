package com.pektv.app

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
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
 * Background play: the music keeps playing with the screen off or the app in the background. [MusicService] (a
 * foreground service with a media notification and lock-screen controls) keeps the process alive, this class asks for
 * audio focus (pauses for calls and other players, ducks for navigation prompts) and pauses when headphones are
 * unplugged. Notification / lock-screen buttons come back in through the remote* functions.
 */
class MpvAudioController(
    private val activity: Activity,
    private val webView: WebView
) : MPVLib.EventObserver, MusicHost {

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

    // ---- background play: audio focus, headphones unplugged, notification
    private val appContext: Context = activity.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var resumeOnFocus = false      // paused by a short interruption (call, voice prompt): continue afterwards
    private var ducked = false
    private var noisyRegistered = false
    private var artUrl = ""

    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            if (i?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) pause()
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        ui.post {
            when (change) {
                AudioManager.AUDIOFOCUS_GAIN -> {
                    if (ducked) { ducked = false; mpv?.setPropertyString("volume", "100") }
                    if (resumeOnFocus) { resumeOnFocus = false; mpv?.setPropertyBoolean("pause", false) }
                }
                AudioManager.AUDIOFOCUS_LOSS -> {          // another player took over for good
                    resumeOnFocus = false
                    mpv?.setPropertyBoolean("pause", true)
                    dropFocus()
                }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                    if (mpv != null && !paused) { resumeOnFocus = true; mpv?.setPropertyBoolean("pause", true) }
                }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                    ducked = true
                    mpv?.setPropertyString("volume", "30")
                }
            }
        }
    }

    init { MusicService.host = this }

    // ---------------- calls from the page (already on the UI thread) ----------------

    fun load(url: String, startSec: Double, autoplay: Boolean) {
        stopEngine()
        loaded = false
        paused = !autoplay
        pausedForCache = false
        seeking = false
        position = 0.0
        duration = 0.0
        ducked = false
        resumeOnFocus = false
        if (autoplay) {
            if (!takeFocus()) paused = true            // someone else (a call) has the sound: stay paused
            (activity as? MainActivity)?.askNotificationPermissionOnce()
            MusicService.start(appContext)
        }
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
            if (paused && autoplay) m.setPropertyBoolean("pause", true)
            emitState()
            m.command(arrayOf("loadfile", url))
        } catch (t: Throwable) {
            Log.e("PEK", "mpv (music) failed to start", t)
            stopEngine()
            emit("error", JSONObject())
        }
    }

    fun play() {
        val m = mpv ?: return
        if (!takeFocus()) return
        resumeOnFocus = false
        MusicService.start(appContext)
        m.setPropertyBoolean("pause", false)
    }
    fun pause() {
        resumeOnFocus = false
        mpv?.setPropertyBoolean("pause", true)
        dropFocus()
    }

    fun seek(sec: Double) {
        val m = mpv ?: return
        m.command(arrayOf("seek", sec.toString(), "absolute"))
    }

    /** Stop and release the instance (the page keeps its queue). */
    fun stop() { stopEngine(); endSession() }

    override fun destroy() { stopEngine(); endSession() }

    /** The page tells us what is playing, for the notification and lock screen. [url] is an absolute cover URL or "". */
    fun setMeta(title: String, artist: String, album: String, url: String) {
        MusicState.title = title; MusicState.artist = artist; MusicState.album = album
        if (url != artUrl) { artUrl = url; MusicState.art = null; fetchArt(url) }
        MusicService.refresh()
    }

    // ---- buttons on the notification / lock screen / headset (main thread). Native first, so pause and play work even
    // if the page is busy; then the page, which owns the queue.
    override fun remotePlay() { play(); js("window.PekMusic&&PekMusic.resume()") }
    override fun remotePause() { pause(); js("window.PekMusic&&PekMusic.pause()") }
    override fun remoteNext() { js("window.PekMusic&&PekMusic.next(false)") }
    override fun remotePrev() { js("window.PekMusic&&PekMusic.prev()") }
    override fun remoteSeek(sec: Double) { js("window.PekMusic&&PekMusic.seek(" + sec + ")") }
    override fun remoteStop() { js("window.PekMusic&&PekMusic.stop()") }
    private fun js(code: String) { webView.post { webView.evaluateJavascript(code, null) } }

    // ---------------- engine ----------------

    private fun stopEngine() {
        val m = mpv ?: return
        mpv = null
        generation++
        try {
            m.removeObserver(this)
            m.destroy()
        } catch (t: Throwable) { /* already gone */ }
        publish()
    }

    // ---------------------------------------------------------------- audio focus, notification

    private fun takeFocus(): Boolean {
        if (focusRequest != null) return true
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build())
            .setOnAudioFocusChangeListener(focusListener, ui)
            .build()
        val ok = try { audioManager.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED } catch (t: Throwable) { true }
        if (ok) {
            focusRequest = req
            if (!noisyRegistered) {
                try { appContext.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)); noisyRegistered = true }
                catch (t: Throwable) { Log.w("PEK", "noisy receiver not registered", t) }
            }
        }
        return ok
    }

    private fun dropFocus() {
        focusRequest?.let { try { audioManager.abandonAudioFocusRequest(it) } catch (t: Throwable) { /* ignore */ } }
        focusRequest = null
        ducked = false
        if (noisyRegistered) {
            try { appContext.unregisterReceiver(noisy) } catch (t: Throwable) { /* ignore */ }
            noisyRegistered = false
        }
    }

    /** The player was closed (or the app is going away): give the sound back and remove the notification. */
    private fun endSession() {
        dropFocus()
        resumeOnFocus = false
        MusicState.title = ""; MusicState.artist = ""; MusicState.album = ""; MusicState.art = null
        artUrl = ""
        MusicState.active = false; MusicState.playing = false; MusicState.buffering = false
        MusicService.stop(appContext)
    }

    /** Copies what the engine is doing into [MusicState] and tells the service. */
    private fun publish() {
        val s = MusicState
        val live = mpv != null
        s.active = live && !paused
        s.playing = live && loaded && !paused && !pausedForCache && !seeking
        s.buffering = live && (!loaded || seeking || pausedForCache)
        s.positionMs = ((if (position.isNaN()) 0.0 else position) * 1000).toLong()
        s.durationMs = ((if (duration.isNaN()) 0.0 else duration) * 1000).toLong()
        MusicService.refresh()
    }

    private fun fetchArt(url: String) {
        if (url.isEmpty()) return
        Thread {
            try {
                val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                c.connectTimeout = 4000; c.readTimeout = 6000
                val bytes = c.inputStream.use { it.readBytes() }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= 512 && bounds.outHeight / (sample * 2) >= 512) sample *= 2
                val bmp: Bitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
                    BitmapFactory.Options().apply { inSampleSize = sample })
                ui.post {
                    if (url == artUrl && bmp != null) { MusicState.art = bmp; MusicService.refresh() }
                }
            } catch (t: Throwable) { Log.w("PEK", "music cover not loaded", t) }
        }.start()
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
                "duration" -> { duration = value; emitTime(); publish() }
            }
        }
    }

    override fun eventProperty(property: String, value: Boolean) {
        val g = generation
        ui.post {
            if (g != generation) return@post
            when (property) {
                "pause" -> { paused = value; emitState(); publish() }
                "paused-for-cache" -> { pausedForCache = value; emitState(); publish() }
                "seeking" -> { seeking = value; emitState(); publish() }
            }
        }
    }

    override fun event(eventId: Int) {
        val g = generation
        ui.post {
            if (g != generation) return@post
            when (eventId) {
                MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> { loaded = true; emitState(); publish() }
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
