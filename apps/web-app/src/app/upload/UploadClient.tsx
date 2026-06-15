"use client";
import { useEffect, useState } from "react";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { apiFetch } from "../../lib/api";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../lib/auth";
import type { DashboardProject } from "../../lib/types";

type CreatedProject = { project: { id: string; title: string; status: string } };
type SignedUpload = { key: string; uploadUrl: string | null; expiresIn: number; expiresAt?: string; method?: "PUT"; mode: string };
type CompletedUpload = { video: { id: string; project_id: string; filename: string; storage_key: string } };
type CreatedJob = { job: { id: string; status: string; type: string } };
type UploadState = "idle" | "preparing" | "uploading" | "verifying" | "complete" | "failed";
type UploadProgress = { percent: number; loadedBytes: number; totalBytes: number; speedBytesPerSecond: number; etaSeconds: number | null; state: UploadState };

function contentTypeFor(file: File) {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mov") return "video/quicktime";
  if (extension === "mkv") return "video/x-matroska";
  if (extension === "webm") return "video/webm";
  return "video/mp4";
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

function uploadToSignedUrl(file: File, signed: SignedUpload, onProgress: (value: UploadProgress) => void) {
  return new Promise<void>((resolve, reject) => {
    if (!signed.uploadUrl) {
      reject(new Error("The API could not create a signed R2 upload URL. Check the server-side R2 environment on the VPS."));
      return;
    }

    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();
    xhr.open(signed.method ?? "PUT", signed.uploadUrl);
    xhr.setRequestHeader("Content-Type", contentTypeFor(file));
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
  const [title, setTitle] = useState("Match Upload");
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("new");
  const [progress, setProgress] = useState<UploadProgress>({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "idle" });
  const [status, setStatus] = useState("Choose a video file to start.");
  const [projectUrl, setProjectUrl] = useState("");
  const [busy, setBusy] = useState(false);
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
    setProjectUrl("");

    try {
      if (!auth.session?.access_token) throw new Error("Checking your sign-in. Try again in a moment.");
      setProgress((current) => ({ ...current, state: "preparing" }));
      setStatus(selectedProjectId === "new" ? "Creating project..." : "Preparing selected project...");
      const created = await resolveProject(file);
      const contentType = contentTypeFor(file);

      setStatus("Requesting signed R2 upload URL...");
      const signed = await apiFetch<SignedUpload>("/uploads/create-signed-url", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType }),
      }, auth.session.access_token);

      setStatus("Uploading directly to Cloudflare R2...");
      await uploadToSignedUrl(file, signed, setProgress);
      setProgress((current) => ({ ...current, percent: 100, loadedBytes: file.size, totalBytes: file.size, etaSeconds: 0, state: "verifying" }));

      setStatus("Verifying R2 upload with HeadObject...");
      await apiFetch("/uploads/verify", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType, storageKey: signed.key, sizeBytes: file.size }),
      }, auth.session.access_token);

      setStatus("Saving video record...");
      const completed = await apiFetch<CompletedUpload>("/uploads/complete", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType, storageKey: signed.key, sizeBytes: file.size }),
      }, auth.session.access_token);

      setStatus("Creating initial analyze job...");
      const job = await apiFetch<CreatedJob>("/jobs/analyze", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, videoId: completed.video.id }),
      }, auth.session.access_token);

      setProgress((current) => ({ ...current, state: "complete" }));
      setStatus(`Upload verified. Ready to produce package. Analyze job ${job.job.id} is ${job.job.status}.`);
      setProjectUrl(`/projects/${created.project.id}/social-production`);
    } catch (error) {
      setProgress((current) => ({ ...current, state: "failed" }));
      setStatus(error instanceof Error ? error.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (auth.status === "loading" || authStatus === "loading") return <AuthStatusMessage status="loading" />;
  if (authStatus !== "authenticated") return <AuthStatusMessage status={authStatus} error={auth.error} />;

  return <section className="hero">
    <h1>Upload Existing Video</h1>
    <p className="muted">Accepted formats: mp4, mov, mkv, webm. Videos upload directly to Cloudflare R2 using signed URLs created by the API.</p>
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
        <input className="input" type="file" accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        {file && <p className="muted">Selected: {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
        <p className="muted">After upload reaches 100%, VideoBlitzer verifies the R2 object exists and that the size matches before enabling package production.</p>
        <button className="button" onClick={startUpload} disabled={busy}>{busy ? "Uploading..." : "Upload Existing Video"}</button>
        <p className={progress.state === "failed" ? "warning" : progress.state === "complete" ? "status" : "muted"}>{status}</p>
        <div className="card">
          <strong>{progress.percent}% uploaded</strong>
          <div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}><div style={{ width: `${progress.percent}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} /></div>
          <p className="muted">State: {progress.state}</p>
          <p className="muted">{formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes || file?.size || 0)} · {formatBytes(progress.speedBytesPerSecond)}/s · ETA {formatEta(progress.etaSeconds)}</p>
          {progress.state === "failed" && <p className="warning">Failed upload can be retried safely. The next attempt requests a fresh signed URL and verifies the new R2 object before package creation.</p>}
        </div>
        {projectUrl && <p><a className="button secondary" href={projectUrl}>Open Social Media Production</a></p>}
      </div>
      <div className="card"><h3>Record New Match</h3><p className="muted">Coming desktop app. Use replay buffers, hotkeys, and separate tracks, then upload to the dashboard.</p><button className="button secondary">Coming Desktop App</button></div>
    </div>
  </section>;
}
