// Hesper Cloud: accounts + sync service for watch history and resume positions.
// Runs as a Cloudflare Worker with ONE D1 database bound as "DB".
//
// Accounts are an email address and a password.
//   - Passwords are stored only as salted PBKDF2-SHA256 hashes.
//   - A sign-in gives the device a random session token (only its SHA-256 hash is stored).
//   - New accounts must verify their email: sign-up emails a 6-digit code (Brevo, https://www.brevo.com),
//     and the device is only signed in once the code is entered.
//   - "Forgot password" emails a 6-digit code the same way (and also counts as verifying the email).
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   BREVO_API_KEY       (Secret)  your Brevo API key
//   BREVO_SENDER_EMAIL  (Text)    a sender address you verified in Brevo
//   BREVO_SENDER_NAME   (Text, optional)  shown as the sender name, default "Hesper"
//
// Routes:
//   POST   /v1/auth/signup   { email, password }                -> { ok, needsVerify, email }   (code emailed)
//   POST   /v1/auth/verify   { email, code }                    -> { ok, token, email }
//   POST   /v1/auth/resend   { email }                          -> { ok }   (always)
//   POST   /v1/auth/login    { email, password }                -> { ok, token, email }  or 403 email_not_verified
//   POST   /v1/auth/forgot   { email }                          -> { ok }   (always, so emails can't be probed)
//   POST   /v1/auth/reset    { email, code, password }          -> { ok, token, email }
//   POST   /v1/auth/logout                                      -> { ok }
//   POST   /v1/sync          push changed items, pull newer ones
//   GET    /v1/export        everything stored for the account (JSON)
//   DELETE /v1/account       permanently delete the account and all its data
//
// Everything except /v1/auth/{signup,verify,resend,login,forgot,reset} needs:  Authorization: Bearer <session token>

const MAX_BODY = 1024 * 1024;     // bytes per request
const MAX_PUSH = 900;             // items per sync request (srv ordering needs < 1000)
const PAGE = 2000;                // items returned per pull page
const MAX_ITEMS = 50000;          // per account
const MAX_DATA = 2000;            // chars of JSON per item
const MAX_KEY = 200;
const CLOCK_SLACK = 5 * 60 * 1000;

const PBKDF2_ITERATIONS = 100000; // the most Cloudflare Workers allows. Stored per user, so it is safe to change later.
const SESSION_TTL = 90 * 24 * 3600 * 1000;
const SESSION_REFRESH_BELOW = 60 * 24 * 3600 * 1000;
const RESET_TTL = 15 * 60 * 1000;
const RESET_MAX_TRIES = 5;
const VERIFY_TTL = 30 * 60 * 1000;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

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

// ---------------------------------------------------------------- database
let ready = false;
async function init(db) {
    if (ready) return;
    // one at a time: an index can only be created once its table exists
    await db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pw TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0)').run();
    // A users table made before email verification existed has no such column: add it (those accounts count as verified).
    try { await db.prepare('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1').run(); } catch (e) { /* already there */ }
    await db.prepare('CREATE TABLE IF NOT EXISTS verifs (user_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS resets (user_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS throttle (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS items (acct TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, srv INTEGER NOT NULL, PRIMARY KEY (acct, kind, key))').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS items_srv ON items (acct, srv)').run();
    ready = true;
}

// ---------------------------------------------------------------- crypto helpers
const enc = new TextEncoder();

function hex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
function unhex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
}
async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
function randomHex(nBytes) { return hex(crypto.getRandomValues(new Uint8Array(nBytes))); }
function randomToken() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sixDigits() {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / 1000000) * 1000000;   // no modulo bias
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return String(buf[0] % 1000000).padStart(6, '0');
}
function sameString(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

async function pbkdf2(password, saltBytes, iterations) {
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
    return hex(bits);
}
// Stored as  pbkdf2$<iterations>$<salt hex>$<hash hex>
async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + hex(salt) + '$' + await pbkdf2(password, salt, PBKDF2_ITERATIONS);
}
async function checkPassword(password, stored) {
    const p = String(stored || '').split('$');
    if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
    const got = await pbkdf2(password, unhex(p[2]), parseInt(p[1], 10));
    return sameString(got, p[3]);
}
let dummyHash = null;   // so "no such email" costs as much time as "wrong password"
async function burnTime(password) {
    if (!dummyHash) dummyHash = await hashPassword('hesper-dummy');
    await checkPassword(password, dummyHash);
}

