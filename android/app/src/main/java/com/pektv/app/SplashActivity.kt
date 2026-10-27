package com.pektv.app

import android.app.Activity
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent

/**
 * The launcher activity: plays the PEK splash video full screen, unskippable, while the whole app boots behind it.
 *
 * Why this is its own activity: Android draws its own launch screen (the app icon on the splash colour) over an activity until that
 * activity's first frame, and the Flutter activity does not draw until Flutter has rendered its first frame. A video placed on the
 * Flutter activity itself therefore stayed hidden for the whole boot. This activity draws at once.
 *
 * Why Flutter is opened right away and not after the video: FlutterHostActivity is started as soon as the video is on screen, but
 * invisible (see [SplashGate]), so Flutter, the server and the update check all run during the video. When the video is over and the
 * app is ready, the Flutter window is revealed on top of this one, which then closes: no orange gap, no screens loading in the open.
 */
class SplashActivity : Activity() {

    private var overlay: SplashOverlay? = null
    private var flutterOpened = false
    private var flutterMissing = false
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawable(ColorDrawable(getColor(R.color.pek_splash_bg)))
        Boot.ensureStarted(applicationContext)   // everything heavy starts now and runs while the video plays
        val o = SplashOverlay(this, onVideoStarted = { openFlutterBehind() }, onGone = { revealApp() })
        overlay = o
        SplashGate.begin(o)
        o.show()
    }

    /** The video is playing: start the Flutter screen under it. It hides itself (see FlutterHostActivity) until revealed. */
    private fun openFlutterBehind() {
        if (flutterOpened || isFinishing || isDestroyed) return
        flutterOpened = true
        val target = try {
            Intent(this, Class.forName("com.pektv.app.flutter.FlutterHostActivity")).putExtra(EXTRA_FROM_SPLASH, true)
        } catch (e: Throwable) {
            Log.e("PEKSplash", "Flutter screen not found, using the hand-over screen", e)
            flutterMissing = true
            return
        }
        target.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        try {
            startActivity(target)
            overridePendingTransition(0, 0)
        } catch (e: Throwable) {
            Log.e("PEKSplash", "could not open the app", e)
            flutterMissing = true
        }
    }

    /** Video over, server up, app ready (or the wait ran out): show the app and close this screen. */
    private fun revealApp() {
        if (isFinishing || isDestroyed) return
        if (!flutterOpened) openFlutterBehind()
        if (flutterMissing) {
            // No Flutter screen: the plain hand-over screen shows a message with Try again.
            try { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)) } catch (e: Throwable) { Log.e("PEKSplash", "hand-over failed", e) }
            handler.postDelayed({ finish() }, 300)
            return
        }
        SplashGate.reveal()
        // A moment after the reveal, so the app's first frame is on screen before this window (and its last video frame) goes.
        handler.postDelayed({ finish() }, CLOSE_DELAY_MS)
    }

    // Swallow everything while the splash is up; the Flutter window above does the same once it exists.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean = if (SplashGate.active) true else super.dispatchKeyEvent(event)
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean = if (SplashGate.active) true else super.dispatchTouchEvent(ev)

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        overlay?.dismissNow()
        SplashGate.end(overlay)   // never leave the Flutter screen hidden because this one went away
        overlay = null
        super.onDestroy()
    }

    @Deprecated("The splash cannot be skipped")
    override fun onBackPressed() {}

    companion object {
        const val EXTRA_FROM_SPLASH = "pek_from_splash"
        private const val CLOSE_DELAY_MS = 350L
    }
}
