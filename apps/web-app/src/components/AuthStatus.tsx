"use client";

import type { AuthState } from "../lib/auth";

export function AuthStatusMessage({ status, error }: { status: AuthState; error?: string }) {
  if (status === "loading") {
    return <section className="hero"><h1>Checking your sign-in...</h1><p className="muted">We are confirming your Supabase session before loading this private beta page.</p></section>;
  }

  if (status === "invalid_link") {
    return <section className="hero"><h1>Magic link expired</h1><p className="warning">{error || "This sign-in link expired or could not be verified. Request a new link."}</p><a className="button" href="/login">Request a new link</a></section>;
  }

  if (status === "unauthorized_email") {
    return <section className="hero"><h1>Private beta access required</h1><p className="warning">This email is not currently on the VideoBlitzer private beta allowlist.</p><p className="muted">Sign in with an allowlisted email, or ask the owner to add your email in Supabase.</p><a className="button" href="/login">Back to login</a></section>;
  }

  return <section className="hero"><h1>Sign in required</h1><p className="muted">Use the newest magic link from your email. If it has expired, request another code.</p><a className="button" href="/login">Back to login</a></section>;
}
