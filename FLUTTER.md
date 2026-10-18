# PEK TV - Flutter UI (phase 1, Android)

The C++ server, the Python plugins, libmpv and the cloud workers are unchanged. Only the screen layer is new:

```
MainActivity (unchanged boot: assets, server on :8080, plugins, splash)
   -> FlutterHostActivity            android/app/src/flutter/java/.../FlutterHostActivity.kt
        Flutter UI (flutter_ui/)  --HTTP-->  C++ server on 127.0.0.1:8080
        pek/mpv channels          ------->  MpvController (libmpv, same engine)  -- SurfaceView behind Flutter
```

## Build
1. `cd flutter_ui && flutter pub get`   (generates `flutter_ui/.android/`, which switches the Flutter build on)
2. Build the Android project as usual. Without step 1 the app builds exactly as before (web UI only).
3. CI: `.github/workflows/build.yml` runs steps 1 automatically when `flutter_ui/pubspec.yaml` exists.

The Flutter UI opens by default when it is compiled in. **More (⋮) > Switch to classic UI** goes back to the web UI and
remembers it (`web_ui` in the `pek_player` prefs).

## What phase 1 has
Library grids (movies, shows) with posters, D-pad focus, movie and show/season/episode pages, and the player
(play/pause, seek, audio and subtitle pick, buffering, auto-hiding controls) on the existing libmpv engine.

## Not ported yet (still in the classic UI)
Profiles and sync/sign-in, Resume Watching and the Continue / Start over card, Music, plugins and the plugin store,
skins, search, settings (Dolby passthrough, HDR, match frame rate), sources, skip intro / next episode, torrent loading
display. Settings and player options already exist in `MpvController`; they only need channel methods.

## Files
- `flutter_ui/lib/src/api.dart` - HTTP client for the existing routes
- `flutter_ui/lib/src/mpv.dart` - Dart side of the player channels
- `android/app/src/main/java/com/pektv/app/MpvController.kt` - events can now go to a Flutter sink (webView is optional)
- `android/settings.gradle`, `android/app/build.gradle` - conditional Flutter module include, Flutter maven repo
