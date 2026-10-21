package com.pektv.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/** Whoever owns the sound (the web UI's MpvAudioController, or the Flutter UI's FlutterMusic) and answers the notification / lock-screen buttons. */
interface MusicHost {
    fun remotePlay()
    fun remotePause()
    fun remoteNext()
    fun remotePrev()
    fun remoteSeek(sec: Double)
    fun remoteStop()
    fun destroy()
}

/** What the music tab is doing right now, written by [MpvAudioController] and read by [MusicService]. */
object MusicState {
    @Volatile var title = ""
    @Volatile var artist = ""
    @Volatile var album = ""
    @Volatile var art: Bitmap? = null
    @Volatile var active = false        // a song is playing, or about to (not paused by the user)
    @Volatile var playing = false       // sound is coming out
    @Volatile var buffering = false
    @Volatile var positionMs = 0L
    @Volatile var durationMs = 0L
}

/**
 * Foreground service that keeps the Music tab playing with the screen off or the app in the background.
 *
 * The sound itself is still played by [MpvAudioController]; this service only keeps the process alive and awake
 * (foreground notification, CPU + Wi-Fi locks while playing) and shows the media notification / lock-screen
 * controls (a MediaSession). Button presses are handed back to the controller, which talks to the page.
 * The service stops when the user closes the player, the app exits, or nothing has played for [IDLE_STOP_MS].
 */
class MusicService : Service() {

    companion object {
        const val ACTION_PLAY = "com.pektv.app.music.PLAY"
        const val ACTION_PAUSE = "com.pektv.app.music.PAUSE"
        const val ACTION_NEXT = "com.pektv.app.music.NEXT"
        const val ACTION_PREV = "com.pektv.app.music.PREV"
        const val ACTION_STOP = "com.pektv.app.music.STOP"

        private const val CHANNEL = "pek_music"
        private const val NOTIF_ID = 4721
        private const val LOCK_GRACE_MS = 3000L          // covers the gap between two songs
        private const val IDLE_STOP_MS = 10 * 60 * 1000L // paused / finished for this long: let go
        private const val LOCK_MAX_MS = 3 * 60 * 60 * 1000L

        @Volatile var instance: MusicService? = null
        @Volatile var host: MusicHost? = null

        fun start(ctx: Context) {
            if (instance != null) { refresh(); return }
            try {
                ctx.startForegroundService(Intent(ctx, MusicService::class.java))
            } catch (t: Throwable) {
                Log.w("PEK", "music service could not start", t)   // e.g. started from the background on Android 12+
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, MusicService::class.java)) } catch (t: Throwable) { /* not running */ }
        }

        /** Call after [MusicState] changed (not for every time tick). Safe from any thread. */
        fun refresh() {
            val s = instance ?: return
            s.ui.post { s.render() }
        }
    }

    private val ui = Handler(Looper.getMainLooper())
    private lateinit var session: MediaSession
    private lateinit var nm: NotificationManager
    private var foreground = false
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private val releaseLocks = Runnable { setLocks(false) }
    private val idleStop = Runnable { Log.i("PEK", "music idle, stopping service"); stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Music playback", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                description = "Controls for the music that is playing"
            })
        session = MediaSession(this, "PEK TV Music").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() { host?.remotePlay() }
                override fun onPause() { host?.remotePause() }
                override fun onSkipToNext() { host?.remoteNext() }
                override fun onSkipToPrevious() { host?.remotePrev() }
                override fun onSeekTo(pos: Long) { host?.remoteSeek(pos / 1000.0) }
                override fun onStop() { host?.remoteStop() }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> host?.remotePlay()
            ACTION_PAUSE -> host?.remotePause()
            ACTION_NEXT -> host?.remoteNext()
            ACTION_PREV -> host?.remotePrev()
            ACTION_STOP -> host?.remoteStop()
        }
        render()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        setLocks(false)
        try { session.isActive = false; session.release() } catch (t: Throwable) { /* ignore */ }
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (t: Throwable) { /* ignore */ }
        foreground = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    // The user swiped PEK TV out of the recents list: the activity is gone and so is the page, so stop.
    override fun onTaskRemoved(rootIntent: Intent?) {
        host?.destroy()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    // ---------------------------------------------------------------- drawing

    private fun render() {
        val s = MusicState
        val state = when {
            s.playing -> PlaybackState.STATE_PLAYING
            s.active && s.buffering -> PlaybackState.STATE_BUFFERING
            else -> PlaybackState.STATE_PAUSED
        }
        try {
            session.setMetadata(MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.durationMs)
                .apply { s.art?.let { putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) } }
                .build())
            session.setPlaybackState(PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                    PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                    PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP)
                .setState(state, s.positionMs, if (s.playing) 1f else 0f)
                .build())
        } catch (t: Throwable) { Log.w("PEK", "media session update failed", t) }

        val n = buildNotification(s)
        try {
            if (!foreground) {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                } else {
                    startForeground(NOTIF_ID, n)
                }
                foreground = true
            } else {
                nm.notify(NOTIF_ID, n)
            }
        } catch (t: Throwable) {
            Log.w("PEK", "music service could not go foreground", t)
        }

        ui.removeCallbacks(releaseLocks)
        ui.removeCallbacks(idleStop)
        if (s.active) {
            setLocks(true)
        } else {
            ui.postDelayed(releaseLocks, LOCK_GRACE_MS)
            ui.postDelayed(idleStop, IDLE_STOP_MS)
        }
    }

    private fun action(icon: Int, label: String, act: String, code: Int): Notification.Action {
        val pi = PendingIntent.getService(this, code, Intent(this, MusicService::class.java).setAction(act),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(Icon.createWithResource(this, icon), label, pi).build()
    }

    private fun buildNotification(s: MusicState): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val b = Notification.Builder(this, CHANNEL)
        b.setSmallIcon(R.drawable.ic_stat_music)
            .setContentTitle(s.title.ifEmpty { "PEK TV" })
            .setContentText(s.artist)
            .setSubText(s.album.ifEmpty { null })
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(s.playing)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
        s.art?.let { b.setLargeIcon(it) }
        b.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV, 1))
        if (s.playing || (s.active && s.buffering)) {
            b.addAction(action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE, 2))
        } else {
            b.addAction(action(android.R.drawable.ic_media_play, "Play", ACTION_PLAY, 3))
        }
        b.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT, 4))
        b.addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "Close", ACTION_STOP, 5))
        b.setStyle(Notification.MediaStyle()
            .setMediaSession(session.sessionToken)
            .setShowActionsInCompactView(0, 1, 2))
        return b.build()
    }

    // ---------------------------------------------------------------- keeping the CPU and Wi-Fi awake while music plays

    @Suppress("DEPRECATION")
    private fun setLocks(on: Boolean) {
        try {
            if (on) {
                if (wake == null) {
                    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pektv:music").apply { setReferenceCounted(false) }
                }
                wake?.acquire(LOCK_MAX_MS)        // renewed on every render while playing
                if (wifi == null) {
                    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                    wifi = wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "pektv:music")?.apply { setReferenceCounted(false) }
                }
                wifi?.let { if (!it.isHeld) it.acquire() }
            } else {
                wake?.let { if (it.isHeld) it.release() }
                wifi?.let { if (it.isHeld) it.release() }
            }
        } catch (t: Throwable) {
            Log.w("PEK", "music lock failed", t)
        }
    }
}
