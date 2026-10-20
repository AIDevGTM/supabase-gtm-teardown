import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasActiveSubscription } from "@/lib/auth";
import { appUrl, getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const base = appUrl(req.nextUrl.origin);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(`${base}/login?next=/dashboard`, 303);

  // Already subscribed: don't create a second subscription (dashboard shows "Manage billing").
  if (hasActiveSubscription(user)) {
    return NextResponse.redirect(`${base}/dashboard`, 303);
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    console.error("STRIPE_PRICE_ID is not set");
    return NextResponse.redirect(`${base}/dashboard?billing_error=1`, 303);
  }

  try {
    const stripe = getStripe();

    // One Stripe customer per user, created on first checkout.
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name ?? undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${base}/dashboard?checkout=success`,
      cancel_url: `${base}/dashboard`,
    });

    return NextResponse.redirect(session.url!, 303);
  } catch (err) {
    console.error("Stripe checkout error", err);
    return NextResponse.redirect(`${base}/dashboard?billing_error=1`, 303);
  }
}
