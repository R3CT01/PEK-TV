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
//   BREVO_SENDER_NAME   (Text, optional)  shown as the sender name, default "PEK TV"
//
// Routes:
//   POST   /v1/auth/signup   { email, password }                -> { ok, needsVerify, email }   (code emailed)
//   POST   /v1/auth/verify   { email, code }                    -> { ok, token, email }   (finishes a sign-up OR a sign-in)
//   POST   /v1/auth/resend   { email }                          -> { ok }   (always; new code for an unconfirmed account or a pending sign-in)
//   POST   /v1/auth/login    { email, password }                -> { ok, needsVerify, email }  (a 6-digit code is emailed; every sign-in needs it)
//                                                                  or 403 email_not_verified (new account that never confirmed its email)
//   POST   /v1/auth/forgot   { email }                          -> { ok }   (always, so emails can't be probed)
//   POST   /v1/auth/reset    { email, code, password }          -> { ok, token, email }
//   POST   /v1/auth/logout                                      -> { ok }
//   POST   /v1/auth/confirm  { password }                      -> { ok }   (re-checks the signed-in account's password, e.g. to reset a forgotten profile passcode; rate limited)
//   POST   /v1/profiles/sync { profiles: [{id,name,color,updated,deleted,avatar,pin}] } -> { ok, profiles, rejected }   (the household's profiles, last writer wins;
//                                                                  avatar = built-in picture id or a small photo, pin = salted passcode hash, both optional)
//   POST   /v1/sync          push changed items (history, progress, favorites) of ONE profile ({ profile, since, ... }), pull newer ones
//   GET    /v1/plugins                                          -> { ok, plugins: [{id,name,version,size,fp,updated,deleted,chunks}] }
//   POST   /v1/plugins/chunk   { id, fp, index, total, data }   -> { ok }      (one piece of a plugin backup)
//   POST   /v1/plugins/commit  { id, fp, total, name, version, size, updated } -> { ok, stored }  (finishes a backup)
//   GET    /v1/plugins/chunk?id=&fp=&i=                         -> { ok, data }
//   POST   /v1/plugins/delete  { id, updated }                  -> { ok }
//   GET    /v1/export        everything stored for the account (JSON)
//   DELETE /v1/account       permanently delete the account and all its data
//
//   Plugin Store (see DEPLOY.md). Uploads need a GitHub sign-in, done on the GitHub Pages site:
//   GET    /v1/gh/login?ret=upload|owner  -> redirects to GitHub;  GET /v1/gh/callback -> back to the site with #token=
//   GET    /v1/store?shelf=official|community                   -> { ok, items }          (public)
//   GET    /v1/store/chunk?id=&fp=&i=                           -> { ok, data }           (public, approved only)
//   POST   /v1/store/chunk | /v1/store/submit | /v1/store/remove ; GET /v1/store/mine ; GET /v1/gh/me   (GitHub token)
//   POST   /v1/store/owner/{chunk,commit,approve,remove} ; GET /v1/store/owner/{all,chunk}             (owner accounts only)
//
// Everything except /v1/auth/{signup,verify,resend,login,forgot,reset} needs:  Authorization: Bearer <session token>

const MAX_BODY = 1024 * 1024;     // bytes per request
const MAX_PUSH = 900;             // items per sync request (srv ordering needs < 1000)
const PAGE = 2000;                // items returned per pull page
const MAX_ITEMS = 50000;          // per account
const MAX_DATA = 2000;            // chars of JSON per item
const MAX_KEY = 200;
const MAX_PROFILES = 5;           // live profiles per account (Netflix-style: each person has their own history and favorites)
const MAX_PROFILE_ROWS = 40;      // profile rows incl. removal markers, per account
const CLOCK_SLACK = 5 * 60 * 1000;

