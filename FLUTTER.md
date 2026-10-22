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
- Music: Albums / Artists / Songs, search, album and artist pages, queue, shuffle / repeat, mini player, full-screen player
  (cover + title on the left, time-synced lyrics on the right, a Browse panel with Queue / Albums / Artists / Songs; `music_fullscreen.dart`,
  a port of `www/music_fullscreen.js`)
- Playlists (`playlists.dart` store per profile, `playlist_ui.dart`): Music > Playlists tab, playlist page (Play / Shuffle / Add to queue / Rename / Delete, drag to reorder), press-and-hold a song for Play next / Add to queue / Add to playlist, "Add to playlist" on album pages and in the full-screen player, "Save as playlist" for the queue. Not synced to the cloud yet.
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
- Pin slots on the More page (`pin_grid.dart`): after the fixed buttons come 10 tiles the same size as the others. A pinned plugin shows its icon, name and description; empty ones show a faint plus. Tap / D-pad centre on an empty tile lists the installed plugins to pin; on a pinned one it opens it, and press-and-hold (long press, held centre button, or Menu) offers Open / Remove from pins. Pins are stored by `plugin_pins.dart` and also still shown in the TV sidebar.
- Network folders (SMB / NFS / FTP / WebDAV / DLNA): Settings > Add network folder (`net_folders.dart`; the Wi-Fi multicast lock
  is the `setMulticast` call on `pek/host`).
- Search (title, actor, genre, year; `library_pages.dart`) and Watch History (a permanent "finished" record kept in `Store`), both under More.
- Skip Intro / Skip Recap (`skip.dart`: file chapters, then the online database) and Up next (last 5 minutes of an episode, 5 s countdown
  when it ends) in the player. Settings > Skip intro and recap.
- Lyrics in the full-screen player (`lyrics.dart`, shown by `music_fullscreen.dart`) and Settings > Music > Online art & lyrics.

## Added in phase 3
- **Profiles** (`profiles.dart`, `profile_pages.dart`): Who's watching? picker, first-time setup, add / edit / delete, 4-digit passcode (same hash as the web UI), 5 profiles max. Each profile has its own history, resume points, favorites, skip settings and skin. Like the web UI, profiles need a signed-in account.
- **Cloud account and sync** (`cloud.dart`, `account_pages.dart`): sign up / sign in with the emailed 6-digit code, forgot password, sign out (asks first), delete account. Watch history, resume points and favorites sync per profile through the existing worker; the profile list syncs too. Favorites are keyed by TMDb id, looked up once through the same TMDb worker the backend uses.
- **Layouts** (`layouts.dart`): Classic, Top bar, Wall, Compact (menu position and poster size, TV/tablet) plus a poster-size setting that phones also get. Per profile.
- **Torrent search** (`torrent_search.dart`): search the https sites you list (address with `{q}`), fetched through the existing `/api/torrent/fetch` route, plus an optional Torznab provider; results are filtered and ranked like the web engine.
- **Torrents** (`torrent.dart`): More > Torrents plays a magnet / .torrent link with a loading screen (peers, speed, progress), a loading card inside the player while it buffers or scrubs, and Resume Watching that restarts the same release (also from other devices).
- **Skins** (`skins.dart`): PEK Ember (default), Cream, Night red, Green, Neon, per profile (Settings > Appearance).
- HDR output and refresh-rate matching were already in Settings > Video output.

- **Dashboard** (`dashboard.dart`, `store.dart`): the same grid as the web UI. Clock, Weather and plugin shortcuts are tiles (Small = 1 column, Wide = 2); Continue Watching, Recently Added and Favorites are full-width poster rows. Customize (or press and hold a tile) to move, resize, remove, add widgets or reset. Saved per profile in the web UI's `{id, type, size, folder}` shape and synced as `s|dashboard`; the layout and poster size sync as `s|look`, the city and unit as `s|weather` (`cloud.dart`).
- **Clock and Weather widgets** (`weather.dart`, `dashboard.dart`): both are dashboard widgets you can add, remove and reorder. The weather tile looks like the web one (big temperature, "condition \u00b7 city" under it). Weather uses Open-Meteo like plugins/weather (pick a city, Fahrenheit or Celsius, last reading shown offline).

- **Clock settings** (`clock.dart`): tap the Clock tile for 24-hour time, Show date and a time zone list (each zone shows the time it has now). Same 38 zones and the same "day \u00b7 zone" line as the web UI; kept on the device, not synced. Zones are computed from built-in daylight-saving rules (US/Canada, EU/UK, Sydney, Auckland, Cairo), so there is no extra package; the rules need a look only if a country changes its clocks.
- **Online / offline mode** (`net.dart`, port of `www/net.js`): a 10px dot in the top right corner (green online, red offline), a "Back online" / "Offline mode" notice, and a check every 30 s (8 s while offline) and whenever the app returns to the front. Back online: poster lookups that failed are asked again, the profile syncs and the weather refreshes. The local library works the same either way.

## Watched / unwatched (port of `_setWatched` in `www/app_library.js`)
Movie page: **Mark as watched / unwatched**. Show page: **Mark show ...**, **Mark season ...** and a tick on each watched episode (press and hold
an episode to toggle just that one); movie posters show a tick before the year. Everything uses Watch History (`Store.setWatched`), so the
Watch History page, plugins and PEK Cloud agree. A change is pushed to the worker about 2 s later (`watched.dart`); removals go up as
`{deleted}` markers, which `cloud/worker.js` already stores for `m|` and `e|` keys, so the worker needed no change. Plugins with the `watched`
permission can check / set movies and episodes (see `FLUTTER_PLUGINS.md`). Plugin movie posters also get the tick and press-and-hold toggle automatically (Settings > Plugin posters).

