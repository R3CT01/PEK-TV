package com.hesper.app

import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/**
 * Full-screen native player. Gets a URL (the C++ server's /api/stream/<id>)
 * and plays it with ExoPlayer, which uses the device's hardware decoders.
 * Back closes it and returns to the Hesper UI.
 */
class PlayerActivity : Activity() {

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView
    private var resumePositionMs: Long = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        playerView = PlayerView(this)
        playerView.setBackgroundColor(0xFF000000.toInt())
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
        playerView.controllerShowTimeoutMs = 4000
        playerView.isFocusable = true
        setContentView(playerView)
        playerView.requestFocus()
        hideSystemBars()
    }

    override fun onStart() {
        super.onStart()
        startPlayback()
    }

    override fun onStop() {
        stopPlayback()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun startPlayback() {
        val url = intent.getStringExtra("url")
        if (url.isNullOrEmpty()) { finish(); return }
        val title = intent.getStringExtra("title") ?: ""

        // Decoder fallback: if a device's preferred decoder fails, try another.
        val renderers = DefaultRenderersFactory(this).setEnableDecoderFallback(true)
        val exo = ExoPlayer.Builder(this, renderers).build()
        exo.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                Toast.makeText(
                    this@PlayerActivity,
                    "Can't play this file (" + error.errorCodeName + ")",
                    Toast.LENGTH_LONG
                ).show()
            }
        })

        val item = MediaItem.Builder()
            .setUri(url)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .build()
        exo.setMediaItem(item, resumePositionMs)
        exo.prepare()
        exo.playWhenReady = true

        playerView.player = exo
        player = exo
    }

    private fun stopPlayback() {
        val p = player ?: return
        resumePositionMs = p.currentPosition
        playerView.player = null
        p.release()
        player = null
    }

    // D-pad / remote keys go to the player controls first.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)
        return playerView.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
    }
}
