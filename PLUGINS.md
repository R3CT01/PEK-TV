# Writing Hesper plugins

Plugins live in `plugins/<id>/`. Anything that is not bundled with Hesper runs **sandboxed**.

## plugin.json (declares what the plugin may do)

```json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "permissions": {
    "network": ["api.example.com", "*.cdn.example.com"],
    "storage": true,
    "library": true
  },
  "ui": { "navTab": "Discover", "reloadOnInstall": true, "closeOnRemove": true }
}
```

- `network`: https host names only (no IP addresses, no `localhost`). `*.x.com` matches subdomains. Poster art and the YouTube player (`ui.video`) are only allowed from hosts listed here.
- `storage`: a small private key/value store, plus read access to `plugins/<id>/data/`.
- `library`: lets the plugin's **Python backend** call `hesper_host.library_titles()` (titles and years only, never file names or folders). The install screen tells the user.
- No permission listed means no access.
- `ui` (optional, only changes Hesper's own screens): `navTab` adds a sidebar / More entry that opens the plugin; `reloadOnInstall` reloads the app right after installing; `closeOnRemove` makes Hesper ask the user to close and reopen it after the plugin is removed (it cannot be dismissed until the app is really closed). The install and remove screens say so.
- `warning` (optional): a screen shown **before** the permissions screen when someone installs your plugin. Use it for disclaimers or advice you want every user to see. The user can cancel from it; "continue" moves on to the normal install screen. Plain text only (no HTML or links). Leave it out and no extra screen is shown.

  ```json
  "warning": {
    "title": "Before you install",
    "text": ["First paragraph (max 400 characters).", "Second paragraph (up to 5 in total)."],
    "button": "I understand, continue"
  }
  ```

  `title` (max 60) and `button` (max 40) are optional and default to the text above. Shortcuts: `"warning": "one paragraph"` or `"warning": ["para 1", "para 2"]`.

## UI (`ui.js`)

Runs in a sandboxed iframe: no access to the page, Hesper's API, cookies or storage.
You get one global, `hesper`:

| Call | Needs | What it does |
|---|---|---|
| `hesper.render(ui => tree)` | | Draw the screen. Re-runs after taps and `requestRender()`. |
| `hesper.requestRender()` | | Redraw after your own async work. |
| `hesper.fetchText(url)` / `fetchJSON(url)` | `network` | HTTPS GET of an allowed host (1 MB, 8 s limit, no redirects). |
| `hesper.storage.get/set/remove` | `storage` | Private store (256 KB total). |
| `hesper.readData(name)` / `readJSON(name)` | `storage` | Read `data/<name>` written by the backend. |
| `ui.card / listRow / button / text / heading / column / row` | | Building blocks. Text only, no HTML. `ui.button(label, fn, {primary, selected})`. |
| `ui.posterCard(title, sub, posterUrl, fn, {badge})` | `network` for the poster's host | Poster tile like the library grid. The image loads only from an https host listed in `network`; otherwise a plain card is shown. `badge` is a short label drawn on the poster. |
| `ui.grid(children, {minColWidth, scroll})` | | Responsive poster grid. `scroll: true` makes one sideways-scrolling row. `minColWidth` like `'150px'`. |
| `ui.tabs([{id, label}], activeId, id => ...)` | | Tab strip; the callback gets the tapped id. |
| `ui.textInput(label, value, text => ..., {placeholder, type, onSubmit})` | | Text box (`type: 'password'` hides it). The first callback runs on every keystroke and does not redraw; `onSubmit(text)` runs on Enter and redraws. Typing and scroll position survive redraws. |
| `ui.spinner(text, big)` | | Loading wheel with an optional label. `big: true` makes it larger. |
| `ui.toggle(label, checked, v => ...)` | | On/off switch. The callback gets `'true'` or `'false'`. |
| `ui.video({id, autoplay, muted, title})` | `network` listing `www.youtube-nocookie.com` | A YouTube player (`id` is the 11-character video id). Hesper pins it to the top of the screen and does not restart it when the screen redraws. One per screen. |
| `{autofocus: 'key'}` on `ui.button` / `ui.posterCard` | | Where the remote's highlight lands when the screen first shows. Use a different key for each screen; Hesper returns to the previously highlighted item when you come back. |
| `hesper.setBack(fn)` / `hesper.setBack(null)` | | Make Back (Esc, the remote's Back, the window's Back button) call `fn` first, so a plugin can step out of its own screens. Pass `null` when there is nothing to step out of; Back then closes the plugin. |
| `hesper.scrollTop()` | | Scroll the plugin screen back to the top (after changing page, say). |

See `plugins/sample_counter/` for a small example and `plugins/tmdb-discover/` for a full one (rows, numbered pages, search, provider chips, trailer, cast, library badges).

## Backend (`backend.py`, optional)

Must pass an automatic scan and then runs with a limited host API:

- Allowed imports: `json re math datetime time collections itertools functools string textwrap html urllib.parse base64 hashlib random statistics decimal fractions typing dataclasses enum copy operator unicodedata`, your own `.py` files in the same folder, and `hesper_host`.
- Not allowed: `eval exec compile open getattr setattr __import__`, any attribute starting with `_`, `os sys subprocess socket ctypes ...`, native or compiled files.
- `import hesper_host as h` gives you `h.fetch_text(url)`, `h.fetch_json(url)`, `h.write_json(name, obj)`, `h.read_json(name)` (also `*_text`). Network and storage obey `plugin.json`.
- `h.library_titles()` (needs `"library": true`) returns `[{"title", "year", "kind": "movie" | "tv"}]` from the library scanner's last saved list, one entry per movie and per show. The list is only as fresh as the last scan, and backends run once at startup.
- `run()` is called once, with a 10 second limit.

Plugins that ship with Hesper are **official** and are listed above a separator in the Plugins tab (third-party ones are listed below it). `weather` keeps full access; `tmdb-discover` is official but still runs sandboxed, and is the only kind of plugin allowed to use Hesper's built-in TMDb access (a proxy that holds Hesper's key, so users never enter one). Installing a .zip whose `plugin.json` lists that proxy host is refused. To trust a plugin you wrote yourself while developing:
`HESPER_TRUSTED_PLUGINS=my_plugin` (backend) and, in the browser console,
`localStorage.setItem('hesper-trusted-plugins', '["my_plugin"]')` (UI).

