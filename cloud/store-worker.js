// PEK Store worker. Separate from the sync worker (worker.js) on purpose:
// own code, own database, nothing shared. Setup: STORE-DEPLOY.md.
//
// GitHub sign-in (used by the GitHub Pages site):
//   GET  /v1/gh/login?ret=upload|owner  -> redirects to GitHub;  GET /v1/gh/callback -> back to the site with #token=
//   GET  /v1/gh/me ; POST /v1/gh/logout                                           (GitHub token)
// Store:
//   GET  /v1/store?shelf=official|community&kind=plugin|skin  -> { ok, items }     (public; no kind = plugins)
//   GET  /v1/store/chunk?id=&fp=&i=                           -> { ok, data }      (public, approved only)
//   POST /v1/store/chunk | /v1/store/submit | /v1/store/remove ; GET /v1/store/mine  (GitHub token)
//   POST /v1/store/owner/{chunk,commit,approve,remove} ; GET /v1/store/owner/{all,chunk}  (owner accounts only)

const MAX_BODY = 1024 * 1024;              // bytes per request
const MAX_PLUGIN_RAW = 8 * 1024 * 1024;    // bytes of plugin files
const PLUGIN_CHUNK = 400000;               // chars per chunk (the app and the site use the same size)
const MAX_PLUGIN_CHUNKS = 40;
const BUILTIN_PLUGINS = ['weather', 'sample_scraper', 'sample_counter', 'tmdb-discover'];
// Bundled with the app, but the OWNER may publish them on the Official shelf (so the app can update them). Nobody else may use these ids.
const OWNER_ONLY_PLUGINS = ['skin-maker', 'trakt'];
const BUILTIN_SKINS = ['default', 'green', 'neon'];
const MAX_SKIN_RAW = 6 * 1024 * 1024;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
};

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
}

