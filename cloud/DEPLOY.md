# Deploying Hesper Cloud (phone browser is enough)

1. Cloudflare dashboard -> Storage & databases -> D1 -> Create database, name it `hesper-sync`.
2. Workers & Pages -> Create -> Start with Hello World -> name it exactly `hesper-sync` -> Deploy.
   (The app calls https://hesper-sync.aquariusibeats.workers.dev. A different name means
   changing `API` at the top of www/sync.js.)
3. Open the worker -> Edit code -> delete everything -> paste all of cloud/worker.js -> Deploy.
4. Worker -> Settings -> Bindings -> Add -> D1 database -> variable name `DB` -> pick `hesper-sync` -> Deploy.
5. Visit https://hesper-sync.aquariusibeats.workers.dev in a browser. It should say: hesper-sync ok
   (tables are created automatically on the first sync).
6. Recommended: Worker -> Security / Rate limiting rule (or WAF) limiting /v1/sync per IP, so nobody
   can mass-create accounts.

Privacy: only a SHA-256 hash of each sync key is stored. Users can delete their cloud data in
Settings -> Cloud Sync. GET /v1/export returns an account's data as JSON.
