package com.pektv.app

import android.app.Activity
import android.app.Dialog
import android.content.res.Configuration
import android.graphics.SurfaceTexture
import android.graphics.drawable.ColorDrawable
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout

/**
 * The splash video, drawn ON TOP of the Flutter screen while the app loads underneath it (the server, the plugins and Flutter's own
 * first frame all start the moment the app opens). It goes away when the video has played AND the app is ready behind it (the
 * server answers and Flutter has drawn its first frame). If the video cannot play, the PEK-orange cover simply stays until the
 * app is ready. It never stays longer than [MAX_WAIT_AFTER_VIDEO_MS] after the video, so a slow start can't trap the person.
 *
 * Two things make it reliable:
 *  - It lives in its OWN WINDOW (a Dialog). Flutter's SurfaceView is set to draw on top of everything in the activity window
 *    (transparent background mode), so anything added to the activity itself ends up behind Flutter's first frame.
 *  - The video is drawn with MediaPlayer into a TextureView, which is an ordinary view (no "hole punched in the window"
 *    like a SurfaceView / VideoView), so no background, z-order or window flag can hide it.
 *
 * Everything it does is logged under the tag "PEKSplash" (adb logcat -s PEKSplash).
 *
 * Use: `val s = SplashOverlay(activity) { ... }; s.show()` in onCreate (after super.onCreate), `s.flutterShown()` from
 * onFlutterUiDisplayed().
 */
class SplashOverlay(private val activity: Activity, private val onGone: () -> Unit) {

    private val handler = Handler(Looper.getMainLooper())
    private val root = FrameLayout(activity)
    private val texture = TextureView(activity)
    private var player: MediaPlayer? = null
    private var surface: Surface? = null
    private var dialog: Dialog? = null

    private var videoDone = false
    private var flutterReady = false
    private var serverReady = false
    private var removed = false
    private var giveUp: Runnable? = null

    fun show() {
        Log.i(TAG, "show()")
        root.setBackgroundColor(activity.getColor(R.color.pek_splash_bg))
        root.isClickable = true
        root.isFocusable = true
        root.isFocusableInTouchMode = true
        root.setOnKeyListener { _, _, _ -> true }   // not skippable: keys (including Back) are swallowed
        root.addView(texture, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }

        texture.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) { Log.i(TAG, "texture ready ${w}x$h"); startVideo(st) }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean { releasePlayer(); return true }
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
        }

        // Shown a moment after onCreate returns, once the activity's window exists (a dialog opened inside onCreate can fail).
        handler.post { openWindow() }

        // The server (Boot) is ready when this thread returns; Flutter calls flutterShown() on its first frame.
        Thread {
            val ok = try { Boot.await() } catch (e: Throwable) { false }
            handler.post { Log.i(TAG, "server ready=$ok"); serverReady = true; if (!ok) flutterReady = true; maybeRemove() }
        }.start()

        // Whatever happens with the video, the splash can never outlive this.
        handler.postDelayed({
            if (!videoDone) { Log.w(TAG, "video never finished - ending it"); endVideo() }
        }, VIDEO_TIMEOUT_MS)
    }

    private fun openWindow() {
        if (removed || activity.isFinishing || activity.isDestroyed) return
        try {
            val d = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
            d.setCancelable(false)
            d.setOnKeyListener { _, _, _ -> true }
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
            d.show()
            dialog = d
            root.requestFocus()
            Log.i(TAG, "splash window open")
        } catch (e: Throwable) {
            // Could not open its own window: fall back to drawing inside the activity (the cover at least shows).
            Log.e(TAG, "splash window failed, using the activity instead", e)
            dialog = null
            try {
                (root.parent as? android.view.ViewGroup)?.removeView(root)
                activity.addContentView(root, FrameLayout.LayoutParams(-1, -1))
            } catch (e2: Throwable) { Log.e(TAG, "fallback failed too", e2); endVideo() }
        }
    }

    private fun startVideo(st: SurfaceTexture) {
        if (videoDone || player != null) return
        try {
            val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
            val res = if (portrait) R.raw.pek_splash_portrait else R.raw.pek_splash
            val mp = MediaPlayer()
            player = mp
            val s = Surface(st)
            surface = s
            activity.resources.openRawResourceFd(res).use { mp.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            mp.setSurface(s)
            mp.setVolume(0f, 0f)
            mp.isLooping = false
            mp.setOnVideoSizeChangedListener { _, w, h -> Log.i(TAG, "video size ${w}x$h"); fit() }
            mp.setOnPreparedListener { p -> Log.i(TAG, "prepared, ${p.duration} ms"); fit(); p.start() }
            mp.setOnInfoListener { _, what, _ ->
                if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) Log.i(TAG, "first frame drawn")
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

    /** Called from FlutterActivity.onFlutterUiDisplayed(). A short pause lets Flutter swap its loading screen for the app. */
    fun flutterShown() {
        Log.i(TAG, "flutter first frame")
        handler.postDelayed({ flutterReady = true; maybeRemove() }, 500)
    }

    /** Drops the splash window right away (the activity is going away, so the window must not leak). */
    fun dismissNow() {
        removed = true
        giveUp?.let { handler.removeCallbacks(it) }
        releasePlayer()
        try { dialog?.dismiss() } catch (_: Throwable) {}
        dialog = null
    }

    // Both cuts are 16:9 / 9:16: scale so the video just covers the screen (centre-crop); the parent clips the overflow.
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
        val lp = texture.layoutParams
        if (lp == null || lp.width != w || lp.height != h) texture.layoutParams = FrameLayout.LayoutParams(w, h, Gravity.CENTER)
    }

    private fun releasePlayer() {
        try { player?.setOnCompletionListener(null); player?.setOnErrorListener(null); player?.release() } catch (_: Throwable) {}
        player = null
        try { surface?.release() } catch (_: Throwable) {}
        surface = null
    }

    private fun endVideo() {
        if (videoDone) return
        videoDone = true
        releasePlayer()
        // The orange cover stays until the app is ready (or the video, which stays on its last frame, if you prefer: the cover is brand colour).
        texture.visibility = View.INVISIBLE
        giveUp = Runnable { flutterReady = true; serverReady = true; maybeRemove() }.also { handler.postDelayed(it, MAX_WAIT_AFTER_VIDEO_MS) }
        maybeRemove()
    }

    private fun maybeRemove() {
        if (removed || !videoDone || !flutterReady || !serverReady) return
        removed = true
        giveUp?.let { handler.removeCallbacks(it) }
        Log.i(TAG, "removing splash")
        root.animate().alpha(0f).setDuration(250).withEndAction {
            try { dialog?.dismiss() } catch (_: Throwable) {}
            dialog = null
            (root.parent as? android.view.ViewGroup)?.removeView(root)
            onGone()
        }.start()
    }

    companion object {
        const val TAG = "PEKSplash"
        const val MAX_WAIT_AFTER_VIDEO_MS = 6000L
        const val VIDEO_TIMEOUT_MS = 12000L   // the clips are 5 s; this only catches a player that never reports back
    }
}
