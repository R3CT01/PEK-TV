# PEK TV - Flutter UI

The C++ server, the Python plugins, libmpv and the cloud workers are unchanged. Only the screen layer is new:

```
SplashActivity (launcher: starts Boot, plays the unskippable splash video full screen via SplashOverlay.kt, and opens FlutterHostActivity behind it, invisible, so Flutter boots during the video; SplashGate.kt reveals it when the video is over and Flutter has sent pek/host splashReady) ; FlutterHostActivity ; MainActivity (hand-over for widget/notification taps) ; Boot = assets, server on :8080, plugins
   -> FlutterHostActivity            android/app/src/flutter/java/.../FlutterHostActivity.kt
        Flutter UI (flutter_ui/)  --HTTP-->  C++ server on 127.0.0.1:8080
        pek/mpv channels          ------->  MpvController (libmpv, same engine)  -- SurfaceView behind Flutter
```

## Build
1. `cd flutter_ui && flutter pub get`   (generates `flutter_ui/.android/`, which switches the Flutter build on)
2. Build the Android project as usual. Step 1 is required: the app has no other UI.
3. CI: `.github/workflows/build_android.yml` (the Android build) runs step 1 automatically when `flutter_ui/pubspec.yaml` exists.

The Flutter UI is the only UI.

## One branch, one folder per platform
Everything lives on `main`. `flutter_ui/` (screens) and `backend/` (C++ server) are shared; each platform has its own host folder
next to them. Today that is `android/` with its workflow `.github/workflows/build_android.yml`. A new platform adds its own folder (for
example `linux/` or `windows/`) and its own workflow file; it does not need a branch. A host has to provide what Android's host
does: start the backend on `127.0.0.1:8080`, and answer the `pek/*` platform channels (`pek/mpv`, `pek/music`, `pek/host`,
`pek/plugins`, `pek/output`) that `flutter_ui/lib/src/` calls. Some pieces here are Android-only today (the Kotlin side of those
channels, `webview_flutter_android` for plugin trailers).

## What the Flutter UI has now
Swipe navigation on phones and tablets: **Home, Movies, Shows, Music and More are pages you swipe between** (or tap in the
bottom bar). "More" is a page of its own with tiles for Resume Watching, Favorites, Duplicates, Unknown, Plugins and
Settings; a tap opens that screen on top and Back returns. On a TV the sidebar lists everything and switches the content.

- Dashboard: clock, Continue Watching, Recently Added, Favorites rows (press and hold a widget: Move / Delete; Add widget button)
- Movies, TV Shows: poster grids, Refresh (rescan), movie and show / season / episode pages, Favorite button
- Player: libmpv engine, audio + subtitle pick, buffering, auto-hiding controls, records progress for Resume Watching
- Resume Watching, Favorites (long-press a poster to remove)
- Music: Albums / Artists / Songs, search, album and artist pages, queue, shuffle / repeat, mini player, full-screen player
  (cover + title on the left, time-synced lyrics on the right, a Browse panel with Queue / Albums / Artists / Songs; `music_fullscreen.dart`)
- Playlists (`playlists.dart` store per profile, `playlist_ui.dart`): Music > Playlists tab, playlist page (Play / Shuffle / Add to queue / Rename / Delete, drag to reorder), press-and-hold a song for Play next / Add to queue / Add to playlist, "Add to playlist" on album pages and in the full-screen player, "Save as playlist" for the queue. Not synced to the cloud yet.
- Duplicates, Unknown, Plugins (list + remove), Settings (media sources + folder picker)
- Settings > Subtitles (automatic look-up on / off, language drop-down), Video output (match refresh rate, HDR) and Audio output
  (Dolby / DTS passthrough). Subtitles are also found automatically while a library movie / episode plays, and the player's
  audio / subtitle menu has a "Find subtitles online" list (`subtitles.dart`).

Resume progress, favorites and the dashboard layout are stored on the device with `shared_preferences` (`store.dart`). 

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
- Show page: the synopsis is cut to 4 lines with **Show more / Show less** (`ExpandableText`, `detail.dart`). Tapping an episode opens its page (`EpisodeScreen`): the episode's still picture, title and the whole synopsis from `/api/episode-details` (`Api.episodeDetails`; the library's own .nfo / thumbnail first, then TMDb), with Play / Continue / Start over and Mark as watched. Press and hold an episode row still marks just that one.
- Search (title, actor, genre, year; `library_pages.dart`) and Watch History (a permanent "finished" record kept in `Store`), both under More.
- Skip Intro / Skip Recap (`skip.dart`: file chapters, then the online database) and Up next (last 5 minutes of an episode, 5 s countdown
  when it ends) in the player. Settings > Skip intro and recap.
