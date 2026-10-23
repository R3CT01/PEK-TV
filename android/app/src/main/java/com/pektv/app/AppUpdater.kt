package com.pektv.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File

/**
 * Installs a newer PEK TV apk that the Flutter side (app_update.dart) has downloaded into the cache folder.
 *
 * Android never lets an app update itself silently (only a device owner can). What it does allow:
 *  - the person turns on "Install unknown apps" for PEK TV once (canInstall / openInstallSettings),
 *  - the apk goes in through PackageInstaller, and Android shows its own "Update this app?" confirmation.
 *    On Android 12+ an update of an app the same installer put there can skip that confirmation (USER_ACTION_NOT_REQUIRED);
 *    Android decides, so the confirmation may still appear.
 * Android itself refuses an apk signed with a different key or with a lower versionCode, so a wrong file can never replace the app.
 */
object AppUpdater {
    /** Set by the Flutter host while it is open; called on the main thread with (PackageInstaller.STATUS_*, message). */
    @Volatile
    var onStatus: ((Int, String) -> Unit)? = null

    fun info(ctx: Context): Map<String, Any?> {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else pi.versionCode.toLong()
        return mapOf(
            "versionName" to (pi.versionName ?: ""),
            "versionCode" to code,
            "debuggable" to ((ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0),
            "canInstall" to ctx.packageManager.canRequestPackageInstalls(),
            "cacheDir" to ctx.cacheDir.absolutePath,
        )
    }

    /** The "Install unknown apps" page for PEK TV (some TV boxes lack it: then the general settings open). */
    fun openInstallSettings(ctx: Context): Boolean {
        val own = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
        val general = Intent(Settings.ACTION_SECURITY_SETTINGS)
        for (i in listOf(own, general)) {
            try {
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return true
            } catch (e: Throwable) {
                android.util.Log.w("PEK", "could not open install settings", e)
            }
        }
        return false
    }

    /** Returns null when the install was handed to Android, "needs_permission", or an error text. Blocking: call off the UI thread. */
    fun install(ctx: Context, path: String): String? {
        try {
            if (!ctx.packageManager.canRequestPackageInstalls()) return "needs_permission"
            val file = File(path).canonicalFile
            // Only a file in our own cache folder (where the app downloaded it) is ever installed.
            if (!file.path.startsWith(ctx.cacheDir.canonicalPath + File.separator) || !file.isFile || file.length() <= 0) {
                return "The downloaded update file is missing."
            }
            val installer = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(ctx.packageName)
            params.setSize(file.length())
            if (Build.VERSION.SDK_INT >= 31) {
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("pek.apk", 0, file.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                val intent = Intent(ctx, InstallResultReceiver::class.java).setPackage(ctx.packageName)
                // Mutable: Android adds the status (and the confirmation screen) to this intent.
                val pending = PendingIntent.getBroadcast(ctx, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
            }
            return null
        } catch (t: Throwable) {
            android.util.Log.w("PEK", "app update install failed", t)
            return t.message ?: "The update could not be installed."
        }
    }
}

/** Receives PackageInstaller's progress: opens Android's confirmation screen when it asks, and tells the Flutter side the outcome. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            } else {
                intent.getParcelableExtra(Intent.EXTRA_INTENT)
            }
            try {
                confirm?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            } catch (t: Throwable) {
                android.util.Log.w("PEK", "could not open the install confirmation", t)
            }
        }
        AppUpdater.onStatus?.invoke(status, message)
    }
}
