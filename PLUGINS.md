# Writing PEK TV plugins

Plugins live in `plugins/<id>/`. Anything that is not bundled with PEK TV runs **sandboxed**.

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
- `library`: lets the plugin's **Python backend** call `pek_host.library_titles()` (titles and years only, never file names or folders). The install screen tells the user.
- No permission listed means no access.
- `ui` (optional, only changes PEK TV's own screens): `navTab` adds a sidebar / More entry that opens the plugin; `reloadOnInstall` reloads the app right after installing; `closeOnRemove` makes PEK TV ask the user to close and reopen it after the plugin is removed (it cannot be dismissed until the app is really closed). The install and remove screens say so.
- `warning` (optional): a screen shown **before** the permissions screen when someone installs your plugin. Use it for disclaimers or advice you want every user to see. The user can cancel from it; "continue" moves on to the normal install screen. Plain text only (no HTML or links). Leave it out and no extra screen is shown.

  ```json
  "warning": {
    "title": "Before you install",
    "text": ["First paragraph (max 400 characters).", "Second paragraph (up to 5 in total)."],
    "button": "I understand, continue"
  }
  ```

  `title` (max 60) and `button` (max 40) are optional and default to the text above. Shortcuts: `"warning": "one paragraph"` or `"warning": ["para 1", "para 2"]`.

## Backend (`backend.py`, optional)

Must pass an automatic scan and then runs with a limited host API:

- Allowed imports: `json re math datetime time collections itertools functools string textwrap html urllib.parse base64 hashlib random statistics decimal fractions typing dataclasses enum copy operator unicodedata`, your own `.py` files in the same folder, and `pek_host`.
- Not allowed: `eval exec compile open getattr setattr __import__`, any attribute starting with `_`, `os sys subprocess socket ctypes ...`, native or compiled files.
- `import pek_host as h` (the older name `hesper_host` also works) gives you `h.fetch_text(url)`, `h.fetch_json(url)`, `h.write_json(name, obj)`, `h.read_json(name)` (also `*_text`). Network and storage obey `plugin.json`.
- `h.library_titles()` (needs `"library": true`) returns `[{"title", "year", "kind": "movie" | "tv"}]` from the library scanner's last saved list, one entry per movie and per show. The list is only as fresh as the last scan, and backends run once at startup.
- `run()` is called once, with a 10 second limit.

Plugins that ship with PEK TV are **official** and are listed above a separator in the Plugins tab (third-party ones are listed below it). `weather` keeps full access; `tmdb-discover` is official but still runs sandboxed, and is the only kind of plugin allowed to use PEK TV's built-in TMDb access (a proxy that holds PEK TV's key, so users never enter one). Installing a .zip whose `plugin.json` lists that proxy host is refused. To trust a plugin you wrote yourself while developing:
`PEK_TRUSTED_PLUGINS=my_plugin` (backend).

## Remote access

PEK TV only answers the device it runs on. To open it to other devices on your network:
`PEK_BIND=0.0.0.0 PEK_TOKEN=choose-a-secret`, then open `http://<device-ip>:8080/?token=choose-a-secret`.

## Installing a plugin from a .zip

In the app: **Settings -> Plugins -> Install plugin from .zip**, pick the file, check the permissions PEK TV
shows, and confirm. To remove an installed plugin, hold its row in the Plugins tab. Plugins that ship
with PEK TV (`weather` and `tmdb-discover`; the ids `sample_scraper` and `sample_counter` are also reserved) can't be replaced or removed.

The zip must contain `plugin.json` (with a `"flutter": {"screen": "screen.py"}` entry) and `screen.py` (a plugin that only has a `ui.js` is no longer accepted), either at the top of the zip or inside one folder
(the folder name becomes the plugin id: lowercase letters, digits, `-` and `_`). Installed plugins are sandboxed:

- allowed files: `.json .css .md .txt .png .jpg .jpeg .gif .webp .ico .woff .woff2 .ttf .otf`, and `.py` for the backend
- a `backend.py` is not trusted: it only runs if `plugin.json` declares its permissions and the code passes the
  safety scan described under "Backend" above, and then it can only use the hosts it declared and its own `data/`
  folder. It starts the next time PEK TV starts, so restart PEK TV after installing one. If the scan refuses it,
  the reason is printed in PEK TV's log (`[PEK TV Plugin Guard] REFUSED ...`).
