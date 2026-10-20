import "server-only";
import Stripe from "stripe";
import { prisma } from "@/lib/db";

let client: Stripe | null = null;

/** Lazily construct the Stripe client so builds don't require the key. */
export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    client = new Stripe(key, { typescript: true });
  }
  return client;
}

export function appUrl(fallbackOrigin: string) {
  return process.env.NEXT_PUBLIC_APP_URL || fallbackOrigin;
}

/** Copy a Stripe subscription's state onto the matching user row. */
export async function syncSubscription(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  await prisma.user.updateMany({
    where: { stripeCustomerId: customerId },
    data: {
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      stripePriceId: sub.items.data[0]?.price.id ?? null,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    },
  });
}
