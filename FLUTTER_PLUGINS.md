# Plugins in the Flutter UI (Python screens)

The web UI runs a plugin's `ui.js` in a sandboxed iframe. The Flutter UI cannot run JavaScript, and Flutter cannot load new
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

### JS -> Python

| Web sandbox (`ui.js`) | Python (`screen.py`) |
|---|---|
| `pek.render(ui => tree)` | `def render(): return ui.column(...)` |
| `pek.requestRender()` after a fetch | `ui.background(work, done, fail)` (redraws by itself) |
| `ui.column / row / text / heading / spinner` | same names |
| `ui.button(label, fn, {primary, selected, autofocus})` | `ui.button(label, fn, primary=, selected=, autofocus=)` |
| `ui.card / listRow / posterCard / grid` | `ui.card / list_row / poster_card / grid(kids, min_col=, scroll=)` |
| `ui.tabs(items, active, fn)` | `ui.tabs([(id, label)], active, fn)`, `fn(id)` |
| `ui.textInput(label, value, onChange, {placeholder, type:'password', onSubmit})` | `ui.text_input(label, value, on_change, placeholder=, secret=, on_submit=, key=)` |
| `ui.toggle(label, checked, fn)` | `ui.toggle(label, checked, fn)`, `fn(True/False)` |
| `ui.providerButton({...})` (`providers`) | `ui.provider_button(name, logo, title, kind, tmdb_id, region)` (`providers`): opens the service's app, see below |
| `pek.setBack(fn)` / `pek.scrollTop()` | `ui.set_back(fn_or_None)` / `ui.scroll_top()` |
| `pek.favorites.add/remove` (`favorites`) | `ui.favorite_add(kind, id, title, year, poster_path)` / `ui.favorite_remove("movie:603")` |
| `ui.video({id, autoplay, muted})` (YouTube host in `network`) | `ui.video(video_id, autoplay=, muted=)`: an inline player pinned to the top of the screen; `ui.open_trailer(video_id)` opens YouTube instead |
| `pek.plugins.streamers()` / `pek.plugins.open(id, intent)` (`plugins`) | `ui.streamers()` / `ui.open_plugin(id, kind, tmdb_id, title, year)` (`plugins`) |
| `pek.watched.has / set` (`watched`) | `ui.is_watched("movie", title, year)` / `ui.set_watched("movie", title, year, True)` (`watched`) |
| `pek.fetchJSON(url)` (`network`) | `h.fetch_json(url)` (inside `ui.background`) |
| `pek.storage.*`, `pek.readJSON` | `h.write_json / h.read_json` (`storage`, in `data/`) |
| `navigator.language` | `ui.ctx()["lang"]`, `["region"]`, `["tv"]`, `["favorites"]` |
| `pek.onLaunch(fn)` | `def on_launch(intent)` |

Text typed in a box reaches `on_change` just before the next tap's own callback (not on every key), so the screen needs no
round trip per keystroke. Pictures (`poster_card`, provider logos) only load from hosts listed under `permissions.network`.

### What a screen can ask for (effects)
A fixed list, each checked in Python against `plugin.json` before Flutter sees it: open an **https** link (`open_trailer`
builds the YouTube address itself; a plugin never supplies an address), open a streaming **app**, open another plugin on a
title, save / remove a favorite (`favorites`), mark a movie watched / unwatched (`watched`), show a message, close itself.
Anything else is dropped.

**Streaming apps.** `provider_button` looks the service up in `python/pek_providers.py`, which is generated from
`www/providers.js` by `node tools/sync_providers.js` (the same run also refreshes the Kotlin allow-lists and the manifest
`<queries>`), so adding a service stays a one-place change. A known service opens its app on the title's page when the app
supports the link, else the app, else its website; any other service opens the title's TMDb "where to watch" page.
`FlutterHostActivity` only starts packages on its own allow-list.

**Trailers.** `ui.video` shows the trailer in an Android web view that can only load `www.youtube-nocookie.com` (any other
address is refused). If `autoplay` is false the person presses **Play trailer**. On a TV the web view is skipped by the D-pad.

**Play with a plugin.** A plugin that can play a title declares `"provides": {"stream": true}` plus a Flutter screen, and
implements `on_launch(intent)` (`{"type", "id", "title", "year"}`). Every other screen with the `plugins` permission can then
list it (`ui.streamers()`) and hand it a title (`ui.open_plugin`).

**Watched.** It is PEK TV's own Watch History (the same record the library and PEK Cloud use), movies only, keyed
`m|title|year`.

**Favorites.** Plugin favorites use the web UI's cloud format (`f|movie:603`, `from` = the plugin id), so they sync with the
web UI and other devices; one that arrives for a title outside this library shows under Favorites > Saved from plugins.

