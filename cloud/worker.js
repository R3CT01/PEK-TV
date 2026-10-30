// PEK Cloud: accounts + sync service for watch history and resume positions.
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
//   INVITE_ONLY        (Text, optional)  1 = new accounts need a single-use invite code (existing accounts are not affected)
//   ADMIN_KEY          (Secret, optional) a long random text (16+ characters); lets YOU make invite codes (see cloud/DEPLOY.md)
//
// Plans (paid with Stripe on the website by cloud/billing-worker.js, which shares this D1 database; see cloud/BILLING-DEPLOY.md):
//   free         account only: no cloud backup (sync, profile sync, plugin backup answer 402 subscription_required), 1 profile in the app
//   grandfathered accounts that existed before plans were added: everything unlocked, forever
//   monthly / yearly  paid while plan_until is in the future (the billing worker moves it forward on every renewal)
//   lifetime     paid once, everything unlocked, forever
//
// Routes:
//   POST   /v1/auth/signup   { email, username, password, invite? } -> { ok, needsVerify, email }   (username is required: 3 to 20 letters, digits . _ -; code emailed; invite needed when INVITE_ONLY=1)
//                                                                  Sign-up is done on the website (public/pektv/account.html); the app only signs in.
//   GET    /v1/news                                             -> { ok, items }   (public: the app's Updates screen)
//   POST   /v1/news/post     { title, body?, kind?, code?, link?, days? }  (Authorization: Bearer <ADMIN_KEY>; kind = news | update | coupon)
//   POST   /v1/news/list  and  /v1/news/delete { id }           (same key)
//   POST   /v1/invites/new   { count?, days?, note? }           -> { ok, codes }   (Authorization: Bearer <ADMIN_KEY>; codes are shown once)
//   POST   /v1/invites/list  {}                                 -> { ok, invites }   (same key)   POST /v1/invites/revoke { id } -> { ok }
//   POST   /v1/auth/verify   { email, code }                    -> { ok, token, email }   (finishes a sign-up OR a sign-in)
//   POST   /v1/auth/resend   { email }                          -> { ok }   (always; new code for an unconfirmed account or a pending sign-in)
//   POST   /v1/auth/login    { email, password }                -> { ok, needsVerify, email }  (a 6-digit code is emailed; every sign-in needs it)
//                                                                  or 403 email_not_verified (new account that never confirmed its email)
//   POST   /v1/auth/forgot   { email }                          -> { ok }   (always, so emails can't be probed)
//   POST   /v1/auth/reset    { email, code, password }          -> { ok, token, email }
//   POST   /v1/subs/search   { title, year?, season?, episode?, lang?, file? } -> { ok, results }   (shared OpenSubtitles account, no sign-in)
//   POST   /v1/subs/get      { id }                                            -> { ok, text, cached }  (see "subtitles" below)
//   POST   /v1/auth/logout                                      -> { ok }
//   POST   /v1/account/username { username }                    -> { ok, username }   (only for an older account that has none yet; it cannot be changed afterwards)
//   GET    /v1/me                                               -> { ok, email, username, plan, entitled, until, cancelling }   (works on every plan)
//   POST   /v1/auth/confirm  { password }                      -> { ok }   (re-checks the signed-in account's password, e.g. to reset a forgotten profile passcode; rate limited)
//   POST   /v1/profiles/sync { profiles: [{id,name,color,updated,deleted,avatar,pin}] } -> { ok, profiles, rejected }   (the household's profiles, last writer wins;
//                                                                  avatar = built-in picture id or a small photo, pin = salted passcode hash, both optional)
//   POST   /v1/sync          push changed items (history, progress, favorites, settings, skins, ratings) of ONE profile ({ profile, since, ... }), pull newer ones
//   GET    /v1/plugins                                          -> { ok, plugins: [{id,name,version,size,fp,updated,deleted,chunks}] }
//   POST   /v1/plugins/chunk   { id, fp, index, total, data }   -> { ok }      (one piece of a plugin backup)
//   POST   /v1/plugins/commit  { id, fp, total, name, version, size, updated } -> { ok, stored }  (finishes a backup)
//   GET    /v1/plugins/chunk?id=&fp=&i=                         -> { ok, data }
//   POST   /v1/plugins/delete  { id, updated }                  -> { ok }
//   GET    /v1/export        everything stored for the account (JSON; works on every plan)
//   DELETE /v1/account       permanently delete the account and all its data (409 cancel_subscription_first while a renewing subscription is active)
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
const REJECT_TTL = 3 * 24 * 3600 * 1000;   // the "Wasn't you? Reject this login" link in an email works for 3 days
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 31 characters, no 0 / O / 1 / I / L
const INVITE_MAX_NEW = 20;          // codes made per request
const INVITE_DEFAULT_DAYS = 14;     // an unused code stops working after this many days (0 = never)
const DEVICE_TTL = 10 * 60 * 1000;   // a TV's link code works for 10 minutes
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
    // gf = 1: the account existed before invite-only sign-up, so it is never asked for a code. New sign-ups are stored with gf = 0.
    try { await db.prepare('ALTER TABLE users ADD COLUMN gf INTEGER NOT NULL DEFAULT 1').run(); } catch (e) { /* already there */ }
    // Username (3 to 20 characters, required at sign-up), unique ignoring upper/lower case. Older accounts have none ('').
    try { await db.prepare("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    // Plans. Rows that already exist when these columns are added get 'grandfathered' (the column default); sign-up stores 'free'.
    try { await db.prepare("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'grandfathered'").run(); } catch (e) { /* already there */ }
    try { await db.prepare('ALTER TABLE users ADD COLUMN plan_until INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* already there */ }
    try { await db.prepare('ALTER TABLE users ADD COLUMN plan_cancel INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* already there */ }
    try { await db.prepare("ALTER TABLE users ADD COLUMN stripe_customer TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    try { await db.prepare("ALTER TABLE users ADD COLUMN stripe_sub TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (username COLLATE NOCASE) WHERE username <> ''").run();
    await db.prepare('CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT \'\', reserved_by TEXT, reserved_until INTEGER NOT NULL DEFAULT 0, used_by TEXT, used_at INTEGER)').run();
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
    // TV link login: a TV asks for a 6-digit code, the person approves it on the website, the TV collects a session.
    await db.prepare('CREATE TABLE IF NOT EXISTS device_links (poll_hash TEXT PRIMARY KEY, code_hash TEXT NOT NULL, dtype TEXT NOT NULL, dname TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, user_id TEXT)').run();
    await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS device_links_code ON device_links (code_hash)').run();
    // Where the TV asked for its code (its IP address and the approximate place that IP is in), shown to the person who approves.
    try { await db.prepare("ALTER TABLE device_links ADD COLUMN ip TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    try { await db.prepare("ALTER TABLE device_links ADD COLUMN loc TEXT NOT NULL DEFAULT ''").run(); } catch (e) { /* already there */ }
    // Which TV-link a session came from, so rejecting that login can sign that one device out again.
    try { await db.prepare('ALTER TABLE sessions ADD COLUMN dev_ref TEXT').run(); } catch (e) { /* already there */ }
    // One-time links in emails: "Wasn't you? Reject this login". Only the hash of the token is stored.
    await db.prepare('CREATE TABLE IF NOT EXISTS reject_tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL, expires INTEGER NOT NULL)').run();
    // The app's Updates screen: messages you post (news, new coupon codes). Anyone can read them, only the ADMIN_KEY can post.
    await db.prepare("CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, expires INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'news', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '')").run();
    await db.prepare('CREATE TABLE IF NOT EXISTS subs_cache (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL)').run();
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
// '' = none given, null = not allowed, otherwise the cleaned name.
function cleanUsername(v) {
    const u = String(v == null ? '' : v).trim();
    if (!u) return '';
    return /^[A-Za-z0-9][A-Za-z0-9._-]{2,19}$/.test(u) ? u : null;
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

// ---------------------------------------------------------------- invite codes (single use)
// A code looks like PEK-7K3QX-9MLTA. Only its SHA-256 hash is stored, so the code can't be read back from the database.
// Life of a code: unused -> held (while its owner confirms their email, 30 minutes, renewed by "resend") -> used (for good).
function inviteOnly(env) {
    const v = String(env.INVITE_ONLY == null ? '' : env.INVITE_ONLY).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}
function normInvite(v) {                       // "pek-7k3qx-9mlta", "PEK7K3QX9MLTA" and "7K3QX9MLTA" are the same code
    let n = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (n.length === 13 && n.indexOf('PEK') === 0) n = n.slice(3);
    return n;
}
async function inviteHash(v) {
    const n = normInvite(v);
    return n.length === 10 ? sha256Hex('pek:invite:' + n) : null;
}
function newInviteCode() {
    let s = '';
    while (s.length < 10) {                    // rejection sampling: no bias towards the first letters
        const b = crypto.getRandomValues(new Uint8Array(16));
        for (const x of b) if (x < 248 && s.length < 10) s += INVITE_ALPHABET[x % 31];
    }
    return 'PEK-' + s.slice(0, 5) + '-' + s.slice(5);
}
// Holds an unused, unexpired code for this account. One UPDATE decides it, so two people can never get the same code.
async function holdInvite(db, hash, userId, now) {
    await db.prepare('UPDATE invites SET reserved_by = NULL, reserved_until = 0 WHERE reserved_by = ? AND used_by IS NULL AND hash <> ?').bind(userId, hash).run();
    const r = await db.prepare('UPDATE invites SET reserved_by = ?, reserved_until = ? WHERE hash = ? AND used_by IS NULL AND (expires = 0 OR expires > ?) AND (reserved_by IS NULL OR reserved_until < ? OR reserved_by = ?)')
        .bind(userId, now + VERIFY_TTL, hash, now, now, userId).run();
    return !!(r.meta && r.meta.changes);
}
// The confirmed email burns the code for good. Returns false when this account does not hold one (it must not be confirmed then).
async function useInvite(env, db, user, now) {
    if (!inviteOnly(env) || user.verified || user.gf) return true;
    const r = await db.prepare('UPDATE invites SET used_by = ?, used_at = ?, reserved_by = NULL, reserved_until = 0 WHERE reserved_by = ? AND used_by IS NULL').bind(user.id, now, user.id).run();
    return !!(r.meta && r.meta.changes);
}

// ---------------------------------------------------------------- sessions
async function startSession(db, userId, now, devRef) {
    const token = randomToken();
    await db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires, dev_ref) VALUES (?, ?, ?, ?, ?)')
        .bind(await sha256Hex('hesper:session:' + token), userId, now, now + SESSION_TTL, devRef || null).run();
    // tidy up: expired sessions, expired throttle rows, expired reset codes
    await db.batch([
        db.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
        db.prepare('DELETE FROM throttle WHERE reset_at < ?').bind(now),
        db.prepare('DELETE FROM resets WHERE expires < ?').bind(now),
        db.prepare('DELETE FROM verifs WHERE expires < ?').bind(now),
        db.prepare('DELETE FROM reject_tokens WHERE expires < ?').bind(now),
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
        lead: 'Enter this code to finish signing in:',
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

function escHtml(v) {
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A device (TV, phone, browser) as the apps and the website describe it. Anything the caller sends is cut down to plain
// short text first: it ends up in an email and on the approve page, so it must never carry markup or look like a sentence.
function cleanDeviceText(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Returns { type, name, when } or null when the caller sent no device. [request] gives the time zone of whoever is asking.
function deviceFrom(raw, now, request) {
    if (!raw || typeof raw !== 'object') return null;
    const type = cleanDeviceText(raw.type, 24) || 'Device';
    const name = cleanDeviceText(raw.name, 60) || 'Unnamed device';
    const g = geoFrom(request);
    return { type, name, when: whenText(now, request), ip: g.ip, location: g.location };
}
// The caller's IP address and the approximate place it is in (Cloudflare's own lookup: city, region, country). Either may be empty.
function geoFrom(request) {
    let ip = clientIp(request); if (ip === 'unknown') ip = '';
    let parts = [];
    try { const cf = request && request.cf; if (cf) parts = [cf.city, cf.region, cf.country].filter(Boolean); } catch (e) { /* none */ }
    return { ip: cleanDeviceText(ip, 45), location: cleanDeviceText(parts.join(', '), 80) };
}
function whenText(now, request) {
    let tz = '';
    try { tz = (request && request.cf && request.cf.timezone) || ''; } catch (e) { /* none */ }
    for (const zone of [tz, 'UTC']) {
        if (zone === '' ) continue;
        try { return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' }).format(new Date(now)); }
        catch (e) { /* unknown zone: try UTC */ }
    }
    return new Date(now).toISOString();
}

async function postMail(env, to, subject, text, html) {
    const sender = { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || 'PEK TV' };
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.BREVO_API_KEY, 'accept': 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html })
    });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
        console.error('Brevo send failed', res.status, detail);
        return false;
    }
    return true;
}

function mailHtml(title, lead, code, device, foot, rejectUrl) {
    return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#111">' +
        '<h2 style="margin:0 0 12px">' + title + '</h2>' +
        '<p style="margin:0 0 16px">' + lead + '</p>' +
        (code ? '<p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:0 0 16px">' + code + '</p>' : '') +
        (device ? '<table style="border-collapse:collapse;margin:0 0 16px;font-size:15px">' +
            '<tr><td style="padding:2px 14px 2px 0;color:#555">Device</td><td style="padding:2px 0"><b>' + escHtml(device.type) + '</b></td></tr>' +
            '<tr><td style="padding:2px 14px 2px 0;color:#555">Name</td><td style="padding:2px 0"><b>' + escHtml(device.name) + '</b></td></tr>' +
            (device.location ? '<tr><td style="padding:2px 14px 2px 0;color:#555">Location</td><td style="padding:2px 0"><b>' + escHtml(device.location) + '</b></td></tr>' : '') +
            (device.ip ? '<tr><td style="padding:2px 14px 2px 0;color:#555">IP address</td><td style="padding:2px 0"><b>' + escHtml(device.ip) + '</b></td></tr>' : '') +
            '<tr><td style="padding:2px 14px 2px 0;color:#555">Time</td><td style="padding:2px 0"><b>' + escHtml(device.when) + '</b></td></tr></table>' : '') +
        '<p style="margin:0;color:#555;font-size:14px">' + foot + '</p>' +
        (rejectUrl ? '<p style="margin:14px 0 0;font-size:12px"><a href="' + escHtml(rejectUrl) + '" style="color:#a33">Wasn\'t you? Reject this login</a></p>' : '') +
        '</div>';
}
function deviceText(device) {
    return device ? '\nDevice: ' + device.type + '\nName: ' + device.name +
        (device.location ? '\nLocation: ' + device.location : '') + (device.ip ? '\nIP address: ' + device.ip : '') +
        '\nTime: ' + device.when + '\n' : '';
}

// [device] (optional) = where the sign-in is happening; the email then says which device, what it is called and when.
async function sendCodeEmail(env, to, code, kind, device, rejectUrl) {
    const m = MAILS[kind];
    let text = m.text.replace('{code}', code);
    if (device) text = text.replace('\n\n', deviceText(device) + '\n');
    if (rejectUrl) text += '\n\nWasn\'t you? Reject this login: ' + rejectUrl;
    return postMail(env, to, m.subject, text, mailHtml(m.title, m.lead, code, device, m.foot, rejectUrl));
}

// Tells the owner that a device was just signed in with the TV link (QR / 6-digit code). No code in it: the TV is already in.
async function sendDeviceNotice(env, to, device, rejectUrl) {
    const foot = 'If this was you, there is nothing to do. If it was not you, choose \"Forgot password\" in the app or on the website to set a new password: that signs every other device out.';
    return postMail(env, to, 'New sign-in on PEK TV: ' + device.name,
        'A device was just signed in to your PEK TV account.\n' + deviceText(device) + '\nIf this was you, there is nothing to do. If it was not you, choose \"Forgot password\" in the app or on the website to set a new password: that signs every other device out.' + (rejectUrl ? '\n\nWasn\'t you? Reject this login: ' + rejectUrl : ''),
        mailHtml('A device was signed in', 'Your PEK TV account was just signed in on this device:', '', device, foot, rejectUrl));
}

// The website page that confirms a rejection (a button there does the POST, so an email scanner opening the link changes nothing).
function webUrl(env) { return String(env.WEB_URL || 'https://pekindustries.com/pektv').replace(/\/+$/, ''); }
// Makes the one-time link for "Wasn't you? Reject this login". kind 'login' = a sign-in code was sent; kind 'device' = a TV was approved (ref = its poll hash).
async function makeRejectUrl(env, db, userId, kind, ref, now) {
    const token = randomToken();
    await db.prepare('INSERT INTO reject_tokens (hash, user_id, kind, ref, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await sha256Hex('hesper:reject:' + token), userId, kind, ref || '', now, now + REJECT_TTL).run();
    return webUrl(env) + '/reject.html?t=' + token;
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
    await db.prepare('UPDATE invites SET reserved_until = ? WHERE reserved_by = ? AND used_by IS NULL').bind(now + VERIFY_TTL, userId).run();   // the invite stays held while this code works
    return true;
}

// Every sign-in of a confirmed account asks for an emailed code too (the password alone is not enough).
// Same table and check as the sign-up code: the app exchanges it at /v1/auth/verify for the session token.
// Returns 'sent', 'limited' (too many codes this hour) or 'failed' (the email could not be sent).
async function issueLoginCode(env, db, userId, email, now, device) {
    if (await limited(db, 'login:code:' + email, 6, 3600 * 1000, now)) return 'limited';
    const code = sixDigits();
    await db.prepare('INSERT INTO verifs (user_id, code_hash, expires, tries) VALUES (?, ?, ?, 0) ' +
        'ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, tries = 0')
        .bind(userId, await sha256Hex('hesper:verify:' + userId + ':' + code), now + VERIFY_TTL).run();
    try {
        const rejectUrl = device ? await makeRejectUrl(env, db, userId, 'login', '', now) : '';
        return (await sendCodeEmail(env, email, code, 'login', device || null, rejectUrl)) ? 'sent' : 'failed';
    }
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

    const existing = await db.prepare('SELECT id, verified, gf FROM users WHERE email = ?').bind(email).first();
    if (existing && existing.verified) return json({ error: 'email_taken' }, 409);

    // Username (required for new accounts): checked before an invite is held, so a taken name never ties up a code.
    const username = cleanUsername(body.username);
    if (username === null) return json({ error: 'bad_username' }, 400);
    if (!username) return json({ error: 'username_required' }, 400);   // a username is required for every new account (3 to 20 characters)
    if (username && await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').bind(username, existing ? existing.id : '').first()) return json({ error: 'username_taken' }, 409);

    // Invite-only: a new address (or one left unconfirmed since the switch) needs an unused code. Accounts that already
    // existed before the switch (gf = 1) never do, and sign-in / password reset never come through here.
    const userId = existing ? existing.id : randomHex(16);
    if (inviteOnly(env) && !(existing && existing.gf)) {
        if (await limited(db, 'invite:ip:' + clientIp(request), 20, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
        if (!normInvite(body.invite)) return json({ error: 'invite_required' }, 403);
        const hash = await inviteHash(body.invite);
        if (!hash || !(await holdInvite(db, hash, userId, now))) return json({ error: 'bad_invite' }, 403);
    }

    const pw = await hashPassword(body.password);
    let id;
    if (existing) {
        // Someone started this sign-up but never verified. The newest attempt takes it over, so nobody can
        // lock a real owner out of their own address by registering it first.
        id = existing.id;
        await db.prepare('UPDATE users SET pw = ?, created = ?, username = ? WHERE id = ?').bind(pw, now, username, id).run();
    } else {
        id = userId;
        try {
            await db.prepare("INSERT INTO users (id, email, pw, created, last_seen, verified, gf, username, plan) VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'free')")
                .bind(id, email, pw, now, now, username).run();
        } catch (e) {
            await db.prepare('UPDATE invites SET reserved_by = NULL, reserved_until = 0 WHERE reserved_by = ? AND used_by IS NULL').bind(userId).run();   // give the code back
            if (username && await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first()) return json({ error: 'username_taken' }, 409);
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

    const user = await db.prepare('SELECT id, verified, gf, username FROM users WHERE email = ?').bind(email).first();
    const row = user ? await db.prepare('SELECT code_hash, expires, tries FROM verifs WHERE user_id = ?').bind(user.id).first() : null;
    if (!user || !row || row.expires < now || row.tries >= RESET_MAX_TRIES) return json({ error: 'bad_code' }, 400);

    if (!sameString(await sha256Hex('hesper:verify:' + user.id + ':' + code), row.code_hash)) {
        await db.prepare('UPDATE verifs SET tries = tries + 1 WHERE user_id = ?').bind(user.id).run();
        return json({ error: 'bad_code' }, 400);
    }
    if (!(await useInvite(env, db, user, now))) return json({ error: 'bad_invite' }, 403);   // sign-up only: the invite is burned here
    await db.batch([
        db.prepare('UPDATE users SET verified = 1, last_seen = ? WHERE id = ?').bind(now, user.id),
        db.prepare('DELETE FROM verifs WHERE user_id = ?').bind(user.id)
    ]);
    return json(Object.assign({ ok: true, token: await startSession(db, user.id, now), email, username: user.username || '' }, await planOf(db, user.id, now)));
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
        if (pending && pending.expires + 2 * 3600 * 1000 > now) await issueLoginCode(env, db, user.id, email, now, deviceFrom(body.device, now, request));
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
    const sent = await issueLoginCode(env, db, row.id, email, now, deviceFrom(body.device, now, request));
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

    const user = await db.prepare('SELECT id, verified, gf, username FROM users WHERE email = ?').bind(email).first();
    const row = user ? await db.prepare('SELECT code_hash, expires, tries FROM resets WHERE user_id = ?').bind(user.id).first() : null;
    if (!user || !row || row.expires < now || row.tries >= RESET_MAX_TRIES) return json({ error: 'bad_code' }, 400);

    const good = sameString(await sha256Hex('hesper:reset:' + user.id + ':' + code), row.code_hash);
    if (!good) {
        await db.prepare('UPDATE resets SET tries = tries + 1 WHERE user_id = ?').bind(user.id).run();
        return json({ error: 'bad_code' }, 400);
    }
    if (!(await useInvite(env, db, user, now))) return json({ error: 'bad_invite' }, 403);
    await db.batch([
        db.prepare('UPDATE users SET pw = ?, last_seen = ?, verified = 1 WHERE id = ?').bind(await hashPassword(body.password), now, user.id),   // a reset code proves the email too
        db.prepare('DELETE FROM resets WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM verifs WHERE user_id = ?').bind(user.id),
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id)      // everyone is signed out
    ]);
    await clearLimit(db, 'login:mail:' + email);
    return json(Object.assign({ ok: true, token: await startSession(db, user.id, now), email, username: user.username || '' }, await planOf(db, user.id, now)));
}

async function handleLogout(env, sess) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sess.tokenHash).run();
    return json({ ok: true });
}

// ---------------------------------------------------------------- TV link login (6-digit code + QR)
// 1. The TV asks /v1/device/start for a code and keeps the secret `poll` value; it shows the code (and a QR with it) on screen.
// 2. The person opens the website's verify page signed in, sees which device it is (/v1/device/info) and approves it (/v1/device/approve).
// 3. The TV polls /v1/device/poll with its secret; once approved it gets a normal session token (made at that moment, never stored).
// The code alone gives nothing: it only works together with a signed-in account approving it, for DEVICE_TTL.
async function handleDeviceStart(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    if (await limited(db, 'device:start:' + clientIp(request), 20, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    await db.prepare('DELETE FROM device_links WHERE expires < ?').bind(now).run();
    const dev = deviceFrom(body.device || body, now, request) || { type: 'Device', name: 'Unnamed device', ip: geoFrom(request).ip, location: geoFrom(request).location };
    const poll = randomToken();
    const pollHash = await sha256Hex('hesper:device:poll:' + poll);
    for (let i = 0; i < 6; i++) {
        const code = sixDigits();
        try {
            await db.prepare('INSERT INTO device_links (poll_hash, code_hash, dtype, dname, created, expires, user_id, ip, loc) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
                .bind(pollHash, await sha256Hex('hesper:device:code:' + code), dev.type, dev.name, now, now + DEVICE_TTL, dev.ip || '', dev.location || '').run();
        } catch (e) { continue; }   // another live TV has this code: draw another one
        return json({ ok: true, poll, code, expiresIn: Math.floor(DEVICE_TTL / 1000), interval: 3 });
    }
    return json({ error: 'server_busy' }, 503);
}

async function handleDevicePoll(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    const poll = typeof body.poll === 'string' ? body.poll : '';
    if (poll.length < 20 || poll.length > 100) return json({ error: 'expired' }, 410);
    const pollHash = await sha256Hex('hesper:device:poll:' + poll);
    if (await limited(db, 'device:poll:' + pollHash, 400, DEVICE_TTL, now)) return json({ error: 'rate_limited' }, 429);
    const row = await db.prepare('SELECT user_id, expires FROM device_links WHERE poll_hash = ?').bind(pollHash).first();
    if (!row || row.expires < now) return json({ error: 'expired' }, 410);
    if (!row.user_id) return json({ ok: true, status: 'pending' });
    // take the approval exactly once: only the call that deletes the row gets the session
    const del = await db.prepare('DELETE FROM device_links WHERE poll_hash = ? AND user_id IS NOT NULL').bind(pollHash).run();
    if (!del.meta || del.meta.changes !== 1) return json({ ok: true, status: 'pending' });
    const user = await db.prepare('SELECT email, username FROM users WHERE id = ?').bind(row.user_id).first();
    if (!user) return json({ error: 'expired' }, 410);
    return json(Object.assign({ ok: true, status: 'approved', token: await startSession(db, row.user_id, now, pollHash), email: user.email, username: user.username || '' }, await planOf(db, row.user_id, now)));
}

// Finds the waiting TV for a typed / scanned code. Wrong codes are counted so the 6 digits can't be guessed.
async function deviceByCode(request, env, userId, now) {
    const { body, err } = await readJson(request); if (err) return { err };
    const db = env.DB;
    const code = String(body.code == null ? '' : body.code).replace(/\D/g, '');
    const userKey = 'device:miss:' + userId, ipKey = 'device:missip:' + clientIp(request);
    for (const [k, max] of [[userKey, 10], [ipKey, 30]]) {
        const lim = await db.prepare('SELECT n, reset_at FROM throttle WHERE k = ?').bind(k).first();
        if (lim && lim.reset_at > now && lim.n >= max) return { err: json({ error: 'rate_limited' }, 429) };
    }
    const row = code.length === 6
        ? await db.prepare('SELECT poll_hash, dtype, dname, created, expires, user_id, ip, loc FROM device_links WHERE code_hash = ? AND expires > ?')
            .bind(await sha256Hex('hesper:device:code:' + code), now).first()
        : null;
    if (!row) {
        await limited(db, userKey, 10, 15 * 60 * 1000, now);
        await limited(db, ipKey, 30, 15 * 60 * 1000, now);
        return { err: json({ error: 'bad_code' }, 404) };
    }
    return { row };
}

// Shows which TV the code belongs to, so the person can check it before approving. Changes nothing.
async function handleDeviceInfo(request, env, userId) {
    const now = Date.now();
    const found = await deviceByCode(request, env, userId, now); if (found.err) return found.err;
    const row = found.row;
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
    return json({ ok: true, device: { type: row.dtype, name: row.dname, ip: row.ip || '', location: row.loc || '' }, created: row.created, expires: row.expires, done: !!row.user_id, email: user ? user.email : '' });
}

async function handleDeviceApprove(request, env, userId) {
    const db = env.DB, now = Date.now();
    const found = await deviceByCode(request, env, userId, now); if (found.err) return found.err;
    const row = found.row;
    if (row.user_id) return json(row.user_id === userId ? { ok: true, done: true } : { error: 'already_linked' }, row.user_id === userId ? 200 : 409);
    const upd = await db.prepare('UPDATE device_links SET user_id = ? WHERE poll_hash = ? AND user_id IS NULL').bind(userId, row.poll_hash).run();
    if (!upd.meta || upd.meta.changes !== 1) return json({ error: 'already_linked' }, 409);
    // tell the owner (best effort: the TV is linked either way)
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
    if (user && emailReady(env)) {
        try {
            const rejectUrl = await makeRejectUrl(env, db, userId, 'device', row.poll_hash, now);
            await sendDeviceNotice(env, user.email, { type: row.dtype, name: row.dname, ip: row.ip || '', location: row.loc || '', when: whenText(now, request) }, rejectUrl);
        }
        catch (e) { console.error('Brevo request error', String(e)); }
    }
    return json({ ok: true, device: { type: row.dtype, name: row.dname }, email: user ? user.email : '' });
}

// "Wasn't you?" on the approve page: the signed-in person throws away a waiting (or just approved, not yet collected) TV link.
async function handleDeviceReject(request, env, userId) {
    const db = env.DB, now = Date.now();
    const found = await deviceByCode(request, env, userId, now); if (found.err) return found.err;
    const row = found.row;
    if (row.user_id && row.user_id !== userId) return json({ error: 'already_linked' }, 409);
    await db.batch([
        db.prepare('DELETE FROM device_links WHERE poll_hash = ?').bind(row.poll_hash),
        db.prepare('DELETE FROM sessions WHERE dev_ref = ? AND user_id = ?').bind(row.poll_hash, userId)
    ]);
    return json({ ok: true });
}

// The one-time link from an email (public: the token is the proof, and it only ever makes things safer).
//   'device': the TV is unlinked and, if it already collected its session, that one session is deleted.
//   'login' : the waiting sign-in code is deleted, and sessions made since the code was sent are signed out.
async function handleRejectToken(request, env) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB, now = Date.now();
    if (await limited(db, 'reject:ip:' + clientIp(request), 20, 3600 * 1000, now)) return json({ error: 'rate_limited' }, 429);
    const token = typeof body.token === 'string' ? body.token : '';
    if (token.length < 20 || token.length > 100) return json({ error: 'bad_reject' }, 404);
    const hash = await sha256Hex('hesper:reject:' + token);
    const row = await db.prepare('SELECT user_id, kind, ref, created FROM reject_tokens WHERE hash = ? AND expires > ?').bind(hash, now).first();
    if (!row) return json({ error: 'bad_reject' }, 404);
    let signedOut = 0;
    if (row.kind === 'device') {
        const r = await db.prepare('DELETE FROM sessions WHERE dev_ref = ? AND user_id = ?').bind(row.ref, row.user_id).run();
        signedOut = (r.meta && r.meta.changes) || 0;
        await db.prepare('DELETE FROM device_links WHERE poll_hash = ?').bind(row.ref).run();
    } else {
        await db.prepare('DELETE FROM verifs WHERE user_id = ?').bind(row.user_id).run();
        const r = await db.prepare('DELETE FROM sessions WHERE user_id = ? AND created >= ?').bind(row.user_id, row.created).run();
        signedOut = (r.meta && r.meta.changes) || 0;
    }
    await db.prepare('DELETE FROM reject_tokens WHERE hash = ?').bind(hash).run();
    return json({ ok: true, kind: row.kind, signedOut });
}

// ---------------------------------------------------------------- plans
// Same rules as cloud/billing-worker.js (that worker is the only one that ever changes a plan).
function isEntitled(u, now) {
    if (!u) return false;
    if (u.plan === 'grandfathered' || u.plan === 'lifetime') return true;
    return (u.plan === 'monthly' || u.plan === 'yearly') && Number(u.plan_until) > now;
}
async function planOf(db, userId, now) {
    const u = await db.prepare('SELECT plan, plan_until, plan_cancel FROM users WHERE id = ?').bind(userId).first();
    if (!u) return { plan: 'free', entitled: false, until: 0, cancelling: false };
    return { plan: u.plan, entitled: isEntitled(u, now), until: (u.plan === 'monthly' || u.plan === 'yearly') ? Number(u.plan_until) : 0, cancelling: !!u.plan_cancel };
}

// POST /v1/account/username { username } -> { ok, username }
// Accounts made before usernames were required have none ('') and choose one here, once. After that it is fixed.
async function handleSetUsername(request, env, userId) {
    const { body, err } = await readJson(request); if (err) return err;
    const db = env.DB;
    const username = cleanUsername(body.username);
    if (username === null) return json({ error: 'bad_username' }, 400);
    if (!username) return json({ error: 'username_required' }, 400);
    const me = await db.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first();
    if (!me) return json({ error: 'bad_session' }, 401);
    if (me.username) return json({ error: 'username_set' }, 409);
    if (await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').bind(username, userId).first()) return json({ error: 'username_taken' }, 409);
    try {
        await db.prepare("UPDATE users SET username = ? WHERE id = ? AND username = ''").bind(username, userId).run();
    } catch (e) {
        return json({ error: 'username_taken' }, 409);          // lost a race with someone taking the same name
    }
    return json({ ok: true, username });
}

// GET /v1/me -> { ok, email, username, plan, entitled, until, cancelling }
async function handleMe(env, userId) {
    const u = await env.DB.prepare('SELECT email, username FROM users WHERE id = ?').bind(userId).first();
    if (!u) return json({ error: 'bad_session' }, 401);
    return json(Object.assign({ ok: true, email: u.email, username: u.username || '' }, await planOf(env.DB, userId, Date.now())));
}

// ---------------------------------------------------------------- sync handlers
function cleanItem(it, now, kind) {
    if (!it || typeof it !== 'object') return null;
    if (typeof it.key !== 'string' || !it.key || it.key.length > MAX_KEY) return null;
    // history keys start m| / e| (movie / episode), favorites are f|movie:<id> or f|tv:<id>,
    // settings are s|dashboard, s|look, s|weather or s|skin (small choices that follow the profile),
    // skins are k|<skin id>: k|custom-... (made in the app's Skin maker) or k|pkg-... (installed from a .zip / GitHub),
    // ratings are r|<history key> (r|m|<title>|<year> movie, r|e|<show>|<season>|<episode> episode, r|s|<show> whole show): 1 to 10 stars, per profile
    if (kind === 'f' ? !/^f\|(movie|tv):\d{1,10}$/.test(it.key)
        : kind === 's' ? !/^s\|(dashboard|look|weather|skin)$/.test(it.key)
        : kind === 'k' ? !/^k\|(custom-[a-z0-9]{1,20}|pkg-[a-z0-9][a-z0-9_-]{0,39})$/.test(it.key)
        : kind === 'r' ? !/^r\|[mes]\|.{1,150}$/.test(it.key)
        : !/^[me]\|/.test(it.key)) return null;
    const updated = Number(it.updated);
    if (!Number.isFinite(updated) || updated <= 0) return null;
    const deleted = it.deleted ? 1 : 0;
    // data {title, year, season, episode, rating 1..10, at}
    if (kind === 'r' && !deleted) {
        const d = it.data;
        if (!d || typeof d !== 'object' || !Number.isInteger(d.rating) || d.rating < 1 || d.rating > 10) return null;
    }
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
    for (const [kind, field] of [['h', 'history'], ['p', 'progress'], ['f', 'favorites'], ['s', 'settings'], ['k', 'skins'], ['r', 'ratings']]) {
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

    const out = { history: [], progress: [], favorites: [], settings: [], skins: [], ratings: [] };
    let cursor = since;
    for (const r of results) {
        let data = {};
        try { data = JSON.parse(r.data); } catch (e) { /* keep {} */ }
        const item = { key: r.key, data, updated: r.updated, deleted: r.deleted ? 1 : 0 };
        (r.kind === 'h' ? out.history : r.kind === 'f' ? out.favorites : r.kind === 's' ? out.settings : r.kind === 'k' ? out.skins : r.kind === 'r' ? out.ratings : out.progress).push(item);
        if (r.srv > cursor) cursor = r.srv;
    }
    return json({ ok: true, profile, cursor, more: results.length === PAGE, history: out.history, progress: out.progress, favorites: out.favorites, settings: out.settings, skins: out.skins, ratings: out.ratings });
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
        return { profile, kind: r.kind === 'h' ? 'history' : r.kind === 'f' ? 'favorites' : r.kind === 's' ? 'settings' : r.kind === 'k' ? 'skins' : r.kind === 'r' ? 'ratings' : 'progress', key: r.key, data, updated: r.updated, deleted: !!r.deleted };
    });
    const pr = await env.DB.prepare('SELECT id, name, color, updated, deleted, avatar, pin FROM profiles WHERE acct = ? ORDER BY updated').bind(acct).all();
    const profiles = (pr.results || []).map(r => ({ id: r.id, name: r.name, color: r.color, updated: r.updated, deleted: !!r.deleted, avatar: r.avatar || '', hasPasscode: !!r.pin }));   // the passcode hash is not exported
    const pl = await env.DB.prepare('SELECT id, name, version, size, updated, deleted FROM plugins WHERE acct = ? ORDER BY id').bind(acct).all();
    const plugins = (pl.results || []).map(r => ({ id: r.id, name: r.name, version: r.version, size: r.size, updated: r.updated, deleted: !!r.deleted }));
    return json({ exported: Date.now(), email: user ? user.email : '', profiles, items, plugins });
}

async function handleDelete(env, acct) {
    // A renewing subscription keeps charging after the account is gone, so it has to be cancelled first (on the website).
    const pl = await env.DB.prepare('SELECT plan, plan_until, plan_cancel, stripe_sub FROM users WHERE id = ?').bind(acct).first();
    if (pl && (pl.plan === 'monthly' || pl.plan === 'yearly') && pl.stripe_sub && !pl.plan_cancel && Number(pl.plan_until) > Date.now()) return json({ error: 'cancel_subscription_first' }, 409);
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
// ---------------------------------------------------------------- subtitles (one shared OpenSubtitles.com account)
// Everyone's app asks this worker, so nobody needs their own OpenSubtitles account. The worker holds the key.
//   POST /v1/subs/search  { title, year?, season?, episode?, lang?, file? }  -> { ok, results: [{id,name,lang,title,downloads,hi,ai,trusted,score}] }
//   POST /v1/subs/get     { id }                                             -> { ok, text, cached }   (SubRip, UTF-8)
// Search costs nothing against OpenSubtitles' daily download limit. A download does, so:
//   - every downloaded subtitle is kept in D1 (table subs_cache) and served to all later users for free;
//   - downloads are counted per day for the whole service (SUBS_DAILY_LIMIT, default 18 of the free 20)
//     and per IP address (SUBS_IP_DAILY_LIMIT, default 8), so one person cannot use everybody's quota.
// Secrets: OPENSUBTITLES_API_KEY, OPENSUBTITLES_USER, OPENSUBTITLES_PASS  (Text: SUBS_DAILY_LIMIT, SUBS_IP_DAILY_LIMIT optional)
const OS_HOST = 'https://api.opensubtitles.com';
const OS_UA = 'PEK TV v1.0';
const SUBS_CACHE_DAYS = 90;
const SUBS_MAX_BYTES = 2 * 1024 * 1024;
let osSession = null;   // { token, base, exp } kept while this worker instance lives

function subsReady(env) { return !!(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USER && env.OPENSUBTITLES_PASS); }
function osHeaders(env, extra) {
    return Object.assign({ 'Api-Key': env.OPENSUBTITLES_API_KEY, 'User-Agent': OS_UA, 'Accept': 'application/json' }, extra || {});
}
function wordSet(s) {
    const out = new Set();
    String(s || '').toLowerCase().split(/[^a-z0-9]+/).forEach(w => { if (w.length > 1) out.add(w); });
    return out;
}
function goodLang(l) { return typeof l === 'string' && /^[a-z]{2}(-[a-z]{2})?(,[a-z]{2}(-[a-z]{2})?){0,4}$/i.test(l); }

async function osLogin(env, force) {
    const now = Date.now();
    if (!force && osSession && osSession.exp > now) return osSession;
    const r = await fetch(OS_HOST + '/api/v1/login', {
        method: 'POST',
        headers: osHeaders(env, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username: env.OPENSUBTITLES_USER, password: env.OPENSUBTITLES_PASS })
    });
    if (!r.ok) { osSession = null; throw new Error('os_login_' + r.status); }
    const j = await r.json();
    if (!j.token) throw new Error('os_login_no_token');
    let base = String(j.base_url || 'api.opensubtitles.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+$/i.test(base)) base = 'api.opensubtitles.com';
    osSession = { token: j.token, base: 'https://' + base, exp: now + 20 * 3600 * 1000 };
    return osSession;
}

async function handleSubsSearch(request, env) {
    if (!subsReady(env)) return json({ ok: false, error: 'Subtitles are not set up on the server yet.' }, 503);
    const { body, err } = await readJson(request);
    if (err) return err;
    const db = env.DB, now = Date.now();
    if (await limited(db, 'subs:search:ip:' + clientIp(request), 120, 3600 * 1000, now)) return json({ ok: false, error: 'Too many subtitle searches. Try again in a little while.' }, 429);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    if (!title) return json({ ok: false, error: 'No title to search for.' }, 400);
    const year = Number(body.year) | 0, season = Number(body.season) | 0, episode = Number(body.episode) | 0;
    const lang = goodLang(body.lang) ? String(body.lang).toLowerCase() : 'en';
    const file = typeof body.file === 'string' ? body.file.slice(0, 300) : '';
    const isEp = season > 0 && episode > 0;

    // OpenSubtitles wants lower-case parameter names in alphabetical order
    const p = [];
    if (isEp) p.push(['episode_number', episode]);
    p.push(['languages', lang], ['order_by', 'download_count'], ['order_direction', 'desc'], ['query', title.toLowerCase()]);
    if (isEp) p.push(['season_number', season]);
    p.push(['type', isEp ? 'episode' : 'movie']);
    if (!isEp && year > 1800 && year < 2200) p.push(['year', year]);
    const qs = p.map(kv => kv[0] + '=' + encodeURIComponent(kv[1])).join('&');

    // the same title is searched by many people: keep the raw answer for 6 hours (search is free, this just saves calls)
    const cacheKey = new Request('https://subs-cache.invalid/search?' + qs);
    let raw = null;
    const hit = await caches.default.match(cacheKey);
    if (hit) raw = await hit.json();
    if (!raw) {
        const r = await fetch(OS_HOST + '/api/v1/subtitles?' + qs, { headers: osHeaders(env) });
        if (r.status === 429) return json({ ok: false, error: 'OpenSubtitles is busy. Try again in a minute.' }, 429);
        if (!r.ok) return json({ ok: false, error: 'OpenSubtitles answered HTTP ' + r.status + '.' }, 502);
        raw = await r.json();
        await caches.default.put(cacheKey, new Response(JSON.stringify(raw), { headers: { 'Cache-Control': 'max-age=21600', 'Content-Type': 'application/json' } }));
    }

    const want = wordSet(file || title), wantLower = file.toLowerCase();
    const list = [];
    for (const item of (raw.data || [])) {
        const at = item && item.attributes;
        const f = at && at.files && at.files[0];
        if (!f || !f.file_id) continue;
        const name = at.release || f.file_name || '';
        const downloads = Number(at.download_count) || 0;
        const ai = !!(at.ai_translated || at.machine_translated), hi = !!at.hearing_impaired, trusted = !!at.from_trusted;
        let shared = 0;
        wordSet(name).forEach(w => { if (want.has(w)) shared++; });
        let score = shared * 12;
        if (file && name.toLowerCase() === wantLower) score += 60;
        score += Math.min(40, downloads / 500);
        if (trusted) score += 15;
        if (ai) score -= 40;
        if (hi) score -= 8;
        list.push({ id: String(f.file_id), name: name, lang: at.language || '', title: (at.feature_details && at.feature_details.title) || '', downloads: downloads, hi: hi, ai: ai, trusted: trusted, score: Math.round(score) });
    }
    list.sort((a, b) => b.score - a.score);
    return json({ ok: true, results: list.slice(0, 25) });
}

function decodeSubtitle(buf) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder('windows-1252').decode(buf); }   // old files are often Windows-1252
    return text.replace(/^\uFEFF/, '');
}

async function handleSubsGet(request, env) {
    if (!subsReady(env)) return json({ ok: false, error: 'Subtitles are not set up on the server yet.' }, 503);
    const { body, err } = await readJson(request);
    if (err) return err;
    const db = env.DB, now = Date.now();
    const id = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id) : '';
    if (!/^\d{1,12}$/.test(id)) return json({ ok: false, error: 'Bad subtitle id.' }, 400);
    if (await limited(db, 'subs:get:ip:' + clientIp(request), 200, 3600 * 1000, now)) return json({ ok: false, error: 'Too many requests. Try again in a little while.' }, 429);

    // 1) already downloaded by anyone: free
    const row = await db.prepare('SELECT text FROM subs_cache WHERE id = ?').bind(id).first();
    if (row && row.text) return json({ ok: true, text: row.text, cached: true });

    // 2) a real download: counted against the service's day and this address's day
    const dayLimit = Math.max(1, Number(env.SUBS_DAILY_LIMIT) || 18);
    const ipLimit = Math.max(1, Number(env.SUBS_IP_DAILY_LIMIT) || 8);
    const DAY = 24 * 3600 * 1000;
    if (await limited(db, 'subs:dl:ip:' + clientIp(request), ipLimit, DAY, now)) return json({ ok: false, error: 'You have reached today\'s subtitle download limit. It resets tomorrow.' }, 429);
    if (await limited(db, 'subs:dl:all', dayLimit, DAY, now)) return json({ ok: false, error: 'Subtitle downloads are used up for today. Try again tomorrow.' }, 429);

    let text = '';
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            const s = await osLogin(env, attempt > 0);
            const r = await fetch(s.base + '/api/v1/download', {
                method: 'POST',
                headers: osHeaders(env, { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.token }),
                body: JSON.stringify({ file_id: Number(id), sub_format: 'srt' })
            });
            if (r.status === 401 && attempt === 0) continue;                       // token went stale: sign in again once
            if (r.status === 406) {                                                  // OpenSubtitles says the real limit is reached: stop for everybody until tomorrow
                await db.prepare('UPDATE throttle SET n = ? WHERE k = ?').bind(dayLimit, 'subs:dl:all').run();
                return json({ ok: false, error: 'Subtitle downloads are used up for today. Try again tomorrow.' }, 429);
            }
            if (r.status === 429) return json({ ok: false, error: 'OpenSubtitles is busy. Try again in a minute.' }, 429);
            if (!r.ok) return json({ ok: false, error: 'OpenSubtitles answered HTTP ' + r.status + '.' }, 502);
            const j = await r.json();
            let link;
            try { link = new URL(j.link); } catch (e) { return json({ ok: false, error: 'No download link came back.' }, 502); }
            const h = link.hostname.toLowerCase();
            if (link.protocol !== 'https:' || !(h === 'opensubtitles.org' || h === 'opensubtitles.com' || h.endsWith('.opensubtitles.org') || h.endsWith('.opensubtitles.com'))) {
                return json({ ok: false, error: 'Unexpected download address.' }, 502);
            }
            const d = await fetch(link.href, { headers: { 'User-Agent': OS_UA } });
            if (!d.ok) return json({ ok: false, error: 'Could not download that subtitle.' }, 502);
            const buf = await d.arrayBuffer();
            if (!buf.byteLength || buf.byteLength > SUBS_MAX_BYTES) return json({ ok: false, error: 'That subtitle file is empty or too large.' }, 502);
            text = decodeSubtitle(buf);
            break;
        }
    } catch (e) {
        return json({ ok: false, error: 'Could not reach OpenSubtitles.' }, 502);
    }
    if (!text) return json({ ok: false, error: 'No subtitle came back.' }, 502);

    await db.prepare('INSERT OR REPLACE INTO subs_cache (id, text, created) VALUES (?, ?, ?)').bind(id, text, now).run();
    // tidy up now and then: old entries go
    if (Math.random() < 0.05) await db.prepare('DELETE FROM subs_cache WHERE created < ?').bind(now - SUBS_CACHE_DAYS * DAY).run();
    return json({ ok: true, text: text, cached: false });
}

// ---------------------------------------------------------------- invite admin (only with ADMIN_KEY)
// Anyone without the key gets the same answer as for a route that does not exist.
async function adminCheck(request, env, db, now) {
    const key = String(env.ADMIN_KEY || '');
    if (key.length < 16) return 'denied';                                   // not set up, or too short to be safe
    if (await limited(db, 'admin:ip:' + clientIp(request), 30, 15 * 60 * 1000, now)) return 'limited';
    const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    return sameString(await sha256Hex('pek:admin:' + given), await sha256Hex('pek:admin:' + key)) ? 'ok' : 'denied';
}

async function handleInvites(request, env, path) {
    const db = env.DB, now = Date.now(), DAY_MS = 24 * 3600 * 1000;
    const auth = await adminCheck(request, env, db, now);
    if (auth === 'limited') return json({ error: 'rate_limited' }, 429);
    if (auth !== 'ok') return json({ error: 'not_found' }, 404);
    const { body, err } = await readJson(request); if (err) return err;

    if (path === '/v1/invites/new') {
        const count = Math.max(1, Math.min(INVITE_MAX_NEW, Math.floor(Number(body.count) || 1)));
        const days = body.days == null ? INVITE_DEFAULT_DAYS : Math.max(0, Math.min(365, Math.floor(Number(body.days) || 0)));
        const note = String(body.note == null ? '' : body.note).replace(/\s+/g, ' ').trim().slice(0, 60);
        const codes = [], stmts = [];
        for (let i = 0; i < count; i++) {
            const code = newInviteCode();
            codes.push(code);
            stmts.push(db.prepare('INSERT INTO invites (hash, created, expires, note) VALUES (?, ?, ?, ?)').bind(await inviteHash(code), now, days ? now + days * DAY_MS : 0, note));
        }
        await db.batch(stmts);
        return json({ ok: true, codes, expiresInDays: days || null });
    }
    if (path === '/v1/invites/list') {
        const rows = (await db.prepare('SELECT i.hash, i.created, i.expires, i.note, i.reserved_by, i.reserved_until, i.used_at, u.email AS used_email FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created DESC LIMIT 200').all()).results || [];
        return json({ ok: true, invites: rows.map(r => ({
            id: r.hash.slice(0, 8),
            status: r.used_at ? 'used' : (r.expires && r.expires <= now) ? 'expired' : (r.reserved_by && r.reserved_until > now) ? 'waiting for email confirmation' : 'unused',
            note: r.note, created: new Date(r.created).toISOString(),
            expires: r.expires ? new Date(r.expires).toISOString() : null,
            usedBy: r.used_at ? (r.used_email || '(account deleted)') : null
        })) });
    }
    if (path === '/v1/invites/revoke') {
        const id = String(body.id || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (id.length !== 8) return json({ error: 'bad_id' }, 400);
        const r = await db.prepare('DELETE FROM invites WHERE substr(hash, 1, 8) = ? AND used_at IS NULL').bind(id).run();
        return r.meta && r.meta.changes ? json({ ok: true }) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
}

// ---------------------------------------------------------------- news (the app's Updates screen)
// GET /v1/news is public and returns the newest 30 messages that have not expired. Posting needs the ADMIN_KEY.
const NEWS_KINDS = ['news', 'update', 'coupon'];
function cleanNewsText(v, max) {
    return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
async function handleNewsList(env) {
    const now = Date.now();
    const rows = (await env.DB.prepare('SELECT id, created, kind, title, body, code, link FROM announcements WHERE expires = 0 OR expires > ? ORDER BY id DESC LIMIT 30').bind(now).all()).results || [];
    return json({ ok: true, items: rows.map(r => ({ id: r.id, created: r.created, kind: r.kind, title: r.title, body: r.body, code: r.code, link: r.link })) });
}
async function handleNews(request, env, path) {
    const db = env.DB, now = Date.now(), DAY_MS = 24 * 3600 * 1000;
    const auth = await adminCheck(request, env, db, now);
    if (auth === 'limited') return json({ error: 'rate_limited' }, 429);
    if (auth !== 'ok') return json({ error: 'not_found' }, 404);
    const { body, err } = await readJson(request); if (err) return err;
    if (path === '/v1/news/post') {
        const title = cleanNewsText(body.title, 80).replace(/\n/g, ' ');
        if (!title) return json({ error: 'title_required' }, 400);
        const kind = NEWS_KINDS.indexOf(body.kind) >= 0 ? body.kind : 'news';
        const text = cleanNewsText(body.body, 1500);
        const code = cleanNewsText(body.code, 40).replace(/\s+/g, '');
        const link = /^https:\/\/[^\s<>"]{3,200}$/.test(String(body.link || '')) ? String(body.link) : '';
        const days = body.days == null ? 0 : Math.max(0, Math.min(365, Math.floor(Number(body.days) || 0)));   // 0 = never expires
        const r = await db.prepare('INSERT INTO announcements (created, expires, kind, title, body, code, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(now, days ? now + days * DAY_MS : 0, kind, title, text, code, link).run();
        return json({ ok: true, id: r.meta && r.meta.last_row_id, expiresInDays: days || null });
    }
    if (path === '/v1/news/list') {
        const rows = (await db.prepare('SELECT id, created, expires, kind, title, code FROM announcements ORDER BY id DESC LIMIT 100').all()).results || [];
        return json({ ok: true, items: rows.map(r => ({ id: r.id, created: new Date(r.created).toISOString(), expires: r.expires ? new Date(r.expires).toISOString() : null, live: !r.expires || r.expires > now, kind: r.kind, title: r.title, code: r.code })) });
    }
    if (path === '/v1/news/delete') {
        const id = Math.floor(Number(body.id));
        if (!(id > 0)) return json({ error: 'bad_id' }, 400);
        const r = await db.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();
        return r.meta && r.meta.changes ? json({ ok: true }) : json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
}

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
            if (method === 'POST' && path === '/v1/auth/reject') return await handleRejectToken(request, env);
            if (method === 'POST' && path === '/v1/device/start') return await handleDeviceStart(request, env);
            if (method === 'POST' && path === '/v1/device/poll') return await handleDevicePoll(request, env);
            if (method === 'POST' && path.indexOf('/v1/invites/') === 0) return await handleInvites(request, env, path);
            if (method === 'GET' && path === '/v1/news') return await handleNewsList(env);
            if (method === 'POST' && path.indexOf('/v1/news/') === 0) return await handleNews(request, env, path);

            // Subtitles: no sign-in needed (everyone shares the server's OpenSubtitles account)
            if (method === 'POST' && path === '/v1/subs/search') return await handleSubsSearch(request, env);
            if (method === 'POST' && path === '/v1/subs/get') return await handleSubsGet(request, env);

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
            if (method === 'GET' && path === '/v1/me') return await handleMe(env, sess.userId);
            if (method === 'POST' && path === '/v1/device/info') return await handleDeviceInfo(request, env, sess.userId);
            if (method === 'POST' && path === '/v1/device/approve') return await handleDeviceApprove(request, env, sess.userId);
            if (method === 'POST' && path === '/v1/device/reject') return await handleDeviceReject(request, env, sess.userId);
            if (method === 'POST' && path === '/v1/account/username') return await handleSetUsername(request, env, sess.userId);
            // Cloud backup (profile sync, watch-history sync, plugin backup) is a paid feature. Export and account deletion stay free.
            if (path === '/v1/profiles/sync' || path === '/v1/sync' || path.indexOf('/v1/plugins') === 0) {
                if (!(await planOf(env.DB, sess.userId, Date.now())).entitled) return json({ error: 'subscription_required' }, 402);
            }
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
