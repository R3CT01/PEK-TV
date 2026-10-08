# Deploying Hesper Cloud (accounts + sync). A phone browser is enough.

Accounts are an email and a password. New accounts confirm their email with a 6-digit code, and
"Forgot password" works the same way. Both codes are sent through Brevo.

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
   - Type **Text**, name `BREVO_SENDER_NAME`, value = `Hesper` (optional)
   Then **Deploy** so they take effect.
4. Visit the worker URL in a browser. It should say: `hesper-sync ok`
   (tables are created automatically on the first request).
5. The app calls `https://hesper-sync-9275.aquariusibeats.workers.dev`. If your worker's URL is
   different, change `API` at the top of `www/sync.js`.
6. Recommended: Worker -> Security / WAF -> rate limiting rule on `/v1/auth/*` per IP. The worker
   already limits sign-ups, sign-ins, reset requests and code guesses itself.

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
- Settings -> Cloud Sync -> Delete Account removes the account and all its synced data.
- Old 25-character-key accounts no longer work. Their rows can stay (harmless) or be removed in the
  D1 console with:  `DELETE FROM items WHERE acct NOT IN (SELECT id FROM users);  DROP TABLE IF EXISTS accounts;`
