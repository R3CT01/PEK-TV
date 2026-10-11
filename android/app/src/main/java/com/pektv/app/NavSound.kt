package com.pektv.app

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * Navigation "tick" / "select" sounds, played natively.
 *
 * Web Audio inside a WebView goes through a big buffer and the (busy) page thread, which is why the
 * sounds trailed the highlight on TV boxes. Here the two sounds are rendered once into static
 * low-latency AudioTracks and a press only has to restart one. JS calls return immediately: the
 * actual play happens on a small dedicated thread.
 */
class NavSound {
    private val sr = 48000
    private val thread = HandlerThread("hesper-navsound", Process.THREAD_PRIORITY_URGENT_AUDIO).apply { start() }
    private val handler = Handler(thread.looper)
    private val tracks = arrayOfNulls<AudioTrack>(2)      // 0 = tick, 1 = select
    @Volatile private var ready = false

    init { handler.post { build() } }

    fun isReady(): Boolean = ready

    /** kind 0 = tick, 1 = select; volume 0..1 (the web side already applied the Off/Low/Med/High level). */
    fun play(kind: Int, volume: Float) {
        if (kind < 0 || kind > 1 || volume <= 0f) return
        handler.postAtFrontOfQueue {
            val t = tracks[kind] ?: return@postAtFrontOfQueue
            try {
                t.stop()
                t.reloadStaticData()
                t.setVolume(min(1f, volume))
                t.play()
            } catch (e: Exception) { /* silent: a missed tick is fine */ }
        }
    }

    fun release() {
        handler.post {
            for (i in tracks.indices) { try { tracks[i]?.release() } catch (e: Exception) { }; tracks[i] = null }
            ready = false
            thread.quitSafely()
        }
    }

    private class Note(val f0: Double, val f1: Double, val start: Double, val dur: Double)

    // Same enveloped sine sweeps as navsound.js, so the sound is unchanged: only the path to the speaker is.
    private fun render(notes: List<Note>, total: Double): ShortArray {
        val n = ceil(sr * total).toInt()
        val d = FloatArray(n)
        for (nt in notes) {
            val s0 = (nt.start * sr).toInt()
            val len = (nt.dur * sr).toInt()
            var ph = 0.0
            var i = 0
            while (i < len && s0 + i < n) {
                val p = i.toDouble() / len
                val f = nt.f0 * (nt.f1 / nt.f0).pow(p)
                ph += 2 * PI * f / sr
                val env = min(1.0, i / (sr * 0.004)) * (1 - p).pow(2.0)
                d[s0 + i] += (sin(ph) * env).toFloat()
                i++
            }
        }
        val out = ShortArray(n)
        for (i in 0 until n) out[i] = (d[i].coerceIn(-1f, 1f) * 32000f).toInt().toShort()
        return out
    }

    private fun makeTrack(pcm: ShortArray): AudioTrack {
        val bytes = pcm.size * 2
        val t = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sr)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bytes)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .build()
        t.write(pcm, 0, pcm.size)
        return t
    }

    private fun build() {
        try {
            tracks[0] = makeTrack(render(listOf(Note(1850.0, 1250.0, 0.0, 0.055)), 0.07))
            tracks[1] = makeTrack(render(listOf(Note(880.0, 880.0, 0.0, 0.07), Note(1320.0, 1320.0, 0.055, 0.11)), 0.19))
            // One silent-volume play wakes the audio path so the very first real tick is not late.
            for (t in tracks) { t?.setVolume(0f); t?.play() }
            ready = true
        } catch (e: Exception) {
            ready = false      // the web page falls back to its own Web Audio sounds
        }
    }
}
