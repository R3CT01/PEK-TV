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
import android.widget.FrameLayout
import android.widget.VideoView

// Plays res/raw/hesper_splash.mp4 once, then opens MainActivity.
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
        }
        video.setOnCompletionListener { next() }
        video.setOnErrorListener { _, _, _ -> next(); true }
        video.setVideoURI(Uri.parse("android.resource://$packageName/${R.raw.hesper_splash}"))
        video.start()
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
