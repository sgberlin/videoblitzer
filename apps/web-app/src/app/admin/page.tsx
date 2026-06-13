"use client";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { apiFetch } from "../../lib/api";
import { isInvalidLinkError, isOwnerRequiredError, isPrivateBetaError, type AuthState, useAuthSession } from "../../lib/auth";
import { useEffect, useState } from "react";

const links: Array<[string, string]> = [
  ["Users", "/admin/users"],
  ["Credits", "/admin/credits"],
  ["Jobs", "/admin/jobs"],
  ["Imports", "/admin/imports"],
  ["Storage", "/admin/storage"],
  ["Logs", "/admin/logs"],
];

export default function AdminIndex(){
  const auth = useAuthSession();
  const [status, setStatus] = useState<AuthState | "owner_required">("loading");

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setStatus(auth.status);
      return;
    }
    apiFetch("/admin/worker-status", {}, auth.session?.access_token)
      .then(() => setStatus("authenticated"))
      .catch((error: Error) => {
        if (isOwnerRequiredError(error.message)) setStatus("owner_required");
        else if (isPrivateBetaError(error.message)) setStatus("unauthorized_email");
        else if (isInvalidLinkError(error.message)) setStatus("invalid_link");
        else setStatus("owner_required");
      });
  }, [auth.session?.access_token, auth.status]);

  if (auth.status === "loading" || status === "loading") return <AuthStatusMessage status="loading" />;
  if (status === "owner_required") return <section className="hero"><h1>Owner access required</h1><p className="warning">Admin tools are restricted to the server-configured owner.</p><a className="button" href="/dashboard">Back to dashboard</a></section>;
  if (status !== "authenticated") return <AuthStatusMessage status={status} error={auth.error} />;
  return <section className="grid"><div className="hero"><span className="pill">Owner only</span><h1>Admin Operations</h1><p className="muted">Manage access, credits, jobs, source imports, storage, and audit logs.</p></div><div className="grid grid-3">{links.map(([label, href]) => <a className="card" href={href} key={href}><h3>{label}</h3><p className="muted">Open {label.toLowerCase()} admin tools.</p></a>)}</div></section>;
}
