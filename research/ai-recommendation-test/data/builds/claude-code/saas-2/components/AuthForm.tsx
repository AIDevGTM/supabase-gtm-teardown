"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { AuthState } from "@/app/actions/auth";

type Action = (prev: AuthState, formData: FormData) => Promise<AuthState>;

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
      {pending ? "Please wait…" : label}
    </button>
  );
}

export function AuthForm({ action, submitLabel, isSignup }: {
  action: Action;
  submitLabel: string;
  isSignup?: boolean;
}) {
  const [state, formAction] = useFormState(action, undefined);

  return (
    <form action={formAction}>
      {state?.error && <div className="alert alert-error">{state.error}</div>}
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
          minLength={8}
          required
        />
        {isSignup && <span className="small muted">At least 8 characters.</span>}
      </div>
      <SubmitButton label={submitLabel} />
    </form>
  );
}
