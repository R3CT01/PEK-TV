// PEK Billing: Stripe payments for PEK Cloud. A SEPARATE Cloudflare Worker from cloud/worker.js.
// It shares the same D1 database (bound as "DB") so it can see who is signed in and write each account's plan.
// cloud/worker.js never talks to Stripe; this worker never touches watch history. Only this worker changes a plan.
//
// Plans (all paid on the website, never inside the app):
//   monthly   $5.99 / month      yearly   $48 / year      lifetime   $199 once
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   STRIPE_SECRET_KEY      (Secret)  sk_test_... while testing, sk_live_... when you go live
//   STRIPE_WEBHOOK_SECRET  (Secret)  whsec_... from the webhook endpoint you add in Stripe (see cloud/BILLING-DEPLOY.md)
//   SITE_URL               (Text)    where the PEK TV site lives: https://pekindustries.com/pektv (no slash at the end). Stripe sends people back to SITE_URL/account.
//   ALLOWED_ORIGINS        (Text, optional) extra origins allowed to call this worker, comma separated (e.g. https://pek-tv.web.app while you switch over, or http://localhost:5000).
//                          The origin of SITE_URL (https://pekindustries.com) is always allowed.
//   STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY / STRIPE_PRICE_LIFETIME  (Text, optional) price_... ids from the Stripe dashboard.
//                          Leave them out and the worker uses the prices written below.
//
// Routes:
//   GET   /                         -> "pek-billing ok"
//   POST  /v1/billing/checkout  { plan: monthly|yearly|lifetime } -> { ok, url }   (Authorization: Bearer <session token>; send the person to url)
//   POST  /v1/billing/portal    {}                                -> { ok, url }   (Stripe's page to cancel, change card, see invoices)
//   POST  /v1/billing/webhook                                     Stripe -> worker (checked with the webhook secret)

const GRACE_MS = 3 * 24 * 3600 * 1000;     // a renewal that is a little late does not lock someone out right away
const PLANS = {
    monthly:  { mode: 'subscription', amount: 599,   interval: 'month', name: 'PEK Cloud (monthly)',  env: 'STRIPE_PRICE_MONTHLY' },
    yearly:   { mode: 'subscription', amount: 4800,  interval: 'year',  name: 'PEK Cloud (yearly)',   env: 'STRIPE_PRICE_YEARLY' },
    lifetime: { mode: 'payment',      amount: 19900,                    name: 'PEK Cloud (lifetime)', env: 'STRIPE_PRICE_LIFETIME' }
};
const SESSION_REFRESH_BELOW = 60 * 24 * 3600 * 1000;   // same sliding session as worker.js
const SESSION_TTL = 90 * 24 * 3600 * 1000;
const enc = new TextEncoder();

function corsFor(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ok = new Set();
    try { ok.add(new URL(String(env.SITE_URL || '')).origin); } catch (e) { /* SITE_URL not set yet */ }
    String(env.ALLOWED_ORIGINS || '').split(',').forEach(o => { o = o.trim().replace(/\/+$/, ''); if (o) ok.add(o); });
    const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
    if (origin && ok.has(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
}
function json(obj, status, cors) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors || {}) });
}

// ---------------------------------------------------------------- helpers
function hex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
function sameString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

let ready = false;
async function init(db) {
    if (ready) return;
    // Same columns (and same defaults) as cloud/worker.js: whichever worker runs first adds them.
    const cols = [
        "plan TEXT NOT NULL DEFAULT 'grandfathered'", 'plan_until INTEGER NOT NULL DEFAULT 0', 'plan_cancel INTEGER NOT NULL DEFAULT 0',
        "stripe_customer TEXT NOT NULL DEFAULT ''", "stripe_sub TEXT NOT NULL DEFAULT ''"
    ];
    for (const c of cols) { try { await db.prepare('ALTER TABLE users ADD COLUMN ' + c).run(); } catch (e) { /* already there */ } }
    // Stripe resends events: each one is only applied once.
    await db.prepare('CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, created INTEGER NOT NULL)').run();
    ready = true;
}

async function sessionUser(request, db, now) {
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
    if (!m || m[1].length < 20 || m[1].length > 100) return null;
    const hash = await sha256Hex('hesper:session:' + m[1]);
    const row = await db.prepare('SELECT user_id, expires FROM sessions WHERE token_hash = ?').bind(hash).first();
    if (!row || row.expires < now) return null;
    if (row.expires - now < SESSION_REFRESH_BELOW) await db.prepare('UPDATE sessions SET expires = ? WHERE token_hash = ?').bind(now + SESSION_TTL, hash).run();
    return await db.prepare('SELECT id, email, plan, plan_until, plan_cancel, stripe_customer, stripe_sub FROM users WHERE id = ? AND verified = 1').bind(row.user_id).first();
}