let ready = false;
async function init(db) {
    if (ready) return;
    await db.prepare('CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS store_plugins (id TEXT PRIMARY KEY, shelf TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, author TEXT NOT NULL DEFAULT \'\', description TEXT NOT NULL DEFAULT \'\', size INTEGER NOT NULL, fp TEXT NOT NULL, chunks INTEGER NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL, updated INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT \'plugin\')').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS store_chunks (owner TEXT NOT NULL, id TEXT NOT NULL, fp TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (owner, id, fp, idx))').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS gh_states (state TEXT PRIMARY KEY, ret TEXT NOT NULL, created INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS gh_sessions (token_hash TEXT PRIMARY KEY, gh_id TEXT NOT NULL, login TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)').run();
    try { await db.prepare("ALTER TABLE store_plugins ADD COLUMN kind TEXT NOT NULL DEFAULT 'plugin'").run(); } catch (e) { /* column already there */ }
    try { await db.prepare("ALTER TABLE store_plugins ADD COLUMN icon TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* column already there */ }
    ready = true;
}

const enc = new TextEncoder();
function hex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
function randomHex(nBytes) { return hex(crypto.getRandomValues(new Uint8Array(nBytes))); }
function randomToken() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function readJson(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) return { err: json({ error: 'too_large' }, 413) };
    try {
        const body = text ? JSON.parse(text) : {};
        if (!body || typeof body !== 'object') return { err: json({ error: 'bad_json' }, 400) };
        return { body };
    } catch (e) { return { err: json({ error: 'bad_json' }, 400) }; }
}
// ---------------------------------------------------------------- rate limiting (stored in D1)
// Returns true when the caller is OVER the limit. Counts every call it sees.
async function limited(db, key, max, windowMs, now) {
    const row = await db.prepare('SELECT n, reset_at FROM throttle WHERE k = ?').bind(key).first();
    if (!row || row.reset_at <= now) {
        await db.prepare('INSERT INTO throttle (k, n, reset_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = 1, reset_at = excluded.reset_at').bind(key, now + windowMs).run();
        return false;
    }
    if (row.n >= max) return true;
    await db.prepare('UPDATE throttle SET n = n + 1 WHERE k = ?').bind(key).run();
    return false;
}
function clientIp(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }
function goodId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id); }
function goodStoreId(id, kind, official) {
    if (!goodId(id)) return false;
    if (kind !== 'skin' && OWNER_ONLY_PLUGINS.indexOf(id) !== -1) return official === true;   // owner route only
    return (kind === 'skin' ? BUILTIN_SKINS : BUILTIN_PLUGINS).indexOf(id) === -1;
}
function goodFp(fp) { return typeof fp === 'string' && /^[a-f0-9]{8,64}$/.test(fp); }
function shortText(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

// One store, two shelves, both browsable and downloadable WITHOUT any sign-in:
//   official   plugins published by the owner(s). Live immediately.
//   community  everyone else's. Uploaded from the GitHub Pages site, hidden until an owner approves.
// Everyone who uploads signs in with GitHub (mandatory). Owners are the GitHub accounts listed in OWNER_GITHUB.
//
// Worker settings (Variables and Secrets):
//   GITHUB_CLIENT_ID      (Text)    from your GitHub OAuth App
//   GITHUB_CLIENT_SECRET  (Secret)  from your GitHub OAuth App
//   SITE_URL              (Text)    the address of your GitHub Pages site, e.g. https://you.github.io/hesper-plugins/
//   OWNER_GITHUB          (Text)    your GitHub username(s), comma separated
//   MIN_ACCOUNT_DAYS      (Text, optional)  newest GitHub account allowed to upload, default 7
//   BLOCKED_GITHUB        (Text, optional)  usernames (or numeric ids) refused at sign-in, comma separated
const GH_SESSION_TTL = 7 * 24 * 3600 * 1000;
const GH_STATE_TTL = 10 * 60 * 1000;
const STORE_MAX_PER_USER = 10;         // community plugins one GitHub account may have (pending + approved)
const STORE_MAX_SIZE = MAX_PLUGIN_RAW;

function csv(v) { return String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
function inList(list, gh) { return list.indexOf(String(gh.login).toLowerCase()) >= 0 || list.indexOf(String(gh.id)) >= 0; }
function siteUrl(env) { const u = String(env.SITE_URL || ''); return /^https:\/\//.test(u) ? (u.endsWith('/') ? u : u + '/') : ''; }

function siteRedirect(env, page, hash) {
    const base = siteUrl(env);
    if (!base) return json({ error: 'site_not_configured' }, 500);
    return new Response(null, { status: 302, headers: { Location: base + (page === 'owner' ? 'owner.html' : '') + '#' + hash, 'Cache-Control': 'no-store' } });
}

async function ghLogin(url, request, env) {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !siteUrl(env)) return json({ error: 'github_not_configured' }, 500);
    const now = Date.now();
    if (await limited(env.DB, 'gh:login:' + clientIp(request), 30, 10 * 60 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    const ret = url.searchParams.get('ret') === 'owner' ? 'owner' : 'upload';
    const state = randomHex(16);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM gh_states WHERE created < ?').bind(now - GH_STATE_TTL),
        env.DB.prepare('INSERT INTO gh_states (state, ret, created) VALUES (?, ?, ?)').bind(state, ret, now)
    ]);
    const to = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(env.GITHUB_CLIENT_ID) +
        '&redirect_uri=' + encodeURIComponent(url.origin + '/v1/gh/callback') + '&state=' + state + '&allow_signup=true';
    return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

async function ghCallback(url, env) {
    const now = Date.now();
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    const row = /^[a-f0-9]{32}$/.test(state)
        ? await env.DB.prepare('SELECT ret, created FROM gh_states WHERE state = ?').bind(state).first() : null;
    if (row) await env.DB.prepare('DELETE FROM gh_states WHERE state = ?').bind(state).run();   // one use only
    if (!row || row.created < now - GH_STATE_TTL) return siteRedirect(env, 'upload', 'error=expired');
    const page = row.ret;
    if (!code) return siteRedirect(env, page, 'error=denied');

    let access = '', gh = null;
    try {
        const t = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'hesper-store' },
            body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code })
        });
        access = ((await t.json()) || {}).access_token || '';
        if (access) {
            const u = await fetch('https://api.github.com/user', { headers: { 'Authorization': 'Bearer ' + access, 'Accept': 'application/vnd.github+json', 'User-Agent': 'hesper-store' } });
            if (u.ok) gh = await u.json();
        }
    } catch (e) { /* handled below */ }
    // We only needed to learn who this is; revoke GitHub's token straight away (best effort).
    if (access) {
        try {
            await fetch('https://api.github.com/applications/' + encodeURIComponent(env.GITHUB_CLIENT_ID) + '/token', {
                method: 'DELETE',
                headers: { 'Authorization': 'Basic ' + btoa(env.GITHUB_CLIENT_ID + ':' + env.GITHUB_CLIENT_SECRET), 'Accept': 'application/vnd.github+json', 'User-Agent': 'hesper-store', 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: access })
            });
        } catch (e) { /* not important */ }
    }
    if (!gh || !gh.id || !gh.login) return siteRedirect(env, page, 'error=github');
    if (inList(csv(env.BLOCKED_GITHUB), gh)) return siteRedirect(env, page, 'error=blocked');
    const owner = inList(csv(env.OWNER_GITHUB), gh);
    const minDays = Number(env.MIN_ACCOUNT_DAYS == null || env.MIN_ACCOUNT_DAYS === '' ? 7 : env.MIN_ACCOUNT_DAYS);
    const age = gh.created_at ? (now - Date.parse(gh.created_at)) / 86400000 : 0;
    if (!owner && Number.isFinite(minDays) && age < minDays) return siteRedirect(env, page, 'error=too_new');
    if (page === 'owner' && !owner) return siteRedirect(env, page, 'error=not_owner');

    const token = randomToken();
    await env.DB.batch([
        env.DB.prepare('DELETE FROM gh_sessions WHERE expires < ?').bind(now),
        env.DB.prepare('INSERT INTO gh_sessions (token_hash, gh_id, login, created, expires) VALUES (?, ?, ?, ?, ?)')
            .bind(await sha256Hex('hesper:gh:' + token), String(gh.id), String(gh.login), now, now + GH_SESSION_TTL)
    ]);
    return siteRedirect(env, page, 'token=' + encodeURIComponent(token));
}

