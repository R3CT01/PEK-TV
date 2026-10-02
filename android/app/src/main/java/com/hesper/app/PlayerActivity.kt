package com.hesper.app

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import org.json.JSONObject

/** Colors read from the web UI's active theme (falls back to the default skin). */
private data class Palette(
    val bg: Int = 0xFF0D121E.toInt(),
    val surface: Int = 0xFF161B22.toInt(),
    val border: Int = 0xFF30363D.toInt(),
    val accent: Int = 0xFF58A6FF.toInt(),
    val text: Int = 0xFFF0F6FC.toInt(),
    val muted: Int = 0xFF8B949E.toInt(),
    val glow: Int = 0x5958A6FF,
    val radiusDp: Int = 16
)

/**
 * Full-screen native player. Gets a URL (the C++ server's /api/stream/<id>)
 * and plays it with ExoPlayer, which uses the device's hardware decoders.
 * Back asks for confirmation, in the app's current theme, before leaving.
 */
class PlayerActivity : Activity() {

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView
    private var resumePositionMs: Long = 0
    private var confirmDialog: Dialog? = null
    private var palette = Palette()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        palette = readPalette(intent.getStringExtra("theme"))

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
        confirmDialog?.dismiss()
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

    // ---------------- Exit confirmation (themed) ----------------

    // Back (button or remote): pause and ask before leaving the video.
    // A second Back while the prompt is open counts as "Keep watching".
    override fun onBackPressed() {
        if (confirmDialog?.isShowing == true) return
        val wasPlaying = player?.playWhenReady == true
        player?.playWhenReady = false

        val pal = palette
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)

        val card = LinearLayout(this)
        card.orientation = LinearLayout.VERTICAL
        card.setPadding(dp(24), dp(22), dp(24), dp(18))
        card.background = rounded(pal.bg, pal.accent, pal.radiusDp, 1)

        val title = TextView(this)
        title.text = "Stop watching?"
        title.setTextColor(pal.text)
        title.textSize = 22f
        title.setTypeface(title.typeface, Typeface.BOLD)
        card.addView(title)

        val message = TextView(this)
        message.text = "Do you want to exit the video?"
        message.setTextColor(pal.muted)
        message.textSize = 15f
        message.setPadding(0, dp(6), 0, 0)
        card.addView(message)

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.END
        row.setPadding(0, dp(20), 0, 0)

        val keep = styledButton("Keep watching", true) { dialog.dismiss() }
        val exit = styledButton("Exit", false) { finish(); dialog.dismiss() }
        row.addView(keep)
        val exitParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        exitParams.leftMargin = dp(10)
        row.addView(exit, exitParams)
        card.addView(row)

        dialog.setContentView(card)
        dialog.setCancelable(true)
        dialog.setCanceledOnTouchOutside(true)
        dialog.setOnDismissListener {
            if (!isFinishing) player?.playWhenReady = wasPlaying
        }

        val width = Math.min(dp(440), (resources.displayMetrics.widthPixels * 0.9f).toInt())
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setLayout(width, ViewGroup.LayoutParams.WRAP_CONTENT)
        dialog.window?.setDimAmount(0.65f)

        confirmDialog = dialog
        dialog.show()
        keep.requestFocus()
    }

    private fun styledButton(label: String, primary: Boolean, onClick: () -> Unit): Button {
        val pal = palette
        val btn = Button(this)
        btn.text = label
        btn.isAllCaps = false
        btn.textSize = 16f
        btn.setTextColor(pal.text)
        btn.isFocusable = true
        btn.stateListAnimator = null
        btn.minHeight = 0
        btn.minimumHeight = 0
        btn.setPadding(dp(20), dp(10), dp(20), dp(10))

        val focused = rounded(pal.glow, pal.accent, 12, 2)
        val normal = rounded(pal.surface, if (primary) pal.accent else pal.border, 12, 1)
        val states = StateListDrawable()
        states.addState(intArrayOf(android.R.attr.state_focused), focused)
        states.addState(intArrayOf(android.R.attr.state_pressed), focused)
        states.addState(intArrayOf(), normal)
        btn.background = states
        btn.setOnClickListener { onClick() }
        return btn
    }

    private fun rounded(fill: Int, stroke: Int, radiusDp: Int, strokeDp: Int): GradientDrawable {
        val d = GradientDrawable()
        d.setColor(fill)
        d.cornerRadius = dp(radiusDp).toFloat()
        d.setStroke(dp(strokeDp), stroke)
        return d
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

    private fun readPalette(json: String?): Palette {
        val d = Palette()
        if (json.isNullOrEmpty()) return d
        return try {
            val o = JSONObject(json)
            fun c(key: String, def: Int): Int =
                if (o.has(key)) Color.parseColor(o.getString(key)) else def
            Palette(
                bg = c("bg", d.bg),
                surface = c("surface", d.surface),
                border = c("border", d.border),
                accent = c("accent", d.accent),
                text = c("text", d.text),
                muted = c("muted", d.muted),
                glow = c("glow", d.glow),
                radiusDp = o.optInt("radius", d.radiusDp)
            )
        } catch (e: Exception) {
            d
        }
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
