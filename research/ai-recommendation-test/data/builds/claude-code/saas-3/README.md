# SaaS Starter

Next.js 14 (App Router) + TypeScript with:

- **Sign-up / log-in**: email + password (bcrypt), session in a signed httpOnly JWT cookie (`jose`)
- **Dashboard**: protected by middleware plus a server-side check, with plan status and a Pro-gated section
- **Stripe subscriptions**: Checkout to subscribe, Customer Portal to manage or cancel, webhooks to keep the DB in sync
- **Prisma** with SQLite for local dev (swap to Postgres for production)

## Quick start

```bash
npm install
cp .env.example .env          # then fill in the values (see below)
npm run db:push               # creates prisma/dev.db
npm run dev                   # http://localhost:3000
```

### Stripe setup (test mode)

1. Create a **Product** with a **recurring Price** (e.g. $19/month). Put its ID in `STRIPE_PRICE_ID`.
2. Copy your secret key into `STRIPE_SECRET_KEY`.
3. Enable the **Customer Portal**: Dashboard → Settings → Billing → Customer portal → Save.
4. Forward webhooks locally with the [Stripe CLI](https://stripe.com/docs/stripe-cli):
   ```bash
   npm run stripe:listen
   ```
   Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET` and restart `npm run dev`.
5. Sign up, click **Upgrade to Pro**, and pay with card `4242 4242 4242 4242` (any future date and any CVC).

### Generate `AUTH_SECRET`

```bash
openssl rand -base64 32
```

## How it works

| Path | Purpose |
| --- | --- |
| `src/app/actions/auth.ts` | Server actions: `signup`, `login`, `logout` |
| `src/lib/session.ts` | Edge-safe JWT sign/verify (used by middleware) |
| `src/lib/auth.ts` | Cookie handling, `getCurrentUser`, `hasActiveSubscription` |
| `src/middleware.ts` | Redirects signed-out visitors away from `/dashboard` |
| `src/app/dashboard/page.tsx` | Dashboard and billing UI |
| `src/app/api/stripe/checkout` | Creates the Stripe customer (once) and a Checkout Session |
| `src/app/api/stripe/portal` | Opens the Stripe Customer Portal |
| `src/app/api/stripe/webhook` | Verifies the signature and syncs subscription state to the `User` row |

The **webhook is the source of truth** for subscription status. The success redirect
only shows a notice. Handled events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

To gate a feature, use `hasActiveSubscription(user)` (status `active` or `trialing`).

## Deploying

1. Switch `provider` in `prisma/schema.prisma` to `"postgresql"` and set `DATABASE_URL`.
2. Set all env vars from `.env.example`, with `NEXT_PUBLIC_APP_URL` set to your domain.
3. In Stripe → Developers → Webhooks, add `https://your-domain.com/api/stripe/webhook`
   with the four events above, and use that endpoint's signing secret.
4. Run `npx prisma db push` (or adopt `prisma migrate`) against the production DB.

## Next steps you'll likely want

- Rate limiting on login and sign-up
- Email verification and password reset
- Multiple plans or annual pricing (read `stripePriceId` on the user)
- Tests and CI
