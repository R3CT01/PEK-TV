# PEK TV skins

A skin changes how PEK TV looks: its colours and its corner size.
A skin can't run code, can't contain CSS and can't reach the network.

## Installing and removing

- **Install:** Settings → Appearance → *Install skin from .zip*, then pick the .zip.
  PEK TV shows the skin's name, author, version and description before it installs anything.
- **From GitHub:** Settings → Appearance → *Install skin from GitHub*, then type `owner/repo` (a pasted github.com link
  works too). PEK TV uses the repository's latest release `.zip` (up to 8 MB), or its source code if it has no
  release, and then shows the same details and confirm screen as a .zip install. A skin that came from GitHub is
  labelled "unverified" in the Skins list. The same *Install from GitHub* switch (Settings → Plugins and skins from GitHub) turns it off.
  The repository must hold a skin (`skin.json`), the same layout as the zip below.
- **Use it:** tap the skin in the Appearance list.
- **Remove:** hold the skin's row (OK on a remote, or a long press on a phone), then confirm.
  The skins that ship with PEK TV (PEK Ember, Cream, Night red, Green, Neon) can't be removed.
- **A zip is a plugin or a skin, never both.** Installing a skin zip as a plugin, or a plugin
  zip as a skin, fails with a message that says which one it is.

## The zip

```
my-skin.zip
└── my-skin/            (the folder is optional; skin.json can also sit at the top of the zip)
    ├── skin.json       (required)
    └── images, fonts   (optional)
```