### Limits
Draw 6 s, tap handler 15 s, one `ui.background` job 25 s (the 10 s network limit per request still applies). A screen that
raises or runs past its limit shows an error card with **Try again**. `plugins/tmdb-discover/data/` style storage is unchanged.
A third-party plugin listing PEK's built-in TMDb proxy host is refused here too (only `tmdb-discover` may use it).

## TMDb Discover (ported, 1.6.0)
`plugins/tmdb-discover/screen.py` has everything `ui.js` has:
- Movies / TV rows (trending, top rated, popular, now playing / on the air), streaming-service chips, numbered pages with Next / Prev / +-10, search, actor pages.
- Detail page: overview, genres, **inline trailer** (auto-play and sound settings), cast, more like this, where to watch / rent or buy as **buttons that open the service's app**, **Play with a plugin**, **Mark as watched**, favorites.
- "In library" badges, refreshed from the library scanner on start and on **Refresh** (no restart needed).
- Built-in TMDb access, optional personal key and region (kept in the plugin's `data/settings.json`).

"Play with a plugin" only shows when another installed plugin with a Flutter screen declares `provides.stream`; none ship
today, so the section stays hidden until one is installed.

## The plugin store in the Flutter UI
Plugins > **Browse the plugin store**. It is the Flutter twin of `www/plugin_store.js` + `www/plugin_installer.js` and talks to the
same two places:

1. **The PEK Store worker** (`https://pek-store.aquariusibeats.workers.dev`, `plugin_store.dart`): `GET /v1/store?shelf=official|community&kind=plugin`
   lists a shelf; `GET /v1/store/chunk?id&fp&i` downloads the bundle in parts. The parts are joined, checked against the
   item's 64-bit fingerprint (a port of `fingerprint()` in `plugin_store.js`, checked equal to the JS on test strings) and unpacked in memory.
2. **PEK TV's own server** (`POST /api/plugins/install`): first a **dry run** (the server's safety checks, and whether it
   replaces an installed plugin), then the real install after the person confirms. The multipart body is built by hand because the
   server pairs repeated `path` / `file` parts by position; it was tested against the real route from `backend/plugin_install.h`.

Screens (`plugin_store_ui.dart`): shelves -> list (with *installed* / *update available* marks) -> install page: download
progress -> the author's own `warning` screen (if `plugin.json` has one) -> the permissions screen (the same sentences as the web
UI) -> **Install / Update**. Nothing installs by itself, and uploading is still done on the store's website, not in the app.
After an install or a removal the menu entries and the Plugins page reload (`PluginHost.changed`), any open screen of that
plugin restarts, and the Plugins page shows where each plugin came from ("PEK Store official" / "approved · community store").
A plugin with only a `ui.js` installs but says it opens in the classic UI; one with a `backend.py` reminds the person to restart
PEK TV once.

Not in the Flutter store yet: **skins** (the store has a skin shelf; skin install is a separate flow, `skin_install.h`),
installing from a GitHub link or a local .zip, and the cloud plugin backup the web UI triggers after an install.

## Files
- `android/app/src/main/python/pek_ui.py` - what a screen imports (builders + host calls)
- `android/app/src/main/python/pek_flutter.py` - sessions, guarded calls, background jobs, effects
- `android/app/src/main/python/pek_providers.py` - streaming services (generated from `www/providers.js`; `tools/sync_providers.js` also feeds `FlutterHostActivity.kt`)
- `android/app/src/main/python/hesper_guard.py` (+ `backend/` copy) - allows `import pek_ui`; `hesper_runner.py` remembers the plugins folder
- `android/app/src/flutter/.../FlutterHostActivity.kt` - `pek/plugins` channel (`call`, `openUrl`)
- `flutter_ui/lib/src/plugin_host.dart` - Dart client, host allow-list for pictures, TV Back hook
- `flutter_ui/lib/src/plugin_ui.dart` - the renderer, effects, polling, "Saved from plugins"
- `flutter_ui/lib/src/plugin_store.dart` / `plugin_store_ui.dart` - the plugin store: client, fingerprint, install upload; shelves, list and install screens
- `flutter_ui/lib/src/shell.dart`, `pages.dart`, `store.dart`, `api.dart`, `cloud.dart` - menu / More entries, Plugins > Open, plugin favorites and their cloud sync
- `flutter_ui/pubspec.yaml` - adds `webview_flutter` / `webview_flutter_android` (trailer player); run `flutter pub get`
- `backend/plugin_install.h` - a zip may contain `screen.py` instead of `ui.js`
- `plugins/tmdb-discover/{screen.py,plugin.json}` - the port (1.6.0)