function entitled(u, now) {
    if (!u) return false;
    if (u.plan === 'grandfathered' || u.plan === 'lifetime') return true;
    return (u.plan === 'monthly' || u.plan === 'yearly') && Number(u.plan_until) > now;
}

// ---------------------------------------------------------------- Stripe API (plain fetch, no library)
// Stripe wants form encoding with bracket keys: { a: { b: 1 }, c: [x] } -> a[b]=1&c[0]=x
function form(obj, prefix, out) {
    out = out || [];
    Object.keys(obj).forEach(k => {
        const v = obj[k];
        if (v === undefined || v === null) return;
        const key = prefix ? prefix + '[' + k + ']' : k;
        if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object') ? form(x, key + '[' + i + ']', out) : out.push(encodeURIComponent(key + '[' + i + ']') + '=' + encodeURIComponent(x)));
        else if (typeof v === 'object') form(v, key, out);
        else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    });
    return out;
}
async function stripe(env, method, path, body) {
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    const r = await fetch('https://api.stripe.com' + path, {
        method,
        headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body ? form(body).join('&') : undefined
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error('stripe ' + r.status + ': ' + (data.error && data.error.message || 'error')); e.status = r.status; throw e; }
    return data;
}

// ---------------------------------------------------------------- checkout + portal
function siteUrl(env) { return String(env.SITE_URL || '').replace(/\/+$/, ''); }

async function handleCheckout(request, env, cors) {
    const db = env.DB, now = Date.now();
    const user = await sessionUser(request, db, now);
    if (!user) return json({ error: 'bad_session' }, 401, cors);
    let body = {};
    try { body = await request.json(); } catch (e) { /* empty */ }
    const plan = PLANS[body.plan] ? body.plan : '';
    if (!plan) return json({ error: 'bad_plan' }, 400, cors);
    if (!siteUrl(env)) return json({ error: 'not_configured' }, 500, cors);

    // Nothing to buy twice: lifetime and grandfathered accounts have everything; a renewing subscription is changed in the portal.
    if (user.plan === 'lifetime' || user.plan === 'grandfathered') return json({ error: 'already_paid' }, 409, cors);
    if (entitled(user, now) && plan !== 'lifetime') return json({ error: 'use_portal' }, 409, cors);

    const p = PLANS[plan];
    let customer = user.stripe_customer;
    if (!customer) {
        const c = await stripe(env, 'POST', '/v1/customers', { email: user.email, metadata: { user_id: user.id } });
        customer = c.id;
        await db.prepare('UPDATE users SET stripe_customer = ? WHERE id = ?').bind(customer, user.id).run();
    }
    const priceId = String(env[p.env] || '');
    const item = priceId ? { price: priceId, quantity: 1 } : {
        quantity: 1,
        price_data: Object.assign({ currency: 'usd', unit_amount: p.amount, product_data: { name: p.name } }, p.interval ? { recurring: { interval: p.interval } } : {})
    };
    const meta = { user_id: user.id, plan };
    const session = await stripe(env, 'POST', '/v1/checkout/sessions', Object.assign({
        mode: p.mode,
        customer,
        client_reference_id: user.id,
        line_items: [item],
        metadata: meta,
        success_url: siteUrl(env) + '/account?paid=1',
        cancel_url: siteUrl(env) + '/account?canceled=1',
        allow_promotion_codes: 'true'
    }, p.mode === 'subscription' ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }));
    return json({ ok: true, url: session.url }, 200, cors);
}

async function handlePortal(request, env, cors) {
    const user = await sessionUser(request, env.DB, Date.now());
    if (!user) return json({ error: 'bad_session' }, 401, cors);
    if (!user.stripe_customer) return json({ error: 'no_customer' }, 404, cors);
    const s = await stripe(env, 'POST', '/v1/billing_portal/sessions', { customer: user.stripe_customer, return_url: siteUrl(env) + '/account' });
    return json({ ok: true, url: s.url }, 200, cors);
}

// ---------------------------------------------------------------- webhook
async function verifySignature(raw, header, secret) {
    if (!secret || !header) return false;
    const parts = {};
    header.split(',').forEach(kv => { const i = kv.indexOf('='); if (i > 0) (parts[kv.slice(0, i).trim()] = parts[kv.slice(0, i).trim()] || []).push(kv.slice(i + 1).trim()); });
    const t = Number((parts.t || [])[0]);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;           // older than 5 minutes: a replay
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + raw)));
    return (parts.v1 || []).some(v => sameString(v, expected));
}

async function userFor(db, userId, customer) {
    let u = userId ? await db.prepare('SELECT id, plan, stripe_sub FROM users WHERE id = ?').bind(userId).first() : null;
    if (!u && customer) u = await db.prepare('SELECT id, plan, stripe_sub FROM users WHERE stripe_customer = ?').bind(customer).first();
    return u;
}

