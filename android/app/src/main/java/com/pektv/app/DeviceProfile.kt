package com.pektv.app

import android.app.Activity
import android.app.ActivityManager
import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import org.json.JSONObject

/**
 * What this device can really play, so a plugin can rank releases for it (a 4K HDR remux on a flagship,
 * a 720p H.264 file on a budget phone). Read by the plugin sandbox through PekAndroid.deviceProfile().
 *
 * Codec numbers are the tallest picture (720 / 1080 / 2160) a HARDWARE decoder handles at 30 fps;
 * 0 means "no hardware decoder", i.e. it would fall back to software and stutter on a weak chip.
 */
object DeviceProfile {
    private const val AVC = "video/avc"
    private const val HEVC = "video/hevc"
    private const val AV1 = "video/av01"

    // Decoder facts never change while the app runs, so they are probed once.
    private var decoders: IntArray? = null    // [h264, hevc, hevc10, av1]

    fun json(activity: Activity): String {
        val d = decoders ?: probeDecoders().also { decoders = it }
        val o = JSONObject()
        o.put("v", 1)
        o.put("sdk", Build.VERSION.SDK_INT)
        o.put("h264", d[0]).put("hevc", d[1]).put("hevc10", d[2]).put("av1", d[3])
        try {
            val pm = activity.packageManager
            val ui = activity.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
            o.put("tv", ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
                pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK))
        } catch (t: Throwable) { o.put("tv", false) }
        try {
            @Suppress("DEPRECATION")
            val disp = activity.windowManager.defaultDisplay
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            disp.getRealMetrics(dm)
            o.put("screenShort", minOf(dm.widthPixels, dm.heightPixels))
            o.put("screenLong", maxOf(dm.widthPixels, dm.heightPixels))
            @Suppress("DEPRECATION")
            val types = disp.hdrCapabilities?.supportedHdrTypes ?: IntArray(0)
            val dv = types.contains(Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION)
            val hlg = types.contains(Display.HdrCapabilities.HDR_TYPE_HLG)
            val pq = types.contains(Display.HdrCapabilities.HDR_TYPE_HDR10) ||
                types.contains(Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS) || dv
            o.put("hdr", pq || hlg).put("dv", dv)
        } catch (t: Throwable) {
            o.put("screenShort", 0).put("screenLong", 0).put("hdr", false).put("dv", false)
        }
        try {
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mi = ActivityManager.MemoryInfo()
            am.getMemoryInfo(mi)
            o.put("ramMb", (mi.totalMem / (1024 * 1024)).toInt()).put("lowRam", am.isLowRamDevice)
        } catch (t: Throwable) { o.put("ramMb", 0).put("lowRam", false) }
        return o.toString()
    }

    private fun isHardware(info: MediaCodecInfo): Boolean {
        if (info.isEncoder) return false
        if (Build.VERSION.SDK_INT >= 29) return info.isHardwareAccelerated && !info.isSoftwareOnly
        val n = info.name.lowercase()
        return !(n.startsWith("omx.google.") || n.startsWith("c2.android.") || n.startsWith("c2.google."))
    }

    private fun tallest(caps: MediaCodecInfo.VideoCapabilities): Int = try {
        when {
            caps.areSizeAndRateSupported(3840, 2160, 30.0) -> 2160
            caps.areSizeAndRateSupported(1920, 1080, 30.0) -> 1080
            caps.areSizeAndRateSupported(1280, 720, 30.0) -> 720
            else -> 0
        }
    } catch (t: Throwable) { 0 }

    private fun probeDecoders(): IntArray {
        var h264 = 0; var hevc = 0; var hevc10 = 0; var av1 = 0
        try {
            for (info in MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos) {
                if (!isHardware(info)) continue
                for (type in info.supportedTypes) {
                    if (type != AVC && type != HEVC && type != AV1) continue
                    try {
                        val caps = info.getCapabilitiesForType(type)
                        val h = tallest(caps.videoCapabilities ?: continue)
                        when (type) {
                            AVC -> h264 = maxOf(h264, h)
                            HEVC -> {
                                hevc = maxOf(hevc, h)
                                // 10-bit HEVC (HDR10 / HLG and most 4K) needs the Main10 profile.
                                val main10 = caps.profileLevels.any {
                                    it.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10 ||
                                        it.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10
                                }
                                if (main10) hevc10 = maxOf(hevc10, h)
                            }
                            AV1 -> av1 = maxOf(av1, h)
                        }
                    } catch (t: Throwable) { /* one odd decoder must not hide the rest */ }
                }
            }
        } catch (t: Throwable) { Log.w("PEK", "could not list the video decoders", t) }
        Log.i("PEK", "decoders (hardware, tallest picture): h264=$h264 hevc=$hevc hevc10=$hevc10 av1=$av1")
        return intArrayOf(h264, hevc, hevc10, av1)
    }
}
