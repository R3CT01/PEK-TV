# Deploying PEK Cloud (accounts + sync). A phone browser is enough.

Accounts are an email and a password. New accounts confirm their email with a 6-digit code, and
"Forgot password" works the same way. **Every sign-in also needs a fresh 6-digit code from the email**
(the password alone never signs a device in). All of these codes are sent through Brevo, so if Brevo
stops working nobody can sign in on a new device (devices that are already signed in keep working).

## A. Brevo (sends the reset emails)

1. Brevo -> your name (top right) -> **Senders, Domains & Dedicated IPs** -> **Senders** -> add the
   address the emails should come from and confirm it from the verification email Brevo sends.
   (Best deliverability: authenticate a domain you own instead. A free-mail address such as Gmail
   works for testing but often lands in spam.)
2. Brevo -> **SMTP & API** -> **API Keys** -> **Generate a new API key**. Name it `hesper`. Copy it
   now (it starts with `xkeysib-`); Brevo only shows it once.
3. Brevo -> **Security** -> **Authorised IPs**. If IP restriction is ON, turn it OFF (or deactivate
   blocking). Cloudflare Workers send from changing addresses, so a fixed allow-list blocks them.

## B. Cloudflare (runs the accounts)

1. D1 database `hesper-sync` and the worker `hesper-sync` already exist from before. Keep them.
   (Only the first-ever setup needs: Storage & databases -> D1 -> Create `hesper-sync`; Workers & Pages ->
   Create -> Hello World -> name `hesper-sync`; Worker -> Settings -> Bindings -> Add -> D1 -> variable
   name `DB` -> `hesper-sync`.)
2. Open the worker -> **Edit code** -> delete everything -> paste all of `cloud/worker.js` -> **Deploy**.
3. Worker -> **Settings** -> **Variables and Secrets** -> Add:
   - Type **Secret**, name `BREVO_API_KEY`, value = the key from step A2
   - Type **Text**, name `BREVO_SENDER_EMAIL`, value = the sender address verified in step A1
   - Type **Text**, name `BREVO_SENDER_NAME`, value = `PEK TV` (optional)
   Then **Deploy** so they take effect.
4. Visit the worker URL in a browser. It should say: `hesper-sync ok`
   (tables are created automatically on the first request).
5. The app calls `https://pek-sync.aquariusibeats.workers.dev`. If your worker's URL is
   different, change `api` in `flutter_ui/lib/src/cloud.dart`.
6. Recommended: Worker -> Security / WAF -> rate limiting rule on `/v1/auth/*` per IP. The worker
   already limits sign-ups, sign-ins, reset requests and code guesses itself.

## Subtitles (one shared OpenSubtitles account for every user)

Users set nothing up. The worker holds one OpenSubtitles.com account and the app asks the worker.

1. Make an account at opensubtitles.com, confirm the email, then create an API consumer/key
   (profile -> API consumers). The free tier allows about 20 subtitle downloads per day, to check on your account.
   If many people use the app, an OpenSubtitles VIP plan raises that limit a lot.
2. Worker -> **Settings** -> **Variables and Secrets** -> Add:
   - Type **Secret**, name `OPENSUBTITLES_API_KEY`, value = the API key
   - Type **Secret**, name `OPENSUBTITLES_USER`, value = the account user name
   - Type **Secret**, name `OPENSUBTITLES_PASS`, value = the account password
   - Optional, Type **Text**: `SUBS_DAILY_LIMIT` (default 18: keep it a little under your real limit) and
     `SUBS_IP_DAILY_LIMIT` (default 8 new downloads per person per day). Then **Deploy**.
3. Paste the new `worker.js` and deploy (the `subs_cache` table is created on the first request).

How the daily limit is protected:
- Searching is free and is not counted.
- Every subtitle that has been downloaded once is stored in D1 and given to everyone after that at no cost, so
  popular episodes and films use the daily limit only once for all users together.
- New downloads are counted for the whole service per day and per IP address, so one person cannot use it all up.
  When the limit is reached the app says "Subtitle downloads are used up for today"; subtitles already stored still work.
- If the worker is not on the sync address, set the `PEK_SUBS_URL` environment variable of the app's backend to its address.

## Plugin backup (no extra setup)

The same worker and the same D1 database also store plugin backups. There is nothing new to configure:
paste the new `worker.js`, deploy, and the two new tables (`plugins`, `plugin_chunks`) are created on the
first request, like the others. Limits per account: 30 plugins, 8 MB each, 60 MB together.
The app needs the new build too (the Android app reads plugin files through two new local routes).

## What syncs, and when

Watch history, resume points, favorites and the plugin backup all go through the same worker. The app syncs by
itself: at start, every 10 minutes, and shortly after a favorite is added or removed, something is watched, a
plugin is installed, playback ends, the device comes back online or the app is reopened. If a sync can't run
at that moment (a video is playing), it retries 20 seconds later. Favorites need only the new `worker.js`.

## Test it

