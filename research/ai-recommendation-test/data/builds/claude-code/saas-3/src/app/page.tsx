import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";

export default async function HomePage() {
  const user = await getCurrentUser();
  const cta = user ? "/dashboard" : "/signup";

  return (
    <>
      <section className="hero">
        <h1>Ship your SaaS this weekend</h1>
        <p>
          Authentication, a dashboard, and Stripe subscriptions, all wired up. Start
          building the part that matters.
        </p>
        <Link href={cta} className="button">
          {user ? "Go to dashboard" : "Get started for free"}
        </Link>
      </section>

      <section className="pricing" id="pricing">
        <div className="card">
          <h2>Free</h2>
          <div className="price">
            $0 <span>/ month</span>
          </div>
          <ul className="features">
            <li>Account &amp; dashboard</li>
            <li>Core features</li>
            <li>Community support</li>
          </ul>
          <Link href={cta} className="button secondary">
            Start free
          </Link>
        </div>
        <div className="card">
          <h2>
            Pro <span className="badge">Popular</span>
          </h2>
          {/* Keep this label in sync with the Stripe price in STRIPE_PRICE_ID */}
          <div className="price">
            $19 <span>/ month</span>
          </div>
          <ul className="features">
            <li>Everything in Free</li>
            <li>Pro-only features</li>
            <li>Priority support</li>
          </ul>
          <Link href={cta} className="button">
            Upgrade to Pro
          </Link>
        </div>
      </section>
    </>
  );
}
