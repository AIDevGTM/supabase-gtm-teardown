import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasActiveSubscription } from "@/lib/plans";
import { appUrl, stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// POST from the dashboard "Upgrade" form -> redirects to Stripe Checkout.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(appUrl("/login"), 303);

  if (hasActiveSubscription(user.subscriptionStatus)) {
    return NextResponse.redirect(appUrl("/dashboard"), 303);
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return new NextResponse("STRIPE_PRICE_ID is not set", { status: 500 });

  // Ensure the user has a Stripe customer so subscriptions map back to them.
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe().customers.create({
      email: user.email,
      name: user.name ?? undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await db.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
  }

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    subscription_data: { metadata: { userId: user.id } },
    success_url: appUrl("/dashboard?checkout=success"),
    cancel_url: appUrl("/dashboard?checkout=canceled"),
  });

  return NextResponse.redirect(session.url!, 303);
}
