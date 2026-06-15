"use client";
import { useEffect, useState } from "react";
import { FormatSelector, OutputFormatCards, ReadinessChecklist, TimelineClipCard, CopyBlock } from "../../../components/Cards";
import { AuthStatusMessage } from "../../../components/AuthStatus";
import { StatsEditor } from "../../../components/StatsEditor";
import { ThumbnailPreview } from "../../../components/ThumbnailPreview";
import { apiFetch } from "../../../lib/api";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../../lib/auth";
import type { ProjectDetail } from "../../../lib/types";

type WorkspaceTab = "overview" | "social-production" | "imports" | "timeline" | "match-data" | "highlights" | "captions" | "commentary" | "thumbnail" | "social-pack" | "exports" | "debug";
type ConversionJob = { id?: string; status?: string; source_object_key?: string; target_object_key?: string; error_message?: string; created_at?: string };
type ImportJob = { id?: string; status?: string; progress?: number; source_url?: string; source_type?: string; error_message?: string; r2_object_key?: string; created_at?: string };
type PackageJob = { id?: string; status?: string; stage?: string; progress?: number; error_message?: string; artifact_object_key?: string; output?: Record<string, unknown>; manifest_json?: Record<string, unknown>; created_at?: string };
type PackageAsset = { id?: string; package_job_id?: string; asset_type?: string; platform?: string; filename?: string; storage_key?: string; duration_seconds?: number; width?: number; height?: number; aspect_ratio?: string; validation_status?: string; confidence?: number; metadata?: Record<string, unknown> };
type UploadVerification = { id?: string; video_id?: string; object_key?: string; status?: string; verified_size_bytes?: number; verified_content_type?: string; verified_at?: string; error_message?: string };

function JsonCard({ title, value }: { title: string; value: unknown }) {
  return <div className="card"><h3>{title}</h3><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(value, null, 2)}</pre></div>;
}

function EmptyState({ label }: { label: string }) { return <p className="muted">No {label} records yet. Generate or confirm content to populate this workspace tab.</p>; }

const packageStages = [
  { key: "queued", label: "Queued" },
  { key: "download_source", label: "Probing source" },
  { key: "normalize_master", label: "Normalizing video/audio" },
  { key: "analyze", label: "Detecting highlights" },
  { key: "rendering_clips", label: "Creating clips" },
  { key: "preset_exports", label: "Converting/exporting MP4" },
  { key: "validating_assets", label: "Validating assets" },
  { key: "building_zip", label: "Building ZIP package" },
  { key: "completed", label: "Complete" },
];

