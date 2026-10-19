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

## What the Flutter UI has now
Swipe navigation on phones and tablets: **Home, Movies, Shows, Music and More are pages you swipe between** (or tap in the
bottom bar). "More" is a page of its own with tiles for Resume Watching, Favorites, Duplicates, Unknown, Plugins and
Settings; a tap opens that screen on top and Back returns. On a TV the sidebar lists everything and switches the content.

- Dashboard: clock, Continue Watching, Recently Added, Favorites rows (Customize: add / remove / reorder)
- Movies, TV Shows: poster grids, Refresh (rescan), movie and show / season / episode pages, Favorite button
- Player: libmpv engine, audio + subtitle pick, buffering, auto-hiding controls, records progress for Resume Watching
- Resume Watching, Favorites (long-press a poster to remove)
- Music: Albums / Artists / Songs, search, album and artist pages, queue, shuffle / repeat, mini player, Now Playing
- Duplicates, Unknown, Plugins (list + remove), Settings (media sources + folder picker)
- Settings > Subtitles (automatic look-up on / off, language, Test), Video output (match refresh rate, HDR) and Audio output
  (Dolby / DTS passthrough). Subtitles are also found automatically while a library movie / episode plays, and the player's
  audio / subtitle menu has a "Find subtitles online" list (`subtitles.dart`, port of `www/subtitles.js`).

Resume progress, favorites and the dashboard layout are stored on the device with `shared_preferences` (`store.dart`). The web
UI kept these in the WebView's localStorage, which Flutter cannot read, so they start empty in the Flutter UI.

## Not ported yet (still in the classic UI)
Profiles and sync / sign-in, Watch History, global search, plugin screens (they are JavaScript that runs in the web UI's
sandbox), the plugin store, skins and layouts, Clock / Weather / plugin tiles on the dashboard, network folders (SMB, NFS, FTP,
DLNA), skip intro / next episode, torrent loading
display, lyrics. Music plays through the same libmpv engine as video, so it stops when the app goes to the background and
there are no lock-screen controls yet (those need native channel methods).

## Files
- `flutter_ui/lib/src/api.dart` - HTTP client for the existing routes
- `flutter_ui/lib/src/subtitles.dart`, `settings_extra.dart` - online subtitles; Subtitles / Video output / Audio output settings
  (the last two talk to MpvController over the `pek/output` channel in `FlutterHostActivity.kt`)
- `flutter_ui/lib/src/mpv.dart` - Dart side of the player channels (one shared player for video and music)
- `flutter_ui/lib/src/shell.dart` - swipe pages, bottom bar, More page, TV sidebar
- `flutter_ui/lib/src/store.dart` - on-device progress, favorites, dashboard layout
- `flutter_ui/lib/src/{dashboard,music,music_controller,pages,common}.dart` - the screens above
- `android/app/src/main/java/com/pektv/app/MpvController.kt` - events can now go to a Flutter sink (webView is optional)
- `android/settings.gradle`, `android/app/build.gradle` - conditional Flutter module include, Flutter maven repo

## Added later
- Network folders (SMB / NFS / FTP / WebDAV / DLNA): Settings > Add network folder (`net_folders.dart`; the Wi-Fi multicast lock
  is the `setMulticast` call on `pek/host`).
- Search (title, actor, genre, year; `library_pages.dart`) and Watch History (a permanent "finished" record kept in `Store`), both under More.
- Skip Intro / Skip Recap (`skip.dart`: file chapters, then the online database) and Up next (last 5 minutes of an episode, 5 s countdown
  when it ends) in the player. Settings > Skip intro and recap.
- Lyrics on Now Playing (`lyrics.dart`) and Settings > Music > Online art & lyrics.

## Added in phase 3
- **Profiles** (`profiles.dart`, `profile_pages.dart`): Who's watching? picker, first-time setup, add / edit / delete, 4-digit passcode (same hash as the web UI), 5 profiles max. Each profile has its own history, resume points, favorites, skip settings and skin. Like the web UI, profiles need a signed-in account.
- **Cloud account and sync** (`cloud.dart`, `account_pages.dart`): sign up / sign in with the emailed 6-digit code, forgot password, sign out (asks first), delete account. Watch history, resume points and favorites sync per profile through the existing worker; the profile list syncs too. Favorites are keyed by TMDb id, looked up once through the same TMDb worker the backend uses.
- **Layouts** (`layouts.dart`): Classic, Top bar, Wall, Compact (menu position and poster size, TV/tablet) plus a poster-size setting that phones also get. Per profile.
- **Torrent search** (`torrent_search.dart`): search the https sites you list (address with `{q}`), fetched through the existing `/api/torrent/fetch` route, plus an optional Torznab provider; results are filtered and ranked like the web engine.
- **Torrents** (`torrent.dart`): More > Torrents plays a magnet / .torrent link with a loading screen (peers, speed, progress), a loading card inside the player while it buffers or scrubs, and Resume Watching that restarts the same release (also from other devices).
- **Skins** (`skins.dart`): PEK Ember (default), Cream, Night red, Green, Neon, per profile (Settings > Appearance).
- HDR output and refresh-rate matching were already in Settings > Video output.

- **Clock and Weather widgets** (`weather.dart`, `dashboard.dart`): both are dashboard widgets you can add, remove and reorder. Weather uses Open-Meteo like plugins/weather (pick a city, Fahrenheit or Celsius, last reading shown offline).

## Still only in the classic UI
Plugins and their screens (JavaScript in the web sandbox), the plugin store, installable skin packages, plugin dashboard tiles.
