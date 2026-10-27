package com.pektv.app

import android.os.Handler
import android.os.Looper

/**
 * The hand-shake between the splash video (SplashActivity / SplashOverlay) and the Flutter screen (FlutterHostActivity) while the
 * app boots. They are two activities in one process, so this is plain shared state.
 *
 * How the boot looks:
 *  1. SplashActivity opens and plays the video straight away (its window draws at once; Flutter's does not).
 *  2. As soon as the video is on screen, SplashActivity opens FlutterHostActivity. That window is see-through (alpha 0) and eats
 *     every touch and key, so the person sees only the video and cannot skip it, while Flutter boots, finds the server and
 *     checks for updates underneath at full speed.
 *  3. When the video has ended AND the app says it is ready (Flutter calls "splashReady"), SplashActivity calls [reveal]:
 *     the Flutter window becomes visible and the video window goes away. Whatever the app shows first (profile picker, update
 *     screen, home) appears at once, with no orange gap.
 *
 * Every path ends in a reveal: a failed video, a failed server, a Flutter screen that never says ready (the splash gives up
 * a few seconds after the video) and a closed splash all reveal, so the person can never be left looking at an invisible app.
 */
object SplashGate {
    private val main = Handler(Looper.getMainLooper())

    /** true from the moment the splash starts until the app has been revealed. */
    @Volatile var active = false
        private set

    @Volatile private var revealRequested = false
    @Volatile private var host: (() -> Unit)? = null
    @Volatile private var overlay: SplashOverlay? = null
    @Volatile private var appWasReady = false

    /** SplashActivity: a new splash is starting. */
    fun begin(o: SplashOverlay) {
        active = true
        revealRequested = false
        appWasReady = false
        overlay = o
    }

    /** Flutter: the app has loaded (server up, update check done, first real screen built). */
    fun appReady() {
        appWasReady = true
        overlay?.appReady()
    }

    fun wasAppReady(): Boolean = appWasReady

    /**
     * FlutterHostActivity: [reveal] makes the Flutter window visible. It runs at once when the splash is already over or the
     * reveal was already asked for (the video can end before Flutter's activity has even been created).
     */
    fun registerHost(reveal: () -> Unit) {
        host = reveal
        if (!active || revealRequested) main.post(reveal)
    }

    fun unregisterHost() {
        host = null
    }

    /** SplashActivity: the video is over and the app is ready (or the wait ran out). */
    fun reveal() {
        revealRequested = true
        active = false
        host?.let { main.post(it) }
    }

    /** SplashActivity is going away: nothing may stay hidden because of it. */
    fun end(o: SplashOverlay?) {
        if (o == null || overlay === o) overlay = null
        if (active || host != null) reveal()
    }

    /** Whether a Flutter screen is waiting to be revealed. */
    fun hasHost(): Boolean = host != null
}