function PackageTimeline({ job }: { job?: PackageJob }) {
  const stage = String(job?.stage ?? job?.output?.stage ?? "queued");
  const progress = Number(job?.progress ?? 0);
  return <div className="card">
    <h3>Package Progress</h3>
    <p className={job?.status === "failed" ? "warning" : job?.status === "completed" ? "status" : "muted"}>{job?.status ?? "not started"} · {stage.replaceAll("_", " ")} · {progress}%</p>
    <div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}>
      <div style={{ width: `${Math.min(100, Math.max(0, progress))}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} />
    </div>
    <div className="grid grid-2">
      {packageStages.map((item) => {
        const reached = packageStages.findIndex((candidate) => candidate.key === item.key) <= packageStages.findIndex((candidate) => candidate.key === stage || (stage === "completed" && candidate.key === "completed"));
        return <p key={item.key} className={reached ? "status" : "muted"}>{reached ? "[x]" : "[ ]"} {item.label}</p>;
      })}
    </div>
    {job?.error_message && <p className="warning">{job.error_message}</p>}
  </div>;
}

function SocialProductionWorkspace({ data, projectId, token }: { data: ProjectDetail; projectId: string; token?: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const videos = data.videos;
  const latestVideo = videos[0];
  const packageJobs = (data.packageJobs ?? []) as PackageJob[];
  const latestPackage = packageJobs[0];
  const packageAssets = (data.packageAssets ?? []) as PackageAsset[];
  const verifications = (data.uploadVerifications ?? []) as UploadVerification[];
  const latestVerification = latestVideo ? verifications.find((verification) => verification.video_id === latestVideo.id) ?? verifications[0] : verifications[0];
  const uploadVerified = latestVideo?.verification_status === "verified" || latestVerification?.status === "verified";
  const activePackage = latestPackage && ["queued", "processing"].includes(String(latestPackage.status));
  const packageComplete = latestPackage?.status === "completed";
  const packageFailed = latestPackage?.status === "failed";

  async function producePackage() {
    if (!token || !latestVideo?.id) return;
    setBusy(true);
    try {
      const response = await apiFetch<{ job_id: string }>("/packages/generate", {
        method: "POST",
        body: JSON.stringify({ projectId, videoId: latestVideo.id }),
      }, token);
      setMessage(`Package queued: ${response.job_id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not queue package.");
    } finally {
      setBusy(false);
    }
  }

  async function retryPackage() {
    if (!token || !latestPackage?.id) return;
    setBusy(true);
    try {
      await apiFetch(`/packages/${latestPackage.id}/retry`, { method: "POST" }, token);
      setMessage(`Retry queued: ${latestPackage.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not retry package.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPackage() {
    if (!token || !latestPackage?.id) return;
    try {
      const response = await apiFetch<{ downloadUrl: string | null }>(`/packages/${latestPackage.id}/download`, {}, token);
      if (!response.downloadUrl) throw new Error("Signed download is not available yet.");
      window.open(response.downloadUrl, "_blank", "noopener,noreferrer");
      setMessage("Opened package ZIP download.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open package ZIP.");
    }
  }

  return <section className="grid">
    <div className="card">
      <span className="pill">Social Media Production</span>
      <h2>Turn Full Games Into Social Media Content</h2>
      <p className="muted">Primary workflow: upload an existing video or import a direct media URL, verify the source, produce a social package, review generated assets, and download the ZIP.</p>
      <p><a className="button secondary" href="/upload">Upload Existing Video</a> <a className="button secondary" href={`/projects/${projectId}/imports`}>Import Direct Media URL</a></p>
    </div>

    <div className="grid grid-2">
      <div className="card">
        <h3>Upload Verification</h3>
        {latestVideo ? <>
          <p><strong>{String(latestVideo.filename ?? latestVideo.original_filename ?? "Uploaded video")}</strong></p>
          <p className={uploadVerified ? "status" : "warning"}>{uploadVerified ? "Upload verified. Ready to produce package." : "Upload is not verified yet."}</p>
          <p className="muted">Size: {typeof latestVideo.verified_size_bytes === "number" ? `${(latestVideo.verified_size_bytes / 1024 / 1024).toFixed(1)} MB verified` : typeof latestVideo.size_bytes === "number" ? `${(latestVideo.size_bytes / 1024 / 1024).toFixed(1)} MB expected` : "Unknown size"}</p>
          {latestVerification?.verified_at && <p className="muted">Verified at {new Date(latestVerification.verified_at).toLocaleString()}</p>}
        </> : <EmptyState label="uploaded video" />}
      </div>

      <div className="card">
        <h3>Produce Package</h3>
        <p className="muted">Creates vertical clips, landscape exports, thumbnails, captions/metadata, manifest, README, and ZIP. Package generation is async and safe for long videos.</p>
        <button className="button" disabled={busy || !latestVideo || !uploadVerified || Boolean(activePackage)} onClick={() => void producePackage()}>{busy ? "Working..." : "Produce Package"}</button>
        {!uploadVerified && <p className="warning">Button stays disabled until upload verification succeeds.</p>}
        {packageFailed && <button className="button secondary" disabled={busy} onClick={() => void retryPackage()}>Retry Package</button>}
        {packageComplete && <button className="button secondary" onClick={() => void downloadPackage()}>Download Package ZIP</button>}
        {message && <p className="muted">{message}</p>}
      </div>
    </div>

    <PackageTimeline job={latestPackage} />

    <div className="card">
      <h3>Detected Clips and Assets</h3>
      {packageAssets.length ? <div className="grid grid-2">{packageAssets.slice(0, 24).map((asset) => <div className="card" key={asset.id ?? asset.storage_key}>
        <strong>{asset.filename ?? asset.asset_type}</strong>
        <p className={asset.validation_status === "failed" ? "warning" : asset.validation_status === "valid" ? "status" : "muted"}>{asset.asset_type} · {asset.platform ?? "all"} · {asset.validation_status ?? "pending"}</p>
        <p className="muted">{asset.width && asset.height ? `${asset.width}x${asset.height}` : "metadata"} {asset.aspect_ratio ? `· ${asset.aspect_ratio}` : ""} {asset.duration_seconds ? `· ${Number(asset.duration_seconds).toFixed(1)}s` : ""}</p>
        {typeof asset.confidence === "number" && <p className="muted">Confidence: {Math.round(asset.confidence * 100)}%</p>}
        {typeof asset.metadata?.reason === "string" && <p className="muted">{asset.metadata.reason}</p>}
      </div>)}</div> : <EmptyState label="package asset" />}
    </div>

    <div className="card">
      <h3>Package Standards</h3>
      <p className="muted">ZIP includes clips by aspect ratio, thumbnails, SRT social captions, metadata, manifest.json, and README.txt. Low-confidence clips are labeled as candidates for review.</p>
      <ul>
        <li>Instagram Reels, TikTok, YouTube Shorts, Facebook Reels: 9:16 1080x1920 clips.</li>
        <li>YouTube Standard: 16:9 1920x1080 landscape assets.</li>
        <li>Optional square social clips: 1:1 1080x1080.</li>
      </ul>
    </div>
  </section>;
}

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

function DirectUrlImport({ projectId, jobs, token }: { projectId: string; jobs: ImportJob[]; token?: string }) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [message, setMessage] = useState("Paste a direct .mp4, .mov, .webm, or .mkv file URL.");
  const [busy, setBusy] = useState(false);

  async function startImport() {
    if (!token) return;
    setBusy(true);
    try {
      const response = await apiFetch<{ importJob: ImportJob }>("/source-import/direct", {
        method: "POST",
        body: JSON.stringify({ projectId, sourceUrl, permissionConfirmed }),
      }, token);
      setSourceUrl("");
      setPermissionConfirmed(false);
      setMessage(`Import queued: ${response.importJob.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not queue direct URL import.");
    } finally {
      setBusy(false);
    }
  }

  async function retryImport(jobId?: string) {
    if (!token || !jobId) return;
    setBusy(true);
    try {
      await apiFetch(`/source-import/${jobId}/retry`, { method: "POST" }, token);
      setMessage(`Retry queued: ${jobId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not retry import job.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="grid">
    <div className="card"><h2>Import Direct Video URL</h2><p className="muted">Admin/private-beta feature for authorized direct media files only. YouTube, Vimeo, social, stream, and platform pages are metadata-only and cannot be downloaded here.</p><input className="input" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.com/authorized-video.webm" /><br /><br /><label className="toggle"><input type="checkbox" checked={permissionConfirmed} onChange={(event) => setPermissionConfirmed(event.target.checked)} /> I confirm I own this file or have permission to import it.</label><br /><br /><button className="button" disabled={busy || !sourceUrl || !permissionConfirmed} onClick={() => void startImport()}>{busy ? "Queueing..." : "Import Direct Video URL"}</button><p className="muted">{message}</p><p className="warning">Video platform pages cannot be downloaded here. Use Capture Screen Video if you have permission to record your own accessible source.</p></div>
    <div className="grid grid-2">{jobs.length ? jobs.map((job) => <div className="card" key={job.id}><h3>Import {job.status ?? "queued"}</h3><p className={job.status === "failed" ? "warning" : job.status === "completed" ? "status" : "muted"}>{job.status === "completed" ? "Imported to R2 and attached to this project." : job.status === "failed" ? job.error_message ?? "Import failed." : "Worker is validating and importing this source."}</p><p>Progress: {job.progress ?? 0}%</p>{job.source_url && <p><strong>Source URL</strong><br /><span className="muted">{job.source_url}</span></p>}{job.r2_object_key && <p><strong>R2 object key</strong><br /><span className="muted">{job.r2_object_key}</span></p>}{job.status === "failed" && <button className="button secondary" disabled={busy} onClick={() => void retryImport(job.id)}>Retry import</button>}</div>) : <div className="card"><EmptyState label="direct import job" /></div>}</div>
  </section>;
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
        const active = [...response.jobs, ...(response.exportJobs ?? []), ...(response.importJobs ?? []), ...(response.packageJobs ?? [])].some((job) => ["queued", "processing"].includes(String(job.status)));
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

  if (tab === "social-production") return <SocialProductionWorkspace data={data} projectId={projectId} token={auth.session?.access_token} />;
  if (tab === "imports") return <DirectUrlImport projectId={projectId} jobs={(data.importJobs ?? []) as ImportJob[]} token={auth.session?.access_token} />;
  if (tab === "timeline") return <section className="grid"><TimelineClipCard />{data.events.length ? data.events.map((event, index) => <JsonCard key={index} title="Timeline Event" value={event} />) : <div className="card"><EmptyState label="timeline event" /></div>}</section>;
  if (tab === "match-data") return <section><h2>Confirm match data</h2><StatsEditor />{data.matchData ? <JsonCard title="Saved Match Data" value={data.matchData} /> : <div className="card"><EmptyState label="match data" /></div>}</section>;
  if (tab === "highlights") return <section className="grid"><div className="card"><h2>Highlight candidates</h2><p>Signals include manual markers, audio spikes, mic reactions, scoreboard changes, replay scenes, scene changes, post-match stats, and user-confirmed events.</p></div>{data.events.length ? data.events.map((event, index) => <JsonCard key={index} title="Detected or Confirmed Event" value={event} />) : <div className="card"><EmptyState label="highlight" /></div>}</section>;
  if (tab === "captions") return <section className="grid grid-2"><div className="card"><h2>Captions</h2><p>Caption generation costs 10 credits and will use confirmed transcript/timeline data when enabled.</p></div><JsonCard title="Caption Jobs" value={data.jobs.filter((job) => job.type.includes("caption"))} /></section>;
  if (tab === "commentary") return <section className="grid grid-2"><div className="card"><h2>Commentary</h2><p>Commentary scripts must not invent goals, players, coaches, stats, or cards.</p></div><CopyBlock title="Commentary draft" copy="Generate commentary after confirmed match data and timeline notes are available." /></section>;
  if (tab === "thumbnail") return <section className="grid"><ThumbnailPreview />{data.thumbnails.length ? <JsonCard title="Saved Thumbnails" value={data.thumbnails} /> : <div className="card"><EmptyState label="thumbnail" /></div>}</section>;
  if (tab === "social-pack") return <section className="grid grid-2">{["YouTube title variants", "YouTube description", "Chapters", "Pinned comment", "TikTok caption", "Instagram caption", "X post", "Hashtags", "Thumbnail text options", "Posting strategy", "Multi-language variants"].map((label) => <CopyBlock key={label} title={label} copy="Generated copy will use only confirmed match and project data." />)}{data.socialPackages.length ? <JsonCard title="Saved Social Packages" value={data.socialPackages} /> : <div className="card"><EmptyState label="social package" /></div>}</section>;
  if (tab === "exports") return <section className="grid"><FormatSelector /><OutputFormatCards /><ReadinessChecklist />{data.exports.length ? <JsonCard title="Exports" value={data.exports} /> : <div className="card"><EmptyState label="export" /></div>}<ConversionJobs jobs={(data.exportJobs ?? []) as ConversionJob[]} token={auth.session?.access_token} /></section>;
  return <section className="grid"><JsonCard title="Project" value={data.project} /><JsonCard title="Videos" value={data.videos} /><JsonCard title="Jobs" value={data.jobs} /><JsonCard title="Exports" value={data.exports} /><JsonCard title="Conversion Jobs" value={data.exportJobs ?? []} /><JsonCard title="Import Jobs" value={data.importJobs ?? []} /><JsonCard title="Match Data" value={data.matchData} /></section>;
}