// ---------------------------------------------------------------- input checks
function cleanEmail(v) {
    const e = String(v == null ? '' : v).trim().toLowerCase();
    if (e.length < 5 || e.length > 254) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
    return e;
}
function goodPassword(v) {
    return typeof v === 'string' && v.length >= MIN_PASSWORD && v.length <= MAX_PASSWORD;
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
async function clearLimit(db, key) { await db.prepare('DELETE FROM throttle WHERE k = ?').bind(key).run(); }
function clientIp(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }

// ---------------------------------------------------------------- sessions
async function startSession(db, userId, now) {
    const token = randomToken();
    await db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)')
        .bind(await sha256Hex('hesper:session:' + token), userId, now, now + SESSION_TTL).run();
    // tidy up: expired sessions, expired throttle rows, expired reset codes
    await db.batch([
        db.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
        db.prepare('DELETE FROM throttle WHERE reset_at < ?').bind(now),
        db.prepare('DELETE FROM resets WHERE expires < ?').bind(now),
        db.prepare('DELETE FROM verifs WHERE expires < ?').bind(now)
    ]);
    return token;
}

async function sessionFor(request, db, now) {
    const h = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m || m[1].length < 20 || m[1].length > 100) return null;
    const hash = await sha256Hex('hesper:session:' + m[1]);
    const row = await db.prepare('SELECT user_id, expires FROM sessions WHERE token_hash = ?').bind(hash).first();
    if (!row || row.expires < now) return null;
    if (row.expires - now < SESSION_REFRESH_BELOW) {
        await db.prepare('UPDATE sessions SET expires = ? WHERE token_hash = ?').bind(now + SESSION_TTL, hash).run();
    }
    return { userId: row.user_id, tokenHash: hash };
}

// ---------------------------------------------------------------- email (Brevo)
const MAILS = {
    reset: {
        subject: 'Your Hesper password reset code',
        title: 'Reset your Hesper password',
        lead: 'Enter this code in the app:',
        foot: 'It works for 15 minutes. If you did not ask to reset your password, ignore this email; your password has not changed.',
        text: 'Your Hesper password reset code is {code}\n\nIt works for 15 minutes. If you did not ask to reset your password, you can ignore this email; your password has not changed.'
    },
    verify: {
        subject: 'Verify your email for Hesper',
        title: 'Verify your email',
        lead: 'Enter this code in the app to finish creating your Hesper account:',
        foot: 'It works for 30 minutes. If you did not create a Hesper account, ignore this email and nothing will happen.',
        text: 'Your Hesper verification code is {code}\n\nIt works for 30 minutes. If you did not create a Hesper account, you can ignore this email.'
    }
};

async function sendCodeEmail(env, to, code, kind) {
    const m = MAILS[kind];
    const sender = { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || 'Hesper' };
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'accept': 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
            sender,
            to: [{ email: to }],
            subject: m.subject,
            textContent: m.text.replace('{code}', code),
            htmlContent:
                '<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#111">' +
                '<h2 style="margin:0 0 12px">' + m.title + '</h2>' +
                '<p style="margin:0 0 16px">' + m.lead + '</p>' +
                '<p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:0 0 16px">' + code + '</p>' +
                '<p style="margin:0;color:#555;font-size:14px">' + m.foot + '</p>' +
                '</div>'
        })
    });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
        console.error('Brevo send failed', res.status, detail);
        return false;
    }
    return true;
}

function emailReady(env) { return !!(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL); }

// Makes a fresh verification code for an unverified account and emails it.
// Returns false when the per-email hourly limit stopped it from sending.
async function issueVerification(env, db, userId, email, now) {
    if (await limited(db, 'verify:mail:' + email, 5, 3600 * 1000, now)) return false;
    const code = sixDigits();
    await db.prepare('INSERT INTO verifs (user_id, code_hash, expires, tries) VALUES (?, ?, ?, 0) ' +
        'ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0')
        .bind(userId, await sha256Hex('hesper:verify:' + userId + ':' + code), now + VERIFY_TTL).run();
    try { await sendCodeEmail(env, email, code, 'verify'); } catch (e) { console.error('Brevo request error', String(e)); }
    return true;
}

