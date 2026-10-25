# Cable Shot

A third-party TV directory for the channels bundled inside it. Pick a channel to see what is on now, how long is left, what is up next
and what follows, then watch it live in PEK TV's own player. Search finds channels by name, or a show by title.

While a channel plays, a **GUIDE** tab sits on the right edge of the picture (press **Right** on the remote, or tap it). It shrinks the
picture into the top left corner and opens a TV guide: the highlighted channel's programme and description next to the picture, the
channels going down below it with what is on now and what follows. OK tunes a channel; Left or Back closes the guide.

This is the Python version of the old web plugin. Install: Plugins -> Install from .zip -> `cable-shot.zip`, read the warning and the
permissions (`live`, `epg`, `storage`, and the guide / logo hosts) and confirm. A **Cable Shot** entry appears in the menu.

## Where things come from

- `playlists/*.json`: the channels, shipped inside the plugin (stream, group, guide id, logo). `playlists/index.json` lists them and
  the guide addresses.
- The guide: the "cable guide" XMLTV files in `index.json` (`epg.urls`). They are read when the plugin opens and again when what is
  stored is more than 6 hours old (by the Cable Shot tab or, if you only use the player, by the player's guide). Only the channels
  this plugin has are kept, 3 hours back to 24 hours ahead, stored in the plugin's `data/` folder. Settings has **Reload the guide now**.

## For the developer

- `screen.py` the tab, `live.py` the player's questions, `cable_core.py` channels + guide shared by both (they run in separate sessions
  and share `data/`).
- To change channels, replace the files in `playlists/` (format: `{"c": [[name, stream, group, guide id, logo], ...]}`) and list them in
  `index.json`. Limits: 8 MB / 200 files per plugin, 2 MB per file, http(s) streams only, nothing on this device. Pictures only load from
  hosts under `permissions.network`.
- Tests: `python3 tools/test_cable_shot.py`.

Only add streams you have the right to use.
