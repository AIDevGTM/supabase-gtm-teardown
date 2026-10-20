import Link from "next/link";
import { login } from "@/app/actions/auth";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";

export const metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <>
      <Nav signedIn={false} />
      <main className="container">
        <div className="card auth">
          <h2>Welcome back</h2>
          <AuthForm action={login} submitLabel="Log in" />
          <p className="small muted">
            No account yet? <Link href="/signup">Sign up</Link>
          </p>
        </div>
      </main>
    </>
  );
}
