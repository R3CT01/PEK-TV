package com.pektv.app.flutter

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.pektv.app.MpvController
import com.pektv.app.MusicHost
import com.pektv.app.MusicService
import com.pektv.app.MusicState

/**
 * Background play + lock-screen controls for the Flutter UI's music.
 *
 * The sound is still played by [MpvController] (one shared libmpv engine, like the video player). The queue lives in Dart
 * (music_controller.dart). This class is the glue to the existing [MusicService] (foreground service, media notification,
 * MediaSession, CPU / Wi-Fi locks):
 *   Dart -> here   pek/music  meta {title, artist, album, art}   a new song is current
 *                             state {active, buffering, positionMs, durationMs}
 *                             end                                 the queue is closed (or a video took the engine)
 *   here -> Dart   [toDart]("remote", {action: next|prev|stop})    the queue owner handles these
 * Play, pause and seek are answered here at once, so they work even if Dart is busy.
 * It also owns audio focus (pause for calls, resume afterwards) and pauses when headphones are unplugged.
 */
class FlutterMusic(
    private val activity: Activity,
    private val mpv: MpvController,
    private val toDart: (String, Map<String, Any?>) -> Unit
) : MusicHost {

    private val ui = Handler(Looper.getMainLooper())
    private val appContext: Context = activity.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var resumeOnFocus = false
    private var noisyRegistered = false
    private var artUrl = ""
    private var live = false          // a song is current (Dart sent meta, not yet end)

    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            if (i?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) mpv.pause()
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        ui.post {
            when (change) {
                AudioManager.AUDIOFOCUS_GAIN -> if (resumeOnFocus) { resumeOnFocus = false; mpv.play() }
                AudioManager.AUDIOFOCUS_LOSS -> { resumeOnFocus = false; mpv.pause(); dropFocus() }   // another player took over for good
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> if (live && MusicState.active) { resumeOnFocus = true; mpv.pause() }
                // Navigation prompts (AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK): nothing to do here. The request below says we do NOT
                // pause when ducked, so Android lowers our volume by itself for the prompt and restores it afterwards.
            }
        }
    }

    init { MusicService.host = this }

    // ---------------------------------------------------------------- from Dart

    fun meta(title: String, artist: String, album: String, art: String) {
        live = true
        mpv.keepPlayingInBackground = true
        MusicState.title = title; MusicState.artist = artist; MusicState.album = album
        if (art != artUrl) { artUrl = art; MusicState.art = null; fetchArt(art) }
        askNotificationPermissionOnce()
        MusicService.start(appContext)
        MusicService.refresh()
    }

    fun state(active: Boolean, buffering: Boolean, positionMs: Long, durationMs: Long) {
        if (!live) return
        val s = MusicState
        var on = active
        if (on && !takeFocus()) { mpv.pause(); on = false }          // someone else (a call) has the sound
        if (!on && !resumeOnFocus) dropFocus()
        s.active = on
        s.playing = on && !buffering
        s.buffering = on && buffering
        s.positionMs = positionMs
        s.durationMs = durationMs
        MusicService.refresh()
    }

    /** The queue was closed, or a video is taking the engine: give the sound back and remove the notification. */
    fun end() {
        live = false
        mpv.keepPlayingInBackground = false
        dropFocus()
        resumeOnFocus = false
        artUrl = ""
        val s = MusicState
        s.title = ""; s.artist = ""; s.album = ""; s.art = null
        s.active = false; s.playing = false; s.buffering = false
        s.positionMs = 0; s.durationMs = 0
        MusicService.stop(appContext)
    }

    // ---------------------------------------------------------------- buttons (notification, lock screen, headset): main thread

    override fun remotePlay() { if (takeFocus()) { resumeOnFocus = false; mpv.play() } }
    override fun remotePause() { resumeOnFocus = false; mpv.pause() }
    override fun remoteNext() = toDart("remote", mapOf("action" to "next"))
    override fun remotePrev() = toDart("remote", mapOf("action" to "prev"))
    override fun remoteSeek(sec: Double) { mpv.seek(sec) }
    override fun remoteStop() = toDart("remote", mapOf("action" to "stop"))

    /** The task was swiped away (MusicService.onTaskRemoved) or the activity is going: stop everything. */
    override fun destroy() {
        try { mpv.destroy() } catch (t: Throwable) { /* already gone */ }
        end()
    }

    // ---------------------------------------------------------------- audio focus

    private fun takeFocus(): Boolean {
        if (focusRequest != null) return true
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build())
            .setWillPauseWhenDucked(false)      // automatic ducking (Android 8+): the system turns us down for navigation prompts
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
        if (noisyRegistered) {
            try { appContext.unregisterReceiver(noisy) } catch (t: Throwable) { /* ignore */ }
            noisyRegistered = false
        }
    }

    // ---------------------------------------------------------------- notification permission (Android 13+), asked once

    private fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33) return
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = activity.getSharedPreferences("pek", Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked_notif", false)) return
        prefs.edit().putBoolean("asked_notif", true).apply()
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4713)
    }

    // ---------------------------------------------------------------- cover for the notification / lock screen

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
                val bmp: Bitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                ui.post { if (url == artUrl && bmp != null) { MusicState.art = bmp; MusicService.refresh() } }
            } catch (t: Throwable) { Log.w("PEK", "music cover not loaded", t) }
        }.start()
    }
}
