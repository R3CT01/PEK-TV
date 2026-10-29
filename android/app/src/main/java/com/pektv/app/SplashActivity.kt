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
 * The launcher activity: plays the PEK splash video full screen, unskippable, while the server and the Python plugins start in the
 * background (Boot). It is the only window on screen while the video plays.
 *
 * When the video is over it opens the Flutter screen (FlutterHostActivity) on top. That window is see-through until Flutter has drawn
 * its first frame, so the video's last frame stays up instead of flashing a colour; this activity closes when the app says it has
 * loaded (see [SplashGate]), or after [MAX_WAIT_MS] at the latest.
 *
 * (An earlier version started Flutter invisible ON TOP of the playing video and lifted it afterwards. Hiding a whole window with
 * alpha 0 and a see-through activity over a video surface is exactly what shows a black screen on many phones, so the two are now
 * strictly one after the other.)
 */
class SplashActivity : Activity() {

    private var overlay: SplashOverlay? = null
    private var appOpened = false
    private var leftForApp = false
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A pektv:// link while the app is already loaded (the website after sign-up): no splash video, straight to the app.
        val link = intent?.data
        if (link != null && SplashGate.wasAppReady()) {
            try {
                startActivity(Intent(this, Class.forName("com.pektv.app.flutter.FlutterHostActivity")).setData(link).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION))
            } catch (e: Throwable) {
                Log.e("PEKSplash", "could not open the link", e)
            }
            finish()
            return
        }
        window.setBackgroundDrawable(ColorDrawable(getColor(R.color.pek_splash_bg)))
        Boot.ensureStarted(applicationContext)   // everything heavy starts now and runs while the video plays
        SplashGate.begin { handler.postDelayed({ closeSplash() }, CLOSE_DELAY_MS) }
        val o = SplashOverlay(this) { openApp() }
        overlay = o
        o.show()
    }

    /** The video is over (or never played): open the Flutter screen on top of this one. */
    private fun openApp() {
        if (appOpened || isFinishing || isDestroyed) return
        appOpened = true
        val target = try {
            Intent(this, Class.forName("com.pektv.app.flutter.FlutterHostActivity")).putExtra(EXTRA_FROM_SPLASH, true)
        } catch (e: Throwable) {
            Log.e("PEKSplash", "Flutter screen not found, using the hand-over screen", e)
            handOver()
            return
        }
        target.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        intent?.data?.let { target.data = it }   // a pektv:// link that started the app (cold start) goes on to the Flutter screen
        try {
            startActivity(target)
            overridePendingTransition(0, 0)
        } catch (e: Throwable) {
            Log.e("PEKSplash", "could not open the app", e)
            handOver()
            return
        }
        Log.i("PEKSplash", "video over - app opened")
        // Normally closed by SplashGate when the app is ready; the timeout covers a Flutter screen that never says so. When the app
        // was already loaded in this process (a second launch of the splash) there is nothing to wait for.
        handler.postDelayed({ closeSplash() }, if (SplashGate.wasAppReady()) CLOSE_DELAY_MS else MAX_WAIT_MS)
    }

    /** No Flutter screen: the plain hand-over screen shows a message with Try again. */
    private fun handOver() {
        try { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)) } catch (e: Throwable) { Log.e("PEKSplash", "hand-over failed", e) }
        handler.postDelayed({ closeSplash() }, 300)
    }

    private fun closeSplash() {
        if (!isFinishing && !isDestroyed) finish()
    }

    override fun onPause() {
        super.onPause()
        if (appOpened) leftForApp = true
    }

    override fun onResume() {
        super.onResume()
        // Back from the app (its Back button closed it): this screen has nothing left to show.
        if (leftForApp) closeSplash()
    }

    // Swallow everything while the video plays; once the app is open the window above takes input.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean = if (!appOpened) true else super.dispatchKeyEvent(event)
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean = if (!appOpened) true else super.dispatchTouchEvent(ev)

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        overlay?.dismissNow()
        overlay = null
        SplashGate.end()
        super.onDestroy()
    }

    @Deprecated("The splash cannot be skipped")
    override fun onBackPressed() {
        if (appOpened) closeSplash()   // while the video plays Back does nothing
    }

    companion object {
        const val EXTRA_FROM_SPLASH = "pek_from_splash"
        private const val CLOSE_DELAY_MS = 350L    // after the app is ready, so its first frame is on screen before this window goes
        private const val MAX_WAIT_MS = 15000L     // the longest this screen stays behind the app waiting for "ready"
    }
}
