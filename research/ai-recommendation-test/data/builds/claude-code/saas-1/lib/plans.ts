// Display-only plan info. The actual price charged comes from STRIPE_PRICE_ID —
// keep these in sync with your Stripe product.
export const PRO_PLAN = {
  name: "Pro",
  priceLabel: "$19",
  interval: "month",
  features: [
    "Unlimited projects",
    "Priority support",
    "Advanced analytics",
    "Cancel anytime",
  ],
};

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export function hasActiveSubscription(status: string | null | undefined) {
  return !!status && ACTIVE_STATUSES.has(status);
}