// Plugin backups (the plugin's own files, packed by the app into one text bundle and cut into chunks)
const MAX_PLUGINS = 30;                    // per account
const MAX_PLUGIN_RAW = 8 * 1024 * 1024;    // bytes of plugin files (same limit the app enforces when installing)
const PLUGIN_CHUNK = 400000;               // chars per chunk (the app uses the same size)
const MAX_PLUGIN_CHUNKS = 40;              // 40 x 400k chars is more than an 8 MB plugin needs
const MAX_PLUGIN_TOTAL = 60 * 1024 * 1024; // all of an account's plugin backups together (raw bytes)
const BUILTIN_PLUGINS = ['weather', 'sample_scraper', 'sample_counter', 'tmdb-discover'];

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
    await db.prepare('CREATE TABLE IF NOT EXISTS profiles (acct TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (acct, id))').run();
    // Profile picture and passcode hash (added later: older tables get the columns here).
    try { await db.prepare("ALTER TABLE profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    try { await db.prepare("ALTER TABLE profiles ADD COLUMN pin TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    await db.prepare('CREATE TABLE IF NOT EXISTS plugins (acct TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, size INTEGER NOT NULL, fp TEXT NOT NULL, chunks INTEGER NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (acct, id))').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS plugin_chunks (acct TEXT NOT NULL, id TEXT NOT NULL, fp TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (acct, id, fp, idx))').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS store_plugins (id TEXT PRIMARY KEY, shelf TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, author TEXT NOT NULL DEFAULT \'\', description TEXT NOT NULL DEFAULT \'\', size INTEGER NOT NULL, fp TEXT NOT NULL, chunks INTEGER NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL, updated INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS store_chunks (owner TEXT NOT NULL, id TEXT NOT NULL, fp TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (owner, id, fp, idx))').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS gh_states (state TEXT PRIMARY KEY, ret TEXT NOT NULL, created INTEGER NOT NULL)').run();
    await db.prepare('CREATE TABLE IF NOT EXISTS gh_sessions (token_hash TEXT PRIMARY KEY, gh_id TEXT NOT NULL, login TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)').run();
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
        db.prepare('DELETE FROM verifs WHERE expires < ?').bind(now),
        // half-finished plugin uploads (never committed) older than a day
        db.prepare('DELETE FROM plugin_chunks WHERE created < ? AND NOT EXISTS (SELECT 1 FROM plugins p WHERE p.acct = plugin_chunks.acct AND p.id = plugin_chunks.id AND p.fp = plugin_chunks.fp)').bind(now - 24 * 3600 * 1000)
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
        subject: 'Your PEK TV password reset code',
        title: 'Reset your PEK TV password',
        lead: 'Enter this code in the app:',
        foot: 'It works for 15 minutes. If you did not ask to reset your password, ignore this email; your password has not changed.',
        text: 'Your PEK TV password reset code is {code}\n\nIt works for 15 minutes. If you did not ask to reset your password, you can ignore this email; your password has not changed.'
    },
    login: {
        subject: 'Your PEK TV sign-in code',
        title: 'Confirm your sign-in',
        lead: 'Enter this code in the app to finish signing in:',
        foot: 'It works for 30 minutes. If you did not just try to sign in, someone has your password: use \"Forgot password\" in the app to choose a new one.',
        text: 'Your PEK TV sign-in code is {code}\n\nIt works for 30 minutes. If you did not just try to sign in, someone has your password: use \"Forgot password\" in the app to choose a new one.'
    },
    verify: {
        subject: 'Verify your email for PEK TV',
        title: 'Verify your email',
        lead: 'Enter this code in the app to finish creating your PEK TV account:',
        foot: 'It works for 30 minutes. If you did not create a PEK TV account, ignore this email and nothing will happen.',
        text: 'Your PEK TV verification code is {code}\n\nIt works for 30 minutes. If you did not create a PEK TV account, you can ignore this email.'
    }
};

