# PEK Cloud plans and Stripe payments

Accounts are free. **PEK Cloud** is the paid part: cloud backup (watch history, resume points, plugin backup)
and up to 5 profiles. A free account keeps working with 1 profile and no cloud backup.

| Plan | Price | Stripe mode |
|---|---|---|
| Monthly | $5.99 / month | subscription |
| Yearly | $48 / year | subscription |
| Lifetime | $199 once | one-time payment |

Payment only happens on the website (`public/pektv/account.html`, Stripe Checkout). The app never takes payment: it only asks
the cloud which plan the account has (`GET /v1/me`) and opens the website for upgrades.

## How the pieces fit

- `cloud/worker.js` (existing) keeps accounts, sessions and sync. It now stores each account's plan and answers
  `402 subscription_required` for sync, profile sync and plugin backup on a free account. Export and account deletion stay free.
- `cloud/billing-worker.js` (**new, separate worker**) talks to Stripe: starts Checkout, opens the customer portal and receives
  Stripe's webhook. It is the only thing that changes a plan. It shares the same D1 database.
- `public/pektv/account.html` + `public/pektv/js/account.js` (website, at `pekindustries.com/pektv/account`): create account, sign in, pick a plan, pay, manage.
- Accounts that existed before this update are **grandfathered**: everything unlocked, forever. New sign-ups start free.
- Renewing plans stay on for 3 days after a missed renewal date, then lock until Stripe collects the payment. Buying
  lifetime while subscribed cancels the subscription so nobody is charged twice. A renewing subscription has to be
  cancelled (portal) before the account can be deleted, otherwise Stripe would keep charging.

## 1. Stripe (start in TEST mode)

1. Create an account at https://dashboard.stripe.com. Make sure the **Test mode** switch (top right) is on.
2. Developers -> API keys -> copy the **Secret key** (`sk_test_...`).
3. Settings -> Billing -> **Customer portal** -> turn it on (allow cancelling subscriptions and updating the card).
4. You do **not** need to create products or prices: the worker sends the three prices itself. (If you prefer dashboard
   prices, create them and put their `price_...` ids in `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, `STRIPE_PRICE_LIFETIME`.)

## 2. Update the cloud worker first

1. Cloudflare -> the existing worker (`hesper-sync`) -> **Edit code** -> paste all of the new `cloud/worker.js` -> **Deploy**.
2. Visit the worker URL once. The new plan columns are added on the first request; every existing account becomes `grandfathered`.

Do this **before** deploying the billing worker or the new app.

## 3. Create the billing worker

1. Workers & Pages -> Create -> Hello World -> name it `pek-billing` -> Deploy -> **Edit code** -> paste all of
   `cloud/billing-worker.js` -> **Deploy**.
2. Worker -> Settings -> **Bindings** -> Add -> D1 database -> variable name `DB` -> `hesper-sync` (the SAME database).
3. Worker -> Settings -> **Variables and Secrets**:
   - **Secret** `STRIPE_SECRET_KEY` = `sk_test_...`
   - **Text** `SITE_URL` = `https://pekindustries.com/pektv` (where the PEK TV site lives, no slash at the end; use `https://YOUR-PROJECT.web.app/pektv` until the domain is connected)
   - **Secret** `STRIPE_WEBHOOK_SECRET` = added in step 4
4. Stripe -> Developers -> **Webhooks** -> Add endpoint:
   - URL: `https://pek-billing.<your-subdomain>.workers.dev/v1/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`, then **Deploy** the worker.
5. Visit the worker URL. It should say `pek-billing ok`.
6. If your worker address is not `https://pek-billing.aquariusibeats.workers.dev`, change `BILLING` at the top of
   `public/pektv/js/account.js`.

## 4. Website

`firebase deploy --only hosting` from the site folder. The page is `pekindustries.com/pektv/account`. If your billing worker is not `https://pek-billing.aquariusibeats.workers.dev`, edit `BILLING` at the top of `public/pektv/js/account.js` first.

## 5. Test it (no real money)

1. Make a brand-new account in the app (you need an invite code). It starts **Free**: Settings -> Account shows a FREE badge with a QR code and the web address for getting PEK Cloud, and a second profile is locked.
2. Open the website -> Account -> sign in (a code is emailed) -> pick a plan -> pay with card `4242 4242 4242 4242`, any
   future expiry, any CVC, any postcode.
3. You come back to the account page; within a few seconds it shows the plan. The app (with Settings -> Account open) notices by itself: the badge changes to PAID and the first backup starts. You can also tap **I have subscribed** or **Sync now**.
4. Try the other cards: `4000 0000 0000 0002` (declined), `4000 0027 6000 3184` (3D Secure).
5. Test renewals and cancellations without waiting: Stripe dashboard -> Billing -> **Test clocks**.
6. Stripe -> Developers -> Webhooks -> your endpoint shows every delivery and lets you resend one.

## 6. Going live

1. Stripe: finish activating the account, switch Test mode off, copy the **live** secret key, enable the Customer portal in live mode,
   and add the webhook endpoint again in live mode (it has its own `whsec_...`).
2. Replace `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the worker with the live values. No code changes.

## Granting or removing a plan by hand

In Cloudflare -> D1 -> `hesper-sync` -> Console:

```sql
UPDATE users SET plan = 'lifetime', plan_until = 0 WHERE email = 'friend@example.com';   -- give someone PEK Cloud
UPDATE users SET plan = 'free', plan_until = 0, plan_cancel = 0, stripe_sub = '' WHERE email = 'someone@example.com';
```

Plan values: `free`, `grandfathered`, `monthly`, `yearly`, `lifetime`.

## Refunds

A refunded **lifetime** payment does not lock the account automatically: set the plan back to `free` with the SQL above.
Cancelling or refunding a subscription in Stripe is picked up by the webhook.

## Notes

- Existing signed-in app users keep working: the app asks `/v1/me` on start and treats a worker without plans as unlocked.
- Google Play's rules for selling digital features may apply if you ever publish the app there; the website-only payment
  works for the APK you ship from GitHub.
