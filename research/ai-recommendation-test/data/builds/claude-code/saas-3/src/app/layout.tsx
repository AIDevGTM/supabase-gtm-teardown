import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { logout } from "@/app/actions/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Acme SaaS",
  description: "A SaaS starter with auth, a dashboard and Stripe subscriptions.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="en">
      <body>
        <header className="nav">
          <Link href="/" className="brand">
            Acme
          </Link>
          <nav>
            {user ? (
              <>
                <Link href="/dashboard">Dashboard</Link>
                <form action={logout}>
                  <button type="submit" className="link-button">
                    Log out
                  </button>
                </form>
              </>
            ) : (
              <>
                <Link href="/login">Log in</Link>
                <Link href="/signup" className="button small">
                  Sign up
                </Link>
              </>
            )}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
