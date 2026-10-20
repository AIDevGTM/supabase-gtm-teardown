import Link from "next/link";
import { PRO_PLAN } from "@/lib/plans";

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <h1>Ship your SaaS<br />this weekend.</h1>
        <p>
          Authentication, a dashboard and Stripe subscriptions are already wired up.
          Focus on the part that makes your product unique.
        </p>
        <Link href="/signup" className="btn btn-primary">Get started free →</Link>
      </section>

      <section className="card pricing">
        <div className="stat-label">{PRO_PLAN.name}</div>
        <div className="price">
          {PRO_PLAN.priceLabel}<span> / {PRO_PLAN.interval}</span>
        </div>
        <ul className="features">
          {PRO_PLAN.features.map((f) => <li key={f}>{f}</li>)}
        </ul>
        <Link href="/signup" className="btn btn-primary btn-block" style={{ textAlign: "center" }}>
          Start now
        </Link>
      </section>
    </main>
  );
}
