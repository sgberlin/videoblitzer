"use client";
import { useEffect, useState } from "react";
import { FormatSelector, OutputFormatCards, ReadinessChecklist, TimelineClipCard, CopyBlock } from "../../../components/Cards";
import { AuthStatusMessage } from "../../../components/AuthStatus";
import { StatsEditor } from "../../../components/StatsEditor";
import { ThumbnailPreview } from "../../../components/ThumbnailPreview";
import { apiFetch } from "../../../lib/api";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../../lib/auth";
import type { ProjectDetail } from "../../../lib/types";

type WorkspaceTab = "overview" | "timeline" | "match-data" | "highlights" | "captions" | "commentary" | "thumbnail" | "social-pack" | "exports" | "debug";
type ConversionJob = { id?: string; status?: string; source_object_key?: string; target_object_key?: string; error_message?: string; created_at?: string };

function JsonCard({ title, value }: { title: string; value: unknown }) {
  return <div className="card"><h3>{title}</h3><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(value, null, 2)}</pre></div>;
}

function EmptyState({ label }: { label: string }) { return <p className="muted">No {label} records yet. Generate or confirm content to populate this workspace tab.</p>; }

function ConversionJobs({ jobs, token }: { jobs: ConversionJob[]; token?: string }) {
  const [message, setMessage] = useState("");
  async function openDownload(jobId?: string) {
    if (!jobId) return;
    try {
      const response = await apiFetch<{ downloadUrl: string | null }>(`/exports/${jobId}/download`, {}, token);
      if (!response.downloadUrl) throw new Error("Signed download is not available yet.");
      window.open(response.downloadUrl, "_blank", "noopener,noreferrer");
      setMessage("Opened signed MP4 download link.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open converted MP4.");
    }
  }
  if (!jobs.length) return <div className="card"><EmptyState label="conversion job" /></div>;
  return <div className="grid grid-2">{jobs.map((job) => {
    const status = job.status ?? "queued";
    const complete = status === "completed";
    const failed = status === "failed";
    return <div className="card" key={job.id}><h3>{complete ? "MP4 conversion complete" : failed ? "MP4 conversion failed" : `MP4 conversion ${status}`}</h3><p className={complete ? "status" : failed ? "warning" : "muted"}>{complete ? "Ready to review or download." : failed ? job.error_message ?? "The worker reported a conversion failure." : "The worker is preparing the MP4 export."}</p>{job.source_object_key && <p><strong>R2 source key</strong><br /><span className="muted">{job.source_object_key}</span></p>}{job.target_object_key && <p><strong>MP4 output key</strong><br /><span className="muted">{job.target_object_key}</span></p>}{complete && <button className="button" onClick={() => void openDownload(job.id)}>Open converted MP4</button>}{failed && <p className="warning">Use Admin &gt; Jobs to retry after checking worker logs.</p>}</div>;
  })}{message && <div className="card"><p className="muted">{message}</p></div>}</div>;
}

