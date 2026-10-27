package com.pektv.app

import android.os.Handler
import android.os.Looper

/**
 * The hand-shake between the splash screen (SplashActivity) and the Flutter screen (FlutterHostActivity). Two activities in one
 * process, so this is plain shared state.
 *
 * How the boot looks (one window at a time, nothing hidden behind anything):
 *  1. SplashActivity opens and plays the video straight away. The server and the Python plugins start in the background (Boot).
 *  2. When the video has ended (or could not play), SplashActivity opens FlutterHostActivity. That window is see-through until
 *     Flutter has drawn its first frame, so the video's last frame stays on screen instead of flashing a colour.
 *  3. Flutter loads, then tells us ([appReady], the "splashReady" call) and SplashActivity closes.
 *
 * Every path ends in the splash closing: a Flutter screen that never says ready is covered by a timeout in SplashActivity, and
 * pressing Back in the app brings SplashActivity back to the front only to close itself at once.
 */
object SplashGate {
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var onReady: (() -> Unit)? = null
    @Volatile private var appWasReady = false

    /** SplashActivity: a splash is starting; [ready] runs (on the main thread) when the Flutter app has loaded. */
    fun begin(ready: () -> Unit) {
        onReady = ready
    }

    /** Flutter: the app has loaded (server up, update check done, first real screen built). */
    fun appReady() {
        appWasReady = true
        onReady?.let { main.post(it) }
    }

    /** true when the app has already loaded once in this process (a second launch of the splash in a running app). */
    fun wasAppReady(): Boolean = appWasReady

    /** SplashActivity is going away. */
    fun end() {
        onReady = null
    }
}