- Lyrics in the full-screen player (`lyrics.dart`, shown by `music_fullscreen.dart`) and Settings > Music > Online art & lyrics.

## Added in phase 3
- **Profiles** (`profiles.dart`, `profile_pages.dart`): Who's watching? picker, first-time setup, add / edit / delete, 4-digit passcode (hashed), 5 profiles max. Each profile has its own history, resume points, favorites, skip settings and skin. Profiles need a signed-in account.
- **Cloud account and sync** (`cloud.dart`, `account_pages.dart`): sign up / sign in with the emailed 6-digit code, forgot password, sign out (asks first), delete account. Watch history, resume points and favorites sync per profile through the existing worker; the profile list syncs too. Favorites are keyed by TMDb id, looked up once through the same TMDb worker the backend uses.
- **Layouts** (`layouts.dart`): Classic, Top bar, Wall, Compact (menu position and poster size, TV/tablet) plus a poster-size setting that phones also get. Per profile.
- **Torrent search** (`torrent_search.dart`): search the https sites you list (address with `{q}`), fetched through the existing `/api/torrent/fetch` route, plus an optional Torznab provider; results are filtered and ranked like the web engine.
- **Torrents** (`torrent.dart`): More > Torrents plays a magnet / .torrent link with a loading screen (peers, speed, progress), a loading card inside the player while it buffers or scrubs, and Resume Watching that restarts the same release (also from other devices).
- **Skins** (`skins.dart`): PEK Ember (default), Cream, Night red, Green, Neon, per profile (Settings > Appearance). Skins made or installed are kept per profile and saved to the cloud account with the rest of the profile's data (`k|<id>` items plus the `s|skin` setting, see SKINS.md), so a sign-in puts them back.
- HDR output and refresh-rate matching were already in Settings > Video output.

- **Dashboard** (`dashboard.dart`, `store.dart`): a grid. Clock and plugin shortcuts are tiles (Small = 1 column, Wide = 2); Weather is a full-width card; Continue Watching, Recently Added and Favorites are full-width poster rows. Press and hold a widget (touch, held centre button, or the Menu key) for **Move** / **Delete** (and Make wide / small on tiles). Move: drag the widget up or down and let go on a square to place it (D-pad: Up / Down pick the square, centre places it); Back leaves move mode. The Add widget button adds widgets or resets. Saved per profile in the `{id, type, size, folder}` shape and synced as `s|dashboard`; the layout and poster size sync as `s|look`, the city and unit as `s|weather` (`cloud.dart`).
- **Clock and Weather widgets** (`weather.dart`, `dashboard.dart`): both are dashboard widgets you can add, remove and reorder. The weather tile shows a big temperature with "condition \u00b7 city" under it. Weather uses Open-Meteo like plugins/weather (pick a city, Fahrenheit or Celsius, last reading shown offline).

- **Clock settings** (`clock.dart`): tap the Clock tile for 24-hour time, Show date and a time zone list (each zone shows the time it has now). 38 zones with a "day \u00b7 zone" line; kept on the device, not synced. Zones are computed from built-in daylight-saving rules (US/Canada, EU/UK, Sydney, Auckland, Cairo), so there is no extra package; the rules need a look only if a country changes its clocks.
- **Online / offline mode** (`net.dart`): a 10px dot in the top right corner (green online, red offline), a "Back online" / "Offline mode" notice, and a check every 30 s (8 s while offline) and whenever the app returns to the front. Back online: poster lookups that failed are asked again, the profile syncs and the weather refreshes. The local library works the same either way.

## Watched / unwatched
Movie page: **Mark as watched / unwatched**. Show page: **Mark show ...**, **Mark season ...** and a tick on each watched episode (press and hold
an episode to toggle just that one); movie posters show a tick before the year. Everything uses Watch History (`Store.setWatched`), so the
Watch History page, plugins and PEK Cloud agree. A change is pushed to the worker about 2 s later (`watched.dart`); removals go up as
`{deleted}` markers, which `cloud/worker.js` already stores for `m|` and `e|` keys, so the worker needed no change. Plugins with the `watched`
permission can check / set movies and episodes (see `FLUTTER_PLUGINS.md`). Plugin movie posters also get the tick and press-and-hold toggle automatically (Settings > Plugin posters).