## Remote access

Hesper only answers the device it runs on. To open it to other devices on your network:
`HESPER_BIND=0.0.0.0 HESPER_TOKEN=choose-a-secret`, then open `http://<device-ip>:8080/?token=choose-a-secret`.

## Installing a plugin from a .zip

In the app: **Settings -> Plugins -> Install plugin from .zip**, pick the file, check the permissions Hesper
shows, and confirm. To remove an installed plugin, hold its row in the Plugins tab. Plugins that ship
with Hesper (`weather`, `sample_scraper`, `sample_counter`, `tmdb-discover`) can't be replaced or removed.

The zip must contain `plugin.json` and `ui.js`, either at the top of the zip or inside one folder
(the folder name becomes the plugin id: lowercase letters, digits, `-` and `_`). Installed plugins are sandboxed:

- allowed files: `.js .json .css .md .txt .png .jpg .jpeg .gif .webp .ico .woff .woff2 .ttf .otf`, and `.py` for the backend
- a `backend.py` is not trusted: it only runs if `plugin.json` declares its permissions and the code passes the
  safety scan described under "Backend" above, and then it can only use the hosts it declared and its own `data/`
  folder. It starts the next time Hesper starts, so restart Hesper after installing one. If the scan refuses it,
  the reason is printed in Hesper's log (`[Hesper Plugin Guard] REFUSED ...`).
- limits: 200 files, 2 MB per file (200 KB per `.py`), 8 MB in total, no hidden files, no `..` in paths
- installing again with the same id updates the plugin and keeps its `data/` folder

On Android the plugins folder is private to the app, so this is the way to add plugins. On a computer or
Termux you can still drop a folder into `plugins/` yourself. A build that must not install code from files
(for example a store build) can start with `HESPER_ALLOW_PLUGIN_BACKEND=0`, which refuses `.py` files.


## Backing plugins up to Hesper Cloud

When you are signed in (Settings -> Cloud Sync), plugins you installed from a .zip are backed up to your account
automatically; switch it off with **Back up my plugins**. Built-in plugins are not backed up, and neither is a
plugin's `data/` folder. On another device (or after reinstalling Hesper) the same screen lists your backed-up
plugins. **Restore** opens the usual install screen with the plugin's permissions, runs the same server checks and
safety scan as a .zip, and installs only after you confirm. A plugin is never installed or replaced by itself, and
removing a plugin on one device only stops it being offered on the others.

## The `torrent` permission

```json
"permissions": { "network": ["api.themoviedb.org"], "torrent": true }
```

A plugin with `"torrent": true` may call, from its UI code:

- `hesper.torrent.info()` -> `{available, configured}` (is the engine built in, is a provider set)
- `hesper.torrent.search({kind: 'movie' | 'episode', title, year, season, episode})` -> array of
  `{title, source, sizeText, seeders, quality, pack}`, best first
