# PEK TV

A media center with a sandboxed plugin system, network library support and a TV-first interface. It is in beta, so expect rough edges.

Website: https://r3ct01.github.io/PEK-TV/ &nbsp;|&nbsp; Source docs: see `docs/`

## Screenshots

PEK TV running at 1920x1080.

| | |
|---|---|
| ![Dashboard](docs/assets/screens/dashboard.png)<br>**Dashboard** | ![TV Shows](docs/assets/screens/tv-shows.png)<br>**TV Shows library** |
| ![Show page](docs/assets/screens/show-page.png)<br>**Show page** | ![Episode details](docs/assets/screens/episode-details.png)<br>**Episode details** |
| ![Settings](docs/assets/screens/settings.png)<br>**Settings** | |

> **About the artwork in these screenshots.** The movie and show posters and episode stills shown are **stand-ins**: plain generated gradient images with a title on them, made for these screenshots. They are not the official artwork. Real posters and stills are copyrighted by their owners, so none are included in this repository. The titles, descriptions and episode text shown are sample entries for demonstration only. All titles and names mentioned are the property of their respective owners, and PEK TV is not affiliated with or endorsed by them. In normal use PEK TV shows artwork from your own files or fetches it from TMDB for your own library.

## What it does

- **Your library, everywhere:** local folders and network shares (SMB, NFS, FTP, WebDAV, UPnP/DLNA). Reads Kodi-style NFO files and artwork first, and asks TMDb only for what is missing.
- **A player that stays out of the way:** libmpv on Android, the browser's player elsewhere. Automatic subtitles, Skip Intro / Skip Recap, and an Up Next card.
- **Built for the couch:** D-pad, remote and gamepad support, with a 10-foot look.
- **A dashboard you design:** widgets you choose and order, saved per profile.
- **Profiles and PEK Cloud:** profiles with their own history and favorites, plus optional cloud sync.
- **Skins:** install a skin from a `.zip`. Skins cannot run code or reach the network.
- **Sandboxed plugins:** plugins declare what they may do and run in a locked-down sandbox.

See `PLUGINS.md`, `SKINS.md`, `SUBTITLES.md` and `LOCAL_METADATA.md` for details.

## Branches

- `main`: backend, web UI, plugins, skins and cloud workers.
- `android`: everything in `main` plus the Android app and the GitHub Actions build.

## Legal

See the `LICENCE` file for what you may and may not do with the code.

PEK Industries is not associated with any illegal activity involving torrents. PEK TV does not host, provide or link to any content, and ships with no search provider or index. You are responsible for what you play.

This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data provided by JustWatch.
