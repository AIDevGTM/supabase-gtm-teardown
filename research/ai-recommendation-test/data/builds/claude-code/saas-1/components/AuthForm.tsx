"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { login, signup, type AuthState } from "@/app/actions/auth";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
      {pending ? "Please wait…" : label}
    </button>
  );
}

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const isSignup = mode === "signup";
  const [state, formAction] = useFormState<AuthState, FormData>(isSignup ? signup : login, undefined);

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
        <p className="sub">{isSignup ? "Start building in seconds." : "Log in to your dashboard."}</p>

        {state?.error && <div className="error" role="alert">{state.error}</div>}

        <form action={formAction}>
          {next && <input type="hidden" name="next" value={next} />}
          {isSignup && (
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" autoComplete="name" placeholder="Ada Lovelace" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={isSignup ? 8 : undefined}
              autoComplete={isSignup ? "new-password" : "current-password"}
              placeholder={isSignup ? "At least 8 characters" : ""}
            />
          </div>
          <SubmitButton label={isSignup ? "Create account" : "Log in"} />
        </form>

        <p className="alt">
          {isSignup ? (
            <>Already have an account? <Link href="/login">Log in</Link></>
          ) : (
            <>New here? <Link href="/signup">Create an account</Link></>
          )}
        </p>
      </div>
    </div>
  );
}
