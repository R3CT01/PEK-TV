# Local metadata: NFO files and artwork

PEK TV reads the small files that Kodi, Radarr, Sonarr, tinyMediaManager and similar tools put next to your
videos. They work on local folders and on network sources (SMB, NFS, FTP, WebDAV, UPnP), need no internet, and
win over the file name and over TMDb. TMDb is only asked for what is still missing.

Files are picked up by the normal scan (**Rescan** after adding or editing them). Nothing is written to your folders.

## NFO files (.nfo)

| Where | What it is |
|---|---|
| `Movie Name (2001).nfo` next to `Movie Name (2001).mkv` | movie: `<movie>` with `title`, `year` (or `premiered`), `plot` (or `outline`) |
| `movie.nfo` in a folder that holds one video | same, for that video |
| `Show S01E02.nfo` next to the episode | `<episodedetails>` with `title`, `showtitle`, `season`, `episode`, `plot` |
| `tvshow.nfo` in the show folder (the parent of the `Season N` folders) | `<tvshow>` with `title`, `plot` |

- An NFO fixes files that would otherwise be "Unknown" or mis-named: the title, year, show, season and episode
  come from the file, not from the file name.
- Show name priority: the episode NFO's `showtitle`, then `tvshow.nfo`'s `title`, then tags / the file name.
- Files holding only a link (for example a themoviedb.org address) are ignored.
- Only the first `<episodedetails>` in a file is read.

## Artwork (images)

Image types: `.jpg`, `.jpeg`, `.png`, `.webp`, `.tbn`. Names are not case sensitive.

| Image | Names looked for |
|---|---|
| Movie poster | `<video name>-poster.jpg`, `<video name>.jpg`; and, when the folder holds only that one video: `poster.jpg`, `folder.jpg`, `cover.jpg`, `movie.jpg` |
| Movie background | `<video name>-fanart.jpg`, `-backdrop`, `-background`; single-video folders also: `fanart.jpg`, `backdrop.jpg`, `background.jpg` |
| Episode picture | `<video name>-thumb.jpg`, `<video name>.jpg` |
| Show poster | `poster.jpg`, `folder.jpg`, `cover.jpg`, `show.jpg` in the show folder |
| Show background | `fanart.jpg`, `backdrop.jpg`, `background.jpg` in the show folder |

Folder-wide names such as `poster.jpg` are ignored when a folder holds several videos, so a loose collection of
movies in one folder never shares one poster. Images over 12 MB are ignored.

## Not supported (yet)

Season posters, actor photos, clear logos, NFOs that only carry IDs or links, and writing NFO files.
