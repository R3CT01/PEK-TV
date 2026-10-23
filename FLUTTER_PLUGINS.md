# Plugins in the Flutter UI (Python screens)

Plugins used to ship a `ui.js` that ran in a sandboxed web view. The Flutter UI cannot run JavaScript, and Flutter cannot load new
code at run time, so a plugin that wants a screen in the Flutter UI ships a **Python screen**, `screen.py`, next to its
`plugin.json` (and its optional `backend.py`). The screen *describes* a UI as data; Flutter draws it with the app's own widgets.

```
Flutter UI (plugin_ui.dart)  --'pek/plugins' channel-->  FlutterHostActivity.kt
        ^                                                         |  Chaquopy (same process)
        |  JSON tree + effects                                    v
        +-------------------------------------------  python/pek_flutter.py  -->  plugins/<id>/screen.py
                                                       (hesper_guard: manifest, scan, pek_host, audit hook, time limits)
```

It is the same idea as the JS side: the plugin can only describe a screen and ask for a few things; it never runs code in the app.
Everything runs under the same guard as `backend.py`.

## Writing a screen

`plugin.json` gets one more entry, and the permissions work exactly as before:

```json
{ "name": "My Plugin", "version": "1.0.0",
  "permissions": { "network": ["api.example.com"], "storage": true, "favorites": true },
  "ui": { "navTab": "Mine" },
  "flutter": { "screen": "screen.py" } }
```

`screen.py`:

```python
import pek_host as h
import pek_ui as ui

state = {"items": None, "error": ""}

def start():                      # once, when the screen first opens (optional)
    def work():                   # runs on another thread: may wait for the network
        return h.fetch_json("https://api.example.com/list")
    def done(result):             # back on the screen's thread; the screen is redrawn afterwards
        state["items"] = result["items"]
    def fail(message):
        state["error"] = message
    ui.background(work, done, fail)

def render():                     # returns the tree, like pek.render(ui => tree)
    if state["items"] is None:
        return ui.column(ui.spinner("Loading..."))
    return ui.column(ui.heading("Things"), [ui.card(i["name"], "", lambda i=i: show(i)) for i in state["items"]])

def show(item):
    ui.toast(item["name"])

def on_launch(intent):            # PEK opened the plugin on a title (optional)
    pass
```

`screen.py` is scanned with `backend.py`: same allowed imports (plus `pek_ui`), no `open/getattr/eval`, no `_attributes`, no `__`.

### Migrating from `ui.js` (JS -> Python)

| Old `ui.js` call | Python (`screen.py`) |
|---|---|
| `pek.render(ui => tree)` | `def render(): return ui.column(...)` |
| `pek.requestRender()` after a fetch | `ui.background(work, done, fail)` (redraws by itself) |
| `ui.column / row / text / heading / spinner` | same names |
| `ui.button(label, fn, {primary, selected, autofocus})` | `ui.button(label, fn, primary=, selected=, autofocus=)` |
| `ui.episodeRow({title, meta, text, image, dim, on})` | `ui.episode_row(title, meta, text, image, dim=, on=)`: episode picture + title + description |
| `ui.card / listRow / posterCard / grid` | `ui.card / list_row / poster_card / grid(kids, min_col=, scroll=)` |
| `ui.tabs(items, active, fn)` | `ui.tabs([(id, label)], active, fn)`, `fn(id)` |
| `ui.textInput(label, value, onChange, {placeholder, type:'password', onSubmit})` | `ui.text_input(label, value, on_change, placeholder=, secret=, on_submit=, key=)` |
| `ui.toggle(label, checked, fn)` | `ui.toggle(label, checked, fn)`, `fn(True/False)` |
| `ui.providerButton({...})` (`providers`) | `ui.provider_button(name, logo, title, kind, tmdb_id, region)` (`providers`): opens the service's app, see below |
| `pek.setBack(fn)` / `pek.scrollTop()` | `ui.set_back(fn_or_None)` / `ui.scroll_top()` |
| `pek.favorites.add/remove` (`favorites`) | `ui.favorite_add(kind, id, title, year, poster_path)` / `ui.favorite_remove("movie:603")` |
| `ui.video({id, autoplay, muted})` (YouTube host in `network`) | `ui.video(video_id, autoplay=, muted=)`: an inline player pinned to the top of the screen; `ui.open_trailer(video_id)` opens YouTube instead |
| `pek.plugins.streamers()` / `pek.plugins.open(id, intent)` (`plugins`) | `ui.streamers()` / `ui.open_plugin(id, kind, tmdb_id, title, year)` (`plugins`) |
| `pek.watched.check / set` (`watched`) | `ui.is_watched("movie", title, year)` / `ui.set_watched("movie", title, year, True)`; episodes: `ui.is_watched("episode", show_title, season=1, episode=3)` / `ui.set_watched("episode", show_title, season=1, episode=3, value=True)`; lists (max 300): `ui.is_watched_many(items)` / `ui.set_watched_many(items, True)` with items `{kind, title, year, season, episode}` (`watched`) |
| `pek.fetchJSON(url)` (`network`) | `h.fetch_json(url)` (inside `ui.background`) |
| `pek.storage.*`, `pek.readJSON` | `h.write_json / h.read_json` (`storage`, in `data/`) |
| `navigator.language` | `ui.ctx()["lang"]`, `["region"]`, `["tv"]`, `["favorites"]` |
| `pek.onLaunch(fn)` | `def on_launch(intent)` |

