# Writing Hesper plugins

Plugins live in `plugins/<id>/`. Anything that is not bundled with Hesper runs **sandboxed**.

## plugin.json (declares what the plugin may do)

```json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "permissions": {
    "network": ["api.example.com", "*.cdn.example.com"],
    "storage": true
  }
}
```

- `network`: https host names only (no IP addresses, no `localhost`). `*.x.com` matches subdomains.
- `storage`: a small private key/value store, plus read access to `plugins/<id>/data/`.
- No permission listed means no access.

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
| `ui.card / listRow / button / text / heading / column / row` | | Building blocks. Text only, no HTML. |

See `plugins/sample_counter/` for a working example.

## Backend (`backend.py`, optional)

Must pass an automatic scan and then runs with a limited host API:

- Allowed imports: `json re math datetime time collections itertools functools string textwrap html urllib.parse base64 hashlib random statistics decimal fractions typing dataclasses enum copy operator unicodedata`, your own `.py` files in the same folder, and `hesper_host`.
- Not allowed: `eval exec compile open getattr setattr __import__`, any attribute starting with `_`, `os sys subprocess socket ctypes ...`, native or compiled files.
- `import hesper_host as h` gives you `h.fetch_text(url)`, `h.fetch_json(url)`, `h.write_json(name, obj)`, `h.read_json(name)` (also `*_text`). Network and storage obey `plugin.json`.
- `run()` is called once, with a 10 second limit.

Plugins that ship with Hesper (`weather`) keep full access. To trust a plugin you wrote yourself while developing:
`HESPER_TRUSTED_PLUGINS=my_plugin` (backend) and, in the browser console,
`localStorage.setItem('hesper-trusted-plugins', '["my_plugin"]')` (UI).

## Remote access

Hesper only answers the device it runs on. To open it to other devices on your network:
`HESPER_BIND=0.0.0.0 HESPER_TOKEN=choose-a-secret`, then open `http://<device-ip>:8080/?token=choose-a-secret`.

## Installing a plugin from a .zip

In the app: **Plugins tab -> Install plugin from .zip**, pick the file, check the permissions Hesper
shows, and confirm. To remove an installed plugin, hold its row in the Plugins tab. Plugins that ship
with Hesper (`weather`, `sample_scraper`, `sample_counter`) can't be replaced or removed.

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