// Who is calling? Reads the GitHub session token. Owner / blocked status is re-checked on every call,
// so removing a name from OWNER_GITHUB or adding one to BLOCKED_GITHUB takes effect straight away.
async function ghSession(request, env, now) {
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
    if (!m || m[1].length < 20 || m[1].length > 100) return null;
    const hash = await sha256Hex('hesper:gh:' + m[1]);
    const r = await env.DB.prepare('SELECT gh_id, login, expires FROM gh_sessions WHERE token_hash = ?').bind(hash).first();
    if (!r || r.expires < now) return null;
    const gh = { id: r.gh_id, login: r.login };
    if (inList(csv(env.BLOCKED_GITHUB), gh)) return null;
    return { id: 'gh:' + r.gh_id, login: r.login, owner: inList(csv(env.OWNER_GITHUB), gh), hash };
}

function storeItem(r) {
    return { id: r.id, shelf: r.shelf, name: r.name, version: r.version, author: r.author, description: r.description,
             kind: r.kind === 'skin' ? 'skin' : 'plugin', icon: r.icon || '', size: r.size, fp: r.fp, chunks: r.chunks, status: r.status, updated: r.updated };
}

async function storeList(url, env) {
    const shelf = url.searchParams.get('shelf');
    const kind = url.searchParams.get('kind') === 'skin' ? 'skin' : 'plugin';   // no kind = plugins
    const q = shelf === 'official' || shelf === 'community'
        ? env.DB.prepare("SELECT * FROM store_plugins WHERE status = 'approved' AND kind = ? AND shelf = ? ORDER BY name").bind(kind, shelf)
        : env.DB.prepare("SELECT * FROM store_plugins WHERE status = 'approved' AND kind = ? ORDER BY shelf, name").bind(kind);
    const rows = await q.all();
    return json({ ok: true, items: (rows.results || []).map(storeItem) });
}

// Download one chunk. Public for approved items; owners may also read pending ones (to review them).
async function storeGetChunk(url, env, allowPending) {
    const id = url.searchParams.get('id'), fp = url.searchParams.get('fp'), i = Number(url.searchParams.get('i'));
    if (!goodId(id) || !goodFp(fp) || !Number.isInteger(i) || i < 0) return json({ error: 'bad_plugin' }, 400);
    const row = await env.DB.prepare('SELECT owner, status FROM store_plugins WHERE id = ? AND fp = ?').bind(id, fp).first();
    if (!row || (row.status !== 'approved' && !allowPending)) return json({ error: 'not_found' }, 404);
    const c = await env.DB.prepare('SELECT data FROM store_chunks WHERE owner = ? AND id = ? AND fp = ? AND idx = ?').bind(row.owner, id, fp, i).first();
    if (!c) return json({ error: 'not_found' }, 404);
    return json({ ok: true, data: c.data });
}