async function sendCodeEmail(env, to, code, kind) {
    const m = MAILS[kind];
    const sender = { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || 'PEK TV' };
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

// Every sign-in of a confirmed account asks for an emailed code too (the password alone is not enough).
// Same table and check as the sign-up code: the app exchanges it at /v1/auth/verify for the session token.
// Returns 'sent', 'limited' (too many codes this hour) or 'failed' (the email could not be sent).
async function issueLoginCode(env, db, userId, email, now) {
    if (await limited(db, 'login:code:' + email, 6, 3600 * 1000, now)) return 'limited';
    const code = sixDigits();
    await db.prepare('INSERT INTO verifs (user_id, code_hash, expires, tries) VALUES (?, ?, ?, 0) ' +
        'ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0')
        .bind(userId, await sha256Hex('hesper:verify:' + userId + ':' + code), now + VERIFY_TTL).run();
    try { return (await sendCodeEmail(env, email, code, 'login')) ? 'sent' : 'failed'; }
    catch (e) { console.error('Brevo request error', String(e)); return 'failed'; }
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

// Sends a new code: to an unverified account, or to a sign-in that is waiting for its code. Always answers ok.
async function handleResend(request, env) {
    if (!emailReady(env)) return json({ error: 'email_not_configured' }, 500);
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const email = cleanEmail(body.email);
    if (!email) return json({ error: 'bad_email' }, 400);
    if (await limited(db, 'resend:ip:' + clientIp(request), 20, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    const user = await db.prepare('SELECT id, verified FROM users WHERE email = ?').bind(email).first();
    if (user && !user.verified) await issueVerification(env, db, user.id, email, now);
    else if (user) {
        // A confirmed account: only while a sign-in is waiting for its code (the password was right in the last few hours),
        // so nobody can use this to fill someone else's inbox.
        const pending = await db.prepare('SELECT expires FROM verifs WHERE user_id = ?').bind(user.id).first();
        if (pending && pending.expires + 2 * 3600 * 1000 > now) await issueLoginCode(env, db, user.id, email, now);
    }
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
    // Right password: now prove it is you with a code from the email. No session until the code is entered.
    if (!emailReady(env)) return json({ error: 'email_not_configured' }, 500);
    const sent = await issueLoginCode(env, db, row.id, email, now);
    if (sent === 'limited') return json({ error: 'rate_limited' }, 429);
    if (sent === 'failed') return json({ error: 'email_failed' }, 502);
    return json({ ok: true, needsVerify: true, email });
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
function cleanItem(it, now, kind) {
    if (!it || typeof it !== 'object') return null;
    if (typeof it.key !== 'string' || !it.key || it.key.length > MAX_KEY) return null;
    // history keys start m| / e| (movie / episode), favorites are f|movie:<id> or f|tv:<id>
    if (kind === 'f' ? !/^f\|(movie|tv):\d{1,10}$/.test(it.key) : !/^[me]\|/.test(it.key)) return null;
    const updated = Number(it.updated);
    if (!Number.isFinite(updated) || updated <= 0) return null;
    const deleted = it.deleted ? 1 : 0;
    const data = deleted ? '{}' : JSON.stringify(it.data && typeof it.data === 'object' ? it.data : {});
    if (data.length > MAX_DATA) return null;
    return { key: it.key, data, updated: Math.min(Math.floor(updated), now + CLOCK_SLACK), deleted };
}

// ---------------------------------------------------------------- profiles
// One account (email + password) for the household; each person in it is a profile with their own
// history, resume points and favorites. A profile's items live in the items table under
//   acct = <user id>                 for the profile called "p1" (the original one: accounts made before profiles
//                                    existed keep all of their data there, nothing is migrated)
//   acct = <user id>:<profile id>    for every other profile
// so every existing query keeps working, one namespace at a time. Plugin backups stay per account.
function goodProfileId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(id); }
function itemsAcct(userId, profile) { return (!profile || profile === 'p1') ? userId : userId + ':' + profile; }
function likeProfiles(userId) { return userId + ':%'; }   // user ids are hex: no wildcard characters

// A profile picture is a built-in avatar id ("b:cat") or a small JPEG photo ("d:data:image/jpeg;base64,..."). The passcode is only ever a
// salted hash made on the device ("<16 hex>:<64 hex>"), never the digits.
function goodAvatar(a) {
    if (a === '') return true;
    if (typeof a !== 'string' || a.length > 14000) return false;
    return /^b:[a-z]{2,16}$/.test(a) || /^d:data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(a);
}
function goodPin(p) { return p === '' || (typeof p === 'string' && /^[0-9a-f]{16}:[0-9a-f]{64}$/.test(p)); }

// POST /v1/auth/confirm  { password } -> { ok }   (session required)
// Lets the app re-check the account password, e.g. so a forgotten profile passcode can be removed. Shares the login
// failure limit, so it cannot be used to guess the password.
async function handleConfirm(request, env, userId) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD) : '';
    if (!password) return json({ error: 'bad_credentials' }, 401);
    const key = 'confirm:' + userId;
    const lim = await db.prepare('SELECT n, reset_at FROM throttle WHERE k = ?').bind(key).first();
    if (lim && lim.reset_at > now && lim.n >= 6) return json({ error: 'rate_limited' }, 429);
    const row = await db.prepare('SELECT pw FROM users WHERE id = ?').bind(userId).first();
    const ok = row ? await checkPassword(password, row.pw) : false;
    if (!ok) { await limited(db, key, 6, 15 * 60 * 1000, now); return json({ error: 'bad_credentials' }, 401); }
    await clearLimit(db, key);
    return json({ ok: true });
}

// POST /v1/profiles/sync  { profiles: [{ id, name, color, updated, deleted, avatar, pin }] } -> { ok, profiles, rejected }
// Last writer wins per profile, by its own "updated" time. Removing a profile (deleted: 1) also removes its stored items.
async function handleProfiles(request, env, userId) {
    const text = await request.text();
    if (text.length > 160 * 1024) return json({ error: 'too_large' }, 413);   // up to 5 small photos
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad_json' }, 400); }
    const incoming = body && Array.isArray(body.profiles) ? body.profiles.slice(0, 40) : null;
    if (!incoming) return json({ error: 'bad_json' }, 400);

    const db = env.DB;
    const now = Date.now();
    const rows = (await db.prepare('SELECT id, name, color, updated, deleted, avatar, pin FROM profiles WHERE acct = ?').bind(userId).all()).results || [];
    const have = {};
    rows.forEach(r => { have[r.id] = { id: r.id, name: r.name, color: r.color, updated: r.updated, deleted: r.deleted ? 1 : 0, avatar: r.avatar || '', pin: r.pin || '' }; });
    let live = rows.filter(r => !r.deleted).length;
    let total = rows.length;
    const stmts = [];
    const rejected = [];

    for (const raw of incoming) {
        if (!raw || typeof raw !== 'object' || !goodProfileId(raw.id)) continue;
        const updated = Math.min(Math.floor(Number(raw.updated) || 0), now + CLOCK_SLACK);
        if (updated < 0) continue;
        const deleted = raw.deleted ? 1 : 0;
        const name = deleted ? '' : String(raw.name == null ? '' : raw.name).replace(/\s+/g, ' ').trim().slice(0, 40);
        const color = deleted ? '' : (/^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#E04A00');
        if (!deleted && !name) continue;
        const avatar = deleted ? '' : goodAvatar(raw.avatar) ? raw.avatar : '';
        const pin = deleted ? '' : goodPin(raw.pin) ? raw.pin : '';
        const cur = have[raw.id];
        if (cur && updated <= cur.updated) continue;                       // the cloud's copy is as new or newer
        if (!cur && !deleted && live >= MAX_PROFILES) { rejected.push(raw.id); continue; }
        if (!cur && total >= MAX_PROFILE_ROWS) { rejected.push(raw.id); continue; }
        if (deleted && cur && !cur.deleted && live <= 1) { rejected.push(raw.id); continue; }   // never remove the last one
        if (deleted && !cur) continue;                                      // nothing to remove, nothing to remember
        if (!cur) total++;
        if (!cur || cur.deleted) { if (!deleted) live++; }
        else if (deleted) live--;
        have[raw.id] = { id: raw.id, name, color, updated, deleted, avatar, pin };
        stmts.push(db.prepare(
            'INSERT INTO profiles (acct, id, name, color, updated, deleted, avatar, pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(acct, id) DO UPDATE SET name = excluded.name, color = excluded.color, updated = excluded.updated, deleted = excluded.deleted, avatar = excluded.avatar, pin = excluded.pin'
        ).bind(userId, raw.id, name, color, updated, deleted, avatar, pin));
        if (deleted) stmts.push(db.prepare('DELETE FROM items WHERE acct = ?').bind(itemsAcct(userId, raw.id)));
    }
    if (stmts.length) await db.batch(stmts);
    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, userId).run();
    const out = Object.keys(have).map(k => have[k]).sort((a, b) => a.updated - b.updated || (a.id < b.id ? -1 : 1));
    return json({ ok: true, profiles: out, rejected });
}

async function handleSync(request, env, userId) {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad_json' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: 'bad_json' }, 400);

    const db = env.DB;
    const now = Date.now();
    await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, userId).run();

    // Which profile's data this is. No profile (an older app) means the original one, "p1".
    const profile = body.profile == null ? 'p1' : body.profile;
    if (!goodProfileId(profile)) return json({ error: 'bad_profile' }, 400);
    if (profile !== 'p1') {   // other profiles must have been announced through /v1/profiles/sync and not removed
        const pr = await db.prepare('SELECT deleted FROM profiles WHERE acct = ? AND id = ?').bind(userId, profile).first();
        if (!pr || pr.deleted) return json({ error: 'unknown_profile' }, 404);
    }
    const acct = itemsAcct(userId, profile);

    // ---- push: last writer wins per item, by the item's own "updated" time
    const pushed = [];
    for (const [kind, field] of [['h', 'history'], ['p', 'progress'], ['f', 'favorites']]) {
        const list = Array.isArray(body[field]) ? body[field] : [];
        for (const raw of list) pushed.push([kind, raw]);
    }
    if (pushed.length > MAX_PUSH) return json({ error: 'too_many_items' }, 413);

    if (pushed.length) {
        const countRow = await db.prepare('SELECT COUNT(*) AS n FROM items WHERE acct = ?').bind(acct).first();
        let total = countRow ? countRow.n : 0;
        const stmts = [];
        let i = 0;
        for (const [kind, raw] of pushed) {
            const it = cleanItem(raw, now, kind);
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

    const out = { history: [], progress: [], favorites: [] };
    let cursor = since;
    for (const r of results) {
        let data = {};
        try { data = JSON.parse(r.data); } catch (e) { /* keep {} */ }
        const item = { key: r.key, data, updated: r.updated, deleted: r.deleted ? 1 : 0 };
        (r.kind === 'h' ? out.history : r.kind === 'f' ? out.favorites : out.progress).push(item);
        if (r.srv > cursor) cursor = r.srv;
    }
    return json({ ok: true, profile, cursor, more: results.length === PAGE, history: out.history, progress: out.progress, favorites: out.favorites });
}

// ---------------------------------------------------------------- plugin backup handlers
function goodPluginId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) && BUILTIN_PLUGINS.indexOf(id) === -1; }
function goodFp(fp) { return typeof fp === 'string' && /^[a-f0-9]{8,64}$/.test(fp); }
function shortText(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

async function handlePluginList(env, acct) {
    const rows = await env.DB.prepare('SELECT id, name, version, size, fp, chunks, updated, deleted FROM plugins WHERE acct = ? ORDER BY id').bind(acct).all();
    const plugins = (rows.results || []).map(r => ({ id: r.id, name: r.name, version: r.version, size: r.size, fp: r.fp, chunks: r.chunks, updated: r.updated, deleted: r.deleted ? 1 : 0 }));
    return json({ ok: true, plugins });
}

async function handlePluginChunk(request, env, acct) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const index = Number(body.index), total = Number(body.total);
    if (!goodPluginId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > MAX_PLUGIN_CHUNKS || index < 0 || index >= total) return json({ error: 'bad_plugin' }, 400);
    if (typeof body.data !== 'string' || !body.data.length || body.data.length > PLUGIN_CHUNK + 1000) return json({ error: 'too_large' }, 413);
    if (await limited(db, 'plugin:chunk:' + acct, 800, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    await db.prepare('INSERT INTO plugin_chunks (acct, id, fp, idx, data, created) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(acct, id, fp, idx) DO UPDATE SET data = excluded.data, created = excluded.created')
        .bind(acct, body.id, body.fp, index, body.data, now).run();
    return json({ ok: true });
}

async function handlePluginCommit(request, env, acct) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const total = Number(body.total), size = Number(body.size), updated = Number(body.updated);
    if (!goodPluginId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isInteger(total) || total < 1 || total > MAX_PLUGIN_CHUNKS) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isFinite(size) || size < 1 || size > MAX_PLUGIN_RAW) return json({ error: 'too_large' }, 413);
    if (!Number.isFinite(updated) || updated <= 0) return json({ error: 'bad_plugin' }, 400);
    const when = Math.min(Math.floor(updated), now + CLOCK_SLACK);

    const have = await db.prepare('SELECT COUNT(*) AS n FROM plugin_chunks WHERE acct = ? AND id = ? AND fp = ?').bind(acct, body.id, body.fp).first();
    if (!have || have.n !== total) return json({ error: 'incomplete' }, 400);

    const cur = await db.prepare('SELECT updated, size FROM plugins WHERE acct = ? AND id = ?').bind(acct, body.id).first();
    if (cur && cur.updated >= when) {
        // the cloud already has a newer (or the same) copy; drop what was just uploaded
        await db.prepare('DELETE FROM plugin_chunks WHERE acct = ? AND id = ? AND fp = ? AND NOT EXISTS (SELECT 1 FROM plugins p WHERE p.acct = ? AND p.id = ? AND p.fp = ?)').bind(acct, body.id, body.fp, acct, body.id, body.fp).run();
        return json({ ok: true, stored: false });
    }
    const stats = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM plugins WHERE acct = ? AND deleted = 0 AND id != ?').bind(acct, body.id).first();
    if (stats && (stats.n >= MAX_PLUGINS || stats.bytes + size > MAX_PLUGIN_TOTAL)) return json({ error: 'plugin_quota' }, 413);

    await db.batch([
        db.prepare('INSERT INTO plugins (acct, id, name, version, size, fp, chunks, updated, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ' +
            'ON CONFLICT(acct, id) DO UPDATE SET name = excluded.name, version = excluded.version, size = excluded.size, fp = excluded.fp, ' +
            'chunks = excluded.chunks, updated = excluded.updated, deleted = 0')
            .bind(acct, body.id, shortText(body.name, 80) || body.id, shortText(body.version, 40), Math.floor(size), body.fp, total, when),
        db.prepare('DELETE FROM plugin_chunks WHERE acct = ? AND id = ? AND fp != ?').bind(acct, body.id, body.fp)
    ]);
    return json({ ok: true, stored: true });
}

async function handlePluginGetChunk(url, env, acct) {
    const id = url.searchParams.get('id'), fp = url.searchParams.get('fp'), i = Number(url.searchParams.get('i'));
    if (!goodPluginId(id) || !goodFp(fp) || !Number.isInteger(i) || i < 0) return json({ error: 'bad_plugin' }, 400);
    const row = await env.DB.prepare('SELECT data FROM plugin_chunks WHERE acct = ? AND id = ? AND fp = ? AND idx = ?').bind(acct, id, fp, i).first();
    if (!row) return json({ error: 'not_found' }, 404);
    return json({ ok: true, data: row.data });
}

async function handlePluginDelete(request, env, acct) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const updated = Number(body.updated);
    if (!goodPluginId(body.id) || !Number.isFinite(updated) || updated <= 0) return json({ error: 'bad_plugin' }, 400);
    const when = Math.min(Math.floor(updated), now + CLOCK_SLACK);
    const cur = await db.prepare('SELECT updated FROM plugins WHERE acct = ? AND id = ?').bind(acct, body.id).first();
    if (cur && cur.updated >= when) return json({ ok: true, stored: false });   // a newer backup exists
    // keep a tiny "deleted" marker so other devices learn about the removal; the files are dropped
    await db.batch([
        db.prepare("INSERT INTO plugins (acct, id, name, version, size, fp, chunks, updated, deleted) VALUES (?, ?, '', '', 0, '', 0, ?, 1) " +
            "ON CONFLICT(acct, id) DO UPDATE SET name = '', version = '', size = 0, fp = '', chunks = 0, updated = excluded.updated, deleted = 1")
            .bind(acct, body.id, when),
        db.prepare('DELETE FROM plugin_chunks WHERE acct = ? AND id = ?').bind(acct, body.id)
    ]);
    return json({ ok: true, stored: true });
}

