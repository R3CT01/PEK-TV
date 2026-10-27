package com.pektv.app

import android.app.Activity
import android.content.res.Configuration
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout

/**
 * The splash video, full screen in SplashActivity's own window (the launcher). See [SplashGate] for how it works with the Flutter
 * screen, which boots at the same time, invisible, above this window.
 *
 * The splash is lifted ([onGone]) only when ALL of these are true:
 *  - the video has played to the end (it cannot be skipped: touches, keys and Back are swallowed here and by the Flutter window),
 *  - the server answers (Boot), and
 *  - the Flutter app says it has loaded ([appReady]).
 * It never waits longer than [MAX_WAIT_AFTER_VIDEO_MS] after the video for the last two, and a video that cannot play ends after
 * [VIDEO_TIMEOUT_MS], so a slow or broken start cannot trap the person. If the video cannot play at all, the PEK-orange cover
 * stays until the app is ready.
 *
 * The video is drawn with MediaPlayer into a SurfaceView: frames go to the screen without passing through the app's main thread,
 * so the video does not stutter while Flutter's activity is being created on that thread.
 *
 * Everything is logged under the tag "PEKSplash" (adb logcat -s PEKSplash).
 */
class SplashOverlay(
    private val activity: Activity,
    /** The video is on screen: time to start booting the Flutter screen behind it. Called once. */
    private val onVideoStarted: () -> Unit,
    /** Video over, server up, app ready: reveal the app. Called once. */
    private val onGone: () -> Unit,
) {

    private val handler = Handler(Looper.getMainLooper())
    private val root = FrameLayout(activity)
    private val surfaceView = SurfaceView(activity)
    private var player: MediaPlayer? = null

    private var videoDone = false
    private var serverReady = false
    private var appReady = false
    private var removed = false
    private var startedNotified = false
    private var giveUp: Runnable? = null

    fun show() {
        Log.i(TAG, "show()")
        root.setBackgroundColor(activity.getColor(R.color.pek_splash_bg))
        root.isClickable = true
        root.isFocusable = true
        root.isFocusableInTouchMode = true
        root.setOnKeyListener { _, _, _ -> true }   // not skippable: keys (including Back) are swallowed
        root.addView(surfaceView, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }

        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) { Log.i(TAG, "surface ready"); startVideo(holder) }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                // The window went away (Home pressed, screen off): the video cannot go on, so it counts as over.
                Log.i(TAG, "surface destroyed")
                releasePlayer()
                if (!removed) endVideo()
            }
        })

        activity.setContentView(root, FrameLayout.LayoutParams(-1, -1))
        @Suppress("DEPRECATION")
        activity.window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        root.requestFocus()

        // Already told (Flutter was faster than this object, which cannot really happen, but costs nothing to handle).
        appReady = SplashGate.wasAppReady()

        // The server (Boot) is ready when this thread returns; Flutter calls SplashGate.appReady() when the app has loaded.
        Thread {
            val ok = try { Boot.await() } catch (e: Throwable) { false }
            handler.post {
                Log.i(TAG, "server ready=$ok")
                serverReady = true
                if (!ok) appReady = true   // the Flutter screen shows its own "server did not start" message: just stop waiting
                maybeRemove()
            }
        }.start()

        // Whatever happens with the video, the splash can never outlive this.
        handler.postDelayed({
            if (!videoDone) { Log.w(TAG, "video never finished - ending it"); endVideo() }
        }, VIDEO_TIMEOUT_MS)
    }

    /** Flutter has loaded the app (server up, update check done, first real screen built). Safe from any thread. */
    fun appReady() {
        handler.post {
            if (appReady) return@post
            Log.i(TAG, "app ready")
            appReady = true
            maybeRemove()
        }
    }

    private fun startVideo(holder: SurfaceHolder) {
        if (videoDone || player != null) return
        try {
            val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
            val res = if (portrait) R.raw.pek_splash_portrait else R.raw.pek_splash
            val mp = MediaPlayer()
            player = mp
            activity.resources.openRawResourceFd(res).use { mp.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            mp.setDisplay(holder)
            mp.setVolume(0f, 0f)
            mp.isLooping = false
            mp.setVideoScalingMode(MediaPlayer.VIDEO_SCALING_MODE_SCALE_TO_FIT_WITH_CROPPING)
            mp.setOnVideoSizeChangedListener { _, w, h -> Log.i(TAG, "video size ${w}x$h"); fit() }
            mp.setOnPreparedListener { p -> Log.i(TAG, "prepared, ${p.duration} ms"); fit(); p.start() }
            mp.setOnInfoListener { _, what, _ ->
                if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) {
                    Log.i(TAG, "first frame drawn")
                    // A moment later, so the first frames are not competing with the Flutter screen's start-up on the main thread.
                    handler.postDelayed({ notifyVideoStarted() }, FLUTTER_START_DELAY_MS)
                }
                false
            }
            mp.setOnCompletionListener { Log.i(TAG, "video finished"); endVideo() }
            mp.setOnErrorListener { _, what, extra -> Log.e(TAG, "video error what=$what extra=$extra"); endVideo(); true }
            mp.prepareAsync()
        } catch (e: Throwable) {
            Log.e(TAG, "video could not start", e)
            endVideo()
        }
    }

    private fun notifyVideoStarted() {
        if (startedNotified || removed) return
        startedNotified = true
        Log.i(TAG, "starting the app behind the video")
        onVideoStarted()
    }

    /** Drops the video right away (the activity is going away). */
    fun dismissNow() {
        removed = true
        giveUp?.let { handler.removeCallbacks(it) }
        handler.removeCallbacksAndMessages(null)
        releasePlayer()
    }

    // Both cuts are 16:9 / 9:16: scale so the video just covers the screen (centre-crop); the window clips the overflow.
    private fun fit() {
        val sw = root.width
        val sh = root.height
        if (sw <= 0 || sh <= 0) return
        val port = sh >= sw
        val vw = player?.videoWidth?.takeIf { it > 0 }?.toFloat() ?: if (port) 1080f else 1920f
        val vh = player?.videoHeight?.takeIf { it > 0 }?.toFloat() ?: if (port) 1920f else 1080f
        val scale = maxOf(sw / vw, sh / vh)
        val w = (vw * scale).toInt() + 1
        val h = (vh * scale).toInt() + 1
        val lp = surfaceView.layoutParams
        if (lp == null || lp.width != w || lp.height != h) surfaceView.layoutParams = FrameLayout.LayoutParams(w, h, Gravity.CENTER)
    }

    private fun releasePlayer() {
        try { player?.setOnCompletionListener(null); player?.setOnErrorListener(null); player?.release() } catch (_: Throwable) {}
        player = null
    }

    private fun endVideo() {
        if (videoDone) return
        videoDone = true
        // The player is NOT released here: a finished MediaPlayer leaves its last frame on the surface, and that frame is what
        // stays on screen until the app is revealed (the cover is brand orange if the video never played).
        notifyVideoStarted()   // a video that never played still has to start the app
        giveUp = Runnable {
            Log.w(TAG, "gave up waiting (server=$serverReady app=$appReady)")
            serverReady = true; appReady = true; maybeRemove()
        }.also { handler.postDelayed(it, MAX_WAIT_AFTER_VIDEO_MS) }
        maybeRemove()
    }

    private fun maybeRemove() {
        if (removed || !videoDone || !serverReady || !appReady) return
        removed = true
        giveUp?.let { handler.removeCallbacks(it) }
        Log.i(TAG, "splash done - revealing the app")
        onGone()
    }

    companion object {
        const val TAG = "PEKSplash"
        const val MAX_WAIT_AFTER_VIDEO_MS = 6000L
        const val VIDEO_TIMEOUT_MS = 12000L          // the clips are 5 s; this only catches a player that never reports back
        const val FLUTTER_START_DELAY_MS = 250L
    }
}