Text typed in a box reaches `on_change` just before the next tap's own callback (not on every key), so the screen needs no
round trip per keystroke. Pictures (`poster_card`, provider logos) only load from hosts listed under `permissions.network`.

### What a screen can ask for (effects)
A fixed list, each checked in Python against `plugin.json` before Flutter sees it: open an **https** link (`open_trailer`
builds the YouTube address itself; a plugin never supplies an address), open a streaming **app**, open another plugin on a
title, save / remove a favorite (`favorites`), mark movies / episodes watched / unwatched (`watched`), show a message, close itself.
Anything else is dropped.

**Streaming apps.** `provider_button` looks the service up in `python/pek_providers.py`, which is generated from
`tools/providers.json` by `node tools/sync_providers.js` (the same run also refreshes the Kotlin allow-lists and the manifest
`<queries>`), so adding a service stays a one-place change. A known service opens its app on the title's page when the app
supports the link, else the app, else its website; any other service opens the title's TMDb "where to watch" page.
`FlutterHostActivity` only starts packages on its own allow-list.

**Trailers.** `ui.video` shows the trailer in an Android web view that can only load `www.youtube-nocookie.com` (any other
address is refused). If `autoplay` is false the person presses **Play trailer**. On a TV the web view is skipped by the D-pad.

**Play with a plugin.** A plugin that can play a title declares `"provides": {"stream": true}` plus a Flutter screen, and
implements `on_launch(intent)` (`{"type", "id", "title", "year"}`). Every other screen with the `plugins` permission can then
list it (`ui.streamers()`) and hand it a title (`ui.open_plugin`).