async function handleExport(env, acct) {
    const user = await env.DB.prepare('SELECT email, created FROM users WHERE id = ?').bind(acct).first();
    const rows = await env.DB.prepare(
        'SELECT acct AS owner, kind, key, data, updated, deleted FROM items WHERE acct = ? OR acct LIKE ? ORDER BY updated'
    ).bind(acct, likeProfiles(acct)).all();
    const items = (rows.results || []).map(r => {
        let data = {};
        try { data = JSON.parse(r.data); } catch (e) { /* keep {} */ }
        const profile = r.owner === acct ? 'p1' : r.owner.slice(acct.length + 1);
        return { profile, kind: r.kind === 'h' ? 'history' : r.kind === 'f' ? 'favorites' : 'progress', key: r.key, data, updated: r.updated, deleted: !!r.deleted };
    });
    const pr = await env.DB.prepare('SELECT id, name, color, updated, deleted, avatar, pin FROM profiles WHERE acct = ? ORDER BY updated').bind(acct).all();
    const profiles = (pr.results || []).map(r => ({ id: r.id, name: r.name, color: r.color, updated: r.updated, deleted: !!r.deleted, avatar: r.avatar || '', hasPasscode: !!r.pin }));   // the passcode hash is not exported
    const pl = await env.DB.prepare('SELECT id, name, version, size, updated, deleted FROM plugins WHERE acct = ? ORDER BY id').bind(acct).all();
    const plugins = (pl.results || []).map(r => ({ id: r.id, name: r.name, version: r.version, size: r.size, updated: r.updated, deleted: !!r.deleted }));
    return json({ exported: Date.now(), email: user ? user.email : '', profiles, items, plugins });
}

