package com.pektv.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Button

/**
 * The hand-over activity (SplashActivity opens it after the splash video). PEK TV has one UI, the Flutter one (FlutterHostActivity), so all this
 * does is wait for Boot (files, C++ server, Python plugins - started by SplashActivity, normally finished by now), open the Flutter screen and finish. There is no web view and no fallback UI any more. If the server cannot start or the
 * Flutter screen cannot open, a plain message with a Try again button is shown instead of a blank screen.
 */
class MainActivity : Activity() {

    private var status: TextView? = null
    private var retry: Button? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The launch theme paints the PEK splash colour for the first instant; behind the app itself the window is black.
        window.setBackgroundDrawable(ColorDrawable(getColor(R.color.pek_splash_bg)))
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(getColor(R.color.pek_splash_bg))
            setPadding(48, 48, 48, 48)
        }
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            text = ""   // empty while it starts: the splash video is just ending, so no text flashes
        }
        retry = Button(this).apply {
            text = "Try again"
            visibility = android.view.View.GONE
            setOnClickListener { start() }
        }
        column.addView(status)
        column.addView(retry)
        setContentView(FrameLayout(this).apply { addView(column, FrameLayout.LayoutParams(-1, -1)) })
        hideStatusBar()
        start()
    }

    private fun start() {
        retry?.visibility = android.view.View.GONE
        status?.text = ""
        Boot.ensureStarted(applicationContext)   // already running (or done) when SplashActivity started it
        Thread {
            val ready = Boot.await()
            runOnUiThread {
                if (ready && launchFlutterUi()) return@runOnUiThread
                showProblem(if (ready) "PEK TV could not open its screen." else "PEK TV's server did not start.")
            }
        }.start()
    }

    private fun showProblem(text: String) {
        status?.text = text
        retry?.visibility = android.view.View.VISIBLE
        retry?.requestFocus()
    }

    /** The server is up: open the Flutter screen and leave. */
    private fun launchFlutterUi(): Boolean {
        return try {
            startActivity(Intent(this, Class.forName("com.pektv.app.flutter.FlutterHostActivity")))
            finish()
            true
        } catch (e: Throwable) {
            Log.e("PEK", "The Flutter UI failed to start", e)
            false
        }
    }

    // The status bar (clock, notification icons, battery) stays hidden. The navigation bar is left alone.
    private fun hideStatusBar() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideStatusBar()
    }

    // ---- notifications (Android 13+): the music notification / lock-screen controls need it. Asked once, on first play.
    fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("pek", Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked_notif", false)) return
        prefs.edit().putBoolean("asked_notif", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4713)
    }
}
