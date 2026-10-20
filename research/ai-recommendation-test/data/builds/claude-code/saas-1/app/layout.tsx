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
        <div className="container">
          <nav className="nav">
            <Link href="/" className="logo">◆ Acme</Link>
            <div className="nav-links">
              {user ? (
                <>
                  <Link href="/dashboard" className="btn">Dashboard</Link>
                  <form action={logout}>
                    <button type="submit" className="btn">Log out</button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/login" className="btn">Log in</Link>
                  <Link href="/signup" className="btn btn-primary">Sign up</Link>
                </>
              )}
            </div>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
