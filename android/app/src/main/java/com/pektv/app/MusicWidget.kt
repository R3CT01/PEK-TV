package com.pektv.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.util.Log
import android.view.View
import android.widget.RemoteViews

/**
 * Home-screen widget for the music player (PEK Ember colours): cover, title, artist and previous / play-pause / next.
 *
 * It only mirrors [MusicState]; [MusicService] calls [update] whenever it redraws the notification (and once more when
 * it stops), and the buttons send the same actions as the notification buttons. While the service is not running there is
 * nothing to control (a button cannot start it from the home screen on newer Android), so the widget shows
 * "Nothing playing" and a tap anywhere opens the app.
 */
class MusicWidget : AppWidgetProvider() {

    /** Placed, resized, or after a reboot: draw the current state (the first draw is always sent). */
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        try {
            val v = build(context)
            for (id in ids) manager.updateAppWidget(id, v)
        } catch (t: Throwable) {
            Log.w("PEK", "music widget update failed", t)
        }
    }

    companion object {
        private const val ART_PX = 192            // kept small: widget pictures travel through a size-limited channel

        private var lastKey = ""
        private var artSource: Bitmap? = null
        private var artRounded: Bitmap? = null

        /** Redraw every placed widget from [MusicState]. Skipped when nothing visible changed. Call on the main thread. */
        fun update(ctx: Context) {
            try {
                val app = ctx.applicationContext
                val manager = AppWidgetManager.getInstance(app)
                val ids = manager.getAppWidgetIds(ComponentName(app, MusicWidget::class.java))
                if (ids.isEmpty()) return
                val s = MusicState
                val key = "${running()}|${s.title}|${s.artist}|${isPlaying()}|${System.identityHashCode(s.art)}"
                if (key == lastKey) return
                lastKey = key
                val v = build(app)
                for (id in ids) manager.updateAppWidget(id, v)
            } catch (t: Throwable) {
                Log.w("PEK", "music widget update failed", t)
            }
        }

        private fun running() = MusicService.instance != null && MusicState.title.isNotEmpty()
        private fun isPlaying() = MusicState.playing || (MusicState.active && MusicState.buffering)

        private fun build(ctx: Context): RemoteViews {
            val s = MusicState
            val v = RemoteViews(ctx.packageName, R.layout.widget_music)

            // A tap on the card opens the app (same as the notification).
            ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
                v.setOnClickPendingIntent(R.id.widget_root,
                    PendingIntent.getActivity(ctx, 10, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            }

            if (!running()) {
                v.setTextViewText(R.id.widget_title, ctx.getString(R.string.widget_music_idle_title))
                v.setTextViewText(R.id.widget_artist, ctx.getString(R.string.widget_music_idle_text))
                v.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder)
                v.setViewVisibility(R.id.widget_controls, View.GONE)
                return v
            }

            v.setTextViewText(R.id.widget_title, s.title)
            v.setTextViewText(R.id.widget_artist, s.artist.ifEmpty { s.album })
            val art = s.art
            if (art != null) {
                val rounded = roundedArt(art)
                if (rounded != null) v.setImageViewBitmap(R.id.widget_art, rounded)
                else v.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder)
            } else {
                v.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder)
            }

            v.setViewVisibility(R.id.widget_controls, View.VISIBLE)
            v.setOnClickPendingIntent(R.id.widget_prev, button(ctx, MusicService.ACTION_PREV, 11))
            v.setOnClickPendingIntent(R.id.widget_next, button(ctx, MusicService.ACTION_NEXT, 12))
            if (isPlaying()) {
                v.setImageViewResource(R.id.widget_play, R.drawable.ic_widget_pause)
                v.setContentDescription(R.id.widget_play, ctx.getString(R.string.widget_pause))
                v.setOnClickPendingIntent(R.id.widget_play, button(ctx, MusicService.ACTION_PAUSE, 13))
            } else {
                v.setImageViewResource(R.id.widget_play, R.drawable.ic_widget_play)
                v.setContentDescription(R.id.widget_play, ctx.getString(R.string.widget_play))
                v.setOnClickPendingIntent(R.id.widget_play, button(ctx, MusicService.ACTION_PLAY, 14))
            }
            return v
        }

        /** The service is running whenever these buttons are shown, so this just hands it the action. */
        private fun button(ctx: Context, action: String, code: Int): PendingIntent =
            PendingIntent.getService(ctx, code, Intent(ctx, MusicService::class.java).setAction(action),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        /** Square, centre-cropped, rounded corners; the last one is kept so a redraw for the same cover costs nothing. */
        private fun roundedArt(src: Bitmap): Bitmap? {
            if (src === artSource && artRounded != null) return artRounded
            return try {
                val out = Bitmap.createBitmap(ART_PX, ART_PX, Bitmap.Config.ARGB_8888)
                val c = Canvas(out)
                val p = Paint(Paint.ANTI_ALIAS_FLAG)
                val dst = RectF(0f, 0f, ART_PX.toFloat(), ART_PX.toFloat())
                c.drawRoundRect(dst, ART_PX * 0.17f, ART_PX * 0.17f, p)       // the mask
                p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
                val side = minOf(src.width, src.height)
                val left = (src.width - side) / 2
                val top = (src.height - side) / 2
                c.drawBitmap(src, Rect(left, top, left + side, top + side), dst, p)
                artSource = src
                artRounded = out
                out
            } catch (t: Throwable) {
                Log.w("PEK", "music widget cover failed", t)
                null
            }
        }
    }
}
