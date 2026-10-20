# SaaS Starter

Next.js 14 (App Router) + TypeScript + Prisma + Stripe.

- **Sign-up / log-in**: email + password, bcrypt hashing, signed JWT session in an httpOnly cookie
- **Dashboard**: protected by middleware, shows plan status and gates a "Pro" section
- **Stripe subscriptions**: Checkout to subscribe, Billing Portal to manage or cancel, webhooks keep the DB in sync

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the values (see below)
npm run db:push               # creates the SQLite DB from prisma/schema.prisma
npm run dev                   # http://localhost:3000
```

### Stripe setup (test mode)

1. Create a product (e.g. "Pro") with a **recurring** price in the [Stripe dashboard](https://dashboard.stripe.com/test/products). Put its `price_...` ID in `STRIPE_PRICE_ID`.
2. Put your secret key in `STRIPE_SECRET_KEY`.
3. Turn on the [Customer Portal](https://dashboard.stripe.com/test/settings/billing/portal) (save its settings once).
4. Forward webhooks locally with the [Stripe CLI](https://stripe.com/docs/stripe-cli):
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```
   Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET` and restart `npm run dev`.
5. Sign up, click **Upgrade to Pro**, and pay with card `4242 4242 4242 4242` (any future date and any CVC).

## How it works

| Path | Purpose |
| --- | --- |
| `app/actions/auth.ts` | Server actions for signup, login and logout |
| `lib/session.ts` | Edge-safe JWT sign/verify (used by middleware) |
| `lib/auth.ts` | Cookie handling, `getCurrentUser()`, `requireUser()` |
| `middleware.ts` | Redirects logged-out users away from `/dashboard` and logged-in users away from `/login` and `/signup` |
| `app/api/stripe/checkout` | Creates or reuses the Stripe customer, then redirects to Checkout |
| `app/api/stripe/portal` | Redirects to the Stripe Billing Portal |
| `app/api/stripe/webhook` | Verifies the signature and syncs subscription status, price and period end to the `User` |
| `lib/plans.ts` | Plan display info and `hasActiveSubscription()` |

**The webhook is the source of truth for subscription state.** The success redirect only shows a banner. Access is granted once `customer.subscription.*` or `checkout.session.completed` updates the user.

Webhook events to enable in production: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.

## Going to production

- Switch `provider` in `prisma/schema.prisma` to `postgresql` and point `DATABASE_URL` at your database.
- Set `APP_URL` to your real domain and use a strong random `AUTH_SECRET`.
- Add a webhook endpoint in the Stripe dashboard at `https://yourdomain.com/api/stripe/webhook`.
- Consider adding email verification, password reset and rate limiting on the auth actions.
