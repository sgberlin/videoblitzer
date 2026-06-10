"use client";
import { useState } from "react";
import { createBrowserSupabaseClient } from "../../lib/supabase";
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("Enter your private-beta email to receive a magic code.");
  async function sendOtp() {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) { setMessage("Supabase publishable configuration is required before login can send codes."); return; }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/dashboard` } });
    setMessage(error ? error.message : "Magic code sent. Check your inbox and continue to the dashboard after verification.");
  }
  return <section className="hero"><span className="pill">Private beta</span><h1>Sign in to VideoBlitzer</h1><p className="muted">Only allowlisted emails can access the app. All access checks are confirmed server-side after Supabase email OTP login.</p><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" /><br /><br /><button className="button" onClick={sendOtp}>Send magic code</button><p className="muted">{message}</p></section>;
}
