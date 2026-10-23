# Trakt sign-in proxy (cloud/trakt-worker.js)

The Trakt plugin signs people in with Trakt's device flow. That needs your Trakt app's **client secret**, and a secret inside the
apk is not a secret. This tiny worker holds it and adds it to the four sign-in calls. It stores nothing. Everything else the plugin
does goes straight to `api.trakt.tv` with the person's own token.

You do this once. A phone browser is enough.

## 1. Register the Trakt app

1. Sign in at trakt.tv, then open **trakt.tv/oauth/applications** and press **New Application**.
2. Name: `PEK TV`. Redirect uri: `urn:ietf:wg:oauth:2.0:oob`. Leave the permission boxes (`/checkin`, `/scrobble`) ticked: scrobbling
   needs `/scrobble`.
3. Save. Keep the page open: you need the **Client ID** and **Client Secret** below.

## 2. Create the worker

1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Create Worker**. Name it `pek-trakt` and press **Deploy**.
2. Press **Edit code**, delete what is there, paste all of `cloud/trakt-worker.js`, press **Deploy**.
3. **Settings** > **Variables and Secrets** > add two **Secrets** (type "Secret", not "Text"):
   - `TRAKT_CLIENT_ID` = the Client ID
   - `TRAKT_CLIENT_SECRET` = the Client Secret
4. Open `https://pek-trakt.<your-subdomain>.workers.dev/client`. It must show `{"client_id":"..."}`.

## 3. Tell PEK TV the worker's address

The address is written in two places and they must match:

- `plugin_packages/trakt/plugin.json`: `permissions.network` (the host name only, no `https://`)
- `plugin_packages/trakt/trakt_core.py`: `PROXY` (the full `https://...` address)
- `android/app/src/main/python/pek_flutter.py`: `TRAKT_PROXY_HOST` (the host name). Only the plugin whose id is `trakt` may list this
  host, the same rule the TMDb proxy has.

If you keep the name `pek-trakt` and your account's workers.dev subdomain is `aquariusibeats`, nothing needs changing.

## 4. Optional: rate limit

In Cloudflare **Security > WAF > Rate limiting rules**, limit `pek-trakt.*.workers.dev` to, say, 60 requests per minute per IP. Signing in
and refreshing a token are rare, so this never gets in the way of real use.

## What a person's Trakt token can do

The plugin asks Trakt for the default scopes of your app. It uses them to scrobble, read and write the person's watch history and read
their user name. It never sees a password: the person approves the code on trakt.tv.