// Upload one chunk. Chunks are filed under their uploader, so nobody can overwrite another person's files.
async function storePutChunk(request, env, who) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const index = Number(body.index), total = Number(body.total);
    if (!goodId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > MAX_PLUGIN_CHUNKS || index < 0 || index >= total) return json({ error: 'bad_plugin' }, 400);
    if (typeof body.data !== 'string' || !body.data.length || body.data.length > PLUGIN_CHUNK + 1000) return json({ error: 'too_large' }, 413);
    if (!who.owner && await limited(db, 'store:chunk:' + who.id, 400, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    await db.prepare('INSERT INTO store_chunks (owner, id, fp, idx, data, created) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(owner, id, fp, idx) DO UPDATE SET data = excluded.data, created = excluded.created')
        .bind(who.id, body.id, body.fp, index, body.data, now).run();
    return json({ ok: true });
}

// The plugin's picture: plugin.json \"icon\" names a png / jpg / webp file in the bundle. It is stored with the listing as a small
// data: address (60 KB at most) so the store list shows it without downloading the plugin. '' = none (never an error).
async function extractIcon(db, owner, id, fp, total) {
    try {
        const rows = await db.prepare('SELECT idx, data FROM store_chunks WHERE owner = ? AND id = ? AND fp = ? ORDER BY idx').bind(owner, id, fp).all();
        const bundle = JSON.parse((rows.results || []).map(r => r.data).join(''));
        const files = Array.isArray(bundle.files) ? bundle.files : [];
        const pj = files.find(f => f && f.p === 'plugin.json');
        if (!pj) return '';
        const manifest = JSON.parse(atob(pj.d).replace(/^\uFEFF/, ''));
        const name = manifest && typeof manifest.icon === 'string' ? manifest.icon : '';
        const m = /\.(png|jpe?g|webp)$/i.exec(name);
        if (!m) return '';
        const f = files.find(x => x && x.p === name);
        if (!f || typeof f.d !== 'string' || f.d.length > 80000) return '';   // base64: about 60 KB of picture
        const mime = m[1].toLowerCase() === 'png' ? 'image/png' : m[1].toLowerCase() === 'webp' ? 'image/webp' : 'image/jpeg';
        return 'data:' + mime + ';base64,' + f.d;
    } catch (e) { return ''; }
}

// official = true only ever comes from the owner route.
async function storeCommit(request, env, who, official) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const total = Number(body.total), size = Number(body.size);
    const kind = body.kind === 'skin' ? 'skin' : 'plugin';
    if (!goodStoreId(body.id, kind, official) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isInteger(total) || total < 1 || total > MAX_PLUGIN_CHUNKS) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isFinite(size) || size < 1 || size > (kind === 'skin' ? MAX_SKIN_RAW : STORE_MAX_SIZE)) return json({ error: 'too_large' }, 413);
    const have = await db.prepare('SELECT COUNT(*) AS n FROM store_chunks WHERE owner = ? AND id = ? AND fp = ?').bind(who.id, body.id, body.fp).first();
    if (!have || have.n !== total) return json({ error: 'incomplete' }, 400);

    const cur = await db.prepare('SELECT owner, shelf, kind FROM store_plugins WHERE id = ?').bind(body.id).first();
    if (cur && (cur.kind === 'skin' ? 'skin' : 'plugin') !== kind) return json({ error: 'id_taken' }, 409);   // ids are shared by plugins and skins
    if (!official) {
        if (cur && (cur.shelf === 'official' || cur.owner !== who.id)) return json({ error: 'id_taken' }, 409);
        const mine = await db.prepare("SELECT COUNT(*) AS n FROM store_plugins WHERE owner = ? AND shelf = 'community' AND id != ?").bind(who.id, body.id).first();
        if (mine && mine.n >= STORE_MAX_PER_USER) return json({ error: 'store_quota' }, 413);
        if (await limited(db, 'store:submit:' + who.id, 20, 24 * 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    }
    const shelf = official ? 'official' : 'community';
    const status = official ? 'approved' : 'pending';          // community uploads wait for an owner
    // On Community the author is always the signed-in GitHub account, whatever plugin.json says.
    const author = official ? (shortText(body.author, 80) || who.login) : who.login;
    const icon = kind === 'plugin' ? await extractIcon(db, who.id, body.id, body.fp, total) : '';
    await db.batch([
        db.prepare('INSERT INTO store_plugins (id, shelf, name, version, author, description, size, fp, chunks, status, owner, updated, kind, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET shelf = excluded.shelf, name = excluded.name, version = excluded.version, author = excluded.author, ' +
            'description = excluded.description, size = excluded.size, fp = excluded.fp, chunks = excluded.chunks, status = excluded.status, owner = excluded.owner, updated = excluded.updated, kind = excluded.kind, icon = excluded.icon')
            .bind(body.id, shelf, shortText(body.name, 80) || body.id, shortText(body.version, 40), author,
                  shortText(body.description, 200), Math.floor(size), body.fp, total, status, who.id, now, kind, icon),
        db.prepare('DELETE FROM store_chunks WHERE id = ? AND NOT EXISTS (SELECT 1 FROM store_plugins p WHERE p.id = store_chunks.id AND p.owner = store_chunks.owner AND p.fp = store_chunks.fp)')
            .bind(body.id)
    ]);
    return json({ ok: true, status });
}

async function storeMine(env, who) {
    const rows = await env.DB.prepare('SELECT * FROM store_plugins WHERE owner = ? ORDER BY id').bind(who.id).all();
    return json({ ok: true, items: (rows.results || []).map(storeItem) });
}

async function storeRemove(request, env, who, asOwner) {
    const { body, err } = await readJson(request); if (err) return err;
    if (!goodId(body.id)) return json({ error: 'bad_plugin' }, 400);
    const row = await env.DB.prepare('SELECT owner FROM store_plugins WHERE id = ?').bind(body.id).first();
    if (!row || (!asOwner && row.owner !== who.id)) return json({ error: 'not_found' }, 404);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM store_plugins WHERE id = ?').bind(body.id),
        env.DB.prepare('DELETE FROM store_chunks WHERE id = ? AND owner = ?').bind(body.id, row.owner)
    ]);
    return json({ ok: true });
}

