"use client";
import { useEffect, useState } from "react";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { apiFetch } from "../../lib/api";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../lib/auth";
import type { DashboardProject } from "../../lib/types";

type CreatedProject = { project: { id: string; title: string; status: string } };
type SignedUpload = { key: string; uploadUrl: string | null; expiresIn: number; expiresAt?: string; method?: "PUT"; mode: string };
type CompletedUpload = { video: { id: string; project_id: string; filename: string; storage_key: string; has_video?: boolean; has_audio?: boolean; duration_seconds?: number | null; width?: number | null; height?: number | null; video_codec?: string | null; audio_codec?: string | null } };
type PackageJobResponse = { job_id: string; status: string };
type PackageJob = { id?: string; status?: string; stage?: string; progress?: number; error_message?: string; artifact_object_key?: string | null; output?: Record<string, unknown> };
type PackageStatusResponse = { packageJob: PackageJob; assets?: Array<Record<string, unknown>> };
type UploadState = "idle" | "preparing" | "uploading" | "verifying" | "complete" | "failed";
type UploadProgress = { percent: number; loadedBytes: number; totalBytes: number; speedBytesPerSecond: number; etaSeconds: number | null; state: UploadState };
type UploadedVideoState = CompletedUpload["video"] & { project_id: string };
type UploadVerificationResponse = { media?: { has_audio?: boolean; has_video?: boolean; audio_codec?: string | null; video_codec?: string | null } };

const packageStages = [
  { key: "queued", label: "Queued" },
  { key: "download_source", label: "Downloading source media" },
  { key: "normalize_master", label: "Merging and normalizing media" },
  { key: "analyze", label: "Detecting highlights" },
  { key: "rendering_clips", label: "Creating social clips" },
  { key: "preset_exports", label: "Creating export presets" },
  { key: "validating_assets", label: "Validating generated assets" },
  { key: "building_zip", label: "Building ZIP package" },
  { key: "completed", label: "Complete" },
];

function contentTypeForVideo(file: File) {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mov") return "video/quicktime";
  if (extension === "mkv") return "video/x-matroska";
  if (extension === "webm") return "video/webm";
  return "video/mp4";
}

function contentTypeForAudio(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "mp4") return "audio/mp4";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "aac") return "audio/aac";
  if (extension === "wav") return "audio/wav";
  if (extension === "webm") return "audio/webm";
  if (extension === "ogg") return "audio/ogg";
  if (extension === "flac") return "audio/flac";
  if (file.type) return file.type;
  return "audio/mpeg";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  return `${(value / 1024 / 1024).toFixed(value > 1024 * 1024 * 1024 ? 2 : 1)} MB`;
}

function formatEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "calculating";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function friendlyPackageError(error: unknown) {
  const message = error instanceof Error ? error.message : "Could not produce package.";
  if (message.toLowerCase() === "failed to fetch") return "Could not contact the API. Check deployment/network status, then try Produce Package again.";
  return message;
}

function isPackageWarning(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("audio only") || lower.includes("could not") || lower.includes("failed") || lower.includes("unavailable") || lower.includes("not available");
}

function PackageProgressPanel({ job, onDownload, downloadBusy }: { job: PackageJob | null; onDownload: () => void; downloadBusy: boolean }) {
  const stage = String(job?.stage ?? job?.output?.stage ?? (job?.status === "completed" ? "completed" : "queued"));
  const progress = Math.min(100, Math.max(0, Number(job?.progress ?? 0)));
  const activeIndex = Math.max(0, packageStages.findIndex((item) => item.key === stage || (stage === "completed" && item.key === "completed")));
  const statusClass = job?.status === "failed" ? "warning" : job?.status === "completed" ? "status" : "muted";
  return <div className="card">
    <h3>Package Progress</h3>
    <p className={statusClass}>{job?.status ?? "not started"} · {stage.replaceAll("_", " ")} · {progress}%</p>
    <div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}>
      <div style={{ width: `${progress}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} />
    </div>
    <div className="grid grid-2">
      {packageStages.map((item, index) => {
        const reached = Boolean(job) && index <= activeIndex;
        const current = Boolean(job) && index === activeIndex && job?.status !== "completed";
        return <p key={item.key} className={reached ? "status" : "muted"}>{reached ? "[x]" : "[ ]"} {current ? "Now: " : ""}{item.label}</p>;
      })}
    </div>
    {job?.error_message && <p className="warning">{job.error_message}</p>}
    {job?.status === "completed" && <button className="button" disabled={downloadBusy} onClick={onDownload}>{downloadBusy ? "Opening..." : "Download Package ZIP"}</button>}
  </div>;
}

function uploadToSignedUrl(file: File, signed: SignedUpload, contentType: string, onProgress: (value: UploadProgress) => void) {
  return new Promise<void>((resolve, reject) => {
    if (!signed.uploadUrl) {
      reject(new Error("The API could not create a signed R2 upload URL. Check the server-side R2 environment on the VPS."));
      return;
    }

    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();
    xhr.open(signed.method ?? "PUT", signed.uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
        const speedBytesPerSecond = event.loaded / elapsedSeconds;
        const remainingBytes = Math.max(0, event.total - event.loaded);
        onProgress({
          percent: Math.round((event.loaded / event.total) * 100),
          loadedBytes: event.loaded,
          totalBytes: event.total,
          speedBytesPerSecond,
          etaSeconds: speedBytesPerSecond > 0 ? remainingBytes / speedBytesPerSecond : null,
          state: "uploading",
        });
      }
    };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 upload failed with status ${xhr.status}. Please try again.`));
    xhr.onerror = () => reject(new Error("R2 upload failed before completion. Check your connection and try again."));
    xhr.send(file);
  });
}

