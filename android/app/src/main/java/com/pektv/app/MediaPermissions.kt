package com.pektv.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.net.HttpURLConnection
import java.net.URL

/**
 * The permissions PEK needs to read the user's media folders: video AND audio (Music).
 * Android 13+ has one permission per media type; Android 12 and older have the single READ_EXTERNAL_STORAGE.
 * Used by MainActivity (web UI) and FlutterHostActivity (Flutter UI).
 */
object MediaPermissions {
    const val REQUEST = 4714
    /** Set once the system prompt has been shown, so the app asks on first start and never nags. */
    const val ASKED_KEY = "asked_media_perms"

    fun needed(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_AUDIO)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)

    /** The ones not granted yet (empty when everything is allowed). */
    fun missing(a: Activity): List<String> =
        needed().filter { a.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

    /** Shows the system prompt for whatever is missing, once. Does nothing when all is granted or it was asked before. */
    fun askOnce(a: Activity) {
        val missing = missing(a)
        if (missing.isEmpty()) return
        val prefs = a.getSharedPreferences("pek", Context.MODE_PRIVATE)
        if (prefs.getBoolean(ASKED_KEY, false)) return
        prefs.edit().putBoolean(ASKED_KEY, true).apply()
        a.requestPermissions(missing.toTypedArray(), REQUEST)
    }

    /** After a permission is granted the earlier scans found nothing: ask the server to scan again (a no-op if it says "too soon"). */
    fun rescan() {
        Thread {
            try {
                val c = URL("http://127.0.0.1:8080/api/rescan").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.connectTimeout = 3000
                c.readTimeout = 5000
                c.responseCode
                c.disconnect()
            } catch (_: Exception) {
            }
        }.start()
    }
}
