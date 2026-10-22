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