// Turns a Stripe subscription into the account's plan.
async function applySubscription(db, sub) {
    const u = await userFor(db, sub.metadata && sub.metadata.user_id, typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id));
    if (!u || u.plan === 'lifetime' || u.plan === 'grandfathered') return;    // these never go down
    if (u.plan !== 'free' && u.stripe_sub && u.stripe_sub !== sub.id) return;   // an older, replaced subscription
    const item = sub.items && sub.items.data && sub.items.data[0];
    if (['active', 'trialing', 'past_due'].indexOf(sub.status) >= 0) {
        const end = Number(sub.current_period_end || (item && item.current_period_end) || 0) * 1000;
        const interval = item && item.price && item.price.recurring ? item.price.recurring.interval : (item && item.plan && item.plan.interval) || 'month';
        await db.prepare('UPDATE users SET plan = ?, plan_until = ?, plan_cancel = ?, stripe_sub = ? WHERE id = ?')
            .bind(interval === 'year' ? 'yearly' : 'monthly', end ? end + GRACE_MS : 0, (sub.cancel_at_period_end || sub.cancel_at) ? 1 : 0, sub.id, u.id).run();
    } else if (['canceled', 'unpaid', 'incomplete_expired'].indexOf(sub.status) >= 0) {
        await db.prepare("UPDATE users SET plan = 'free', plan_until = 0, plan_cancel = 0, stripe_sub = '' WHERE id = ? AND stripe_sub = ?").bind(u.id, sub.id).run();
    }
}

async function freshSubscription(env, payload) {
    try { return await stripe(env, 'GET', '/v1/subscriptions/' + encodeURIComponent(payload.id)); } catch (e) { return payload; }   // the event itself is the fallback
}

async function handleEvent(env, ev) {
    const db = env.DB, obj = ev.data && ev.data.object;
    if (!obj) return;
    if (ev.type === 'checkout.session.completed') {
        const userId = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
        const u = await userFor(db, userId, obj.customer);
        if (!u) return;
        if (obj.mode === 'payment' && obj.payment_status === 'paid' && obj.metadata && obj.metadata.plan === 'lifetime') {
            // Lifetime replaces any renewing subscription: stop that one so they are not charged twice.
            const oldSub = u.stripe_sub;
            await db.prepare("UPDATE users SET plan = 'lifetime', plan_until = 0, plan_cancel = 0, stripe_sub = '' WHERE id = ? AND plan <> 'grandfathered'").bind(u.id).run();
            if (oldSub) { try { await stripe(env, 'DELETE', '/v1/subscriptions/' + encodeURIComponent(oldSub)); } catch (e) { console.error('could not cancel old subscription', String(e)); } }
        } else if (obj.mode === 'subscription' && obj.subscription) {
            await applySubscription(db, await freshSubscription(env, { id: typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id, metadata: { user_id: u.id }, customer: obj.customer }));
        }
    } else if (ev.type === 'customer.subscription.created' || ev.type === 'customer.subscription.updated') {
        await applySubscription(db, await freshSubscription(env, obj));
    } else if (ev.type === 'customer.subscription.deleted') {
        await applySubscription(db, Object.assign({}, obj, { status: 'canceled' }));
    }
}

async function handleWebhook(request, env) {
    const raw = await request.text();
    if (!(await verifySignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return new Response('bad signature', { status: 400 });
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { return new Response('bad json', { status: 400 }); }
    const db = env.DB;
    if (ev.id && await db.prepare('SELECT id FROM stripe_events WHERE id = ?').bind(ev.id).first()) return new Response('ok', { status: 200 });   // already handled
    try {
        await handleEvent(env, ev);
    } catch (e) {
        console.error('webhook error', ev.type, String(e && e.stack || e));
        return new Response('error', { status: 500 });     // Stripe tries again later
    }
    if (ev.id) {
        await db.prepare('INSERT OR IGNORE INTO stripe_events (id, created) VALUES (?, ?)').bind(ev.id, Date.now()).run();
        await db.prepare('DELETE FROM stripe_events WHERE created < ?').bind(Date.now() - 30 * 24 * 3600 * 1000).run();
    }
    return new Response('ok', { status: 200 });
}

// ---------------------------------------------------------------- router
export default {
    async fetch(request, env) {
        const cors = corsFor(request, env);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        const path = new URL(request.url).pathname, method = request.method;
        if (method === 'GET' && (path === '/' || path === '')) return new Response('pek-billing ok', { headers: { 'Content-Type': 'text/plain' } });
        try {
            await init(env.DB);
            if (method === 'POST' && path === '/v1/billing/webhook') return await handleWebhook(request, env);
            if (method === 'POST' && path === '/v1/billing/checkout') return await handleCheckout(request, env, cors);
            if (method === 'POST' && path === '/v1/billing/portal') return await handlePortal(request, env, cors);
            return json({ error: 'not_found' }, 404, cors);
        } catch (e) {
            console.error('billing error', String(e && e.stack || e));
            return json({ error: 'server_error' }, 500, cors);
        }
    }
};
