import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { appUrl, stripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// POST from the dashboard "Manage billing" form -> Stripe Billing Portal.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(appUrl("/login"), 303);
  if (!user.stripeCustomerId) return NextResponse.redirect(appUrl("/dashboard"), 303);

  const portal = await stripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: appUrl("/dashboard"),
  });

  return NextResponse.redirect(portal.url, 303);
}