- limits: 200 files, 2 MB per file (200 KB per `.py`), 8 MB in total, no hidden files, no `..` in paths
- installing again with the same id updates the plugin and keeps its `data/` folder

On Android the plugins folder is private to the app, so this is the way to add plugins. On a computer or
Termux you can still drop a folder into `plugins/` yourself. A build that must not install code from files
(for example a store build) can start with `PEK_ALLOW_PLUGIN_BACKEND=0`, which refuses `.py` files.


## Backing plugins up to PEK Cloud

When you are signed in (Settings -> Cloud Sync), plugins you installed from a .zip are backed up to your account
automatically; switch it off with **Back up my plugins**. Built-in plugins are not backed up, and neither is a
plugin's `data/` folder. On another device (or after reinstalling PEK TV) the same screen lists your backed-up
plugins. **Restore** opens the usual install screen with the plugin's permissions, runs the same server checks and
safety scan as a .zip, and installs only after you confirm. A plugin is never installed or replaced by itself, and
removing a plugin on one device only stops it being offered on the others.

## The `torrent` permission

```json
"permissions": { "network": ["api.themoviedb.org"], "torrent": true }
```

A plugin with `"torrent": true` may call, from its UI code:

- `pek.torrent.info()` -> `{available}` (is the engine built in)
- `pek.torrent.play({source, title, season, episode, kind, name, year, image})` -> resolves once the player is open.
  Optional `kind` (`'movie'` or `'episode'`) plus `name` (the movie title, or the show name for an episode; episodes also need `season` and `episode`) and `year` (movies) make PEK TV keep the position under Resume Watching. Resuming starts the same release again at that spot. `image` is an optional https poster URL from a host in the plugin's `network` list. PEK TV itself records which plugin started the stream (the plugin cannot set or change this) and shows it on the Resume Watching card. A plugin that gives no `kind`/`name` is still remembered, under the `title` it passed.
  PEK TV shows its own buffering box (with Cancel) and opens the player when enough is downloaded.

What the plugin does NOT get: the search provider's address or API key (set by the user in Settings >
Torrents and kept in PEK TV), the downloaded files, or any other PEK TV API. `source` must be a
`magnet:?` link or a `source` value returned by `search()`. The install screen lists this permission.

Playing a pasted magnet link is not built into the app: a normal plugin using this permission does that. No such plugin is included in this repository.

PEK TV ships with no search provider. The engine (libtorrent) is optional at build time: without it,
`search` still works and `play` fails with "not built in".


## Favorites, provider buttons and plugin launching

A plugin does these from its Python screen with the `favorites`, `providers` and `plugins` permissions (`ui.favorite_add`,
`ui.provider_button`, `ui.open_plugin`, `def on_launch(intent)`). See `FLUTTER_PLUGINS.md`. The streaming services and their
Android packages are listed in `tools/providers.json`; run `node tools/sync_providers.js` after editing it.

## Publishing your plugin on GitHub (for developers)

Users can install a plugin straight from a public GitHub repository: **Settings -> Plugins -> Install from GitHub**,
then type `owner/repo` (a pasted github.com link works too). PEK TV keeps no list of repositories, so there is
nothing to submit anywhere. To make yours installable:

1. Put `plugin.json` and `screen.py` at the top of your plugin's zip, or inside one folder (same rules as a .zip install).
2. Make a **GitHub Release** and attach the zip as a release file (an `.zip` asset up to 8 MB). PEK TV installs the
   *latest* release. With no .zip file attached it can offer the release's source code instead, but then the
   plugin files must be at the top of the repository.
3. Keep your plugin's folder name or `plugin.json` name the same across versions, so an update replaces the old one.

Plugins installed this way show as **unverified** in the Plugins tab and on the install screen, which names the
repository, the version and its size, and says PEK TV did not review it. They get no extra trust: the same
sandbox, safety scan and permissions screen apply. The developer of a plugin is responsible for it.

A build that must not install from GitHub can start with `PEK_ALLOW_GITHUB=0`; people can also switch it off
under Settings -> Plugins -> Allow installs from GitHub.
