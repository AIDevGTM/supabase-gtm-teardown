import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { appUrl, getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

// Opens the Stripe Billing Portal (update card, cancel, view invoices).
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url), 303);

  const base = appUrl(req);
  if (!user.stripeCustomerId) return NextResponse.redirect(`${base}/dashboard`, 303);

  const portal = await getStripe().billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${base}/dashboard`,
  });

  return NextResponse.redirect(portal.url, 303);
}