## Background activity line and loading ring (ports of `www/activity.js` and `www/busy.js`)
`activity.dart`: a small, non-focusable status line bottom right ("Scanning your media folders...", "Syncing watch history...", "Loading your library...",
"Searching releases: ...", "Installing ...", "Starting stream: ..."), hidden while a video plays or the keyboard is open, and lifted above the phone's bottom bar
and the mini player. Settings > Background activity: Off / Basic / Detailed (Detailed adds plugin loading / starting). `Activity.begin / update / end / note / track`.
The ring (`Busy`, `BusyRing`) appears over the screen when a request to the PEK TV server takes more than 0.5 s (poll-style lookups are ignored, same list as busy.js).
Not shown: plugin network requests (the Python side makes them, so the app can't see them).

## Plugin screens (Python)
Plugins can ship a Python `screen.py` that the Flutter UI draws natively (see `FLUTTER_PLUGINS.md`). TMDb Discover is fully ported (inline trailer, streaming apps, watched, Play with a plugin, synced favorites):
Plugins > Open, or its own entry in the menu / More page.

## Plugin store
Plugins > Browse the plugin store: the PEK Official and Community shelves, install and update with the same warning and permissions screens as the web UI (`plugin_store.dart`, `plugin_store_ui.dart`; details in `FLUTTER_PLUGINS.md`).

## Still only in the classic UI
Plugins that only have a `ui.js`, the store's skin shelf, plugin dashboard tiles for plugins that only have a `ui.js` (plugins with a Python screen get a tile).

## TV mode (port of `www/tv_mode.js`)
Settings > **TV mode** (`tv_mode.dart`): Auto (on for TV boxes, off on phones) / On / Off, and Screen margins (None, Small 2 %, Medium 4 %,
Large 6 %). Both belong to the device, not to a profile, like the web UI. The 10-foot look is the web `html.pek-tv` rules:
- rem follows the screen width (1920 wide = 30 px) and TV-safe margins are applied by `PekScope.safeX / safeY` (pages, sidebar, top bar,
  sub-screen app bar, detail pages).
- Bold 0.2rem focus ring plus the 1.07 poster lift (`PekFocusable`), 3rem buttons / list rows / text fields, poster grid minimum 9rem
  (7rem small, 14rem large) so the column count is the same at any resolution.
- Material-drawn widgets (dialogs, text fields, icons) follow rem too (`PekRoot`).
- The mouse pointer hides after 3 idle seconds in TV mode (mouse only, so touch is never blocked).
- `PekScope.isTv` is the look; `PekScope.tvDevice` is the hardware and `PekScope.sidebar` the layout (sidebar on TV boxes, or wide screens
  with the look forced on). Forcing TV mode Off on a TV box keeps the sidebar and D-pad behaviour.
- Game controllers need no port: Android turns them into D-pad keys, which Flutter's focus system already handles.


## Artwork / title cache and the video surface (Fixes 3)

- `flutter_ui/lib/src/art_cache.dart`: posters (and any other picture shown through `ArtImage`) are kept on the device (cache
  folder, about 300 MB, oldest removed first). Synopsis + poster address per title are kept in `details.json` for 30 days
  (internet pictures only), and the last movie / show lists in `movies.json` / `shows.json` (used when the server cannot answer).
  Pictures from the local server (127.0.0.1) are not copied.
- Video shows through the transparent Flutter surface. Flutter's Impeller renderer is switched off in `AndroidManifest.xml`
  (`io.flutter.embedding.android.EnableImpeller`) because its Vulkan path can paint an opaque black frame over the video.
  The `PEK playback: vo=...` line in logcat (MpvController) says whether mpv itself is producing video.

## Flutter is the only UI (classic UI fallback removed)
`MainActivity` is now only the start-up activity: it copies the app's files and built-in plugins, starts the C++ server and the Python
plugins, waits for the server, opens `FlutterHostActivity` and finishes. No web view, no `PekBridge`, no `pek_classic` / `web_ui`
switch, no "Open classic UI" buttons. If the server does not start, or the Flutter screen cannot open, a plain message with a
**Try again** button is shown. `SplashOverlay.kt` (it drew over the web view) is gone. The `www/` folder is not used by the app any
more, but the server still serves it; it can be deleted in a later step.

## Skin install and skin builder
- **Install skin from .zip / GitHub** (`skin_install.dart`, `skin_install_ui.dart`, Settings > Appearance): ports of `www/skin_installer.js` and `backend/skin_install.h`.
  It reuses the plugin zip reader (`PluginZip.read`), the zip picker and the GitHub flow (`plugin_install_ui.dart`, now with a `skin:` switch;
  `PekGithub.downloadBytes` is the shared download). Colours and corner size are stored on the device like made skins (id `pkg-<slug>`);
  `skin.css` is checked but not drawn. GitHub skins are labelled unverified. The Settings > Plugins and skins from GitHub switch covers both.
- **`SkinBuilder`** (`skin_builder.dart`) makes skins from code and writes installable .zips; `tools/make_skin.py` does the same from the command line. See SKINS.md.
- Tests: `flutter test test/skin_install_test.dart`.
