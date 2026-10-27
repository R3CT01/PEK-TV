# Trakt sign-in proxy (no longer needed)

The Trakt plugin used to sign people in through a small worker (`cloud/trakt-worker.js`) that held the Trakt client secret.
Trakt apps no longer have a client secret, so the plugin now signs in with Trakt's device flow plus PKCE (a one-time
`code_verifier` made on the device), straight to `api.trakt.tv`. PEK TV's own Trakt app only needs its public client id,
which is written in the plugin (`trakt_core.py`, `CLIENT_ID`).

So there is **nothing to deploy** for Trakt: no worker, no secrets, no host to list in `plugin.json` besides `api.trakt.tv`.
If you already deployed `pek-trakt` you can delete it in the Cloudflare dashboard, and you can delete `cloud/trakt-worker.js`
from the repository. Someone who prefers their own Trakt app can enter its client id in the plugin (**Use my own Trakt app**);
see `plugin_packages/trakt/README.md`.