export function ProjectWorkspaceClient({ projectId, tab }: { projectId: string; tab: WorkspaceTab }) {
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthState>("loading");
  const [loading, setLoading] = useState(true);
  const auth = useAuthSession();

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setAuthStatus(auth.status);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timeoutId: number | undefined;
    const loadProject = (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      apiFetch<ProjectDetail>(`/projects/${projectId}`, {}, auth.session?.access_token)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError("");
        authDebug("allowlist result", { allowed: true, userEmail: auth.email, currentRoute: `/projects/${projectId}` });
        const active = [...response.jobs, ...(response.exportJobs ?? [])].some((job) => ["queued", "processing"].includes(String(job.status)));
        if (active) timeoutId = window.setTimeout(() => loadProject(false), 5000);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        authDebug("allowlist result", { allowed: false, userEmail: auth.email, error: err.message, currentRoute: `/projects/${projectId}` });
        if (isPrivateBetaError(err.message)) setAuthStatus("unauthorized_email");
        else if (isInvalidLinkError(err.message)) setAuthStatus("invalid_link");
        else setError(err.message.toLowerCase() === "unauthorized" ? "Your sign-in was created, but the API could not verify it yet. Please refresh once." : err.message);
      })
      .finally(() => setLoading(false));
    };
    setAuthStatus("authenticated");
    loadProject(true);
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [auth.email, auth.session?.access_token, auth.status, projectId]);

  if (auth.status === "loading" || loading) return <AuthStatusMessage status="loading" />;
  if (authStatus !== "authenticated") return <AuthStatusMessage status={authStatus} error={auth.error} />;
  if (error) return <section className="card"><h2>Project unavailable</h2><p className="warning">{error}</p></section>;
  if (!data) return null;

  if (tab === "overview") return <section className="grid grid-2"><div className="card"><h2>{data.project.title}</h2><p className="muted">Status: {data.project.status}</p><p>Videos: {data.videos.length} · Jobs: {data.jobs.length} · Exports: {data.exports.length}</p><p className="muted">Workflow: upload or record video, analyze, confirm stats, choose outputs, edit timeline, build thumbnail, generate social pack, export.</p></div><div className="card"><h3>Latest Jobs</h3>{data.jobs.length ? data.jobs.slice(0, 5).map((job) => <p key={job.id}>{job.type} · <span className="status">{job.status}</span> · {job.progress ?? 0}%</p>) : <EmptyState label="job" />}</div><JsonCard title="Source Videos" value={data.videos} /></section>;

  if (tab === "timeline") return <section className="grid"><TimelineClipCard />{data.events.length ? data.events.map((event, index) => <JsonCard key={index} title="Timeline Event" value={event} />) : <div className="card"><EmptyState label="timeline event" /></div>}</section>;
  if (tab === "match-data") return <section><h2>Confirm match data</h2><StatsEditor />{data.matchData ? <JsonCard title="Saved Match Data" value={data.matchData} /> : <div className="card"><EmptyState label="match data" /></div>}</section>;
  if (tab === "highlights") return <section className="grid"><div className="card"><h2>Highlight candidates</h2><p>Signals include manual markers, audio spikes, mic reactions, scoreboard changes, replay scenes, scene changes, post-match stats, and user-confirmed events.</p></div>{data.events.length ? data.events.map((event, index) => <JsonCard key={index} title="Detected or Confirmed Event" value={event} />) : <div className="card"><EmptyState label="highlight" /></div>}</section>;
  if (tab === "captions") return <section className="grid grid-2"><div className="card"><h2>Captions</h2><p>Caption generation costs 10 credits and will use confirmed transcript/timeline data when enabled.</p></div><JsonCard title="Caption Jobs" value={data.jobs.filter((job) => job.type.includes("caption"))} /></section>;
  if (tab === "commentary") return <section className="grid grid-2"><div className="card"><h2>Commentary</h2><p>Commentary scripts must not invent goals, players, coaches, stats, or cards.</p></div><CopyBlock title="Commentary draft" copy="Generate commentary after confirmed match data and timeline notes are available." /></section>;
  if (tab === "thumbnail") return <section className="grid"><ThumbnailPreview />{data.thumbnails.length ? <JsonCard title="Saved Thumbnails" value={data.thumbnails} /> : <div className="card"><EmptyState label="thumbnail" /></div>}</section>;
  if (tab === "social-pack") return <section className="grid grid-2">{["YouTube title variants", "YouTube description", "Chapters", "Pinned comment", "TikTok caption", "Instagram caption", "X post", "Hashtags", "Thumbnail text options", "Posting strategy", "Multi-language variants"].map((label) => <CopyBlock key={label} title={label} copy="Generated copy will use only confirmed match and project data." />)}{data.socialPackages.length ? <JsonCard title="Saved Social Packages" value={data.socialPackages} /> : <div className="card"><EmptyState label="social package" /></div>}</section>;
  if (tab === "exports") return <section className="grid"><FormatSelector /><OutputFormatCards /><ReadinessChecklist />{data.exports.length ? <JsonCard title="Exports" value={data.exports} /> : <div className="card"><EmptyState label="export" /></div>}<ConversionJobs jobs={(data.exportJobs ?? []) as ConversionJob[]} token={auth.session?.access_token} /></section>;
  return <section className="grid"><JsonCard title="Project" value={data.project} /><JsonCard title="Videos" value={data.videos} /><JsonCard title="Jobs" value={data.jobs} /><JsonCard title="Exports" value={data.exports} /><JsonCard title="Conversion Jobs" value={data.exportJobs ?? []} /><JsonCard title="Match Data" value={data.matchData} /></section>;
}
