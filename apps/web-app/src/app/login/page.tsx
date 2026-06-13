"use client";
import { useEffect, useMemo, useState } from "react";
import { appConfig } from "../../lib/config";
import { createBrowserSupabaseClient } from "../../lib/supabase";
import { authDebug, clearStaleAuthErrors } from "../../lib/auth";
import { clearLoginCooldown, readPersistedLoginCooldown, writeLoginCooldown, type LoginCooldownReason } from "../../lib/loginCooldown";

const NORMAL_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

function formatCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function supabaseProjectRef() {
  try {
    return new URL(appConfig.supabaseUrl).hostname.split(".")[0];
  } catch {
    return "";
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("Enter your private-beta email to receive a magic code.");
  const [pending, setPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownReason, setCooldownReason] = useState<LoginCooldownReason | null>(null);
  const [now, setNow] = useState(0);

  const remainingMs = Math.max(0, cooldownUntil - now);
  const isCoolingDown = remainingMs > 0;
  const buttonDisabled = pending || isCoolingDown;
  const buttonText = useMemo(() => {
    if (pending) return "Sending...";
    if (isCoolingDown && cooldownReason === "sent_success") return `Email sent. Try again in ${Math.ceil(remainingMs / 1000)}s.`;
    if (isCoolingDown && cooldownReason === "rate_limit_429") return `Too many requests. Try again in ${formatCountdown(remainingMs)}.`;
    return "Send new sign-in link";
  }, [cooldownReason, isCoolingDown, pending, remainingMs]);

  useEffect(() => {
    const currentTime = Date.now();
    const persistedCooldown = readPersistedLoginCooldown();
    setNow(currentTime);
    setCooldownUntil(persistedCooldown?.until ?? 0);
    setCooldownReason(persistedCooldown?.reason ?? null);
    const supabase = createBrowserSupabaseClient();
    void supabase?.auth.getSession().then(({ data }) => {
      if (data.session) window.location.replace("/dashboard");
    });
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (cooldownUntil && cooldownUntil <= currentTime) {
        clearLoginCooldown();
        setCooldownUntil(0);
        setCooldownReason(null);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [cooldownUntil]);

  function startCooldown(durationMs: number, reason: LoginCooldownReason) {
    const requestedAt = Date.now();
    const nextCooldownUntil = requestedAt + durationMs;
    writeLoginCooldown({ until: nextCooldownUntil, reason });
    setNow(requestedAt);
    setCooldownUntil(nextCooldownUntil);
    setCooldownReason(reason);
  }

  function isRateLimitError(error: { message?: string; status?: number }) {
    const messageText = error.message?.toLowerCase() ?? "";
    return error.status === 429 || messageText.includes("rate limit") || messageText.includes("too many requests");
  }

  async function sendOtp() {
    if (buttonDisabled) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) { setMessage("Supabase publishable configuration is required before login can send codes."); return; }
    setPending(true);
    clearStaleAuthErrors();
    authDebug("signInWithOtp redirect", { redirectTo: `${window.location.origin}/auth/callback`, currentRoute: window.location.pathname });
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
    setPending(false);
    if (error) {
      if (isRateLimitError(error)) {
        startCooldown(RATE_LIMIT_COOLDOWN_MS, "rate_limit_429");
        setMessage("Too many login emails requested. Please wait before requesting another code.");
        return;
      }
      clearLoginCooldown();
      setCooldownUntil(0);
      setCooldownReason(null);
      setMessage(error.message);
      return;
    }
    startCooldown(NORMAL_COOLDOWN_MS, "sent_success");
    setMessage("Check your email for the sign-in link.");
  }

  function clearLoginState() {
    const projectRef = supabaseProjectRef();
    const allowedKeys = new Set([
      ...(projectRef ? [`sb-${projectRef}-auth-token`, `sb-${projectRef}-auth-token-code-verifier`] : []),
    ]);

    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("videoblitzer:") || allowedKeys.has(key)) {
        window.localStorage.removeItem(key);
      }
    }

    window.location.reload();
  }

  return <section className="hero"><span className="pill">Private beta</span><h1>Sign in to VideoBlitzer</h1><p className="muted">Only allowlisted emails can access the app. All access checks are confirmed server-side after Supabase email OTP login.</p><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" disabled={pending} /><br /><br /><button className="button" onClick={sendOtp} disabled={buttonDisabled}>{buttonText}</button>{isCoolingDown && <p className="muted">{cooldownReason === "rate_limit_429" ? `Supabase rate limited this email request. Try again in ${formatCountdown(remainingMs)}.` : `You can request another link in ${Math.ceil(remainingMs / 1000)}s.`}</p>}<p className="muted">{message}</p><button className="link-button" type="button" onClick={clearLoginState}>Clear login state</button></section>;
}
