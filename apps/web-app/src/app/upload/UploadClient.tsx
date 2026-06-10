"use client";
import { useEffect, useState } from "react";
import { authedApiFetch, getAccessToken } from "../../lib/api";
import type { DashboardProject } from "../../lib/types";

type CreatedProject = { project: { id: string; title: string; status: string } };
type SignedUpload = { key: string; uploadUrl: string | null; expiresIn: number; expiresAt?: string; method?: "PUT"; mode: string };
type CompletedUpload = { video: { id: string; project_id: string; filename: string; storage_key: string } };
type CreatedJob = { job: { id: string; status: string; type: string } };

function contentTypeFor(file: File) {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mov") return "video/quicktime";
  if (extension === "mkv") return "video/x-matroska";
  if (extension === "webm") return "video/webm";
  return "video/mp4";
}

function uploadToSignedUrl(file: File, signed: SignedUpload, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    if (!signed.uploadUrl) {
      reject(new Error("The API could not create a signed R2 upload URL. Check the server-side R2 environment on the VPS."));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(signed.method ?? "PUT", signed.uploadUrl);
    xhr.setRequestHeader("Content-Type", contentTypeFor(file));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
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
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Choose a video file to start.");
  const [projectUrl, setProjectUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authedApiFetch<{ projects: DashboardProject[] }>("/projects")
      .then((response) => setProjects(response.projects))
      .catch(() => setStatus("Sign in to load existing projects, or create a new project during upload."));
  }, []);

  async function resolveProject(fileToUpload: File) {
    if (selectedProjectId !== "new") {
      const existing = projects.find((project) => project.id === selectedProjectId);
      return { project: { id: selectedProjectId, title: existing?.title ?? "Selected project", status: existing?.status ?? "draft" } } satisfies CreatedProject;
    }

    return authedApiFetch<CreatedProject>("/projects", {
      method: "POST",
      body: JSON.stringify({ title: title || fileToUpload.name.replace(/\.[^.]+$/, "") }),
    });
  }

  async function startUpload() {
    if (!file) { setStatus("Select an mp4, mov, mkv, or webm file first."); return; }
    setBusy(true);
    setProgress(0);
    setProjectUrl("");

    try {
      await getAccessToken();
      setStatus(selectedProjectId === "new" ? "Creating project..." : "Preparing selected project...");
      const created = await resolveProject(file);
      const contentType = contentTypeFor(file);

      setStatus("Requesting signed R2 upload URL...");
      const signed = await authedApiFetch<SignedUpload>("/uploads/create-signed-url", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType }),
      });

      setStatus("Uploading directly to Cloudflare R2...");
      await uploadToSignedUrl(file, signed, setProgress);

      setStatus("Saving video record...");
      const completed = await authedApiFetch<CompletedUpload>("/uploads/complete", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType, storageKey: signed.key, sizeBytes: file.size }),
      });

      setStatus("Creating initial analyze job...");
      const job = await authedApiFetch<CreatedJob>("/jobs/analyze", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, videoId: completed.video.id }),
      });

      setStatus(`Upload complete. ${file.name} is saved and analyze job ${job.job.id} is ${job.job.status}.`);
      setProjectUrl(`/projects/${created.project.id}/overview`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

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
        <p className="muted">After upload, VideoBlitzer stores the video record in Supabase and queues analysis. R2 credentials stay on the API server.</p>
        <button className="button" onClick={startUpload} disabled={busy}>{busy ? "Uploading..." : "Upload Existing Video"}</button>
        <p className="muted">{status}</p>
        <div className="card"><strong>{progress}% uploaded</strong><div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}><div style={{ width: `${progress}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} /></div></div>
        {projectUrl && <p><a className="button secondary" href={projectUrl}>Open project workspace</a></p>}
      </div>
      <div className="card"><h3>Record New Match</h3><p className="muted">Coming desktop app. Use replay buffers, hotkeys, and separate tracks, then upload to the dashboard.</p><button className="button secondary">Coming Desktop App</button></div>
    </div>
  </section>;
}