- `hesper.torrent.play({source, title, season, episode, kind, name, year, image})` -> resolves once the player is open.
  Optional `kind` (`'movie'` or `'episode'`) plus `name` (the movie title, or the show name for an episode; episodes also need `season` and `episode`) and `year` (movies) make Hesper keep the position under Resume Watching. Resuming starts the same release again at that spot. `image` is an optional https poster URL from a host in the plugin's `network` list. Hesper itself records which plugin started the stream (the plugin cannot set or change this) and shows it on the Resume Watching card. A plugin that gives no `kind`/`name` is still remembered, under the `title` it passed.
  Hesper shows its own buffering box (with Cancel) and opens the player when enough is downloaded.

What the plugin does NOT get: the search provider's address or API key (set by the user in Settings >
Torrents and kept in Hesper), the downloaded files, or any other Hesper API. `source` must be a
`magnet:?` link or a `source` value returned by `search()`. The install screen lists this permission.

Hesper ships with no search provider. The engine (libtorrent) is optional at build time: without it,
`search` still works and `play` fails with "not built in".


## Favorites, provider buttons and plugin launching

Four optional permissions (`"permissions": {"favorites": true, "providers": true, "plugins": true, "watched": true}`):

| Call | Needs | What it does |
|---|---|---|
| `hesper.favorites.list()` | `favorites` | Resolves to `['movie:603', 'tv:1396', ...]`: the shared Favorites list shown in Hesper's Favorites tab. |
| `hesper.favorites.add({type, id, title, year, posterPath})` / `.remove('movie:603')` | `favorites` | `type` is `'movie'` or `'tv'`, `id` the TMDb id, `posterPath` TMDb's `poster_path` (e.g. `/abc.jpg`). Hesper builds the poster address itself and records which plugin added the title, so Favorites can open it there. |
| `hesper.watched.check(items)` | `watched` | Resolves to `[true, false, ...]`, one per item: is it marked watched in Hesper's Watch History. An item is `{kind: 'movie', title, year}` or `{kind: 'episode', showTitle, season, episode}` (max 300 per call). |
| `hesper.watched.set(item, true \| false)` | `watched` | Marks the item watched or unwatched. Same history the user sees (and that syncs), so it also shows in the library. Plugins that stream with `hesper.torrent.play({kind, name, season, episode, year})` are marked automatically when playback finishes. |
| `ui.providerButton({name, logo, title, type, tmdbId, region})` | `providers` | A "Watch on <service>" button. `name` and `logo` are TMDb's `provider_name` and `logo_path`. Hesper decides what it opens (the service's app on Android, its website elsewhere; unknown services open the title's TMDb "where to watch" page). The logo loads only if `image.tmdb.org` is in `network`. No callback. |
| `hesper.plugins.streamers()` | `plugins` | `[{id, name}]` of the other installed plugins whose plugin.json has `"provides": {"stream": true}`. |
| `hesper.plugins.open(id, {type, id, title, year})` | `plugins` | Opens that plugin on the title. Only works inside a tap handler. |
| `hesper.onLaunch(fn)` | | `fn({type, id, title, year})` runs when Hesper (the Favorites tab or another plugin) opens this plugin on a title. It can arrive before your first screen is ready; keep it and handle it when you are. |

Services and their Android packages are listed in `www/providers.js`. On Android run `node tools/sync_providers.js` after editing it
(it regenerates the allow-list in `MainActivity.kt` and the `<queries>` in `AndroidManifest.xml`).

## Up next (optional): `hesper.onNextEpisode`

Near the end of an episode your plugin started, PEK's player can offer the next one on the right side of the screen. PEK looks in the
user's own library folders first; if the next episode is not there, it asks the plugin the episode came from (only plugins that started
the stream with `kind: 'episode'` and a `name`, which PEK records as the stream's origin).

```js
hesper.onNextEpisode(function (req) {
    // req = { phase: 'check' | 'play', showTitle, season, episode }
    // 'check': season/episode = the one that was playing. Resolve { ok: true, season, episode, name } for the NEXT episode,
    //          only if it has aired and you have a stream for it. Resolve { ok: false } otherwise (no card is shown).
    //          This runs a few minutes before the end, so do the searching here and keep the result.
    // 'play':  season/episode = the one to start (PEK has already closed the player). Call hesper.torrent.play(...)
    //          and resolve { ok: true } once it started, or { ok: false, error } if it did not.
});
```

Needs the `torrent` permission to play anything. A plugin that does not call `onNextEpisode` simply gets no card. Answers are
size-limited by PEK (name 120 characters) and a plugin that does not answer within a minute counts as "no".