**Watched.** It is PEK TV's own Watch History (the same record the library, the Mark as watched buttons and PEK Cloud use).
Movies are keyed `m|title|year`, episodes `e|show title|season|episode` (for an episode `title` is the show's title). A mark or
un-mark made by a plugin is written to history straight away and pushed to PEK Cloud a couple of seconds later (an un-mark goes up
as a removal marker), so it shows on the library's ticks and on the other devices. A plugin sees only whether the items it asks
about are watched, never the rest of the history.

**Universal watched tick (no plugin work, no permission).** Every `ui.poster_card` movie gets a tick in the corner when it is in Watch
History, and pressing and holding it marks / un-marks it (the app does this itself; the plugin is never told). For an exact match pass
`year=` and, for TV, `kind="show"` (`poster_card(title, sub, poster, on, year=2010, kind="movie")`; the default kind is `"movie"`). With no
year the app looks for `(2010)` at the end of the title, then a year in the sub line, then (Settings > Plugin posters, on by default)
matches by title alone. TMDb Discover passes both. Episode rows are not ticked yet.

**Favorites.** Plugin favorites use the cloud format (`f|movie:603`, `from` = the plugin id), so they sync with
your other devices; one that arrives for a title outside this library shows under Favorites > Saved from plugins.

### Limits
Draw 6 s, tap handler 15 s, one `ui.background` job 25 s (the 10 s network limit per request still applies). A screen that
raises or runs past its limit shows an error card with **Try again**. `plugins/tmdb-discover/data/` style storage is unchanged.
A third-party plugin listing PEK's built-in TMDb proxy host is refused here too (only `tmdb-discover` may use it).

## TMDb Discover (ported, 1.6.0)
`plugins/tmdb-discover/screen.py` has:
- Movies / TV rows (trending, top rated, popular, now playing / on the air), streaming-service chips, numbered pages with Next / Prev / +-10, search, actor pages.
- Detail page: overview, genres, **inline trailer** (auto-play and sound settings), cast, more like this, where to watch / rent or buy as **buttons that open the service's app**, **Play with a plugin**, **Mark as watched**, favorites.
- "In library" badges, refreshed from the library scanner on start and on **Refresh** (no restart needed).
- Built-in TMDb access, optional personal key and region (kept in the plugin's `data/settings.json`).

"Play with a plugin" only shows when another installed plugin with a Flutter screen declares `provides.stream`; none ship
today, so the section stays hidden until one is installed.

## The plugin store in the Flutter UI
Plugins > **Browse the plugin store**. It talks to the
same two places:

1. **The PEK Store worker** (`https://pek-store.aquariusibeats.workers.dev`, `plugin_store.dart`): `GET /v1/store?shelf=official|community&kind=plugin`
   lists a shelf; `GET /v1/store/chunk?id&fp&i` downloads the bundle in parts. The parts are joined, checked against the
   item's 64-bit fingerprint (`fingerprint()` in `plugin_store.dart`) and unpacked in memory.
2. **PEK TV's own server** (`POST /api/plugins/install`): first a **dry run** (the server's safety checks, and whether it
   replaces an installed plugin), then the real install after the person confirms. The multipart body is built by hand because the
   server pairs repeated `path` / `file` parts by position; it was tested against the real route from `backend/plugin_install.h`.

Screens (`plugin_store_ui.dart`): shelves -> list (with *installed* / *update available* marks) -> install page: download
progress -> the author's own `warning` screen (if `plugin.json` has one) -> the permissions screen (the same sentences as the web
UI) -> **Install / Update**. Nothing installs by itself, and uploading is still done on the store's website, not in the app.
After an install or a removal the menu entries and the Plugins page reload (`PluginHost.changed`), any open screen of that
plugin restarts, and the Plugins page shows where each plugin came from ("PEK Store official" / "approved · community store").
A plugin with only a `ui.js` is **no longer accepted** anywhere (store, .zip, GitHub), and neither is any other `.js` / `.mjs` file: a plugin is Python only and needs a `screen.py` and a `"flutter"` entry in `plugin.json`, checked in the app and again by `backend/plugin_install.h`. The server also refuses to serve any `.js` under `/plugins/`, so the classic UI can no longer load a plugin's `ui.js` (including ones installed earlier and the bundled Weather / TMDb Discover ones). One with a `backend.py` reminds the person to restart
PEK TV once.

Not in the Flutter store yet: **skins** (the store has a skin shelf; skin install is a separate flow, `skin_install.h`)
and the cloud plugin backup that runs after an install.

## Install from a .zip file or from GitHub
Plugins > **Install from .zip** and **Install from GitHub** (`plugin_install_ui.dart`) are the zip picker and the GitHub
install. Both end on the same install screen as the store
(`PluginInstallPage`: server dry run -> the author's warning -> permissions -> Install), so nothing installs by itself.

- **.zip**: PEK TV's own picker, on `POST /api/plugins/browse` + `/api/plugins/fetch` (works on TV boxes and network folders;
  it starts at *This device* and your media sources). `plugin_zip.dart` unpacks it in memory with the same limits as the server
  (2 MB per file, 8 MB total, 400 files, CRC checked, inflate stops at the limit; no ZIP64 / encrypted / split zips). It needs no
  extra package (`dart:io` raw inflate). plugin.json at the top or inside one folder; a zip with `skin.json` is refused.
- **GitHub**: type `owner/repo` or paste a link. `plugin_github.dart` asks `api.github.com` for the latest release (its .zip files
  and its source), or the default branch's source if there is no release; you pick one when there are several. The download goes
  through `POST /api/plugins/github-zip` (backend/github_install.h). A first-time warning is shown once; the switch is Settings >
  *Plugins from GitHub* (`PEK_ALLOW_GITHUB=0` still turns it off in the server). Source zips are
  installed under the repository name so an update replaces the same plugin.