// ---------------------------------------------------------------- auth handlers
async function handleSignup(request, env) {
    if (!emailReady(env)) return json({ error: 'email_not_configured' }, 500);
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    if (!email) return json({ error: 'bad_email' }, 400);
    if (!goodPassword(body.password)) return json({ error: 'weak_password' }, 400);
    if (await limited(db, 'signup:ip:' + clientIp(request), 10, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);

    const existing = await db.prepare('SELECT id, verified FROM users WHERE email = ?').bind(email).first();
    if (existing && existing.verified) return json({ error: 'email_taken' }, 409);

    const pw = await hashPassword(body.password);
    let id;
    if (existing) {
        // Someone started this sign-up but never verified. The newest attempt takes it over, so nobody can
        // lock a real owner out of their own address by registering it first.
        id = existing.id;
        await db.prepare('UPDATE users SET pw = ?, created = ? WHERE id = ?').bind(pw, now, id).run();
    } else {
        id = randomHex(16);
        try {
            await db.prepare('INSERT INTO users (id, email, pw, created, last_seen, verified) VALUES (?, ?, ?, ?, ?, 0)')
                .bind(id, email, pw, now, now).run();
        } catch (e) {
            return json({ error: 'email_taken' }, 409);     // lost a race with a second sign-up
        }
    }
    if (!(await issueVerification(env, db, id, email, now))) return json({ error: 'rate_limited' }, 429);
    return json({ ok: true, needsVerify: true, email });
}

async function handleVerify(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    const code = String(body.code == null ? '' : body.code).replace(/\D/g, '');
    if (!email || code.length !== 6) return json({ error: 'bad_code' }, 400);
    if (await limited(db, 'verify:ip:' + clientIp(request), 30, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);

    const user = await db.prepare('SELECT id, verified FROM users WHERE email = ?').bind(email).first();
    const row = user ? await db.prepare('SELECT code_hash, expires, tries FROM verifs WHERE user_id = ?').bind(user.id).first() : null;
    if (!user || !row || row.expires < now || row.tries >= RESET_MAX_TRIES) return json({ error: 'bad_code' }, 400);

    if (!sameString(await sha256Hex('hesper:verify:' + user.id + ':' + code), row.code_hash)) {
        await db.prepare('UPDATE verifs SET tries = tries + 1 WHERE user_id = ?').bind(user.id).run();
        return json({ error: 'bad_code' }, 400);
    }
    await db.batch([
        db.prepare('UPDATE users SET verified = 1, last_seen = ? WHERE id = ?').bind(now, user.id),
        db.prepare('DELETE FROM verifs WHERE user_id = ?').bind(user.id)
    ]);
    return json({ ok: true, token: await startSession(db, user.id, now), email });
}

// Sends a new verification code to an unverified account. Always answers ok.
async function handleResend(request, env) {
    if (!emailReady(env)) return json({ error: 'email_not_configured' }, 500);
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    if (!email) return json({ error: 'bad_email' }, 400);
    if (await limited(db, 'resend:ip:' + clientIp(request), 20, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    const user = await db.prepare('SELECT id, verified FROM users WHERE email = ?').bind(email).first();
    if (user && !user.verified) await issueVerification(env, db, user.id, email, now);
    return json({ ok: true });
}

async function handleLogin(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD) : '';
    if (!email || !password) return json({ error: 'bad_credentials' }, 401);

    const ipKey = 'login:ip:' + clientIp(request), mailKey = 'login:mail:' + email;
    if (await limited(db, ipKey, 30, 15 * 60 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    const row = await db.prepare('SELECT id, pw, verified FROM users WHERE email = ?').bind(email).first();
    // check the per-email limit without counting yet; failures are counted below
    const lim = await db.prepare('SELECT n, reset_at FROM throttle WHERE k = ?').bind(mailKey).first();
    if (lim && lim.reset_at > now && lim.n >= 8) return json({ error: 'rate_limited' }, 429);

    let ok = false;
    if (row) ok = await checkPassword(password, row.pw); else await burnTime(password);
    if (!ok) {
        await limited(db, mailKey, 8, 15 * 60 * 1000, now);
        return json({ error: 'bad_credentials' }, 401);
    }
    await clearLimit(db, mailKey);
    if (!row.verified) {
        // right password, but the email was never confirmed: send a fresh code and let the app ask for it
        if (emailReady(env)) await issueVerification(env, db, row.id, email, now);
        return json({ error: 'email_not_verified' }, 403);
    }
    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, row.id).run();
    return json({ ok: true, token: await startSession(db, row.id, now), email });
}

async function handleForgot(request, env) {
    if (!emailReady(env)) return json({ error: 'email_not_configured' }, 500);
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    if (!email) return json({ error: 'bad_email' }, 400);
    if (await limited(db, 'forgot:ip:' + clientIp(request), 20, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    if (await limited(db, 'forgot:mail:' + email, 5, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);

    const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (user) {
        const code = sixDigits();
        await db.prepare('INSERT INTO resets (user_id, code_hash, expires, tries) VALUES (?, ?, ?, 0) ' +
            'ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0')
            .bind(user.id, await sha256Hex('hesper:reset:' + user.id + ':' + code), now + RESET_TTL).run();
        try { await sendCodeEmail(env, email, code, 'reset'); } catch (e) { console.error('Brevo request error', String(e)); }
    }
    return json({ ok: true });   // same answer whether or not the email has an account
}

async function handleReset(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    const code = String(body.code == null ? '' : body.code).replace(/\D/g, '');
    if (!email || code.length !== 6) return json({ error: 'bad_code' }, 400);
    if (!goodPassword(body.password)) return json({ error: 'weak_password' }, 400);
    if (await limited(db, 'reset:ip:' + clientIp(request), 30, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);

    const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    const row = user ? await db.prepare('SELECT code_hash, expires, tries FROM resets WHERE user_id = ?').bind(user.id).first() : null;
    if (!user || !row || row.expires < now || row.tries >= RESET_MAX_TRIES) return json({ error: 'bad_code' }, 400);

    const good = sameString(await sha256Hex('hesper:reset:' + user.id + ':' + code), row.code_hash);
    if (!good) {
        await db.prepare('UPDATE resets SET tries = tries + 1 WHERE user_id = ?').bind(user.id).run();
        return json({ error: 'bad_code' }, 400);
    }
    await db.batch([
        db.prepare('UPDATE users SET pw = ?, last_seen = ?, verified = 1 WHERE id = ?').bind(await hashPassword(body.password), now, user.id),   // a reset code proves the email too
        db.prepare('DELETE FROM resets WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM verifs WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id)      // everyone is signed out
    ]);
    await clearLimit(db, 'login:mail:' + email);
    return json({ ok: true, token: await startSession(db, user.id, now), email });
}

async function handleLogout(env, sess) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sess.tokenHash).run();
    return json({ ok: true });
}

// ---------------------------------------------------------------- sync handlers
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
    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, acct).run();

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
    const user = await env.DB.prepare('SELECT email, created FROM users WHERE id = ?').bind(acct).first();
    const rows = await env.DB.prepare(
        'SELECT kind, key, data, updated, deleted FROM items WHERE acct = ? ORDER BY updated'
    ).bind(acct).all();
    const items = (rows.results || []).map(r => {
        let data = {};
        try { data = JSON.parse(r.data); } catch (e) { /* keep {} */ }
        return { kind: r.kind === 'h' ? 'history' : 'progress', key: r.key, data, updated: r.updated, deleted: !!r.deleted };
    });
    return json({ exported: Date.now(), email: user ? user.email : '', items });
}

async function handleDelete(env, acct) {
    await env.DB.batch([
        env.DB.prepare('DELETE FROM items WHERE acct = ?').bind(acct),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(acct),
        env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(acct),
        env.DB.prepare('DELETE FROM verifs WHERE user_id = ?').bind(acct),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(acct)
    ]);
    return json({ ok: true });
}

// ---------------------------------------------------------------- router
export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const url = new URL(request.url);
        const path = url.pathname, method = request.method;
        if (path === '/' && method === 'GET') {
            return new Response('hesper-sync ok', { headers: Object.assign({ 'Content-Type': 'text/plain' }, CORS) });
        }
        try {
            if (!env.DB) return json({ error: 'no_database_bound' }, 500);
            await init(env.DB);

            if (method === 'POST' && path === '/v1/auth/signup') return await handleSignup(request, env);
            if (method === 'POST' && path === '/v1/auth/verify') return await handleVerify(request, env);
            if (method === 'POST' && path === '/v1/auth/resend') return await handleResend(request, env);
            if (method === 'POST' && path === '/v1/auth/login') return await handleLogin(request, env);
            if (method === 'POST' && path === '/v1/auth/forgot') return await handleForgot(request, env);
            if (method === 'POST' && path === '/v1/auth/reset') return await handleReset(request, env);

            const sess = await sessionFor(request, env.DB, Date.now());
            if (!sess) return json({ error: 'bad_session' }, 401);

            if (method === 'POST' && path === '/v1/auth/logout') return await handleLogout(env, sess);
            if (method === 'POST' && path === '/v1/sync') return await handleSync(request, env, sess.userId);
            if (method === 'GET' && path === '/v1/export') return await handleExport(env, sess.userId);
            if (method === 'DELETE' && path === '/v1/account') return await handleDelete(env, sess.userId);
            return json({ error: 'not_found' }, 404);
        } catch (e) {
            console.error('worker error', String(e && e.stack || e));
            return json({ error: 'server_error' }, 500);
        }
    }
};
