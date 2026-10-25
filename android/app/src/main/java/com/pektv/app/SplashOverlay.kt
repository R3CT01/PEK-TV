package com.pektv.app

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.WindowManager
import android.content.res.Configuration
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.VideoView

/**
 * The splash video, drawn ON TOP of the Flutter screen while the app loads underneath it (the server, the plugins and Flutter's own
 * first frame all start the moment the app opens). It goes away when the video has played  AND the
 * app is ready behind it (the server answers and Flutter has drawn its first frame). If the video cannot play, the PEK-orange cover
 * simply stays until the app is ready. It never stays longer than [MAX_WAIT_AFTER_VIDEO_MS] after the video, so a slow start can't trap
 * the person behind it.
 *
 * Use: `val s = SplashOverlay(activity) { ... }; s.show()` in onCreate (after super.onCreate), `s.flutterShown()` from
 * onFlutterUiDisplayed().
 */
class SplashOverlay(private val activity: Activity, private val onGone: () -> Unit) {

    private val handler = Handler(Looper.getMainLooper())
    private val root = FrameLayout(activity)
    private val video = VideoView(activity)

    // The splash lives in its own window (a Dialog), not inside the activity's view tree. Flutter's SurfaceView is set to
    // draw on top of everything in the activity window (transparent background mode), so a video added as a normal view,
    // even with setZOrderMediaOverlay, ends up BEHIND Flutter's first frame and is never seen. A separate window always
    // sits above all of the activity's surfaces.
    private var dialog: Dialog? = null

    private var videoDone = false
    private var flutterReady = false
    private var serverReady = false
    private var removed = false
    private var giveUp: Runnable? = null

    fun show() {
        root.setBackgroundColor(activity.getColor(R.color.pek_splash_bg))
        root.isClickable = true
        root.isFocusable = true
        root.isFocusableInTouchMode = true
        // Not skippable: touches and keys (including Back) are swallowed while the splash is up.
        root.setOnKeyListener { _, _, _ -> true }

        root.addView(video, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }

        val d = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        d.setCancelable(false)
        d.setOnKeyListener { _, _, _ -> true }   // not skippable: keys (including Back) are swallowed
        d.setContentView(root, FrameLayout.LayoutParams(-1, -1))
        d.window?.let { w ->
            w.setBackgroundDrawable(ColorDrawable(activity.getColor(R.color.pek_splash_bg)))
            w.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
            w.setWindowAnimations(0)
            w.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
            if (Build.VERSION.SDK_INT >= 28) {
                w.attributes = w.attributes.also { it.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
            }
            @Suppress("DEPRECATION")
            w.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
        dialog = d
        try { d.show() } catch (e: Throwable) { dialog = null }
        root.requestFocus()

        video.setOnPreparedListener { mp: MediaPlayer ->
            mp.setVolume(0f, 0f)
            mp.isLooping = false
            fit()
        }
        video.setOnCompletionListener { endVideo() }
        video.setOnErrorListener { _, _, _ -> endVideo(); true }
        try {
            val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
            val res = if (portrait) R.raw.pek_splash_portrait else R.raw.pek_splash
            video.setVideoURI(Uri.parse("android.resource://${activity.packageName}/$res"))
            video.start()
        } catch (e: Throwable) {
            endVideo()
        }

        // The server (Boot) is ready when this thread returns; Flutter calls flutterShown() on its first frame.
        Thread {
            val ok = try { Boot.await() } catch (e: Throwable) { false }
            handler.post { serverReady = true; if (!ok) flutterReady = true; maybeRemove() }
        }.start()
    }

    /** Called from FlutterActivity.onFlutterUiDisplayed(). A short pause lets Flutter swap its loading screen for the app. */
    /** Drops the splash window right away (the activity is going away, so the window must not leak). */
    fun dismissNow() {
        removed = true
        giveUp?.let { handler.removeCallbacks(it) }
        try { video.stopPlayback() } catch (_: Throwable) {}
        try { dialog?.dismiss() } catch (_: Throwable) {}
        dialog = null
    }

    fun flutterShown() {
        handler.postDelayed({ flutterReady = true; maybeRemove() }, 500)
    }

    // VideoView letterboxes. Make it just big enough to cover the screen (centre-crop); the parent clips the overflow.
    private fun fit() {
        val sw = root.width
        val sh = root.height
        if (sw <= 0 || sh <= 0) return
        val port = sh >= sw
        // Both cuts are 16:9 / 9:16 and 1920x1080 sized: scale so the shorter side matches, centre-crop the rest.
        val vidW = if (port) 1080f else 1920f
        val vidH = if (port) 1920f else 1080f
        val scale = maxOf(sw / vidW, sh / vidH)
        val lp = FrameLayout.LayoutParams((vidW * scale).toInt() + 1, (vidH * scale).toInt() + 1, Gravity.CENTER)
        if (video.layoutParams == null || video.layoutParams.width != lp.width || video.layoutParams.height != lp.height) video.layoutParams = lp
    }

    private fun endVideo() {
        if (videoDone) return
        videoDone = true
        try { video.stopPlayback() } catch (_: Throwable) {}
        video.visibility = View.INVISIBLE   // the orange cover stays until the app is ready
        giveUp = Runnable { flutterReady = true; serverReady = true; maybeRemove() }.also { handler.postDelayed(it, MAX_WAIT_AFTER_VIDEO_MS) }
        maybeRemove()
    }

    private fun maybeRemove() {
        if (removed || !videoDone || !flutterReady || !serverReady) return
        removed = true
        giveUp?.let { handler.removeCallbacks(it) }
        root.animate().alpha(0f).setDuration(250).withEndAction {
            try { dialog?.dismiss() } catch (_: Throwable) {}
            dialog = null
            onGone()
        }.start()
    }

    companion object {
        const val MAX_WAIT_AFTER_VIDEO_MS = 6000L
    }
}
