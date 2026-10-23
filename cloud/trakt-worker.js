// PEK TV Trakt sign-in proxy (Cloudflare Worker). Setup: TRAKT-DEPLOY.md.
//
// Why it exists: signing in to Trakt needs the Trakt app's client SECRET, and anything inside the apk can be read. This worker
// keeps the secret and adds it to the four sign-in calls the Trakt plugin makes. Everything else the plugin does (scrobbling,
// history, search) goes straight from the phone to api.trakt.tv with the person's own token, so this worker never sees it.
//
//   GET  /client              -> { client_id }                      (public: the id is not a secret)
//   POST /oauth/device/code   {}                                    -> Trakt: a code for the person to type at trakt.tv/activate
//   POST /oauth/device/token  { code }                              -> Trakt: the tokens, once the person approved
//   POST /oauth/token         { refresh_token }                     -> Trakt: a new access token
//   POST /oauth/revoke        { token }                             -> Trakt: sign out
//
// Secrets to set in the Cloudflare dashboard (Settings > Variables and Secrets): TRAKT_CLIENT_ID, TRAKT_CLIENT_SECRET.
// Nothing is stored and nothing is logged. Only the fields listed below are passed on, so the plugin cannot make the worker
// call anything else or choose its own grant type.

const TRAKT = 'https://api.trakt.tv';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const MAX_BODY = 2048;

const ROUTES = {
    '/oauth/device/code': { required: [], secret: false },
    '/oauth/device/token': { required: ['code'], secret: true },
    '/oauth/token': { required: ['refresh_token'], secret: true, extra: { grant_type: 'refresh_token', redirect_uri: OOB } },
    '/oauth/revoke': { required: ['token'], secret: true },
};

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

export default {
    async fetch(req, env) {
        if (!env.TRAKT_CLIENT_ID || !env.TRAKT_CLIENT_SECRET) return reply({ error: 'not configured' }, 503);
        const path = new URL(req.url).pathname;

        if (req.method === 'GET' && path === '/client') return reply({ client_id: env.TRAKT_CLIENT_ID });

        const route = ROUTES[path];
        if (!route || req.method !== 'POST') return reply({ error: 'not found' }, 404);

        let body = {};
        try {
            const text = await req.text();
            if (text.length > MAX_BODY) return reply({ error: 'too large' }, 413);
            body = text.trim() ? JSON.parse(text) : {};
        } catch (e) {
            return reply({ error: 'bad json' }, 400);
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'bad json' }, 400);

        const out = { client_id: env.TRAKT_CLIENT_ID };
        for (const f of route.required) {
            if (typeof body[f] !== 'string' || !body[f] || body[f].length > 256) return reply({ error: 'missing ' + f }, 400);
            out[f] = body[f];
        }
        if (route.secret) out.client_secret = env.TRAKT_CLIENT_SECRET;
        Object.assign(out, route.extra || {});

        let r;
        try {
            r = await fetch(TRAKT + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': env.TRAKT_CLIENT_ID, 'User-Agent': 'PEK-TV-trakt-proxy' },
                body: JSON.stringify(out),
            });
        } catch (e) {
            return reply({ error: 'trakt unreachable' }, 502);
        }
        // Trakt's own status matters to the plugin: 400 = still waiting, 418 = denied, 429 = slow down, 410 = expired.
        const headers = { ...JSON_HEADERS };
        const retry = r.headers.get('Retry-After');
        if (retry) headers['Retry-After'] = retry;
        return new Response(await r.text(), { status: r.status, headers });
    },
};