async function handleDelete(env, acct) {
    await env.DB.batch([
        env.DB.prepare('DELETE FROM items WHERE acct = ? OR acct LIKE ?').bind(acct, likeProfiles(acct)),
        env.DB.prepare('DELETE FROM profiles WHERE acct = ?').bind(acct),
        env.DB.prepare('DELETE FROM plugins WHERE acct = ?').bind(acct),
        env.DB.prepare('DELETE FROM plugin_chunks WHERE acct = ?').bind(acct),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(acct),
        env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(acct),
        env.DB.prepare('DELETE FROM verifs WHERE user_id = ?').bind(acct),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(acct)
    ]);
    return json({ ok: true });
}


// ---------------------------------------------------------------- GitHub sign-in + Plugin Store
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
             size: r.size, fp: r.fp, chunks: r.chunks, status: r.status, updated: r.updated };
}

async function storeList(url, env) {
    const shelf = url.searchParams.get('shelf');
    const q = shelf === 'official' || shelf === 'community'
        ? env.DB.prepare("SELECT * FROM store_plugins WHERE status = 'approved' AND shelf = ? ORDER BY name").bind(shelf)
        : env.DB.prepare("SELECT * FROM store_plugins WHERE status = 'approved' ORDER BY shelf, name");
    const rows = await q.all();
    return json({ ok: true, items: (rows.results || []).map(storeItem) });
}

