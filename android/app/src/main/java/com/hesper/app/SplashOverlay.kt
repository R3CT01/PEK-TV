package com.hesper.app

import android.content.Context
import android.content.res.Configuration
import android.media.MediaPlayer
import android.net.Uri
import android.view.Gravity
import android.view.MotionEvent
import android.widget.FrameLayout
import android.widget.VideoView

/**
 * The PEK splash video, drawn as a full-screen layer ON TOP of MainActivity's WebView.
 *
 * Because it is an overlay (not a separate screen), the app keeps loading underneath while the
 * video plays. The layer swallows every touch, and MainActivity swallows every key / Back press
 * while it exists, so nothing can be skipped or clicked until the video is over.
 *
 * Phones in portrait get the 9:16 cut (hesper_splash_portrait); TVs, boxes and any landscape
 * screen get the 16:9 cut (hesper_splash). Both are centre-cropped to fill every edge.
 *
 * If the video can't play for any reason it reports "done" straight away - the splash must
 * never block startup.
 */
class SplashOverlay(context: Context, private val onVideoDone: () -> Unit) : FrameLayout(context) {

    private val video = VideoView(context)
    private var reported = false
    private var vw = 0
    private var vh = 0

    init {
        setBackgroundColor(context.getColor(R.color.pek_splash_bg))
        isClickable = true
        isFocusable = true
        isFocusableInTouchMode = true
        addView(video, LayoutParams(-1, -1, Gravity.CENTER))

        video.setOnPreparedListener { mp: MediaPlayer ->
            mp.setVolume(0f, 0f)
            mp.isLooping = false
            vw = mp.videoWidth
            vh = mp.videoHeight
            fillScreen()
        }
        video.setOnCompletionListener { report() }
        video.setOnErrorListener { _, _, _ -> report(); true }

        val portrait = context.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        val res = if (portrait) R.raw.hesper_splash_portrait else R.raw.hesper_splash
        video.setVideoURI(Uri.parse("android.resource://${context.packageName}/$res"))
    }

    fun start() {
        if (!reported) video.start()
    }

    /** Back in the foreground (e.g. after the screen was off): carry on if the video stalled. */
    fun resumeIfNeeded() {
        if (!reported && !video.isPlaying) video.start()
    }

    fun release() {
        try { video.stopPlayback() } catch (e: Throwable) { /* already gone */ }
    }

    private fun report() {
        if (reported) return
        reported = true
        onVideoDone()
    }

    /** Force "done" (used by MainActivity's safety timeout if the video never finishes). */
    fun forceDone() = report()

    // VideoView letterboxes by default. Make it just big enough to cover the screen (centre-crop)
    // and let this layer clip the overflow, so the video fills every edge.
    private fun fillScreen() {
        if (vw <= 0 || vh <= 0 || width <= 0 || height <= 0) return
        val scale = maxOf(width.toFloat() / vw, height.toFloat() / vh)
        video.layoutParams = LayoutParams((vw * scale).toInt() + 1, (vh * scale).toInt() + 1, Gravity.CENTER)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        fillScreen()
    }

    // Touches never reach the video or the app underneath.
    override fun onInterceptTouchEvent(ev: MotionEvent?): Boolean = true
    override fun onTouchEvent(event: MotionEvent?): Boolean = true
}
