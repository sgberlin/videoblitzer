"use client";
import { useEffect, useMemo, useState } from "react";
import { createBrowserSupabaseClient } from "../../lib/supabase";

const NORMAL_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const OTP_COOLDOWN_STORAGE_KEY = "videoblitzer:lastOtpRequestAt";
const OTP_COOLDOWN_UNTIL_STORAGE_KEY = "videoblitzer:otpCooldownUntil";

function formatCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function readStoredCooldown() {
  const explicitCooldownUntil = Number(window.localStorage.getItem(OTP_COOLDOWN_UNTIL_STORAGE_KEY) ?? "0");
  const lastRequestAt = Number(window.localStorage.getItem(OTP_COOLDOWN_STORAGE_KEY) ?? "0");
  return Math.max(explicitCooldownUntil, lastRequestAt ? lastRequestAt + NORMAL_COOLDOWN_MS : 0);
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("Enter your private-beta email to receive a magic code.");
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(0);

  const remainingMs = Math.max(0, cooldownUntil - now);
  const isCoolingDown = remainingMs > 0;
  const buttonDisabled = pending || isCoolingDown;
  const buttonText = useMemo(() => {
    if (pending) return "Sending...";
    if (isCoolingDown) return `Wait ${formatCountdown(remainingMs)}`;
    return "Send magic code";
  }, [isCoolingDown, pending, remainingMs]);

  useEffect(() => {
    setNow(Date.now());
    setCooldownUntil(readStoredCooldown());
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      const storedCooldownUntil = readStoredCooldown();
      setCooldownUntil(storedCooldownUntil);
      if (storedCooldownUntil <= currentTime) {
        window.localStorage.removeItem(OTP_COOLDOWN_UNTIL_STORAGE_KEY);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  function startCooldown(durationMs: number) {
    const requestedAt = Date.now();
    const nextCooldownUntil = requestedAt + durationMs;
    window.localStorage.setItem(OTP_COOLDOWN_STORAGE_KEY, String(requestedAt));
    window.localStorage.setItem(OTP_COOLDOWN_UNTIL_STORAGE_KEY, String(nextCooldownUntil));
    setNow(requestedAt);
    setCooldownUntil(nextCooldownUntil);
  }

  function isRateLimitError(error: { message?: string; status?: number }) {
    const messageText = error.message?.toLowerCase() ?? "";
    return error.status === 429 || messageText.includes("rate limit") || messageText.includes("too many");
  }

  async function sendOtp() {
    if (buttonDisabled) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) { setMessage("Supabase publishable configuration is required before login can send codes."); return; }
    setPending(true);
    startCooldown(NORMAL_COOLDOWN_MS);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/dashboard` } });
    setPending(false);
    if (error) {
      if (isRateLimitError(error)) {
        startCooldown(RATE_LIMIT_COOLDOWN_MS);
        setMessage("Too many login emails requested. Please wait before requesting another code.");
        return;
      }
      setMessage(error.message);
      return;
    }
    setMessage("Magic code sent. Check your inbox and continue to the dashboard after verification.");
  }
  return <section className="hero"><span className="pill">Private beta</span><h1>Sign in to VideoBlitzer</h1><p className="muted">Only allowlisted emails can access the app. All access checks are confirmed server-side after Supabase email OTP login.</p><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" disabled={pending} /><br /><br /><button className="button" onClick={sendOtp} disabled={buttonDisabled}>{buttonText}</button>{isCoolingDown && <p className="muted">You can request another code in {formatCountdown(remainingMs)}.</p>}<p className="muted">{message}</p></section>;
}