## Background activity line and loading ring
`activity.dart`: a small, non-focusable status line bottom right ("Scanning your media folders...", "Syncing watch history...", "Loading your library...",
"Searching releases: ...", "Installing ...", "Starting stream: ..."), hidden while a video plays or the keyboard is open, and lifted above the phone's bottom bar
and the mini player. Settings > Background activity: Off / Basic / Detailed (Detailed adds plugin loading / starting). `Activity.begin / update / end / note / track`.
The ring (`Busy`, `BusyRing`) appears over the screen when a request to the PEK TV server takes more than 0.5 s (poll-style lookups are ignored, same list as the activity line).
Not shown: plugin network requests (the Python side makes them, so the app can't see them).

## Plugin screens (Python)
Plugins can ship a Python `screen.py` that the Flutter UI draws natively (see `FLUTTER_PLUGINS.md`). TMDb Discover is fully ported (inline trailer, streaming apps, watched, Play with a plugin, synced favorites):
Plugins > Open, or its own entry in the menu / More page.

## Plugin store
Plugins > Browse the plugin store, and Settings > Appearance > Browse the skin store: one full-page store for both (`store_browser.dart`; the same worker, `kind=plugin` or `kind=skin`).
- A search box that suggests as you type (names first, then authors: tap a name to open it, tap an author to show only theirs), the Official / Community shelves, a sort (best match, newest, oldest, name A-Z, author A-Z) and an author filter. "Newest" uses the `updated` time the worker already sends for every item.
- Cards show the picture (a skin shows its own colours, drawn small from the skin's file, downloaded once per session), version, author, size, when it was uploaded, and an Installed / Update / New badge.
- Opening a card goes to the same install screens as before: the warning and permissions screens for a plugin (`plugin_store.dart`, `plugin_store_ui.dart`; details in `FLUTTER_PLUGINS.md`), the colour preview for a skin (`skin_install_ui.dart`). Nothing installs from the browsing screen. A skin installed this way is remembered as `{'type': 'store', 'shelf': ...}` and shown as "PEK Store" under its name.

## TV mode
Settings > **TV mode** (`tv_mode.dart`): Auto (on for TV boxes, off on phones) / On / Off, and Screen margins (None, Small 2 %, Medium 4 %,
Large 6 %). Both belong to the device, not to a profile. The 10-foot look:
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
- A poster / synopsis lookup that fails is tried again after 2 s and 6 s, and one that still fails (or finds no picture) is forgotten after 20 s (60 s) so the next time the screen is built it asks again; a picture that will not load is retried after 8, 16 and 24 s (`Api._cachedDetails`, `PosterCard`). Refresh is no longer needed to get blank posters back.
- Video shows through the transparent Flutter surface. Flutter's Impeller renderer is switched off in `AndroidManifest.xml`
  (`io.flutter.embedding.android.EnableImpeller`) because its Vulkan path can paint an opaque black frame over the video.
  The `PEK playback: vo=...` line in logcat (MpvController) says whether mpv itself is producing video.

## Flutter is the only UI (classic UI fallback removed)
`MainActivity` is now only the start-up activity: it copies the app's files and built-in plugins, starts the C++ server and the Python
plugins, waits for the server, opens `FlutterHostActivity` and finishes. No web view, no `PekBridge`, no `pek_classic` / `web_ui`
switch, no "Open classic UI" buttons. If the server does not start, or the Flutter screen cannot open, a plain message with a
**Try again** button is shown. `SplashOverlay.kt` (it drew over the web view) is gone. The old `www/` web UI folder has been deleted and the server no longer serves pages: it is API only.

## Skin install and skin builder
- **Install skin from .zip / GitHub** (`skin_install.dart`, `skin_install_ui.dart`, Settings > Appearance): same checks as `backend/skin_install.h`.
  It reuses the plugin zip reader (`PluginZip.read`), the zip picker and the GitHub flow (`plugin_install_ui.dart`, now with a `skin:` switch;
  `PekGithub.downloadBytes` is the shared download). Colours and corner size are stored on the device like made skins (id `pkg-<slug>`);
  a skin with a `skin.css` is refused (no CSS in skins, here and in `SkinBuilder` / `tools/make_skin.py`). GitHub skins are labelled unverified. The Settings > Plugins and skins from GitHub switch covers both.
- The Skin maker is the bundled `skin-maker` plugin (`plugins/skin-maker`); `tools/make_skin.py` makes skins and installable .zips from the command line. The app keeps only what the plugin needs drawn (`skin_widgets.dart`: colour window, preview). See SKINS.md.
- Tests: `flutter test test/skin_install_test.dart test/skin_sync_test.dart`.

## Dashboard widgets (Add widget)
Add widget lists every widget that is not on the dashboard yet, in groups. `flutter_ui/lib/src/dash_widgets.dart` holds the
newer ones; each loads its own data and keeps itself up to date:
- Music: **Now Playing** (cover, title, artist, progress, shuffle / previous / play / next / repeat; tap = full-screen player),
  **Playlists** and **Albums** (rows of covers).
- Weather and time: Clock and **Weather** (one full-width card: the temperature and conditions now, and under them a horizontal, scrollable
  forecast, the next 24 hours or next 7 days, toggled with Hourly / Daily; tap a day for its details; Open-Meteo, cached for offline).
  The old separate **Forecast** widget was merged into Weather: a saved layout that has `forecast` is read as `weather` (`Store.cleanDashboard`).
  The Weather widget, the header badge and the Weather plugin share one city and unit, so a city is only typed once.
- Movies and shows: Continue Watching, **Up Next** (the next unwatched episode of each show you are watching), Recently Added, **Recently Watched**, **TV Shows**, Favorites, **Library** (counts tile), **Surprise me** (random movie tile).
- Plugins: **Pinned plugins** (a row of the icons pinned on the More page) and a shortcut tile for each installed plugin with a screen.

To add one: write the widget in `dash_widgets.dart`, add its type to `Store.dashTypes` and `Store.dashGroups` (and `Store.dashIsTile` if it is a
small tile), then add a `case` for it in `_DashboardPageState._widget` (`dashboard.dart`). The layout syncs to the profile like before
(`s|dashboard`).

## Pictures that heal themselves (no manual refresh)
Posters used to stay blank until the screen was rebuilt by hand (Refresh). Causes and fixes:
- `Api._cachedDetails` kept a failed or picture-less look-up for the card that asked for it; `PosterCard` / `PosterImage` (`widgets.dart`) now keep
  their own copy of the look-up and re-ask through `Api.retryDetails` after 5, 12, 25, 45, 60 and 60 s (library posters, dashboard rows, detail pages).
- `ArtCache` treated 403 / 429 as final ("not there"), so a rate-limited picture was never asked for again this run. Only 404 / 410 are final now.
- `ArtImage` keeps asking after the quick tries (every 30 s, 10 more times) and swaps the picture in when it arrives; plugin posters
  (`ui.poster_card`, `ui.episode_row`, provider logos, which now also use `ArtImage`) rely on this because their screens only redraw when the plugin does.
- `Net._backOnline` calls `ArtCache.retryAll()`: every picture and poster that gave up tries again at once.
- Plugins: `api()` in `tmdb-discover` (1.7.1) and `snake-skin` / Stream Media (3.4.1) retries a failed TMDb request inside its background job.

## Files that will not open
`MpvController` tells Dart why a load ended: `ended` (it played) or `error` (it never loaded: damaged, 0 bytes, unsupported). The mpv event
channel is now `{event: time|state|tracks|ended|error, data: {...}}`. `PekPlayer.failed` (`mpv.dart`) is the Dart side;
`music_controller.dart` marks the song unplayable and skips it, `music.dart` (`TrackRow`) greys it out, and `player.dart` closes a video that
will not open. Only when libmpv itself cannot start does the host still show "Player has crashed - please restart" (and send `ended`).
Details and limits: `MUSIC.md` > "Files that cannot be played".

## Music home-screen widget (Android)
`android/app/src/main/java/com/pektv/app/MusicWidget.kt` plus the widget resources (layout, provider info, drawables, `ember_*` colours,
strings) and a receiver in `AndroidManifest.xml`. It is native only: no Flutter screen and no channel. `MusicService` pushes `MusicState` to
it whenever it redraws the notification. Details: `MUSIC.md` > "Home-screen widget".
