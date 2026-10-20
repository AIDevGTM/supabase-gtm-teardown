"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { login, signup } from "@/app/actions/auth";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button" disabled={pending}>
      {pending ? "Please wait…" : label}
    </button>
  );
}

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const [state, formAction] = useFormState(mode === "login" ? login : signup, undefined);
  const isSignup = mode === "signup";

  return (
    <div className="card auth">
      <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>

      {state?.error && (
        <div className="error" role="alert">
          {state.error}
        </div>
      )}

      <form action={formAction}>
        {next && <input type="hidden" name="next" value={next} />}

        {isSignup && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" autoComplete="name" />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            minLength={isSignup ? 8 : undefined}
            required
          />
        </div>

        <SubmitButton label={isSignup ? "Sign up" : "Log in"} />
      </form>

      <p className="muted">
        {isSignup ? (
          <>
            Already have an account? <Link href="/login">Log in</Link>
          </>
        ) : (
          <>
            New here? <Link href="/signup">Create an account</Link>
          </>
        )}
      </p>
    </div>
  );
}
