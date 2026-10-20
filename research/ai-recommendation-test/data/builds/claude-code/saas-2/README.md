# SaaS Starter

A Next.js starter with email/password sign-up, a protected dashboard and a Stripe subscription.

**Stack:** Next.js 14 (App Router, TypeScript) · Prisma (SQLite by default) · Stripe Checkout + Billing Portal + webhooks · JWT session cookies (`jose`) · bcrypt password hashes.

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the values (see below)
npm run db:push               # creates the SQLite DB from prisma/schema.prisma
npm run dev                   # http://localhost:3000
```

In a second terminal, forward Stripe webhooks to your local server (needs the [Stripe CLI](https://stripe.com/docs/stripe-cli)):

```bash
stripe login
npm run stripe:listen         # prints a whsec_... secret: put it in STRIPE_WEBHOOK_SECRET, then restart `npm run dev`
```

### Environment variables

| Var | What it is |
| --- | --- |
| `DATABASE_URL` | `file:./dev.db` for local SQLite |
| `AUTH_SECRET` | 32+ random chars: `openssl rand -base64 32` |
| `APP_URL` | Base URL, e.g. `http://localhost:3000` |
| `STRIPE_SECRET_KEY` | Test secret key from the Stripe dashboard |
| `STRIPE_PRICE_ID` | ID of a **recurring** price (Products → Add product → recurring price) |
| `STRIPE_WEBHOOK_SECRET` | From `stripe listen` locally, or from your webhook endpoint in production |

Also turn on the **Customer Portal** in Stripe (Settings → Billing → Customer portal) so "Manage billing" works.

### Try it

1. Sign up at `/signup`. You land on `/dashboard` on the Free plan.
2. Click **Upgrade now** and pay with test card `4242 4242 4242 4242` (any future date, any CVC).
3. You're sent back to the dashboard; the webhook flips you to **Pro** within a few seconds.
4. **Manage billing** opens the Stripe portal, where you can cancel. The webhook keeps the dashboard in sync.

## How it works

```
app/
  page.tsx                     Landing page + pricing
  signup/, login/              Auth pages (server actions in app/actions/auth.ts)
  dashboard/page.tsx           Protected dashboard, plan status, upgrade/billing, gated content
  api/auth/signout/            Clears the session cookie
  api/stripe/checkout/         Creates a Stripe customer (once) + Checkout Session → redirect
  api/stripe/portal/           Opens the Stripe Billing Portal
  api/stripe/webhook/          Verifies signature, syncs subscription state to the User row
lib/
  session.ts                   Sign/verify JWT (edge-safe, used by middleware)
  auth.ts                      Cookie helpers, getCurrentUser(), hasActiveSubscription()
  stripe.ts                    Stripe client + syncSubscription()
  config.ts                    Product name, plan names/prices/features (display only)
middleware.ts                  Redirects signed-out users away from /dashboard
prisma/schema.prisma           User model with Stripe billing fields
```

- **Source of truth for billing is Stripe.** The app never marks a user as paid from the redirect; only the signed webhook updates `subscriptionStatus`. The webhook re-fetches the subscription on every event, so events that arrive out of order can't leave stale state behind.
- **Gating:** use `hasActiveSubscription(user)` (status `active` or `trialing`) on any server component or route.
- Webhook events used: `checkout.session.completed`, `customer.subscription.created|updated|deleted|paused|resumed`. In production, add an endpoint at `https://your-domain/api/stripe/webhook` that listens for those events.

## Going to production

- Switch to Postgres: set `provider = "postgresql"` in `prisma/schema.prisma` and point `DATABASE_URL` at your DB, then run `npx prisma migrate deploy` (or `db push`).
- Set every env var on your host, with `APP_URL` set to your real domain.
- Add rate limiting to the login and signup actions (e.g. Upstash), plus email verification and password reset if you need them.
