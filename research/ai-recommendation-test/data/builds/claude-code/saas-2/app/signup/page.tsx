import Link from "next/link";
import { signup } from "@/app/actions/auth";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";

export const metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <>
      <Nav signedIn={false} />
      <main className="container">
        <div className="card auth">
          <h2>Create your account</h2>
          <AuthForm action={signup} submitLabel="Sign up" isSignup />
          <p className="small muted">
            Already have an account? <Link href="/login">Log in</Link>
          </p>
        </div>
      </main>
    </>
  );
}
