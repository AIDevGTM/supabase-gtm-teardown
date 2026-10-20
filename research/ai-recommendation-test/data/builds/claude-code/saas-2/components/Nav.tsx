import Link from "next/link";
import { siteConfig } from "@/lib/config";

export function Nav({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="container nav">
      <Link href="/" className="nav-brand">
        {siteConfig.name}
      </Link>
      <nav className="nav-links">
        {signedIn ? (
          <>
            <Link href="/dashboard" className="btn">
              Dashboard
            </Link>
            <form action="/api/auth/signout" method="post">
              <button type="submit" className="btn">
                Sign out
              </button>
            </form>
          </>
        ) : (
          <>
            <Link href="/login" className="btn">
              Log in
            </Link>
            <Link href="/signup" className="btn btn-primary">
              Sign up
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