1. Settings -> Cloud Sync -> Create Account. A code arrives by email; enter it to finish (you are then signed in).
2. Sign out -> Sign In works with the same email and password.
3. Sign out -> Forgot Password -> enter the code from the email and choose a new password.
If the email never arrives: Brevo -> Transactional -> Logs shows whether Brevo got the request, and
Cloudflare -> Worker -> Logs shows errors (look for "Brevo send failed").

## Notes

- Passwords are stored only as salted PBKDF2-SHA256 hashes; sessions as hashes of random tokens.
- An account that never confirms its email can't sign in. If someone registers an address that isn't
  theirs, it stays unusable, and the real owner can register it again to take it over.
- Verification codes work for 30 minutes (reset codes 15), allow 5 wrong tries, and only the newest code works.
  At most 5 verification emails per address per hour.
- Accounts made before verification existed are treated as already verified.
- Resetting a password also confirms the email, and signs out every device (they just sign in again with the new password).
- Settings -> Cloud Sync -> Delete Account removes the account and all its synced data, plugin backups included.
- Old 25-character-key accounts no longer work. Their rows can stay (harmless) or be removed in the
  D1 console with:  `DELETE FROM items WHERE substr(acct, 1, instr(acct || ':', ':') - 1) NOT IN (SELECT id FROM users);  DROP TABLE IF EXISTS accounts;`
  (Profile data is stored as `<user id>:<profile id>`, which is why the id is cut off at the colon.)

## Profiles (one household account, a profile per person)

Redeploy the worker (step B2) **before** people update the app. Nothing else to do: the new `profiles`
table is created automatically on the first request, and existing accounts need no migration, because
their data simply becomes the original profile (`p1`).

- Each profile syncs its own history, resume points and favorites; the list of profiles (names and
  colours) syncs too, up to 5 per account. Plugin backups stay per account.
- An app that is newer than the worker only syncs the original profile and shows a message for the
  others (it never mixes anyone's data), so a late deploy is safe.
- Removing a profile in the app also removes that profile's data from the cloud.

## Skins (saved per profile)

Redeploy the worker (step B2) to let the app save skins to the account. Nothing else to do: skins are stored as
`k|<skin id>` items of the profile (kind `k` in the existing `items` table, so no migration) and the chosen skin as the
`s|skin` setting. An app that is newer than the worker keeps its skins on the device and sends them once the worker is updated.

## Sign-in codes (every sign-in needs one)

Deploy the worker (step B2) and update the app together. The new worker answers a correct password
with "check your email" instead of a session, and only the updated app knows what to do with that;
an older app would not be able to finish signing in (devices that are already signed in are not
affected). Codes work once, for 30 minutes, with 5 tries per code and at most 6 code emails per
address per hour. Brevo must be set up (part A), or sign-in answers "Email is not set up".

## Profile pictures and passcodes

Profile pictures, passcodes (stored only as a salted hash) and "forgot passcode" (re-checks the account password through the new
`POST /v1/auth/confirm`) need the newest `worker.js`: paste it, deploy, done. The `profiles` table gets its two new columns
(`avatar`, `pin`) by itself. Until the worker is updated everything still works on the device; pictures and passcodes just don't
reach other devices, and "Forgot passcode?" says the cloud service needs an update.


## Invite-only sign-up (single-use codes)

New accounts, and with them cloud backup and multiple profiles (profiles live inside the account), can be limited to people
you give a code to. Accounts that already exist are not affected: they keep signing in, resetting passwords and syncing as before
(they are marked `gf = 1` by the worker the first time it runs).

**Switch it on:** Cloudflare -> Worker -> Settings -> Variables and Secrets:
- `INVITE_ONLY` (Text) = `1`. Delete it, or set it to `0`, to open sign-up to everyone again.
- `ADMIN_KEY` (Secret) = a long random text of 16 or more characters. Keep it to yourself: it is the only thing that can make codes.
Then paste the new `worker.js` and deploy. The `invites` table and the `gf` column are created on the first request.

**Make codes:** with your own private admin tool (it is deliberately not part of this repo). It sends
`POST <your worker>/v1/invites/new` with the header `Authorization: Bearer <ADMIN_KEY>` and a JSON body such as
`{"count": 3, "note": "for Sam", "days": 14}`; the worker answers with the codes. `/v1/invites/list` and
`/v1/invites/revoke` work the same way. Without the right key every one of these answers "not found".
A code is shown once when it is made and cannot be read back later (only its hash is stored). Give each person their own code.

**How a code behaves:** it works for one account, once. While that person types the email code it is *held* for them
(30 minutes, renewed by "Resend code"); if they never confirm, it frees itself and can be used again. The moment their email is
confirmed it is used up for good. Unused codes also stop working after 14 days (`days` in the request; 0 = never).
A person who starts sign-up and abandons it cannot finish later without a code.


## Usernames

Sign-up has a required **Username** box: 3 to 20 characters (letters, numbers, `.`, `-`, `_`, starting with a letter or number),
unique without regard to upper/lower case. Accounts made before this have none and are not asked for one. It is shown under
Settings -> Cloud Sync once signed in. Sign-in still uses the email and password. Deploy the new `worker.js` (the `username` column and its
unique index are created on the first request), then update the app.
