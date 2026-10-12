# Live TV Guide

PEK's official TV directory plugin, installed on request (it is not built into PEK TV). It shows the channels
bundled inside it. Pick a channel to see what is on now,
how long is left, what is up next and what follows, then watch it live in PEK TV's own player.
Search finds channels by name, or a show by title ("when is the match on?").

This official plugin ships WITHOUT any channels. Third-party channel bundles go in **Cable Shot**
(`plugin_packages/cable-shot`), a copy of this plugin that add_m3u.py fills by default. If PEK's owner
wants to ship licensed channels here, add `--plugin live-tv` to the commands below.

## For the developer: adding channels (before you zip)

The channel lists live INSIDE the plugin (`playlists/*.json`), so the stream links stay in it
after it is zipped and installed. Use `add_m3u.py` (next to this folder, not part of the zip):

    python3 add_m3u.py my_channels.m3u              # one list
    python3 add_m3u.py lists/                       # every .m3u / .m3u8 in a folder
    python3 add_m3u.py https://host/list.m3u        # download one first
    python3 add_m3u.py --channel "News 24" https://host/live/index.m3u8 --group News
    python3 add_m3u.py --list                       # what the plugin holds
    python3 add_m3u.py --remove "my_channels"       # remove a list

Every run rebuilds the plugin's zip (`cable-shot.zip`, or `live-tv.zip` with `--plugin live-tv`). Install it with Settings -> Plugins -> Install plugin from .zip.
Adding a list with a name that already exists replaces it.

### Guide (what is on now / next)

Without guide data the plugin still lists and plays channels. For schedules, give it XMLTV data:

- `--epg-file guide.xml` (or `.xml.gz`): copied into the plugin as a snapshot of the next ~3 days, only for
  the channels in your lists (matched by `tvg-id`, then by channel name). Snapshots go stale; re-run to refresh.
- `--epg-url https://host/guide.xml`: loaded live every time the plugin opens (and every 30 min). The plugin
  can read about 1 MB per address, does not read `.gz`, and does not follow redirects. The host is added to
  `plugin.json` "network" for you.

Channel logos are off by default (they come from many hosts). `--logo-hosts 5` allows the 5 most common
https logo hosts in your lists, and turns on logo tiles (Settings -> Show channels as tiles).

### Limits

- 8 MB / 200 files per plugin (the tool warns). About 30,000 channels fit in roughly 4 MB.
- Only `http://` and `https://` streams (not rtmp/rtsp/udp). `|User-Agent=...` style suffixes are removed
  because PEK TV's player cannot send custom headers.
- Streams on this device (`localhost`, `127.x`) are refused.
- HLS plays natively on Android (libmpv). A desktop browser build plays what that browser can.

Only add streams you have the right to use. The stream's server sees the viewer's internet address.

## Publishing it as an official, optional plugin

Official plugins that users install on request live on the PEK Store's **PEK Official** shelf. The owner
uploads `live-tv.zip` there from the owner page (signed in with a GitHub account listed in OWNER_GITHUB; see
`cloud/STORE-DEPLOY.md`). It is deliberately not in PEK TV's built-in plugin list, so it installs and
removes like any other plugin.
