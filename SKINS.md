# PEK TV skins

A skin changes how PEK TV looks: colours, corner radius and, if you want, extra styling.
A skin can't run code and can't reach the network.

## Installing and removing

- **Install:** Settings → Skins → *Install skin from .zip*, then pick the .zip.
  PEK TV shows the skin's name, author, version and description before it installs anything.
- **From GitHub:** Settings → Skins → *Install skin from GitHub*, then type `owner/repo` (a pasted github.com link
  works too). PEK TV uses the repository's latest release `.zip` (up to 8 MB), or its source code if it has no
  release, and then shows the same details and confirm screen as a .zip install. A skin that came from GitHub is
  labelled "unverified" in the Skins list. The same *Allow installs from GitHub* switch (Settings) turns it off.
  The repository must hold a skin (`skin.json`), the same layout as the zip below.
- **Use it:** tap the skin in the Skins list.
- **Remove:** hold the skin's row (OK on a remote, or a long press on a phone), then confirm.
  The skins that ship with PEK TV (PEK Ember, Green, Neon) can't be removed.
- **A zip is a plugin or a skin, never both.** Installing a skin zip as a plugin, or a plugin
  zip as a skin, fails with a message that says which one it is.

## The zip

```
my-skin.zip
└── my-skin/            (the folder is optional; skin.json can also sit at the top of the zip)
    ├── skin.json       (required)
    ├── skin.css        (optional)
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
| `name` | yes | the Skins list and the install screen |
| `author` | no | "by …" in the Skins list and the install screen |
| `description` | no | the Skins list and the install screen |
| `version` | no | the Skins list and the install screen |
| `tokens` | no | colours and sizes, see the bundled `skins/neon/skin.json` for every token |
| `tokens.bgImage` | no | a plain CSS gradient drawn behind the app, like the default Ember look. No `url()`. If a skin sets `bg` and no `bgImage`, its background is flat |

## skin.css (optional)

Normal CSS that is loaded on top of PEK TV's own while the skin is in use. To keep skins safe:

- no `@import`, and no `url()` that points to the network (`https://…`, `//…`) or outside the skin folder
- `url()` may point to a file inside the skin folder, or be a `data:image/…` / `data:font/…` link
- no backslash escapes (they could hide the rules above)

## Allowed files and limits

`json`, `css`, `md`, `txt`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `ttf`, `otf`.
No code of any kind (`.js`, `.py`, `.html`, `.svg`). Up to 60 files, 2 MB per file, 6 MB in total.
The server (`backend/skin_install.h`) checks all of this again, so a hand-made request gets no
more than the app does.

## Making a skin in the Flutter app

Settings → Appearance → **Make a skin** opens the Skin maker. Pick a starting look, change the accent, background, cards
and text (the rest of the colours follow them; **More colours** sets each one by hand), set the corner size, name it and
save. A made skin appears in the Appearance list next to the built-in ones, and every profile can choose it.

- **Hold** any skin in the list to use it, edit it, start a new one from it, copy it as a `skin.json`, or delete it.
- **Copy skin.json** gives the same file the web build installs from a .zip (put it in a folder next to an optional
  `skin.css` and zip it).
- **Paste skin.json** opens a skin made in the web build in the maker, ready to save. Only the name, description and
  colours are used; a skin's own `skin.css` styling only works in the web build.
- Like the web theme, a colour that would make the text hard to read on the background, the cards or the bars is refused.

## Making skins from code

Three ways, all giving the same `skin.json` / .zip, so a skin made by any of them installs in the web build and in the Flutter app.

**1. From the command line: `tools/make_skin.py`** (Python 3, no packages). It works out the colours you leave out, refuses
text that is hard to read, runs the same checks as `backend/skin_install.h`, and packs `my-skin/skin.json` (+ `skin.css`) into a .zip.

```
# four colours, the rest follows
tools/make_skin.py new --name Sunset --bg '#1a0f14' --surface '#2a1820' --text '#fff1e8' --accent '#ffb347' --radius 14

# one accent is enough (dark by default, --light for a light skin); a hue works too; --glow adds a background glow (web only)
tools/make_skin.py new --name Ocean --accent '#38bdf8'
tools/make_skin.py new --name Moss --hue 140 --light

# many skins from one JSON list, then check one
tools/make_skin.py batch skins.json --out dist/
tools/make_skin.py validate dist/sunset.zip
```

`--print` shows the skin.json without writing a file, `--folder` writes a skin folder instead of a .zip, `--css file.css` and
`--file image.png` add styling and images, `--force` allows low-contrast text. A batch file is a list of
`{"name", "accent", "bg", "surface", "text", "radius", "mode", "hue", "glow", "tokens": {...}, "css"}`.

**2. From Dart: `SkinBuilder`** (`flutter_ui/lib/src/skin_builder.dart`).

```dart
final sunset = SkinBuilder('Sunset')
    .colors(bg: '#1a0f14', surface: '#2a1820', text: '#fff1e8', accent: '#ffb347')
    .corners(14)
    .by('Me');
await sunset.save();             // shows up in Settings > Appearance
final zip = sunset.zip();        // an installable .zip
final json = sunset.skinJson();  // the skin.json text

final ocean = SkinBuilder.fromAccent('Ocean', const Color(0xFF38BDF8));   // one accent
final moss = SkinBuilder.fromHue('Moss', 140, dark: false);              // one hue
await SkinBuilder.installAll([ocean, moss]);
```

**3. By hand**: write `skin.json` as above.

## Installing skins in the Flutter app

Settings > Appearance has **Install skin from .zip** and **Install skin from GitHub**, the same flow as the web build:
the same zip picker (this device, library folders and network folders), the same GitHub lookup (latest release `.zip`, else the
source code), the same checks (`flutter_ui/lib/src/skin_install.dart`, a port of `backend/skin_install.h` and
`www/skin_installer.js`), and the same confirm screen. A skin from GitHub is labelled "unverified". Installing the same
skin again updates it; hold it in the list to remove it.

What differs: the Flutter UI cannot draw CSS, so an installed skin gives the app its **colours and corner size** only
(`skin.css`, `bgImage` and the glass tokens are checked but not drawn). A skin with no colours or radius in `skin.json` is refused
there with a message saying to use the web build. The skin is kept on the device (not in the server's `skins/` folder).
