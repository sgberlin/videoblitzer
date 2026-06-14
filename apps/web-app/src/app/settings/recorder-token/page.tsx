"use client";

import { useMemo, useState } from "react";
import { AuthStatusMessage } from "../../../components/AuthStatus";
import { useAuthSession } from "../../../lib/auth";

function shortToken(token: string) {
  if (token.length <= 24) return token;
  return `${token.slice(0, 12)}...${token.slice(-12)}`;
}

export default function RecorderTokenPage() {
  const auth = useAuthSession();
  const [copied, setCopied] = useState(false);
  const token = auth.session?.access_token ?? "";
  const expiresAt = useMemo(() => auth.session?.expires_at ? new Date(auth.session.expires_at * 1000).toLocaleString() : "current session", [auth.session?.expires_at]);

  async function copyToken() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  }

  if (auth.status === "loading") return <AuthStatusMessage status="loading" />;
  if (auth.status !== "authenticated") return <AuthStatusMessage status={auth.status} error={auth.error} />;

  return <section className="grid">
    <div className="hero"><span className="pill">Private beta recorder</span><h1>Recorder Token</h1><p className="muted">Copy this temporary Supabase access token into VideoBlitzer Screen Recorder Setup. Treat it like a password and only use it on your own device.</p></div>
    <div className="card"><h3>Current access token</h3><p className="muted">Expires: {expiresAt}</p><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{shortToken(token)}</pre><button className="button" onClick={() => void copyToken()}>{copied ? "Copied" : "Copy recorder token"}</button></div>
    <div className="card"><h3>How to use it</h3><p>Open VideoBlitzer Screen Recorder, click Setup, paste the token, click Save Settings, then Test Connection. The recorder should show Auth: connected.</p></div>
  </section>;
}