// Download one chunk. Public for approved items; owners may also read pending ones (to review them).
async function storeGetChunk(url, env, allowPending) {
    const id = url.searchParams.get('id'), fp = url.searchParams.get('fp'), i = Number(url.searchParams.get('i'));
    if (!goodPluginId(id) || !goodFp(fp) || !Number.isInteger(i) || i < 0) return json({ error: 'bad_plugin' }, 400);
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
    if (!goodPluginId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > MAX_PLUGIN_CHUNKS || index < 0 || index >= total) return json({ error: 'bad_plugin' }, 400);
    if (typeof body.data !== 'string' || !body.data.length || body.data.length > PLUGIN_CHUNK + 1000) return json({ error: 'too_large' }, 413);
    if (!who.owner && await limited(db, 'store:chunk:' + who.id, 400, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    await db.prepare('INSERT INTO store_chunks (owner, id, fp, idx, data, created) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(owner, id, fp, idx) DO UPDATE SET data = excluded.data, created = excluded.created')
        .bind(who.id, body.id, body.fp, index, body.data, now).run();
    return json({ ok: true });
}

// official = true only ever comes from the owner route.
async function storeCommit(request, env, who, official) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const total = Number(body.total), size = Number(body.size);
    if (!goodPluginId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isInteger(total) || total < 1 || total > MAX_PLUGIN_CHUNKS) return json({ error: 'bad_plugin' }, 400);
    if (!Number.isFinite(size) || size < 1 || size > STORE_MAX_SIZE) return json({ error: 'too_large' }, 413);
    const have = await db.prepare('SELECT COUNT(*) AS n FROM store_chunks WHERE owner = ? AND id = ? AND fp = ?').bind(who.id, body.id, body.fp).first();
    if (!have || have.n !== total) return json({ error: 'incomplete' }, 400);

    const cur = await db.prepare('SELECT owner, shelf FROM store_plugins WHERE id = ?').bind(body.id).first();
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
    await db.batch([
        db.prepare('INSERT INTO store_plugins (id, shelf, name, version, author, description, size, fp, chunks, status, owner, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET shelf = excluded.shelf, name = excluded.name, version = excluded.version, author = excluded.author, ' +
            'description = excluded.description, size = excluded.size, fp = excluded.fp, chunks = excluded.chunks, status = excluded.status, owner = excluded.owner, updated = excluded.updated')
            .bind(body.id, shelf, shortText(body.name, 80) || body.id, shortText(body.version, 40), author,
                  shortText(body.description, 200), Math.floor(size), body.fp, total, status, who.id, now),
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
    if (!goodPluginId(body.id)) return json({ error: 'bad_plugin' }, 400);
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
    if (!goodPluginId(body.id) || !goodFp(body.fp)) return json({ error: 'bad_plugin' }, 400);
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

            // GitHub sign-in (used by the GitHub Pages site)
            if (method === 'GET' && path === '/v1/gh/login') return await ghLogin(url, request, env);
            if (method === 'GET' && path === '/v1/gh/callback') return await ghCallback(url, env);
            // Plugin Store: browsing and downloading need no sign-in at all
            if (method === 'GET' && path === '/v1/store') return await storeList(url, env);
            if (method === 'GET' && path === '/v1/store/chunk') return await storeGetChunk(url, env, false);
            // Plugin Store: uploads and owner tools need a GitHub sign-in
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

            const sess = await sessionFor(request, env.DB, Date.now());
            if (!sess) return json({ error: 'bad_session' }, 401);

            if (method === 'POST' && path === '/v1/auth/logout') return await handleLogout(env, sess);
            if (method === 'POST' && path === '/v1/auth/confirm') return await handleConfirm(request, env, sess.userId);
            if (method === 'POST' && path === '/v1/profiles/sync') return await handleProfiles(request, env, sess.userId);
            if (method === 'POST' && path === '/v1/sync') return await handleSync(request, env, sess.userId);
            if (method === 'GET' && path === '/v1/plugins') return await handlePluginList(env, sess.userId);
            if (method === 'POST' && path === '/v1/plugins/chunk') return await handlePluginChunk(request, env, sess.userId);
            if (method === 'POST' && path === '/v1/plugins/commit') return await handlePluginCommit(request, env, sess.userId);
            if (method === 'GET' && path === '/v1/plugins/chunk') return await handlePluginGetChunk(url, env, sess.userId);
            if (method === 'POST' && path === '/v1/plugins/delete') return await handlePluginDelete(request, env, sess.userId);
            if (method === 'GET' && path === '/v1/export') return await handleExport(env, sess.userId);
            if (method === 'DELETE' && path === '/v1/account') return await handleDelete(env, sess.userId);
            return json({ error: 'not_found' }, 404);
        } catch (e) {
            console.error('worker error', String(e && e.stack || e));
            return json({ error: 'server_error' }, 500);
        }
    }
};