export function UploadClient() {
  const [file, setFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [title, setTitle] = useState("Match Upload");
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("new");
  const [progress, setProgress] = useState<UploadProgress>({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "idle" });
  const [audioProgress, setAudioProgress] = useState<UploadProgress>({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "idle" });
  const [status, setStatus] = useState("Choose a video file to start.");
  const [projectUrl, setProjectUrl] = useState("");
  const [uploadedVideo, setUploadedVideo] = useState<UploadedVideoState | null>(null);
  const [packageJob, setPackageJob] = useState<PackageJob | null>(null);
  const [packageStatus, setPackageStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthState>("loading");
  const auth = useAuthSession();

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setAuthStatus(auth.status);
      return;
    }

    apiFetch<{ projects: DashboardProject[] }>("/projects", {}, auth.session?.access_token)
      .then((response) => {
        setProjects(response.projects);
        setAuthStatus("authenticated");
        authDebug("allowlist result", { allowed: true, userEmail: auth.email, currentRoute: "/upload" });
      })
      .catch((error: Error) => {
        authDebug("allowlist result", { allowed: false, userEmail: auth.email, error: error.message, currentRoute: "/upload" });
        if (isPrivateBetaError(error.message)) setAuthStatus("unauthorized_email");
        else if (isInvalidLinkError(error.message)) setAuthStatus("invalid_link");
        else {
          setAuthStatus("authenticated");
          setStatus(error.message.toLowerCase() === "unauthorized" ? "Your sign-in was created, but the API could not verify it yet. Please refresh once." : "Sign in to load existing projects, or create a new project during upload.");
        }
      });
  }, [auth.email, auth.session?.access_token, auth.status]);

  useEffect(() => {
    if (!auth.session?.access_token || !packageJob?.id || ["completed", "failed"].includes(String(packageJob.status))) return;
    const timer = window.setInterval(() => {
      void refreshPackageJob(packageJob.id!);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [auth.session?.access_token, packageJob?.id, packageJob?.status]);

  async function resolveProject(fileToUpload: File) {
    if (!auth.session?.access_token) throw new Error("Checking your sign-in. Try again in a moment.");
    if (selectedProjectId !== "new") {
      const existing = projects.find((project) => project.id === selectedProjectId);
      return { project: { id: selectedProjectId, title: existing?.title ?? "Selected project", status: existing?.status ?? "draft" } } satisfies CreatedProject;
    }

    return apiFetch<CreatedProject>("/projects", {
      method: "POST",
      body: JSON.stringify({ title: title || fileToUpload.name.replace(/\.[^.]+$/, "") }),
    }, auth.session.access_token);
  }

  async function startUpload() {
    if (!file) { setStatus("Select an mp4, mov, mkv, or webm file first."); return; }
    setBusy(true);
    setProgress({ percent: 0, loadedBytes: 0, totalBytes: file.size, speedBytesPerSecond: 0, etaSeconds: null, state: "preparing" });
    setAudioProgress({ percent: 0, loadedBytes: 0, totalBytes: audioFile?.size ?? 0, speedBytesPerSecond: 0, etaSeconds: null, state: audioFile ? "preparing" : "idle" });
    setProjectUrl("");
    setUploadedVideo(null);
    setPackageJob(null);
    setPackageStatus("");

    try {
      if (!auth.session?.access_token) throw new Error("Checking your sign-in. Try again in a moment.");
      setProgress((current) => ({ ...current, state: "preparing" }));
      setStatus(selectedProjectId === "new" ? "Creating project..." : "Preparing selected project...");
      const created = await resolveProject(file);
      const contentType = contentTypeForVideo(file);
      const audioContentType = audioFile ? contentTypeForAudio(audioFile) : null;

      setStatus("Requesting signed R2 upload URL...");
      const signed = await apiFetch<SignedUpload>("/uploads/create-signed-url", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType }),
      }, auth.session.access_token);
      const signedAudio = audioFile && audioContentType ? await apiFetch<SignedUpload>("/uploads/create-signed-url", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: audioFile.name, contentType: audioContentType }),
      }, auth.session.access_token) : null;

      setStatus("Uploading directly to Cloudflare R2...");
      await uploadToSignedUrl(file, signed, contentType, setProgress);
      setProgress((current) => ({ ...current, percent: 100, loadedBytes: file.size, totalBytes: file.size, etaSeconds: 0, state: "verifying" }));
      if (audioFile && signedAudio && audioContentType) {
        setStatus("Uploading optional audio track to Cloudflare R2...");
        await uploadToSignedUrl(audioFile, signedAudio, audioContentType, setAudioProgress);
        setAudioProgress((current) => ({ ...current, percent: 100, loadedBytes: audioFile.size, totalBytes: audioFile.size, etaSeconds: 0, state: "verifying" }));
      }

      setStatus("Verifying R2 upload with HeadObject...");
      const verification = await apiFetch<UploadVerificationResponse>("/uploads/verify", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType, storageKey: signed.key, sizeBytes: file.size }),
      }, auth.session.access_token);
      if (audioFile && verification.media?.has_audio === true) {
        const shouldOverrideAudio = window.confirm("This video already contains audio. Do you want to replace the video's audio with the separate audio file for package production?");
        if (!shouldOverrideAudio) {
          setStatus("Upload stopped before package setup. Remove the separate audio file or confirm audio replacement, then upload again.");
          setProgress((current) => ({ ...current, state: "failed" }));
          setAudioProgress((current) => ({ ...current, state: "failed" }));
          return;
        }
      }

      setStatus("Saving video record...");
      const completed = await apiFetch<CompletedUpload>("/uploads/complete", {
        method: "POST",
        body: JSON.stringify({
          projectId: created.project.id,
          filename: file.name,
          contentType,
          storageKey: signed.key,
          sizeBytes: file.size,
          audio_source: audioFile && signedAudio && audioContentType ? {
            object_key: signedAudio.key,
            filename: audioFile.name,
            content_type: audioContentType,
            size_bytes: audioFile.size,
          } : undefined,
        }),
      }, auth.session.access_token);

      setProgress((current) => ({ ...current, state: "complete" }));
      if (audioFile) setAudioProgress((current) => ({ ...current, state: "complete" }));
      setUploadedVideo(completed.video);
      setStatus(completed.video.has_video === true ? "Upload verified. Ready to produce package." : "This file contains audio only. Social media video packages require a video stream.");
      setProjectUrl(`/projects/${created.project.id}/social-production`);
    } catch (error) {
      setProgress((current) => ({ ...current, state: "failed" }));
      if (audioFile) setAudioProgress((current) => ({ ...current, state: "failed" }));
      setStatus(error instanceof Error ? error.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function producePackage() {
    if (!auth.session?.access_token || !uploadedVideo) return;
    setPackageBusy(true);
    setPackageStatus("");
    try {
      const response = await apiFetch<PackageJobResponse>("/packages/generate", {
        method: "POST",
        body: JSON.stringify({ projectId: uploadedVideo.project_id, videoId: uploadedVideo.id }),
      }, auth.session.access_token);
      setPackageJob({ id: response.job_id, status: response.status, stage: "queued", progress: 0 });
      setPackageStatus(`Package queued: ${response.job_id}. Processing has started.`);
      await refreshPackageJob(response.job_id).catch(() => undefined);
    } catch (error) {
      setPackageStatus(friendlyPackageError(error));
    } finally {
      setPackageBusy(false);
    }
  }

  async function refreshPackageJob(packageJobId: string) {
    if (!auth.session?.access_token) return;
    const response = await apiFetch<PackageStatusResponse>(`/packages/${packageJobId}`, {}, auth.session.access_token);
    setPackageJob(response.packageJob);
    if (response.packageJob.status === "completed") setPackageStatus("Package complete. ZIP is ready to download.");
    else if (response.packageJob.status === "failed") setPackageStatus(response.packageJob.error_message ?? "Package failed. Open Social Media Production for details.");
  }

  async function downloadPackageZip() {
    if (!auth.session?.access_token || !packageJob?.id) return;
    setDownloadBusy(true);
    try {
      const response = await apiFetch<{ downloadUrl: string | null }>(`/packages/${packageJob.id}/download`, {}, auth.session.access_token);
      if (!response.downloadUrl) throw new Error("Package ZIP is not available yet.");
      window.open(response.downloadUrl, "_blank", "noopener,noreferrer");
      setPackageStatus("Opened package ZIP download.");
    } catch (error) {
      setPackageStatus(friendlyPackageError(error));
    } finally {
      setDownloadBusy(false);
    }
  }

  if (auth.status === "loading" || authStatus === "loading") return <AuthStatusMessage status="loading" />;
  if (authStatus !== "authenticated") return <AuthStatusMessage status={authStatus} error={auth.error} />;

  return <section className="hero">
    <h1>Upload Existing Video</h1>
    <p className="muted">Accepted video formats: mp4, mov, mkv, webm. Optional separate audio can be uploaded as mp3, mp4, wav, m4a, aac, ogg, flac, or webm.</p>
    <div className="grid grid-2">
      <div className="card">
        <h3>Upload Existing Video</h3>
        <label>Project</label>
        <select className="input" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
          <option value="new">Create a new project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
        {selectedProjectId === "new" && <><br /><br /><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Project title" /></>}
        <br /><br />
        <label>Video file</label>
        <input className="input" type="file" accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        {file && <p className="muted">Selected: {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
        <br /><br />
        <label>Optional separate audio file</label>
        <input className="input" type="file" accept=".mp3,.mp4,.wav,.m4a,.aac,.ogg,.flac,.webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/flac,audio/webm,video/mp4" onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)} />
        {audioFile && <p className="muted">Optional audio: {audioFile.name} · {(audioFile.size / 1024 / 1024).toFixed(1)} MB</p>}
        <p className="muted">After upload reaches 100%, VideoBlitzer verifies the video and optional audio objects before enabling package production. Optional audio is merged with the video by the package worker.</p>
        {audioFile && <p className="warning">If the video already contains audio, VideoBlitzer will ask before replacing it with this separate audio file.</p>}
        <button className="button" onClick={startUpload} disabled={busy}>{busy ? "Uploading..." : "Upload Existing Video"}</button>
        <p className={progress.state === "failed" ? "warning" : progress.state === "complete" ? "status" : "muted"}>{status}</p>
        <div className="card">
          <strong>Video: {progress.percent}% uploaded</strong>
          <div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}><div style={{ width: `${progress.percent}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} /></div>
          <p className="muted">State: {progress.state}</p>
          <p className="muted">{formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes || file?.size || 0)} · {formatBytes(progress.speedBytesPerSecond)}/s · ETA {formatEta(progress.etaSeconds)}</p>
          {audioFile && <>
            <strong>Audio: {audioProgress.percent}% uploaded</strong>
            <div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}><div style={{ width: `${audioProgress.percent}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} /></div>
            <p className="muted">Audio state: {audioProgress.state}</p>
            <p className="muted">{formatBytes(audioProgress.loadedBytes)} / {formatBytes(audioProgress.totalBytes || audioFile.size)} · {formatBytes(audioProgress.speedBytesPerSecond)}/s · ETA {formatEta(audioProgress.etaSeconds)}</p>
          </>}
          {progress.state === "failed" && <p className="warning">Failed upload can be retried safely. The next attempt requests a fresh signed URL and verifies the new R2 object before package creation.</p>}
        </div>
        {uploadedVideo && <div className="card">
          <h3>Produce Package</h3>
          {uploadedVideo.has_video === true
            ? <p className="status">Upload verified. Ready to produce package.</p>
            : <p className="warning">This file contains audio only. Social media video packages require a video stream.</p>}
          <p className="muted">Has video: {uploadedVideo.has_video === true ? "yes" : "no"} · Has audio: {uploadedVideo.has_audio === true ? "yes" : "no"}</p>
          {audioFile && <p className="status">Separate audio uploaded. The package worker will replace the video's original audio with this track before creating clips and exports.</p>}
          <p className="muted">Duration: {typeof uploadedVideo.duration_seconds === "number" ? `${uploadedVideo.duration_seconds.toFixed(1)}s` : "unknown"} · Resolution: {uploadedVideo.width && uploadedVideo.height ? `${uploadedVideo.width}x${uploadedVideo.height}` : "none"} · Codec: {uploadedVideo.video_codec ?? "no video"} / {uploadedVideo.audio_codec ?? "no audio"}</p>
          <button className="button" onClick={() => void producePackage()} disabled={packageBusy || uploadedVideo.has_video !== true}>{packageBusy ? "Queueing..." : "Produce Package"}</button>
          {projectUrl && <a className="button secondary" href={projectUrl}>Open Social Media Production</a>}
          {packageStatus && <p className={isPackageWarning(packageStatus) ? "warning" : "muted"}>{packageStatus}</p>}
        </div>}
      </div>
      <div className="card">
        <h3>Package Creation</h3>
        <p className="muted">After upload verification, click Produce Package and watch each processing stage here. Keep this page open to follow long game videos through ZIP creation.</p>
        <PackageProgressPanel job={packageJob} onDownload={() => void downloadPackageZip()} downloadBusy={downloadBusy} />
        {projectUrl && <p><a className="button secondary" href={projectUrl}>Open Social Media Production</a></p>}
      </div>
    </div>
  </section>;
}
