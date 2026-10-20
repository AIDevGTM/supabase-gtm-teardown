import { requireUser } from "@/lib/auth";
import { PRO_PLAN, hasActiveSubscription } from "@/lib/plans";

export const metadata = { title: "Dashboard · Acme SaaS" };
export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="badge badge-muted">Free</span>;
  const cls =
    status === "active" || status === "trialing"
      ? "badge-success"
      : status === "past_due" || status === "incomplete" || status === "unpaid"
        ? "badge-warning"
        : "badge-muted";
  return <span className={`badge ${cls}`}>{status.replace("_", " ")}</span>;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  const user = await requireUser();
  const isPro = hasActiveSubscription(user.subscriptionStatus);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  return (
    <main className="dash">
      <h1>Hi{user.name ? `, ${user.name}` : ""} 👋</h1>
      <p className="sub">{user.email}</p>

      {searchParams.checkout === "success" && (
        <div className="banner banner-success">
          🎉 Thanks for subscribing! {isPro ? "Your Pro plan is active." : "We're confirming your payment — refresh in a few seconds."}
        </div>
      )}
      {searchParams.checkout === "canceled" && (
        <div className="banner banner-muted">Checkout canceled — you haven&apos;t been charged.</div>
      )}

      {/* Billing */}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="row">
          <div>
            <div className="stat-label">Current plan</div>
            <div className="stat-value" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {isPro ? PRO_PLAN.name : "Free"} <StatusBadge status={user.subscriptionStatus} />
            </div>
            {user.currentPeriodEnd && isPro && (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                {user.cancelAtPeriodEnd ? "Ends" : "Renews"} on {fmt(user.currentPeriodEnd)}
              </p>
            )}
            {!isPro && (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                Upgrade to {PRO_PLAN.name} for {PRO_PLAN.priceLabel}/{PRO_PLAN.interval}.
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {!isPro && (
              <form action="/api/stripe/checkout" method="POST">
                <button className="btn btn-primary" type="submit">Upgrade to {PRO_PLAN.name}</button>
              </form>
            )}
            {user.stripeCustomerId && (
              <form action="/api/stripe/portal" method="POST">
                <button className="btn" type="submit">Manage billing</button>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* Example app content — replace with your product */}
      <div className="grid">
        <div className="card">
          <div className="stat-label">Projects</div>
          <div className="stat-value">3</div>
        </div>
        <div className="card">
          <div className="stat-label">API calls (30d)</div>
          <div className="stat-value">12,480</div>
        </div>
        <div className="card">
          <div className="stat-label">Member since</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{fmt(user.createdAt)}</div>
        </div>
      </div>

      <section className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <strong>Advanced analytics</strong>
          {!isPro && <span className="badge badge-muted">Pro only</span>}
        </div>
        <div className={isPro ? "" : "locked"}>
          <p className="muted" style={{ margin: 0 }}>
            Conversion rate: 4.2% · Avg. session: 6m 31s · Retention (D30): 38%
          </p>
        </div>
        {!isPro && (
          <p className="muted" style={{ marginBottom: 0 }}>Upgrade to unlock this section.</p>
        )}
      </section>
    </main>
  );
}
