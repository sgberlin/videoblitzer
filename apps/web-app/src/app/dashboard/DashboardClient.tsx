"use client";
import { useEffect, useState } from "react";
import { OwnerModeBadge, CreditBadge } from "../../components/Badges";
import { authedApiFetch } from "../../lib/api";
import type { DashboardData } from "../../lib/types";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authedApiFetch<DashboardData>("/dashboard")
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <section className="hero"><h1>Loading dashboard</h1><p className="muted">Checking private beta access and loading your workspace.</p></section>;
  if (error) {
    const isAuthError = error.toLowerCase().includes("session") || error.toLowerCase().includes("unauthorized") || error.toLowerCase().includes("sign in");
    return <section className="hero"><h1>{isAuthError ? "Sign in required" : "Dashboard unavailable"}</h1><p className="warning">{error}</p><p className="muted">{isAuthError ? "Use the newest magic link from your email. If it has expired, request another code." : "The API is reachable, but the dashboard data could not be loaded."}</p><a className="button" href="/login">Back to login</a></section>;
  }
  if (!data) return null;

  return <>
    <section className="hero">
      {data.profile.isOwner && <OwnerModeBadge />}
      <h1>VideoBlitzer dashboard</h1>
      <p className="muted">Signed in as {data.profile.email}. Server-side access is enforced by the API before any project, job, or storage data is returned.</p>
      <div className="tabs"><a className="button" href="/projects">New Match Project</a><a className="button secondary" href="/upload">Upload Existing Video</a><a className="button secondary" href="/desktop-recorder">Download Desktop Recorder</a></div>
      <CreditBadge credits={data.creditBalance} />
    </section>
    <br />
    <section className="grid grid-3">
      <div className="card"><h3>Recent Projects</h3>{data.recentProjects.length ? data.recentProjects.map((project) => <p key={project.id}><a href={`/projects/${project.id}/overview`}>{project.title}</a><br /><span className="muted">{project.status}</span></p>) : <p className="muted">No projects yet.</p>}</div>
      <div className="card"><h3>Pending Jobs</h3>{data.pendingJobs.length ? data.pendingJobs.map((job) => <p key={job.id}>{job.type} · <span className="status">{job.status}</span> · {job.progress ?? 0}%</p>) : <p className="muted">0 queued or processing jobs.</p>}</div>
      <div className="card"><h3>Failed Jobs</h3>{data.failedJobs.length ? data.failedJobs.map((job) => <p key={job.id}>{job.type}<br /><span className="warning">{job.error ?? "Failed"}</span></p>) : <p className="muted">0 failed jobs.</p>}</div>
      <div className="card"><h3>R2 Storage Usage</h3><p className="muted">Bucket: {data.storage.bucket}</p><p>{formatBytes(data.storage.totalBytes)} across {data.storage.totalObjects} objects</p><p className="muted">Raw files: {data.storage.rawFiles} · Exports: {data.storage.exports} · Thumbnails: {data.storage.thumbnails} · Captions: {data.storage.captions}</p>{!data.storage.configured && <p className="warning">R2 credentials are not configured on the API server.</p>}</div>
      <div className="card"><h3>Usage Events</h3>{data.usageEvents.length ? data.usageEvents.map((event) => <p key={event.id}>{event.event_name}<br /><span className="muted">{event.created_at ? new Date(event.created_at).toLocaleString() : "recently"}</span></p>) : <p className="muted">No usage events recorded yet.</p>}</div>
      <div className="card"><h3>Owner Unlimited Mode</h3><p>{data.profile.isUnlimited ? "Unlimited access active. Credit deductions are bypassed server-side." : "Standard credit validation active."}</p></div>
    </section>
  </>;
}