async function storeOwnerAll(env) {
    const rows = await env.DB.prepare("SELECT * FROM store_plugins ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, shelf, name").all();
    return json({ ok: true, items: (rows.results || []).map(storeItem) });
}

async function storeOwnerApprove(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    if (!goodId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    // approving names the exact version (fp) that was reviewed, so a re-upload can't slip in between
    const r = await env.DB.prepare("UPDATE store_plugins SET status = 'approved' WHERE id = ? AND fp = ? AND shelf = 'community'").bind(body.id, body.fp).run();
    if (!r.meta || !r.meta.changes) return json({ error: 'not_found' }, 404);
    return json({ ok: true });
}

// ---------------------------------------------------------------- router
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const url = new URL(request.url);
        const path = url.pathname, method = request.method;
        if (path === '/' && method === 'GET') return new Response('pek-store ok', { headers: Object.assign({ 'Content-Type': 'text/plain' }, CORS) });
        try {
            if (!env.DB) return json({ error: 'no_database_bound' }, 500);
            await init(env.DB);

            // GitHub sign-in (used by the GitHub Pages site)
            if (method === 'GET' && path === '/v1/gh/login') return await ghLogin(url, request, env);
            if (method === 'GET' && path === '/v1/gh/callback') return await ghCallback(url, env);
            // PEK Store: browsing and downloading need no sign-in at all
            if (method === 'GET' && path === '/v1/store') return await storeList(url, env);
            if (method === 'GET' && path === '/v1/store/chunk') return await storeGetChunk(url, env, false);
            // PEK Store: uploads and owner tools need a GitHub sign-in
            if (path.indexOf('/v1/store/') === 0 || path.indexOf('/v1/gh/') === 0) {
                const who = await ghSession(request, env, Date.now());
                if (!who) return json({ error: 'bad_session' }, 401);
                if (method === 'GET' && path === '/v1/gh/me') return json({ ok: true, login: who.login, owner: who.owner });
                if (method === 'POST' && path === '/v1/gh/logout') { await env.DB.prepare('DELETE FROM gh_sessions WHERE token_hash = ?').bind(who.hash).run(); return json({ ok: true }); }
                if (method === 'POST' && path === '/v1/store/chunk') return await storePutChunk(request, env, who);
                if (method === 'POST' && path === '/v1/store/submit') return await storeCommit(request, env, who, false);
                if (method === 'GET' && path === '/v1/store/mine') return await storeMine(env, who);
                if (method === 'POST' && path === '/v1/store/remove') return await storeRemove(request, env, who, false);
                if (path.indexOf('/v1/store/owner/') === 0) {
                    if (!who.owner) return json({ error: 'forbidden' }, 403);
                    if (method === 'POST' && path === '/v1/store/owner/chunk') return await storePutChunk(request, env, who);
                    if (method === 'POST' && path === '/v1/store/owner/commit') return await storeCommit(request, env, who, true);
                    if (method === 'GET' && path === '/v1/store/owner/chunk') return await storeGetChunk(url, env, true);
                    if (method === 'GET' && path === '/v1/store/owner/all') return await storeOwnerAll(env);
                    if (method === 'POST' && path === '/v1/store/owner/approve') return await storeOwnerApprove(request, env);
                    if (method === 'POST' && path === '/v1/store/owner/remove') return await storeRemove(request, env, who, true);
                }
                return json({ error: 'not_found' }, 404);
            }

            return json({ error: 'not_found' }, 404);
        } catch (e) {
            console.error('worker error', String(e && e.stack || e));
            return json({ error: 'server_error' }, 500);
        }
    }
};
