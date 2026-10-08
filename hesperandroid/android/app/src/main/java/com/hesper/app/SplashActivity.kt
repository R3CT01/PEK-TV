package com.hesper.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.content.res.Configuration
import android.widget.FrameLayout
import android.widget.VideoView

// Plays the splash video once, then opens MainActivity. Portrait screens (phones) get the
// 9:16 cut (hesper_splash_portrait) cropped to fill the whole screen; landscape screens
// (TVs, tablets) get the 16:9 cut (hesper_splash).
// Tap, any key or the remote's OK/Back skips it. If the video can't play for any
// reason the app just opens - the splash must never block startup.
class SplashActivity : Activity() {

    private var done = false
    private lateinit var video: VideoView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        root.setBackgroundColor(resources.getColor(R.color.hesper_cream, theme))
        video = VideoView(this)
        root.addView(video, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        setContentView(root)

        video.setOnPreparedListener { mp: MediaPlayer ->
            mp.setVolume(0f, 0f)
            mp.isLooping = false
            fillScreen(root, mp.videoWidth, mp.videoHeight)
        }
        video.setOnCompletionListener { next() }
        video.setOnErrorListener { _, _, _ -> next(); true }
        val portrait = resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        val res = if (portrait) R.raw.hesper_splash_portrait else R.raw.hesper_splash
        video.setVideoURI(Uri.parse("android.resource://$packageName/$res"))
        video.start()
    }

    // VideoView letterboxes by default. Make it just big enough to cover the screen
    // (centre-crop) and let the parent clip the overflow, so the video fills every edge.
    private fun fillScreen(root: FrameLayout, vw: Int, vh: Int) {
        if (vw <= 0 || vh <= 0) return
        val sw = root.width
        val sh = root.height
        if (sw <= 0 || sh <= 0) return
        val scale = maxOf(sw.toFloat() / vw, sh.toFloat() / vh)
        video.layoutParams = FrameLayout.LayoutParams(
            (vw * scale).toInt() + 1, (vh * scale).toInt() + 1, Gravity.CENTER)
    }

    private fun next() {
        if (done) return
        done = true
        startActivity(Intent(this, MainActivity::class.java))
        finish()
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.action == MotionEvent.ACTION_UP) next()
        return true
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        next()
        return true
    }

    override fun onDestroy() {
        video.stopPlayback()
        super.onDestroy()
    }
}
