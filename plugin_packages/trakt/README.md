# Trakt

Scrobbles what you watch in PEK TV to [Trakt](https://trakt.tv), sends your "mark watched" changes there, and brings your Trakt
history into PEK TV. Made for people who already use Trakt with Kodi (the same account, the same history).

## What it does

| | |
|---|---|
| **Scrobble** | While you watch, Trakt shows "watching now". Pausing, resuming and closing the player are reported. Trakt counts a watch at 80%. |
| **Mark watched** | Marking a movie / episode / season watched or unwatched in PEK TV does the same on Trakt. |
| **Import** | When PEK TV starts, on the "Import" button, and then **every 3 minutes while PEK TV is open** (and when the app returns to the front), Trakt history that is new since last time is marked watched in PEK TV, dated with the day you really watched it on Trakt. Titles are matched to your library's own ("The Office" on Trakt is "The Office (US)" in the library; "WALL·E" is "WALL-E"); a title that fits nothing in your library is still kept in Watch History as Trakt names it. While something is playing nothing is checked. The first import of a big history carries on over a few starts. |
| **Retry** | A finished watch that could not be sent (no network, Trakt busy) is kept and sent at the next start. |

Not done (yet): removals on Trakt are not copied into PEK TV; your existing PEK TV history is not uploaded to Trakt (only new marks and
watches are); ratings, watchlist and collection.

## Setup

1. Install the plugin (PEK Store, a .zip, or GitHub). The install screen says what it may do: it is told what you play (title, year,
   season / episode and how far you got, never file names), and it may send data to `api.trakt.tv`.
2. Open **Trakt** from the menu and press **Connect to Trakt**. PEK TV shows a code. Open trakt.tv/activate on any device, enter the
   code and approve. No password is typed into PEK TV.
3. Choose what is shared with the three switches. Press **Import my Trakt history now** if you do not want to wait for the next start.

The account belongs to this device (plugin storage), not to a PEK TV profile. The import goes into the profile that is open when PEK TV
starts.

## How it is built

- `plugin.json`: permissions `send` (Authorization header + POST, to the listed hosts only), `playback` (the hook below), `watched`,
  `storage`; `flutter.hooks` names `hooks.py`.
- `hooks.py`: `on_event(event)`, called by PEK TV without a screen: `app_start`, `tick`, `play`, `resume`, `pause`, `stop`, `watched`.
- `screen.py`: sign-in (device flow), the three switches, the import button, "use my own Trakt app".
- `trakt_core.py`: everything that talks to Trakt. The 3-minute check is one small request (`/sync/last_activities`); the history is only fetched when Trakt says something new was watched. Titles are matched once with Trakt's search (title + year) and the Trakt id is kept in
  `data/ids.json`.
- Sign-in is Trakt's device flow with PKCE (a one-time `code_verifier` made on the device), straight to `api.trakt.tv`. Trakt apps no
  longer have a client secret, so no proxy or server is needed. "Use my own Trakt app" swaps in your own client id.

Files in `data/`: `auth.json` (tokens), `settings.json`, `pkce.json` (only while signing in), `ids.json`, `sync.json` (where the import stopped), `queue.json`.
Removing the plugin removes them; **Disconnect** signs out and revokes the token.

## Testing

`python3 tools/test_trakt_plugin.py` runs the plugin and the sandbox features it needs against a fake Trakt (no network).
