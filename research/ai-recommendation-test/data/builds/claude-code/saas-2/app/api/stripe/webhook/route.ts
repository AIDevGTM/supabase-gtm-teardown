import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe, syncSubscription } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new NextResponse("STRIPE_WEBHOOK_SECRET is not set", { status: 500 });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new NextResponse("Missing stripe-signature header", { status: 400 });

  const stripe = getStripe();
  const body = await req.text(); // raw body is required for signature verification

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid payload";
    return new NextResponse(`Webhook signature verification failed: ${message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription" || !session.subscription) break;

        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;
        // Make sure the customer is linked to the user (normally already done at checkout).
        if (customerId && session.client_reference_id) {
          await prisma.user.updateMany({
            where: { id: session.client_reference_id, stripeCustomerId: null },
            data: { stripeCustomerId: customerId },
          });
        }

        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        await syncSubscription(await stripe.subscriptions.retrieve(subscriptionId));
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        // Re-fetch so out-of-order events can't overwrite newer state.
        const sub = await stripe.subscriptions.retrieve(event.data.object.id);
        await syncSubscription(sub);
        break;
      }
      default:
        // Ignore other events.
        break;
    }
  } catch (err) {
    console.error(`Error handling Stripe event ${event.type}`, err);
    return new NextResponse("Webhook handler failed", { status: 500 }); // Stripe will retry
  }

  return NextResponse.json({ received: true });
}
