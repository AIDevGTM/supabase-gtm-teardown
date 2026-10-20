import { NextResponse } from "next/server";
import { getCurrentUser, hasActiveSubscription } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { appUrl, getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url), 303);

  const base = appUrl(req);
  if (hasActiveSubscription(user)) {
    return NextResponse.redirect(`${base}/dashboard`, 303);
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error("STRIPE_PRICE_ID is not set");

  const stripe = getStripe();

  // One Stripe customer per user, created on first checkout.
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${base}/dashboard?checkout=success`,
    cancel_url: `${base}/dashboard?checkout=canceled`,
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return NextResponse.redirect(session.url, 303);
}
