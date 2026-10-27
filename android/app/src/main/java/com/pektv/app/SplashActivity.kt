package com.pektv.app

import android.app.Activity
import android.content.Intent
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.util.Log

/**
 * The launcher activity: plays the PEK splash video while the app starts underneath (Boot: files, C++ server, Python plugins), then
 * opens the Flutter screen.
 *
 * Why this is its own activity: Android draws its own launch screen (the app icon on the splash colour) over an activity until that
 * activity's first frame. The Flutter activity does not draw until Flutter has rendered its first frame, so a video placed on top of
 * the Flutter activity (the earlier SplashOverlay-in-FlutterHostActivity design) sat hidden behind the launch screen for the whole
 * video and you saw the icon, then a blank orange screen. This activity draws at once, so the launch screen goes away immediately and
 * the video is the first thing on screen.
 */
class SplashActivity : Activity() {

    private var overlay: SplashOverlay? = null
    private var opened = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawable(ColorDrawable(getColor(R.color.pek_splash_bg)))
        Boot.ensureStarted(applicationContext)   // everything heavy starts now and runs while the video plays
        overlay = SplashOverlay(this, standalone = true) { openApp() }.also { it.show() }
    }

    private fun openApp() {
        if (opened || isFinishing || isDestroyed) return
        opened = true
        val target = try {
            Intent(this, Class.forName("com.pektv.app.flutter.FlutterHostActivity"))
        } catch (e: Throwable) {
            Log.e("PEKSplash", "Flutter screen not found, using the hand-over screen", e)
            Intent(this, MainActivity::class.java)   // shows a message with Try again
        }
        target.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        try {
            startActivity(target)
            overridePendingTransition(0, 0)
        } catch (e: Throwable) {
            Log.e("PEKSplash", "could not open the app", e)
            opened = false
        }
    }

    // This screen stays under the app until the app has drawn, then goes away.
    override fun onStop() {
        super.onStop()
        if (opened) finish()
    }

    override fun onDestroy() {
        overlay?.dismissNow()
        overlay = null
        super.onDestroy()
    }

    @Deprecated("The splash cannot be skipped")
    override fun onBackPressed() {}
}