The folder name (or, without a folder, the skin's name) becomes the skin's id, so installing
a zip with the same id again updates the skin.

## skin.json

```json
{
  "name": "Sunset",
  "author": "PEK TV",
  "version": "1.0.0",
  "description": "Warm dusk colours with soft rounded corners.",
  "tokens": {
    "bg": "#1a0f14",
    "text": "#fff1e8",
    "accent": "#ffb347",
    "radius": "14px"
  }
}
```

| Field | Required | Shown in |
|---|---|---|
| `name` | yes | the Appearance list and the install screen |
| `author` | no | "by …" in the Appearance list and the install screen |
| `description` | no | the Appearance list and the install screen |
| `version` | no | the Appearance list and the install screen |
| `tokens` | no | colours and the corner size (`radius`); see the bundled `skins/neon/skin.json` for every token. The app draws the colours and `radius`; other tokens are checked but not drawn |
| `tokens.bgImage` | no | accepted and checked (a plain CSS gradient, no `url()`), but **not drawn** by the Flutter app, which has no background image |

## No CSS

A skin is its colours and its corner size, nothing more. **A skin that contains a `skin.css` (any `.css` file) is refused**: by
Install skin from .zip / GitHub in the app, by the server, by `SkinBuilder` and by
`tools/make_skin.py`. The message is "skins can't contain CSS (skin.css): a skin is colours and a corner size only. Remove the .css
file and try again."

## Allowed files and limits

`json`, `md`, `txt`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `ttf`, `otf`.
No code of any kind (`.js`, `.py`, `.html`, `.svg`). Up to 60 files, 2 MB per file, 6 MB in total.
The server (`backend/skin_install.h`) checks all of this again, so a hand-made request gets no
more than the app does.

## Making a skin in the Flutter app

The Skin maker is **PEK's official, bundled plugin `skin-maker`** (`plugins/skin-maker`, with its own icon). It is no longer
built into the app. Settings → Appearance → **Make a skin** (or Plugins → Skin Maker → Open) opens it. Pick a starting look,
change the accent, background, cards and text (the rest of the colours follow them; **More colours** sets each one by hand), set
the corner size, name it and save. A made skin appears in the Appearance list next to the built-in ones, and every profile can choose it.

- **From one accent colour** makes a whole skin from one colour (dark or light) or one hue.
- **Hold** any skin in the Appearance list to use it, edit it, start a new one from it, copy it as a `skin.json`, or delete it.
  Edit / "Make my own from this" open the plugin on that skin.
- **Copy skin.json** gives a `skin.json` you can install from a .zip (put it in a folder and zip it).
- **Paste skin.json** opens a `skin.json` made elsewhere in the maker, ready to save. Only the name, description and
  colours are used.
- A colour that would make the text hard to read on the background, the cards or the bars is refused
  (in the plugin, and again by the app before it stores anything).

It cannot be removed, and it updates from the PEK Store's Official shelf like Weather and TMDb Discover. The plugin only describes
the screen; it asks the app to save, use or delete a skin through the `skins` permission, which only this official plugin may use.
See FLUTTER_PLUGINS.md ("Skin Maker").

## Making skins from code

Two ways, both giving the same `skin.json` / .zip, so a skin made either way installs in the app.

**1. From the command line: `tools/make_skin.py`** (Python 3, no packages). It works out the colours you leave out, refuses
text that is hard to read, runs the same checks as `backend/skin_install.h`, and packs `my-skin/skin.json` into a .zip. It does **not** accept a `skin.css` (PEK TV draws a skin from its colours and corner size only): `--css` is gone, a `"css"` field in a batch file is an error, and `validate` refuses a zip that contains a `skin.css`.

```
# four colours, the rest follows
tools/make_skin.py new --name Sunset --bg '#1a0f14' --surface '#2a1820' --text '#fff1e8' --accent '#ffb347' --radius 14

# one accent is enough (dark by default, --light for a light skin); a hue works too; --glow adds a bgImage glow that the app checks but does not draw
tools/make_skin.py new --name Ocean --accent '#38bdf8'
tools/make_skin.py new --name Moss --hue 140 --light

# many skins from one JSON list, then check one
tools/make_skin.py batch skins.json --out dist/
tools/make_skin.py validate dist/sunset.zip
```

`--print` shows the skin.json without writing a file, `--folder` writes a skin folder instead of a .zip, `--file image.png` adds an
extra file, `--force` allows low-contrast text. A batch file is a list of
`{"name", "accent", "bg", "surface", "text", "radius", "mode", "hue", "glow", "tokens": {...}}`.

**2. By hand**: write `skin.json` as above.

## Installing skins in the Flutter app

Settings > Appearance has **Install skin from .zip** and **Install skin from GitHub**. They use the zip picker plugins use (this
device, library folders and network folders), the GitHub lookup (latest release `.zip`, else the source code), the checks in
`flutter_ui/lib/src/skin_install.dart` (mirroring `backend/skin_install.h`) and a confirm screen. A skin from GitHub is labelled "unverified". Installing the same
skin again updates it; hold it in the list to remove it.

Notes: an installed skin gives the app its **colours and corner size** only (`bgImage` and the glass tokens are checked but
not drawn). A skin with no colours or radius in `skin.json` is refused there. The skin is kept on the device (not in the server's `skins/` folder).

## Skins in the cloud (per profile)

When a cloud account is signed in, each profile's skins are saved to the account: the ones made in the Skin maker (or pasted
from a skin.json) and the ones installed from a .zip or GitHub, plus which skin the profile has chosen. Nothing to switch on: the
normal sync (at start, every 5 minutes after a change, and when a profile is opened) sends a new, changed or deleted skin.

- **Per profile.** Every profile has its own list of skins; one profile's skins are not in another's. (Before this, all profiles on a
  device shared one list; a profile that was using one of those skins keeps that skin.) The built-in skins are the same for everyone.
- **Restore.** Signing in on a new device, or again after signing out, brings back every skin and the chosen skin of each profile
  when the profile is opened (signing out removes them from the device; the cloud keeps them).
- **Newest wins.** Changing the same skin on two devices keeps the newer change. Deleting a skin deletes it on the other devices too,
  unless it was changed after the delete.
- **What is stored:** the name, author, version, description, the colours, the corner size and, for an installed skin, where it came
  from (GitHub skins stay labelled "unverified"). Up to 50 skins per profile. Nothing else from a skin zip is kept in the cloud.
- **Needs the new worker:** redeploy `cloud/worker.js` first (see cloud/DEPLOY.md). Until then the skins stay on the device and are
  sent once the worker is updated.
