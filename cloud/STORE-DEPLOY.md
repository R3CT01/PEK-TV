# PEK Store: setup (its own worker, its own database)

The store is separate from the sync worker (`worker.js`). Different worker, different database, nothing shared.

## 1. Database
Cloudflare -> Storage & databases -> D1 -> **Create** -> name `pek-store`.

## 2. Worker
1. Workers & Pages -> Create -> Hello World -> name `pek-store` -> Deploy.
   (Its address will be `https://pek-store.<your-subdomain>.workers.dev`. If it differs from the one in
   `flutter_ui/lib/src/plugin_store.dart` (`base`) and, if you host a separate store site, that site's own config, change both.)
2. Worker -> Settings -> Bindings -> Add -> D1 database -> variable name `DB` -> `pek-store`.
3. Edit code -> delete everything -> paste all of `cloud/store-worker.js` -> Deploy.

## 3. GitHub OAuth App
GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App
- Homepage URL: your Pages address (`https://r3ct01.github.io/pek-plugins/`)
- Authorization callback URL: `https://pek-store.<your-subdomain>.workers.dev/v1/gh/callback`
- Create it, then **Generate a new client secret** and copy it straight away (GitHub shows it once).

## 4. Worker settings (Worker -> Settings -> Variables and Secrets), then Deploy
- Secret `GITHUB_CLIENT_SECRET`, Text `GITHUB_CLIENT_ID`
- Text `SITE_URL` = `https://r3ct01.github.io/pek-plugins/`
- Text `OWNER_GITHUB` = your GitHub username (several: comma separated)
- Optional Text `MIN_ACCOUNT_DAYS` (default 7), Optional Text `BLOCKED_GITHUB`

## 5. Check
- `https://pek-store.<subdomain>.workers.dev` says `pek-store ok`
- `.../v1/store?shelf=official` shows `{"ok":true,"items":[]}`

Owners publish and review at `<site>/owner.html`. Uploads from `<site>/` wait for approval.

## Skins
Skins use the same store: same worker, same database, same site. A skin zip has `skin.json` (and optionally `skin.css`
and images) instead of `plugin.json`. The site tells them apart on its own.
- Plugins and skins are on separate shelves in the app (Settings -> Plugins -> PEK Store, Settings -> Skins -> PEK Store).
- A plugin and a skin can't share an id. Skin ids `default`, `green` and `neon` are reserved.
- The worker adds its new `kind` column by itself on the first request after you paste the update. Nothing to run, nothing lost.
- Skin size limit is 6 MB (plugins 8 MB).
