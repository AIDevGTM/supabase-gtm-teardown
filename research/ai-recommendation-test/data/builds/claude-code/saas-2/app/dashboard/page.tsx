import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { getCurrentUser, hasActiveSubscription } from "@/lib/auth";
import { siteConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

function formatDate(d: Date) {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  const user = await getCurrentUser();
  // Middleware already checked the cookie; a null user here means the account no longer exists.
  if (!user) redirect("/api/auth/signout");

  const isPro = hasActiveSubscription(user);
  const plan = isPro ? siteConfig.plans.pro : siteConfig.plans.free;

  return (
    <>
      <Nav signedIn />
      <main className="container">
        <h1>Dashboard</h1>
        <p className="muted">Signed in as {user.email}</p>

        {searchParams.checkout === "success" && !isPro && (
          <div className="alert alert-info">
            Payment received. Your subscription is activating; refresh in a few seconds.
          </div>
        )}
        {searchParams.checkout === "success" && isPro && (
          <div className="alert alert-success">You&apos;re on Pro. Thanks for subscribing!</div>
        )}
        {searchParams.checkout === "canceled" && (
          <div className="alert alert-error">Checkout canceled. You haven&apos;t been charged.</div>
        )}
        {user.subscriptionStatus === "past_due" && (
          <div className="alert alert-error">
            Your last payment failed. Update your payment method to keep Pro.
          </div>
        )}

        <div className="grid">
          <div className="card">
            <div className="muted small">Current plan</div>
            <p className="stat">
              {plan.name}{" "}
              <span className={`badge ${isPro ? "badge-pro" : ""}`}>
                {user.subscriptionStatus ?? "free"}
              </span>
            </p>
            {isPro && user.currentPeriodEnd && (
              <p className="small muted">
                {user.cancelAtPeriodEnd ? "Ends on " : "Renews on "}
                {formatDate(user.currentPeriodEnd)}
              </p>
            )}
          </div>

          <div className="card">
            <div className="muted small">Member since</div>
            <p className="stat">{formatDate(user.createdAt)}</p>
          </div>
        </div>

        <div className="grid" style={{ marginTop: 24 }}>
          {isPro ? (
            <div className="card">
              <h3>Billing</h3>
              <p className="muted">Update your card, download invoices, or cancel anytime.</p>
              <form action="/api/stripe/portal" method="post">
                <button type="submit" className="btn">Manage billing</button>
              </form>
            </div>
          ) : (
            <div className="card card-highlight">
              <h3>Upgrade to {siteConfig.plans.pro.name}: {siteConfig.plans.pro.price}</h3>
              <ul className="features">
                {siteConfig.plans.pro.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <form action="/api/stripe/checkout" method="post">
                <button type="submit" className="btn btn-primary">Upgrade now</button>
              </form>
              {user.stripeCustomerId && (
                <form action="/api/stripe/portal" method="post" style={{ marginTop: 12 }}>
                  <button type="submit" className="btn">View billing history</button>
                </form>
              )}
            </div>
          )}

          <div className="card">
            <h3>Pro feature</h3>
            {isPro ? (
              <p>🎉 This content is only visible to subscribers. Build your paid features here.</p>
            ) : (
              <p className="muted">🔒 Upgrade to unlock this section.</p>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
