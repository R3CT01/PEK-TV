// Hesper Cloud: sync service for watch history + resume positions.
// Runs as a Cloudflare Worker with ONE D1 database bound as "DB".
//
// Accounts are a secret sync key (made on the device). Only a SHA-256 hash of
// the key is stored, so a database leak does not expose anyone's key.
//
//   POST   /v1/sync     push changed items, pull everything newer than a cursor
//   GET    /v1/export   everything stored for the account (JSON)
//   DELETE /v1/account  permanently delete the account and all its data
//
// Auth for all three:  Authorization: Bearer <sync key>

const MAX_BODY = 1024 * 1024;     // bytes per request
const MAX_PUSH = 900;             // items per sync request (srv ordering needs < 1000)
const PAGE = 2000;                // items returned per pull page
const MAX_ITEMS = 50000;          // per account
const MAX_DATA = 2000;            // chars of JSON per item
const MAX_KEY = 200;
const CLOCK_SLACK = 5 * 60 * 1000;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
};

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
    });
}

let ready = false;
async function init(db) {
    if (ready) return;
    // one at a time: the index can only be created once the table exists
    await db.prepare('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created INTEGER NOT NULL, last_seen INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS items (acct TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, srv INTEGER NOT NULL, PRIMARY KEY (acct, kind, key))').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS items_srv ON items (acct, srv)').run();
    ready = true;
}

async function accountId(request) {
    const h = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const key = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key.length < 20 || key.length > 64) return null;
    const bytes = new TextEncoder().encode('hesper:v1:' + key);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanItem(it, now) {
    if (!it || typeof it !== 'object') return null;
    if (typeof it.key !== 'string' || !it.key || it.key.length > MAX_KEY) return null;
    if (!/^[me]\|/.test(it.key)) return null;
    const updated = Number(it.updated);
    if (!Number.isFinite(updated) || updated <= 0) return null;
    const deleted = it.deleted ? 1 : 0;
    const data = deleted ? '{}' : JSON.stringify(it.data && typeof it.data === 'object' ? it.data : {});
    if (data.length > MAX_DATA) return null;
    return { key: it.key, data, updated: Math.min(Math.floor(updated), now + CLOCK_SLACK), deleted };
}

async function handleSync(request, env, acct) {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad_json' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: 'bad_json' }, 400);

    const db = env.DB;
    const now = Date.now();

    const existing = await db.prepare('SELECT id FROM accounts WHERE id = ?').bind(acct).first();
    if (!existing) {
        if (!body.create) return json({ error: 'no_account' }, 404);
        await db.prepare('INSERT OR IGNORE INTO accounts (id, created, last_seen) VALUES (?, ?, ?)').bind(acct, now, now).run();
    } else {
        await db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').bind(now, acct).run();
    }

    // ---- push: last writer wins per item, by the item's own "updated" time
    const pushed = [];
    for (const kind of ['h', 'p']) {
        const list = Array.isArray(body[kind === 'h' ? 'history' : 'progress']) ? body[kind === 'h' ? 'history' : 'progress'] : [];
        for (const raw of list) pushed.push([kind, raw]);
    }
    if (pushed.length > MAX_PUSH) return json({ error: 'too_many_items' }, 413);

    if (pushed.length) {
        const countRow = await db.prepare('SELECT COUNT(*) AS n FROM items WHERE acct = ?').bind(acct).first();
        let total = countRow ? countRow.n : 0;
        const stmts = [];
        let i = 0;
        for (const [kind, raw] of pushed) {
            const it = cleanItem(raw, now);
            if (!it) continue;
            if (total >= MAX_ITEMS) break;
            total++;
            stmts.push(db.prepare(
                'INSERT INTO items (acct, kind, key, data, updated, deleted, srv) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(acct, kind, key) DO UPDATE SET data = excluded.data, updated = excluded.updated, ' +
                'deleted = excluded.deleted, srv = excluded.srv WHERE excluded.updated > items.updated'
            ).bind(acct, kind, it.key, it.data, it.updated, it.deleted, now * 1000 + (i++)));
        }
        if (stmts.length) await db.batch(stmts);
    }

    // ---- pull: everything stored at or after the client's cursor
    const since = Math.max(0, Number(body.since) || 0);
    const rows = await db.prepare(
        'SELECT kind, key, data, updated, deleted, srv FROM items WHERE acct = ? AND srv >= ? ORDER BY srv, kind, key LIMIT ?'
    ).bind(acct, since, PAGE).all();
    const results = rows.results || [];

    const out = { history: [], progress: [] };
    let cursor = since;
    for (const r of results) {
        let data = {};
        try { data = JSON.parse(r.data); } catch (e) { /* keep {} */ }
        const item = { key: r.key, data, updated: r.updated, deleted: r.deleted ? 1 : 0 };
        (r.kind === 'h' ? out.history : out.progress).push(item);
        if (r.srv > cursor) cursor = r.srv;
    }
    return json({ ok: true, cursor, more: results.length === PAGE, history: out.history, progress: out.progress });
}

async function handleExport(env, acct) {
    const rows = await env.DB.prepare(
        'SELECT kind, key, data, updated, deleted FROM items WHERE acct = ? ORDER BY updated'
    ).bind(acct).all();
    const items = (rows.results || []).map(r => {
        let data = {};
        try { data = JSON.parse(r.data); } catch (e) { /* keep {} */ }
        return { kind: r.kind === 'h' ? 'history' : 'progress', key: r.key, data, updated: r.updated, deleted: !!r.deleted };
    });
    return json({ exported: Date.now(), items });
}

async function handleDelete(env, acct) {
    await env.DB.batch([
        env.DB.prepare('DELETE FROM items WHERE acct = ?').bind(acct),
        env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(acct)
    ]);
    return json({ ok: true });
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const url = new URL(request.url);
        if (url.pathname === '/' && request.method === 'GET') {
            return new Response('hesper-sync ok', { headers: Object.assign({ 'Content-Type': 'text/plain' }, CORS) });
        }
        try {
            if (!env.DB) return json({ error: 'no_database_bound' }, 500);
            await init(env.DB);
            const acct = await accountId(request);
            if (!acct) return json({ error: 'bad_key' }, 401);

            if (url.pathname === '/v1/sync' && request.method === 'POST') return await handleSync(request, env, acct);
            if (url.pathname === '/v1/export' && request.method === 'GET') {
                const ok = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(acct).first();
                return ok ? await handleExport(env, acct) : json({ error: 'no_account' }, 404);
            }
            if (url.pathname === '/v1/account' && request.method === 'DELETE') return await handleDelete(env, acct);
            return json({ error: 'not_found' }, 404);
        } catch (e) {
            return json({ error: 'server_error' }, 500);
        }
    }
};