- The Plugins page labels where each plugin came from ("unverified - from GitHub owner/repo", "third party - from a .zip file").
- Still web-UI only: the system file picker, finding network devices from inside the zip picker (add the device as a media
  source in Settings, then it shows up under the picker's start list), and installing a *skin* from a zip or GitHub.

## Skin Maker (bundled, official)
`plugins/skin-maker` replaces the Skin maker that used to be hard-coded in the app (`skin_maker.dart`, `skin_builder.dart`). It has a
`screen.py` and an icon like any plugin, and it is built in: no Remove button, and it updates from the PEK Store Official shelf.
What it needed from the host, all in `pek_ui`:
- Permission **`skins`**, reserved: `pek_flutter.OFFICIAL_SKIN_PLUGINS = {"skin-maker"}`; any other plugin that asks for it is refused when it opens.
- `ui.skins()` (the skins on the device, as hex tokens), `ui.skin_save / skin_use / skin_delete`, `ui.copy_skin_json`.
- Widgets: `ui.color_row` (a swatch that opens PEK's colour window), `ui.slider`, `ui.skin_preview` (drawn by `skin_widgets.dart`).
- Effects `skin.save`, `skin.use`, `skin.delete`, `clipboard.copy`. `plugin_ui.dart` only runs `skin.*` for `skin-maker`, only touches skins made on
  the device (`custom-...`), and refuses unreadable colours again. Built-in and installed skins are never changed by a plugin.
- Settings > Appearance opens it with `launch` `{"type": "skin", "id": <skin id>, "mode": "edit" | "from" | "paste"}`.
- The store: `skin-maker` is in `PluginInstaller.stockIds`, `isReservedId` / `isStockId` (backend), `PluginBackup.builtin` and `MainActivity.stockPlugins`.
  In `cloud/store-worker.js` the id is **owner-only** (`OWNER_ONLY_PLUGINS`): only the owner route may publish it, nobody else can take the id.

## Files
- `android/app/src/main/python/pek_ui.py` - what a screen imports (builders + host calls)
- `android/app/src/main/python/pek_flutter.py` - sessions, guarded calls, background jobs, effects
- `android/app/src/main/python/pek_providers.py` - streaming services (generated from `tools/providers.json`; `tools/sync_providers.js` also feeds `FlutterHostActivity.kt`)
- `android/app/src/main/python/hesper_guard.py` (+ `backend/` copy) - allows `import pek_ui`; `hesper_runner.py` remembers the plugins folder
- `android/app/src/flutter/.../FlutterHostActivity.kt` - `pek/plugins` channel (`call`, `openUrl`)
- `flutter_ui/lib/src/plugin_host.dart` - Dart client, host allow-list for pictures, TV Back hook
- `flutter_ui/lib/src/plugin_ui.dart` - the renderer, effects, polling, "Saved from plugins"
- `flutter_ui/lib/src/plugin_store.dart` / `plugin_store_ui.dart` - the plugin store: client, fingerprint, install upload; shelves, list and the shared install screen
- `flutter_ui/lib/src/plugin_zip.dart` / `plugin_github.dart` / `plugin_install_ui.dart` - install from a .zip file / from GitHub: zip reader + picker client, GitHub client, screens and the Settings switch
- `flutter_ui/lib/src/shell.dart`, `pages.dart`, `store.dart`, `api.dart`, `cloud.dart` - menu / More entries, Plugins > Open, plugin favorites and their cloud sync
- `flutter_ui/pubspec.yaml` - adds `webview_flutter` / `webview_flutter_android` (trailer player); run `flutter pub get`
- `backend/plugin_install.h` - a zip needs a `screen.py`; any `.js` is refused
- `plugins/tmdb-discover/{screen.py,plugin.json}` - the port (1.6.0)

## Plugin pictures, built-in plugins and updates (Fixes 4)
- **Picture**: `plugin.json` `"icon": "icon.png"` (png / jpg / webp in the plugin folder, 256x256 recommended, under 60 KB). The Plugins page shows it
  (served from `/plugins/<id>/<icon>`), the store worker copies it into the listing as a small data: address (`icon` column, added by itself
  on the first request after you paste `cloud/store-worker.js`) so the store list and the install screen show it without downloading the plugin.
- **Built-in plugins** (`weather`, `tmdb-discover`, `PluginInstaller.stockIds` / `isReservedId`) cannot be removed: no Remove button, and the
  server refuses (`/api/plugins` now reports `builtin`).
- **Updates** (`plugin_updates.dart`, checked 6 s after start and whenever the Plugins page opens):
  built-in plugins update by themselves from the PEK Store Official shelf (an `official=1` install, the only way the server lets a built-in
  plugin be replaced); plugins installed from GitHub are looked up again on GitHub and an **Update** button (with the permissions screen) appears
  on the Plugins page when the latest release tag differs. The app copies built-in plugins from its own files at every start; it now leaves a
  copy alone when the store's version is newer (`MainActivity.copyAssetDir`).
- **Torrents**: the Torrents page and the in-app release search are gone. The engine (`TorrentApi`, loading screen, `pek_ui.play_torrent`) stays for
  plugins with the `torrent` permission.
