import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe, syncSubscription } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) {
    return NextResponse.json({ error: "Missing signature or secret" }, { status: 400 });
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    // Signature verification needs the raw, unparsed body.
    event = stripe.webhooks.constructEvent(await req.text(), signature, secret);
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription" || !session.subscription) break;

        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;

        // Make sure the customer is linked (normally already done at checkout creation).
        if (session.client_reference_id && customerId) {
          await prisma.user.updateMany({
            where: { id: session.client_reference_id, stripeCustomerId: null },
            data: { stripeCustomerId: customerId },
          });
        }

        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
        await syncSubscription(await stripe.subscriptions.retrieve(subscriptionId));
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // Always fetch the latest state; events can arrive out of order.
        const sub = await stripe.subscriptions.retrieve(event.data.object.id);
        await syncSubscription(sub);
        break;
      }

      default:
        // Ignore other events.
        break;
    }
  } catch (err) {
    console.error(`Error handling webhook ${event.type}`, err);
    // 500 makes Stripe retry later.
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
