import { redirect } from "next/navigation";
import { getCurrentUser, hasActiveSubscription } from "@/lib/auth";

export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string | null }) {
  if (status === "active" || status === "trialing") {
    return <span className="badge">Pro{status === "trialing" ? " (trial)" : ""}</span>;
  }
  if (status === "past_due" || status === "unpaid" || status === "incomplete") {
    return <span className="badge warn">Payment issue</span>;
  }
  return <span className="badge free">Free</span>;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { checkout?: string; billing_error?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/dashboard");

  const isPro = hasActiveSubscription(user);
  const periodEnd = user.currentPeriodEnd?.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <>
      {searchParams.checkout === "success" && !isPro && (
        <div className="notice">
          Payment received. Your Pro plan is being activated. Refresh in a few seconds.
        </div>
      )}
      {searchParams.checkout === "success" && isPro && (
        <div className="notice">You&apos;re on Pro. Thanks for subscribing!</div>
      )}
      {searchParams.billing_error && (
        <div className="error">
          Billing is temporarily unavailable. Please try again shortly.
        </div>
      )}

      <h1>Hi {user.name || user.email.split("@")[0]} 👋</h1>
      <p className="muted">Here&apos;s an overview of your account.</p>

      <div className="grid">
        <section className="card">
          <h2>
            Plan <StatusBadge status={user.subscriptionStatus} />
          </h2>

          {isPro ? (
            <>
              <p className="muted">
                {user.cancelAtPeriodEnd
                  ? `Your subscription ends on ${periodEnd}.`
                  : `Renews on ${periodEnd}.`}
              </p>
              <form action="/api/stripe/portal" method="POST">
                <button type="submit" className="button secondary">
                  Manage billing
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="muted">
                Upgrade to Pro for $19/month to unlock all features. Cancel anytime.
              </p>
              <form action="/api/stripe/checkout" method="POST">
                <button type="submit" className="button">
                  Upgrade to Pro
                </button>
              </form>
              {user.stripeCustomerId && (
                <form action="/api/stripe/portal" method="POST" style={{ marginTop: 12 }}>
                  <button type="submit" className="link-button">
                    View billing history
                  </button>
                </form>
              )}
            </>
          )}
        </section>

        <section className="card">
          <h2>Account</h2>
          <p>
            <strong>Email:</strong> {user.email}
          </p>
          <p className="muted">
            Member since {user.createdAt.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
        </section>

        <section className="card">
          <h2>Core feature</h2>
          <p className="muted">Available on every plan. Replace this with your product.</p>
        </section>

        <section className={`card ${isPro ? "" : "locked"}`}>
          <h2>Pro feature {!isPro && "🔒"}</h2>
          <p className="muted">
            {isPro
              ? "You have access. Build your premium functionality here."
              : "Upgrade to Pro to unlock this."}
          </p>
        </section>
      </div>
    </>
  );
}
