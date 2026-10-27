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
| ratings (`watched`) | `ui.ratings()` -> `[{kind, title, year, season, episode, rating 1-10, at}]` (the open profile's ratings; `kind` is `movie`, `episode` or `show`, and an episode's or show's `title` is the show's title); `ui.set_ratings_many(items)` with items `{kind (movie by default), title, year, season, episode, rating, at}` (rating 0 removes it, `at` = seconds since 1970, max 300). `ui.rating_stars(kind, title, year=0, season=0, episode=0, plain=False)` (plain is accepted and ignored) returns a ready-made "rate this" control (ten stars side by side on one line, no numbers, tap the current one to clear) for a detail page, with no state to keep. A hook with the `playback` permission also gets a `rated` event: `{type: "rated", items: [{kind, title, year, season, episode, rating}]}` (0 = removed). Ratings are per profile and sync to PEK Cloud; a rating a plugin sets is not sent back to that plugin. |
| favorites (`watched`) | `ui.favorites()` -> `[{kind ("movie" or "show"), title, year, tmdb}]` (the open profile's favorite movies and shows, library and plugin favorites together; `tmdb` is 0 when unknown); `ui.set_favorites_many(items, value=True)` adds (False removes) favorites: items `{kind, title, year, tmdb, at}`. A title the library has becomes a library favorite; one it does not have is kept as a plugin favorite through `tmdb`. With value False, `at` is "the time I last looked" (seconds since 1970) and a favorite changed here after it is kept. A hook with `playback` gets `{type: "favorited", value: bool, items: [{kind, title, year, tmdb}]}`. A change a plugin makes is not sent back to that plugin. |
| removals (`watched`) | `ui.set_watched_many(items, False)`: with value False an item's `at` is "the time I last looked"; a title finished in PEK TV after that time stays watched. |
| profile (`storage`) | `ui.profile()` -> the open profile's id (string), for plugins that keep one account or setting per profile; see "Profiles" under Hooks |
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

**Trailers.** `ui.video` (needs `www.youtube-nocookie.com` under `permissions.network`) shows the trailer in an Android web view that can only load that host (any other
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

## Hooks: plugins that react to playback (`playback` and `send` permissions)

A screen only runs while it is open. Some plugins have to act while the person watches (scrobbling to Trakt, Last.fm, a presence
display), so a plugin can also have a **hooks file**:

```json
"permissions": { "network": ["api.example.com"], "storage": true, "send": true, "playback": true },
"flutter": { "screen": "screen.py", "hooks": "hooks.py" }
```

```python
import pek_host as h
import pek_ui as ui

def on_event(ev):        # called by PEK TV, no screen needed; max 25 s; one event at a time per plugin, in order
    ...
```

`ev["type"]` is one of:

| type | when | other fields |
|---|---|---|
| `app_start` | once per run, a few seconds after the shell opens, and again each time another profile is opened | none |
| `tick` | every 3 minutes while the app is open and nothing is playing, and when the app returns to the front (at most once a minute; never while another event for the plugin is still running) | none |
| `play` | the video really runs (first position after buffering) | item + position |
| `pause` / `resume` | the person paused / continued | item + position |
| `stop` | the player closed, or the next episode took over | item + position |
| `watched` | the person marked movies / episodes watched or unwatched | `items` (max 300 of `{kind, title, year, season, episode}`), `value` |
| `profile_removed` | a profile was deleted (here or on another device), or the profiles were replaced by another account's | none (`ui.profile()` is the removed profile's id) |

An item is `kind` (`movie` or `episode`; torrents with no identity are not reported), `title` (for an episode: the **show's** title), `year`,
`season`, `episode`, `position`, `duration` (seconds) and `percent` (0 to 100). `pek_flutter.py` builds the event itself and passes
**only these fields**: never a file name, folder, library id or stream address.

What a hook may do: everything a screen can that needs no screen, i.e. `h.request_json`, `h.read_json` / `h.write_json` (`storage`) and
`ui.set_watched` / `ui.set_watched_many` (`watched`); both take an optional `at` (when it was really watched, seconds since 1970: Watch History shows and sorts by it; without it the time is now, and a time before 2000 or more than a day ahead is ignored). PEK TV also lines a plugin's titles up with the library's own before it stores them (`flutter_ui/lib/src/library_match.dart`): capitals, accents, punctuation, a leading "The" and a closing "(2005)" / "(US)" do not matter, a movie's year may be one off, and the library's title and year are used when exactly one fits. Anything that fits nothing, or fits more than one, is stored as the plugin sent it. The plugin is never shown the library. Other effects (links, favorites, toasts) are dropped. A change a hook makes to
Watch History is **not** reported back to that same plugin, so an import cannot echo to the service it came from.

**Permissions.**

- `playback`: the plugin is told the events above. It needs `"flutter": {"hooks": "hooks.py"}` (and the other way round). The install screen
  says it "runs in the background, even when its screen is closed".
- `send`: `h.request_json(method, url, body=None, headers=None, timeout=10)` becomes available: HTTPS `GET` or `POST` with a JSON body to a host
  in `permissions.network`, with an `Authorization` header allowed (`fetch_text` still drops it). Redirects are never followed, so a header can
  only reach the host the plugin named; the same public-IP pinning, size caps (256 KB out, 2 MB back) and 10 s limit apply. It returns
  `{"status", "data", "page_count", "retry_after"}` and does **not** raise on an HTTP error status, so a plugin can tell "pending" from "denied".

**Profiles.** Every event belongs to the profile that was open when it happened, and `ui.profile()` (`storage`) tells the plugin which: the
profile's id (`p1` for the first one; letters, digits, `_` and `-`, at most 24 characters), never its name. A plugin that keeps something per
profile (Trakt keeps one account per profile) puts the id in its file names. A screen gets the same call for the profile that is open. Marks,
ratings and favorites a hook brings in are applied to the profile the event belonged to: if another profile was opened while the hook ran,
they wait until that profile is open again (kept while the app runs, at most 20 batches). On `profile_removed` the plugin should let go of
what it kept for that profile (Trakt revokes the account and empties its files). A PEK TV older than this has no `ui.profile()`: a plugin that
wants to run there catches the error and treats everything as one profile.

A hooks file is scanned and sandboxed exactly like `screen.py`. The hook session is separate from the screen's session (each imports its own
copy of the plugin's helper modules, so a shared `*_core.py` gets the right `pek_host`); both share the plugin's `data/` folder. Because two
sessions can write the same file, writes use a temp file per thread and a plugin that rotates tokens should re-read `auth.json` before refreshing
(see `trakt_core.refresh`). Updating a plugin reloads its hooks without restarting the app.

Reserved hosts: `hesper-tmdb...` is for `tmdb-discover` only (`RESERVED_HOSTS` in
`pek_flutter.py`); `trakt` is also owner-only in the PEK Store.

The Trakt plugin (`plugin_packages/trakt/`, tests in `tools/test_trakt_plugin.py`) is the reference user of all this.

## Live TV: channels, the TV guide and the guide reader (`live` and `epg` permissions)

A plugin that is a TV directory (`plugin_packages/m3u8/` is the reference) needs three things a normal screen has no
way to do, so the sandbox has them:

```json
"permissions": { "network": ["raw.githubusercontent.com"], "storage": true, "live": true, "epg": true },
"flutter": { "screen": "screen.py", "live": "live.py" }
```

**1. Play a channel in PEK's own player (`live`).** `ui.live_play(url, title, channel)` from a tap handler. The address must be `http://`
or `https://` with a real host: no sign-in in the address, nothing on this device or the home network (`localhost`, `.local`, a private
IP number), at most 2000 characters. Python checks it (`pek_ui._live_url`), `plugin_ui.dart` checks the scheme again. `channel` is the
plugin's own id for the channel. The player is PEK's: the plugin never touches the stream. A live channel has no seek bar and no end; a
stream that fails shows a message instead of closing the player.

**2. The guide in the player (`flutter.live`).** When the plugin ships a live file, the player asks it four questions and draws the answers
itself (`flutter_ui/lib/src/live_tv.dart`). `live.py` defines `on_query(query)`:

| `query["op"]` | extra fields | answer |
|---|---|---|
| `list` | | `{"guide": bool, "refreshing": bool, "channels": [[id, name, group, has_guide], ...]}` |
| `now` | `ids` (up to 200) | `{id: [[start, stop, title] or 0, [start, stop, title] or 0]}`: on now, next |
| `guide` | `ids`, `from`, `to` (seconds since 1970) | `{id: [[start, stop, title, desc], ...]}` (up to 60 each) |
| `url` | `id` | `{"url": ..., "title": ...}`; the address goes through the same checks as `live_play` |

Any other op, or extra fields, never reach the plugin (`pek_flutter._clean_query`). A query may take 12 s and answer at most 1.5 MB. Like a
hooks file it has its **own session** (separate from the screen's), is scanned like `screen.py`, reloads when the plugin is updated, and
can only answer: effects it asks for are dropped. It may call `ui.background(work, done, fail)` to read something in the background
(M3U8 reads its guide that way) and keep module state between queries. The screen and the live file share the plugin's `data/` folder.

What the person sees: while a channel plays, a little **GUIDE** tab sits on the right edge of the picture (press Right on the remote, or
tap it, or use the list button in the controls). It shrinks the picture into the top left corner (`setMiniRect`, the same call the old
mini player used) and opens the guide: details and description of the highlighted channel beside the picture, the channels going down
below it with what is on (progress bar, minutes left) and what follows. Up / Down move, Channel Up / Down jump 8, OK tunes a channel
(OK on the one playing returns to full screen), Left / Back close the guide. With the guide closed, Channel Up / Down (or the
previous / next buttons) switch channel and show a short now / next banner.

**3. Read a TV guide file (`epg`).** `h.fetch_epg(url, want_ids=None, want_names=None, back_hours=3, ahead_hours=36)` downloads ONE XMLTV file
(xml or xml.gz, up to 12 MB, 40 MB unpacked) from a host in `permissions.network` and returns only what the plugin asked for:
`{"programmes": {channel id: [[start, stop, title, desc], ...]}, "names": {channel id: [h.epg_norm names]}, "channels", "kept", "bytes"}`.
`want_ids` are the plugin's guide ids (matched case-insensitively), `want_names` are `h.epg_norm(name)` of its channels: a channel whose id
is not wanted is still kept when one of its display names matches. Titles are cut to 120 characters, descriptions to 240, 80 programmes
per channel. The reader is host code (`pek_epg.py`): it cuts the text with regular expressions and decodes only the standard entities and
numeric references, so a file cannot expand entities or pull anything in. One file per call, so each is its own `ui.background` job.
Use `h.write_json` (1 MB per file) to keep the result in `data/`.

**Also new for plugins**: `h.read_bundled_text(name)` / `h.read_bundled_json(name)` read a `.json` or `.txt` that shipped inside the plugin
(at the top or one folder down, e.g. `playlists/us.1.json`; 2 MB; never `data/`; no permission needed, it is the plugin's own file), and
`ui.tz_offset()` is how far the device clock is ahead of UTC, in seconds, for showing local times (a phone's Python can think it is UTC).

Install screen: `live` -> "Can play live TV streams in PEK TV's player, from web addresses it chooses ... the servers that send a stream
can see your internet address"; `epg` -> "Can download TV guide files (XMLTV) from the sites listed above".

## M3U8 (official, 1.0.0)
`plugin_packages/m3u8/` (zipped as `plugin_packages/m3u8.zip`) takes `.m3u` / `.m3u8` playlists and turns them into a TV directory. It is an official plugin
that is not bundled in the app: the owner publishes it on the PEK Store's Official shelf (`m3u8` is in the store worker's owner-only list, so nobody else can use the id)
and people install it from there. It runs sandboxed; the `live` and `epg` permissions above are open to any plugin.

- **Adding a playlist**: the M3U8 tab, **Playlists -> Add a playlist**. The person types an `https://` address; the plugin downloads it
  (`h.fetch_text`, up to 8 MB, in a `ui.background` job), reads it (`parse_m3u` in `m3u_core.py`: `#EXTINF` attributes `tvg-id`, `tvg-logo`,
  `group-title`, a name that may hold commas, `#EXTGRP`, Kodi style `address|header` suffixes, only http(s) streams, the same stream kept once,
  the playlist's own `url-tvg` / `x-tvg-url` guide addresses) and stores the channels in `data/pl-<id>-<n>.json`, cut below 1 MB. An address that
  turns out to be one HLS stream (a master or media playlist) becomes a one-channel playlist. A playlist can be updated from its address or
  removed (two taps; its files are emptied because a plugin cannot delete files).
- **Where addresses may point**: playlists and guide files load only from hosts in `permissions.network` (GitHub: `raw.githubusercontent.com`,
  `gist.githubusercontent.com`, `*.github.io`); the plugin checks the address first and says so. There is no file picker in the sandbox.
- **The guide**: the default list in `defaults.json` (`pattern` with `{n}` and a `count`, or `urls`), the `url-tvg` of each playlist and the addresses added
  under Settings -> Guide addresses, all read with `h.fetch_epg` and stored as in the Live TV section. The built-in list can be switched off.
- **Screen and player share `data/`**: `lists.json` has a `rev` that changes whenever a playlist or guide address is added or removed, and both sessions
  reload the channels when it changes, so a playlist added on the screen is in the player's channel switcher without restarting.
- Tests: `python3 tools/test_m3u8_plugin.py` (the guide reader, the playlist reader, the screens, the live provider and the sandbox limits).

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
progress -> the author's own `warning` screen (if `plugin.json` has one) -> the permissions screen (plain-language sentences for each permission) -> **Install / Update**. Nothing installs by itself, and uploading is still done on the store's website, not in the app.
After an install or a removal the menu entries and the Plugins page reload (`PluginHost.changed`), any open screen of that
plugin restarts, and the Plugins page shows where each plugin came from ("PEK Store official" / "approved · community store").
A plugin with only a `ui.js` is **no longer accepted** anywhere (store, .zip, GitHub), and neither is any other `.js` / `.mjs` file: a plugin is Python only and needs a `screen.py` and a `"flutter"` entry in `plugin.json`, checked in the app and again by `backend/plugin_install.h`. The server also refuses to serve any `.js` under `/plugins/`. One with a `backend.py` reminds the person to restart
PEK TV once.

Not in the Flutter plugin store: **skins** (the store has a skin shelf; skin install is a separate flow, `skin_install.h`).

## Install from a .zip file or from GitHub
Plugins > **Install from .zip** and **Install from GitHub** (`plugin_install_ui.dart`) are the zip picker and the GitHub
install. Both end on the same install screen as the store
(`PluginInstallPage`: server dry run -> the author's warning -> permissions -> Install), so nothing installs by itself.

- **.zip**: **Choose a file** opens Android's own file picker (`pek/plugins` `pickFile` -> `FlutterHostActivity`, the Storage Access
  Framework: the app is handed just the chosen file, so **no storage permission and no "All files access"** is needed to see .zip
  files). On a device with no system picker (some TV boxes) it says so, and **Browse this device** is PEK TV's own browser, on
  `POST /api/plugins/browse` + `/api/plugins/fetch` (also used for network folders and your media sources; on Android 11+ it only
  lists .zip files once All files access is allowed). `plugin_zip.dart` unpacks it in memory with the same limits as the server
  (2 MB per file, 8 MB total, 400 files, CRC checked, inflate stops at the limit; no ZIP64 / encrypted / split zips). It needs no
  extra package (`dart:io` raw inflate). plugin.json at the top or inside one folder; a zip with `skin.json` is refused.
- **GitHub**: type `owner/repo` or paste a link. `plugin_github.dart` asks `api.github.com` for the latest release (its .zip files
  and its source), or the default branch's source if there is no release; you pick one when there are several. The download goes
  through `POST /api/plugins/github-zip` (backend/github_install.h). A first-time warning is shown once; the switch is Settings >
  *Plugins from GitHub* (`PEK_ALLOW_GITHUB=0` still turns it off in the server). Source zips are
  installed under the repository name so an update replaces the same plugin.
- The Plugins page labels where each plugin came from ("unverified - from GitHub owner/repo", "third party - from a .zip file").
- Not in the zip picker: the system file picker, and finding network devices from inside it (add the device as a media
  source in Settings, then it shows up under the picker's start list). Skins install from Settings > Appearance (see `SKINS.md`).

## Weather (bundled, official): one city for the whole app
The Weather plugin no longer keeps a city of its own. PEK TV's city and unit (the dashboard's Weather widget, the header badge, `s|weather`
in the cloud) are the plugin's too, so a city is typed once. What it needed from the host:
- Permission **`weather`**, reserved: `pek_flutter.OFFICIAL_WEATHER_PLUGINS = {"weather"}`; any other plugin that asks for it is refused when it opens.
- `ui.weather()` -> `{"lat", "lon", "label", "unit"}` (`lat` / `lon` are `None` and `label` is `""` until a city is chosen); `ui.weather_set(lat, lon, label)`
  and `ui.weather_unit("C" | "F")`. The city is sent to Python only through `ui.weather()` (`ui.ctx()` drops it).
- Effect `weather.set`: `plugin_ui.dart` only runs it for `weather`, and checks the numbers and the name again before `Weather.setCity / setUnit`.
- An older PEK TV has none of this: the plugin catches the error and keeps its own city and unit in `data/settings.json`, as version 1.0 did.

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
- `android/app/src/main/python/pek_epg.py` - the XMLTV reader behind `fetch_epg` (host code)
- `flutter_ui/lib/src/live_tv.dart` - live TV in the player: the plugin client, the guide panel, the guide tab
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
- **Built-in plugins** (`weather`, `tmdb-discover`, `skin-maker`, `PluginInstaller.stockIds` / `isReservedId`) cannot be removed: no Remove button, and the
  server refuses (`/api/plugins` now reports `builtin`).
- **Updates** (`plugin_updates.dart`, checked 6 s after start and whenever the Plugins page opens):
  built-in plugins update by themselves from the PEK Store Official shelf (an `official=1` install, the only way the server lets a built-in
  plugin be replaced); plugins installed from GitHub are looked up again on GitHub and an **Update** button (with the permissions screen) appears
  on the Plugins page when the latest release tag differs. The app copies built-in plugins from its own files at every start; it now leaves a
  copy alone when the store's version is newer (`MainActivity.copyAssetDir`).
- **Torrents**: the Torrents page and the in-app release search are gone. The engine (`TorrentApi`, loading screen, `pek_ui.play_torrent`) stays for
  plugins with the `torrent` permission.
