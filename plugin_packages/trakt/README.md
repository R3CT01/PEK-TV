# Trakt

Scrobbles what you watch in PEK TV to [Trakt](https://trakt.tv), sends your "mark watched" changes there, and brings your Trakt
history into PEK TV. Made for people who already use Trakt with Kodi (the same account, the same history).

## What it does

| | |
|---|---|
| **Scrobble** | While you watch, Trakt shows "watching now". Pausing, resuming and closing the player are reported. Trakt counts a watch at 80%. |
| **Mark watched** | Marking a movie / episode / season watched or unwatched in PEK TV does the same on Trakt. |
| **Import** | When PEK TV starts, on the "Import" button, and then **every 3 minutes while PEK TV is open** (and when the app returns to the front), Trakt history that is new since last time is marked watched in PEK TV, dated with the day you really watched it on Trakt. Titles are matched to your library's own ("The Office" on Trakt is "The Office (US)" in the library; "WALL·E" is "WALL-E"); a title that fits nothing in your library is still kept in Watch History as Trakt names it. While something is playing nothing is checked. The first import of a big history carries on over a few starts. |
| **Ratings** | Rating a movie, an episode or a whole show in PEK TV (1 to 10 stars, the same scale as Trakt) rates it on Trakt; removing the rating removes it there. Ratings you give on Trakt (movies, shows, episodes) come into the open PEK TV profile at start and on the periodic check (one extra request only when Trakt says a rating changed). A rating that cannot be sent is kept and sent at the next start. **Send all my ratings to Trakt now** uploads the ratings PEK TV already has. If you rated the same movie in both places, the newer rating wins. |
| **Favorites** | Adding a movie or show to the favorites in PEK TV adds it to your **Trakt favorites**; removing it removes it there. Trakt favorites come into PEK TV at start (and on the periodic check when Trakt reports a favorites time): a title your library has becomes a library favorite, a title it does not have is kept as a favorite through its TMDb id. **Send all my favorites to Trakt now** uploads the favorites PEK TV already has. Whether Trakt favorites are open to every account is Trakt's decision (they may need Trakt VIP); the plugin then shows what Trakt answered. |
| **Removals** | What you remove on Trakt is removed here too: a watch (the title is unmarked in PEK TV), a rating, a favorite. Trakt keeps no list of deletions, so after Trakt says a list changed the plugin reads the list again and compares it with what it held the last time it looked; only a title it had seen on Trakt can be removed here. Anything you changed in PEK TV after that last look is kept. If a large part of a list vanishes at once it is held back until the next check shows the same (a bad answer must not wipe your lists). The **Remove here what I remove on Trakt** switch turns this off. |
| **Retry** | A finished watch that could not be sent (no network, Trakt busy) is kept and sent at the next start. |

Not done (yet): your existing PEK TV history is not uploaded to Trakt (only new marks and watches are; existing ratings and favorites have the buttons above); watchlist and collection; season ratings; a title in the Trakt history that no longer exists in PEK TV's history is not re-checked until Trakt reports a change.

## Setup

1. Install the plugin (PEK Store, a .zip, or GitHub). The install screen says what it may do: it is told what you play (title, year,
   season / episode and how far you got, never file names), and it may send data to `api.trakt.tv`.
2. Open **Trakt** from the menu and press **Connect to Trakt**. PEK TV shows a code. Open trakt.tv/activate on any device, enter the
   code and approve. No password is typed into PEK TV.
3. Choose what is shared with the six switches. Press **Import my Trakt history now** if you do not want to wait for the next start.

The account belongs to this device (plugin storage), not to a PEK TV profile. The import goes into the profile that is open when PEK TV
starts.

## How it is built

- `plugin.json`: permissions `send` (Authorization header + POST, to the listed hosts only), `playback` (the hook below), `watched`,
  `storage`; `flutter.hooks` names `hooks.py`.
- `hooks.py`: `on_event(event)`, called by PEK TV without a screen: `app_start`, `tick`, `play`, `resume`, `pause`, `stop`, `watched`, `rated`, `favorited`.
- `screen.py`: sign-in (device flow), the switches, the import / ratings / favorites buttons, "use my own Trakt app".
- `trakt_core.py`: everything that talks to Trakt. The 3-minute check is one small request (`/sync/last_activities`); the history is only fetched when Trakt says something new was watched. Titles are matched once with Trakt's search (title + year) and the Trakt id is kept in
  `data/ids.json`.
- Sign-in is Trakt's device flow with PKCE (a one-time `code_verifier` made on the device), straight to `api.trakt.tv`. Trakt apps no
  longer have a client secret, so no proxy or server is needed. "Use my own Trakt app" swaps in your own client id.

Files in `data/`: `auth.json` (tokens), `settings.json`, `pkce.json` (only while signing in), `ids.json`, `sync.json` (where the import stopped), `queue.json`, `rqueue.json` / `fqueue.json` (ratings / favorites that still have to be sent), `rsynced.json` / `wsynced.json` / `fsynced.json` (what Trakt held the last time it was looked at, used to notice removals).
Removing the plugin removes them; **Disconnect** signs out and revokes the token.

## Testing

`python3 tools/test_trakt_plugin.py` runs the plugin and the sandbox features it needs against a fake Trakt (no network).
