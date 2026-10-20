import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { appUrl, getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const base = appUrl(req.nextUrl.origin);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(`${base}/login?next=/dashboard`, 303);
  if (!user.stripeCustomerId) return NextResponse.redirect(`${base}/dashboard`, 303);

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${base}/dashboard`,
    });
    return NextResponse.redirect(session.url, 303);
  } catch (err) {
    console.error("Stripe portal error", err);
    return NextResponse.redirect(`${base}/dashboard?billing_error=1`, 303);
  }
}
