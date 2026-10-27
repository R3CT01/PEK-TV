package com.pektv.app

import android.app.Activity
import android.content.res.Configuration
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout

/**
 * The splash video, full screen in SplashActivity's own window (the launcher).
 *
 * It is drawn into a TextureView, not a SurfaceView: a SurfaceView punches a hole in the window that shows BLACK until the first
 * video frame arrives (and stays black if no frame ever does), while a TextureView is an ordinary view, so the PEK-orange cover
 * underneath shows until the first frame. A video that cannot play therefore leaves the orange screen, never a black one.
 *
 * [onVideoDone] runs exactly once, on the main thread, when the video has played to the end, failed, never started drawing
 * ([FIRST_FRAME_TIMEOUT_MS]) or never finished ([VIDEO_TIMEOUT_MS]). Whatever happens, the splash cannot trap the person.
 * The finished player is kept (not released) so its last frame stays on screen until the app covers it.
 *
 * Everything is logged under the tag "PEKSplash" (adb logcat -s PEKSplash).
 */
class SplashOverlay(
    private val activity: Activity,
    /** The video is over (or could not play): time to open the app. Called once. */
    private val onVideoDone: () -> Unit,
) {

    private val handler = Handler(Looper.getMainLooper())
    private val root = FrameLayout(activity)
    private val textureView = TextureView(activity)
    private var surface: Surface? = null
    private var player: MediaPlayer? = null

    private var done = false
    private var firstFrame = false
    private var removed = false

    fun show() {
        Log.i(TAG, "show()")
        root.setBackgroundColor(activity.getColor(R.color.pek_splash_bg))
        root.isClickable = true
        root.isFocusable = true
        root.isFocusableInTouchMode = true
        root.setOnKeyListener { _, _, _ -> true }   // not skippable: keys (including Back) are swallowed
        root.addView(textureView, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }

        textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
                Log.i(TAG, "texture ready ${width}x$height")
                startVideo(st)
            }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {}
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                // The window went away (Home pressed, screen off): the video cannot go on, so it counts as over.
                Log.i(TAG, "texture destroyed")
                releasePlayer()
                if (!removed) finishVideo()
                return true
            }
        }

        activity.setContentView(root, FrameLayout.LayoutParams(-1, -1))
        @Suppress("DEPRECATION")
        activity.window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        root.requestFocus()

        // Whatever happens with the video, the splash can never outlive these.
        handler.postDelayed({
            if (!firstFrame && !done) { Log.w(TAG, "no video frame after ${FIRST_FRAME_TIMEOUT_MS} ms - skipping the video"); finishVideo() }
        }, FIRST_FRAME_TIMEOUT_MS)
        handler.postDelayed({
            if (!done) { Log.w(TAG, "video never finished - ending it"); finishVideo() }
        }, VIDEO_TIMEOUT_MS)
    }

    private fun startVideo(st: SurfaceTexture) {
        if (done || player != null) return
        try {
            val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
            val res = if (portrait) R.raw.pek_splash_portrait else R.raw.pek_splash
            val s = Surface(st)
            surface = s
            val mp = MediaPlayer()
            player = mp
            activity.resources.openRawResourceFd(res).use { mp.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            mp.setSurface(s)
            mp.setVolume(0f, 0f)
            mp.isLooping = false
            mp.setOnVideoSizeChangedListener { _, w, h -> Log.i(TAG, "video size ${w}x$h"); fit() }
            mp.setOnPreparedListener { p -> Log.i(TAG, "prepared, ${p.duration} ms"); fit(); p.start() }
            mp.setOnInfoListener { _, what, _ ->
                if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) { Log.i(TAG, "first frame drawn"); firstFrame = true }
                false
            }
            mp.setOnCompletionListener { Log.i(TAG, "video finished"); finishVideo() }
            mp.setOnErrorListener { _, what, extra -> Log.e(TAG, "video error what=$what extra=$extra"); finishVideo(); true }
            mp.prepareAsync()
        } catch (e: Throwable) {
            Log.e(TAG, "video could not start", e)
            finishVideo()
        }
    }

    /** Drops the video right away (the activity is going away). */
    fun dismissNow() {
        removed = true
        handler.removeCallbacksAndMessages(null)
        releasePlayer()
        try { surface?.release() } catch (_: Throwable) {}
        surface = null
    }

    // Both cuts are 16:9 / 9:16: size the view so the video just covers the screen (centre-crop); the window clips the overflow.
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
        val lp = textureView.layoutParams
        if (lp == null || lp.width != w || lp.height != h) textureView.layoutParams = FrameLayout.LayoutParams(w, h, Gravity.CENTER)
    }

    private fun releasePlayer() {
        try { player?.setOnCompletionListener(null); player?.setOnErrorListener(null); player?.release() } catch (_: Throwable) {}
        player = null
    }

    private fun finishVideo() {
        if (done) return
        done = true
        // The player is NOT released here: the last video frame stays on the TextureView until the app covers it (the orange
        // cover shows if the video never played).
        if (!removed) onVideoDone()
    }

    companion object {
        const val TAG = "PEKSplash"
        const val FIRST_FRAME_TIMEOUT_MS = 4000L   // the video starts in well under a second; this only catches a player that never draws
        const val VIDEO_TIMEOUT_MS = 12000L        // the clips are 5 s; this only catches a player that never reports back
    }
}
