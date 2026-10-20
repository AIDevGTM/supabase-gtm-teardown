import Link from "next/link";
import { Nav } from "@/components/Nav";
import { getCurrentUser } from "@/lib/auth";
import { siteConfig } from "@/lib/config";

export default async function HomePage() {
  const user = await getCurrentUser();
  const { free, pro } = siteConfig.plans;

  return (
    <>
      <Nav signedIn={!!user} />
      <main className="container">
        <section className="hero">
          <h1>{siteConfig.tagline}</h1>
          <p>Sign up in seconds. Upgrade when you&apos;re ready.</p>
          <Link href={user ? "/dashboard" : "/signup"} className="btn btn-primary">
            {user ? "Go to dashboard" : "Get started for free"}
          </Link>
        </section>

        <section id="pricing" className="grid">
          <div className="card">
            <h3>{free.name}</h3>
            <div className="price">{free.price}</div>
            <ul className="features">
              {free.features.map((f) => <li key={f}>{f}</li>)}
            </ul>
            <Link href={user ? "/dashboard" : "/signup"} className="btn btn-block">
              Start free
            </Link>
          </div>
          <div className="card card-highlight">
            <h3>{pro.name}</h3>
            <div className="price">{pro.price}</div>
            <ul className="features">
              {pro.features.map((f) => <li key={f}>{f}</li>)}
            </ul>
            <Link href={user ? "/dashboard" : "/signup"} className="btn btn-primary btn-block">
              Go Pro
            </Link>
          </div>
        </section>
      </main>
      <footer className="footer">© {new Date().getFullYear()} {siteConfig.name}</footer>
    </>
  );
}
