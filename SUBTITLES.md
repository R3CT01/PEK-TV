# Automatic subtitles

PEK TV looks subtitles up online when what you are watching has none (torrent streams, bare files).
Nobody needs an OpenSubtitles account: one shared account lives in the cloud worker (see cloud/DEPLOY.md, "Subtitles").

## How it behaves
- A few seconds after playback starts, if the file has no subtitle track of its own, the best match is
  downloaded and switched on. A short message on the picture says what was chosen. Files that already have
  subtitles are left alone.
- The subtitle button (CC) always offers "Find subtitles online..." to see the other matches (release name,
  language, trusted uploader, hearing-impaired, auto-translated) and pick one by hand.
- Settings > Subtitles: automatic on/off and the language.
- The daily OpenSubtitles download limit is shared by everyone, so the worker stores every subtitle it downloads and
  serves it to all later users for free, and caps new downloads per day and per person.

## Where things are
- cloud/worker.js      /v1/subs/search, /v1/subs/get (shared account, D1 cache, daily limits)  [pekmain only]
- backend/subtitles.h  local routes /api/subtitles/search, /fetch, /cache/<id>.srt (forwards to the worker)
- www/subtitles.js     release-name parsing, client, SRT->VTT, the per-player controller
- www/app_subtitles.js Settings > Subtitles
- www/player.js        addSubtitle() on the backends, subtitle menu entry, on-screen message
- Android: MpvController.addSubtitle + PekAndroid.mpvAddSubtitle (mpv sub-add)
