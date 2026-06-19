"use client";
import { useEffect, useState } from "react";
import { OwnerModeBadge, CreditBadge } from "../../components/Badges";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { appConfig } from "../../lib/config";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../lib/auth";
import { createBrowserSupabaseClient } from "../../lib/supabase";
import type { DashboardData } from "../../lib/types";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function compactError(message?: string) {
  if (!message) return "Failed";
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

type DashboardDiagnostics = {
  hasSession: boolean;
  hasAccessToken: boolean;
  userEmail: string;
  apiUrl: string;
  dashboardStatus: number | null;
  dashboardErrorCode: string;
  dashboardErrorMessage: string;
  sentAuthorizationHeader: boolean;
};

async function readDashboardError(response: Response) {
  try {
    const parsed = await response.json() as { error?: string; reason?: string; code?: string };
    return {
      code: parsed.reason ?? parsed.code ?? `http_${response.status}`,
      message: parsed.error ?? `Dashboard request failed with status ${response.status}.`,
    };
  } catch {
    return {
      code: `http_${response.status}`,
      message: `Dashboard request failed with status ${response.status}.`,
    };
  }
}

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<DashboardDiagnostics>({
    hasSession: false,
    hasAccessToken: false,
    userEmail: "",
    apiUrl: appConfig.apiUrl,
    dashboardStatus: null,
    dashboardErrorCode: "",
    dashboardErrorMessage: "",
    sentAuthorizationHeader: false,
  });
  const [authStatus, setAuthStatus] = useState<AuthState>("loading");
  const [loading, setLoading] = useState(true);
  const auth = useAuthSession();

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setAuthStatus(auth.status);
      setLoading(false);
      return;
    }

    setLoading(true);
    setAuthStatus("authenticated");
    async function loadDashboard() {
      const supabase = createBrowserSupabaseClient();
      if (!supabase) throw new Error("Supabase publishable configuration is required before dashboard can load.");

      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const session = sessionData.session;
      const token = session?.access_token;
      const userEmail = session?.user.email?.trim().toLowerCase() ?? "";
      const nextDiagnostics: DashboardDiagnostics = {
        hasSession: Boolean(session),
        hasAccessToken: Boolean(token),
        userEmail,
        apiUrl: appConfig.apiUrl,
        dashboardStatus: null,
        dashboardErrorCode: "",
        dashboardErrorMessage: "",
        sentAuthorizationHeader: Boolean(token),
      };
      setDiagnostics(nextDiagnostics);

      if (!token) {
        throw new Error("No Supabase access token found. Please sign in again.");
      }

      authDebug("dashboard request", {
        hasSession: nextDiagnostics.hasSession,
        hasAccessToken: nextDiagnostics.hasAccessToken,
        userEmail,
        apiUrl: appConfig.apiUrl,
        sentAuthorizationHeader: true,
      });

      const response = await fetch(`${appConfig.apiUrl}/dashboard`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const dashboardError = await readDashboardError(response);
        setDiagnostics({ ...nextDiagnostics, dashboardStatus: response.status, dashboardErrorCode: dashboardError.code, dashboardErrorMessage: dashboardError.message });
        throw new Error(dashboardError.message);
      }

      setDiagnostics({ ...nextDiagnostics, dashboardStatus: response.status });
      return response.json() as Promise<DashboardData>;
    }

    loadDashboard()
      .then((response) => {
        authDebug("allowlist result", { allowed: true, userEmail: response.profile.email, currentRoute: "/dashboard" });
        setData(response);
        setError("");
      })
      .catch((err: Error) => {
        authDebug("allowlist result", { allowed: false, userEmail: auth.email, error: err.message, currentRoute: "/dashboard" });
        if (isPrivateBetaError(err.message)) setAuthStatus("unauthorized_email");
        else if (isInvalidLinkError(err.message)) setAuthStatus("invalid_link");
        else setError(err.message.toLowerCase() === "unauthorized" ? "Your sign-in was created, but the API could not verify it yet. Please refresh once or request a fresh magic link." : err.message);
      })
      .finally(() => setLoading(false));
  }, [auth.email, auth.session?.access_token, auth.status]);

  if (auth.status === "loading" || loading) return <AuthStatusMessage status="loading" />;
  if (authStatus !== "authenticated") return <AuthStatusMessage status={authStatus} error={auth.error} />;
  if (error) {
    return <section className="hero"><h1>Dashboard unavailable</h1><p className="warning">{error}</p><p className="muted">The API is reachable, but the dashboard data could not be loaded. Refresh once or sign in again if this persists.</p>{process.env.NODE_ENV !== "production" && <div className="card"><h3>Auth diagnostics</h3><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(diagnostics, null, 2)}</pre></div>}<a className="button" href="/login">Back to login</a></section>;
  }
  if (!data) return null;

  return <>
    <section className="hero">
      {data.profile.isOwner && <OwnerModeBadge />}
      <h1>VideoBlitzer dashboard</h1>
      <p className="muted">Signed in as {data.profile.email}. Upload match video, choose the package recipe, then produce downloadable social-ready videos.</p>
      <p className="muted">Core workflow: upload once, reuse verified media, create new packages with updated settings whenever needed.</p>
      <div className="tabs"><a className="button" href="/upload">Upload Video and Create Package</a><a className="button secondary" href="/projects">View Projects</a></div>
      <CreditBadge credits={data.creditBalance} />
    </section>
    <br />
    <section className="grid grid-3">
      <div className="card"><h3>Recent Projects</h3>{data.recentProjects.length ? data.recentProjects.map((project) => <p key={project.id}><a href={`/projects/${project.id}/overview`}>{project.title}</a><br /><span className="muted">{project.status}</span></p>) : <p className="muted">No projects yet.</p>}</div>
      <div className="card"><h3>Pending Jobs</h3>{data.pendingJobs.length ? data.pendingJobs.map((job) => <p key={job.id}>{job.type} · <span className="status">{job.status}</span> · {job.progress ?? 0}%</p>) : <p className="muted">0 queued or processing jobs.</p>}</div>
      <div className="card"><h3>Failed Jobs</h3>{data.failedJobs.length ? data.failedJobs.map((job) => <p key={job.id}>{job.type}<br /><span className="warning">{compactError(job.error)}</span></p>) : <p className="muted">0 failed jobs.</p>}</div>
      <div className="card"><h3>R2 Storage Usage</h3><p className="muted">Bucket: {data.storage.bucket}</p><p>{formatBytes(data.storage.totalBytes)} across {data.storage.totalObjects} objects</p><p className="muted">Raw files: {data.storage.rawFiles} · Exports: {data.storage.exports} · Thumbnails: {data.storage.thumbnails} · Captions: {data.storage.captions}</p>{!data.storage.configured && <p className="warning">R2 credentials are not configured on the API server.</p>}</div>
      <div className="card"><h3>Usage Events</h3>{data.usageEvents.length ? data.usageEvents.map((event) => <p key={event.id}>{event.event_name}<br /><span className="muted">{event.created_at ? new Date(event.created_at).toLocaleString() : "recently"}</span></p>) : <p className="muted">No usage events recorded yet.</p>}</div>
      <div className="card"><h3>Owner Unlimited Mode</h3><p>{data.profile.isUnlimited ? "Unlimited access active. Credit deductions are bypassed server-side." : "Standard credit validation active."}</p></div>
    </section>
  </>;
}
