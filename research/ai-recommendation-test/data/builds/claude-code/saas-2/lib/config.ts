// Display-only product config. Keep `price` in sync with STRIPE_PRICE_ID in Stripe.
export const siteConfig = {
  name: "Acme SaaS",
  tagline: "The fastest way to ship your next product.",
  plans: {
    free: {
      name: "Free",
      price: "$0",
      features: ["1 project", "Community support", "Basic analytics"],
    },
    pro: {
      name: "Pro",
      price: "$19/mo",
      features: ["Unlimited projects", "Priority support", "Advanced analytics", "Team access"],
    },
  },
};
