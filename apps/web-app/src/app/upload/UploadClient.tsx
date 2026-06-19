"use client";
import { useEffect, useState } from "react";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { apiFetch } from "../../lib/api";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../lib/auth";
import type { DashboardProject } from "../../lib/types";

type CreatedProject = { project: { id: string; title: string; status: string } };
type SignedUpload = { key: string; uploadUrl: string | null; expiresIn: number; expiresAt?: string; method?: "PUT"; mode: string };
type ExistingPackageJob = { id?: string; status?: string; package_variant?: string; artifact_object_key?: string | null; created_at?: string; completed_at?: string; input?: Record<string, unknown> };
type DuplicateSummary = {
  originalVideo?: Record<string, unknown>;
  originalProject?: { id?: string; title?: string; created_at?: string } | null;
  packageCount: number;
  completedPackageCount: number;
  availablePackageTypes: string[];
  lastPackageCreatedAt: string | null;
  packageJobs?: ExistingPackageJob[];
};
type CompletedUpload = { video: { id: string; project_id: string; filename: string; storage_key: string; has_video?: boolean; has_audio?: boolean; duration_seconds?: number | null; width?: number | null; height?: number | null; video_codec?: string | null; audio_codec?: string | null; duplicate_of_video_id?: string | null }; duplicate?: DuplicateSummary | null };
type PackageMode = "fast" | "high_quality";
type PackageVariant = "standard_highlights" | "high_energy" | "coach_review" | "player_highlight" | "tiktok_first" | "instagram_reels" | "youtube_shorts" | "defensive_plays" | "offensive_plays" | "custom";
type PackageJobResponse = { job_id: string; status: string };
type PackageJob = { id?: string; status?: string; stage?: string; progress?: number; error_message?: string; artifact_object_key?: string | null; created_at?: string; output?: Record<string, unknown> };
type PackageStatusResponse = { packageJob: PackageJob; assets?: Array<Record<string, unknown>> };
type PackageOptions = {
  includeMaster: boolean;
  includeGoalClips: boolean;
  includeKeyMoments: boolean;
  useMatchData: boolean;
  includeCaptions: boolean;
  burnCaptions: boolean;
  subtleZoom: boolean;
  voiceModulation: boolean;
  outputs: Array<"vertical" | "landscape" | "square">;
  goalRunupSeconds: number;
  videoKickoffSecond: number;
  secondHalfKickoffSecond?: number;
  matchLookup?: { teamA?: string; teamB?: string; league?: string; matchDate?: string };
};
type MatchTimelineResponse = { events?: Array<Record<string, unknown>>; fixture?: unknown; stats?: unknown; outputs?: unknown; warning?: string | null; provider?: string; attribution?: string; complianceNote?: string };
type DuplicateStatusResponse = {
  duplicateDetected?: boolean;
  duplicateOfVideoId?: string | null;
  originalProject?: DuplicateSummary["originalProject"];
  originalVideo?: Record<string, unknown>;
  packageCount?: number;
  completedPackageCount?: number;
  availablePackageTypes?: string[];
  lastPackageCreatedAt?: string | null;
  packageJobs?: ExistingPackageJob[];
};
type UploadState = "idle" | "preparing" | "uploading" | "verifying" | "complete" | "failed" | "skipped";
type UploadProgress = { percent: number; loadedBytes: number; totalBytes: number; speedBytesPerSecond: number; etaSeconds: number | null; state: UploadState };
type UploadedVideoState = CompletedUpload["video"] & { project_id: string };
type UploadVerificationResponse = { media?: { has_audio?: boolean; has_video?: boolean; audio_codec?: string | null; video_codec?: string | null } };
type SavedUploadSession = {
  savedAt: string;
  projectUrl: string;
  uploadedVideo: UploadedVideoState;
  packageJob?: PackageJob | null;
  duplicate?: DuplicateSummary | null;
  status?: string;
  packageStatus?: string;
};
type ArchivedUploadSession = SavedUploadSession & {
  archiveId: string;
  label: string;
};

const savedUploadSessionKey = "videoblitzer.upload.resume.v1";
const archivedUploadSessionsKey = "videoblitzer.upload.archives.v1";
const defaultPackageOptions: PackageOptions = {
  includeMaster: false,
  includeGoalClips: true,
  includeKeyMoments: true,
  useMatchData: true,
  includeCaptions: true,
  burnCaptions: true,
  subtleZoom: true,
  voiceModulation: true,
  outputs: ["landscape", "vertical"],
  goalRunupSeconds: 120,
  videoKickoffSecond: 0,
};

const packageStages = [
  { key: "queued", label: "Queued", start: 0, end: 15 },
  { key: "download_source", label: "Downloading source media", start: 15, end: 25 },
  { key: "normalize_master", label: "Merging and normalizing media", start: 25, end: 40 },
  { key: "analyze", label: "Detecting highlights", start: 40, end: 55 },
  { key: "final_edit", label: "Building condensed final video", start: 50, end: 55 },
  { key: "rendering_clips", label: "Building 9:16 goal reel", start: 55, end: 70 },
  { key: "preset_exports", label: "Rendering final videos", start: 70, end: 82 },
  { key: "validating_assets", label: "Validating generated assets", start: 82, end: 90 },
  { key: "building_zip", label: "Building ZIP package", start: 90, end: 100 },
  { key: "completed", label: "Complete", start: 100, end: 100 },
];

const slowStageNotes: Record<string, string> = {
  normalize_master: "This is usually the slowest first step because FFmpeg is rebuilding the full master video and replacing/normalizing audio.",
  final_edit: "This creates the condensed final video from goals, key moments, and context sequences.",
  rendering_clips: "This creates the vertical goals reel, or missed-goals/big-chances reel if there are no goals.",
  preset_exports: "This renders the 16:9 highlights video and the 9:16 reel.",
  building_zip: "Large packages take longer while files are collected and compressed.",
};

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

function stagePercent(stage: typeof packageStages[number], totalProgress: number) {
  if (totalProgress >= stage.end) return 100;
  if (totalProgress <= stage.start) return stage.key === "queued" && totalProgress > 0 ? 100 : 0;
  const width = Math.max(1, stage.end - stage.start);
  return Math.min(99, Math.max(1, Math.round(((totalProgress - stage.start) / width) * 100)));
}

function formatStageElapsed(value: unknown) {
  if (typeof value !== "string") return "";
  const startedAt = new Date(value).getTime();
  if (!Number.isFinite(startedAt)) return "";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function numberFromOutput(output: Record<string, unknown> | undefined, key: string) {
  const value = output?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function friendlyPackageError(error: unknown) {
  const message = error instanceof Error ? error.message : "Could not produce package.";
  if (message.toLowerCase() === "failed to fetch") return "Could not contact the API. Check deployment/network status, then try Produce Package again.";
  return message;
}

function isSameLocalFile(a: File | null, b: File | null) {
  return Boolean(a && b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified);
}

function isPackageWarning(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("audio only") || lower.includes("could not") || lower.includes("failed") || lower.includes("unavailable") || lower.includes("not available");
}

function loadSavedUploadSession() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(savedUploadSessionKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedUploadSession;
    if (!parsed.uploadedVideo?.id || !parsed.uploadedVideo.project_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveUploadSession(session: SavedUploadSession | null) {
  if (typeof window === "undefined") return;
  if (!session) {
    window.localStorage.removeItem(savedUploadSessionKey);
    return;
  }
  window.localStorage.setItem(savedUploadSessionKey, JSON.stringify({ ...session, savedAt: new Date().toISOString() }));
}

function loadArchivedUploadSessions() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(archivedUploadSessionsKey);
    const parsed = raw ? JSON.parse(raw) as ArchivedUploadSession[] : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item.archiveId && item.uploadedVideo?.id).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function saveArchivedUploadSessions(sessions: ArchivedUploadSession[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(archivedUploadSessionsKey, JSON.stringify(sessions.slice(0, 20)));
}

function archiveUploadSession(session: SavedUploadSession) {
  const archive: ArchivedUploadSession = {
    ...session,
    archiveId: `${Date.now()}-${session.uploadedVideo.id}`,
    savedAt: new Date().toISOString(),
    label: `${session.uploadedVideo.filename ?? "Uploaded video"} · ${session.packageJob?.status ?? "saved"}`,
  };
  const existing = loadArchivedUploadSessions().filter((item) => item.uploadedVideo.id !== session.uploadedVideo.id || item.packageJob?.id !== session.packageJob?.id);
  const next = [archive, ...existing].slice(0, 20);
  saveArchivedUploadSessions(next);
  return next;
}

function duplicateFromStatus(response: DuplicateStatusResponse): DuplicateSummary | null {
  if (!response.duplicateDetected) return null;
  return {
    originalVideo: response.originalVideo,
    originalProject: response.originalProject ?? null,
    packageCount: response.packageCount ?? 0,
    completedPackageCount: response.completedPackageCount ?? 0,
    availablePackageTypes: response.availablePackageTypes ?? [],
    lastPackageCreatedAt: response.lastPackageCreatedAt ?? null,
    packageJobs: response.packageJobs ?? [],
  };
}

function openDownloadUrl(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.download = "videoblitzer-package.zip";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function PackageProgressPanel({ job, onDownload, downloadBusy }: { job: PackageJob | null; onDownload: () => void; downloadBusy: boolean }) {
  const stage = String(job?.status === "completed" ? "completed" : job?.stage ?? job?.output?.stage ?? "queued");
  const progress = Math.min(100, Math.max(0, Number(job?.progress ?? 0)));
  const activeIndex = Math.max(0, packageStages.findIndex((item) => item.key === stage || (stage === "completed" && item.key === "completed")));
  const statusClass = job?.status === "failed" ? "warning" : job?.status === "completed" ? "status" : "muted";
  const elapsed = formatStageElapsed(job?.output?.stageUpdatedAt);
  const totalElapsed = formatStageElapsed(job?.created_at ?? job?.output?.stageUpdatedAt);
  const activeStageProgress = numberFromOutput(job?.output, "stageProgressPercent");
  const itemLabel = typeof job?.output?.itemLabel === "string" ? job.output.itemLabel : "";
  const itemIndex = numberFromOutput(job?.output, "itemIndex");
  const itemTotal = numberFromOutput(job?.output, "itemTotal");
  const note = slowStageNotes[stage];
  return <div className="card">
    <h3>Package Progress</h3>
    <p className="muted">Total time passed: {totalElapsed || "not started"}</p>
    <p className={statusClass}>{job?.status ?? "not started"} · {stage.replaceAll("_", " ")} · {progress}%{elapsed ? ` · running ${elapsed}` : ""}</p>
    {activeStageProgress !== null && job?.status === "processing" && <p className="status">Current step: {activeStageProgress}%{itemLabel ? ` · ${itemLabel}` : ""}{itemIndex && itemTotal ? ` (${itemIndex}/${itemTotal})` : ""}</p>}
    {note && job?.status === "processing" && <p className="muted">{note}</p>}
    <div style={{ height: 10, background: "rgba(255,255,255,.1)", borderRadius: 999 }}>
      <div style={{ width: `${progress}%`, height: 10, background: "var(--accent)", borderRadius: 999 }} />
    </div>
    <div className="grid grid-2">
      {packageStages.map((item, index) => {
        const reached = Boolean(job) && index <= activeIndex;
        const current = Boolean(job) && index === activeIndex && job?.status !== "completed";
        const itemProgress = job?.status === "completed" ? 100 : current && activeStageProgress !== null ? activeStageProgress : stagePercent(item, progress);
        return <p key={item.key} className={reached ? "status" : "muted"}>{reached ? "[x]" : "[ ]"} {current ? "Now: " : ""}{item.label} · {itemProgress}%</p>;
      })}
    </div>
    {job?.error_message && <p className="warning">{job.error_message}</p>}
    {job?.status === "completed" && <button className="button" disabled={downloadBusy} onClick={onDownload}>{downloadBusy ? "Opening..." : "Download Package ZIP"}</button>}
  </div>;
}

function DuplicateDetectedPanel({
  duplicate,
  onReuse,
  onAlternative,
  onCustom,
  busy,
}: {
  duplicate: DuplicateSummary;
  onReuse: () => void;
  onAlternative: (variant: PackageVariant) => void;
  onCustom: () => void;
  busy: boolean;
}) {
  const completedJob = duplicate.packageJobs?.find((job) => job.status === "completed" && job.artifact_object_key);
  const originalProjectId = duplicate.originalProject?.id;
  return <div className="card">
    <h3>Duplicate Detected</h3>
    <p className="status">This video appears to match a previous upload.</p>
    <p className="muted">This video was already uploaded{duplicate.originalProject?.created_at ? ` on ${new Date(duplicate.originalProject.created_at).toLocaleDateString()}` : ""}. You can reuse the existing package or create a new version with a different style.</p>
    <p><strong>Original project:</strong> {duplicate.originalProject?.title ?? "Previous project"}</p>
    <p className="muted">Packages: {duplicate.packageCount} total · {duplicate.completedPackageCount} completed · Last package: {duplicate.lastPackageCreatedAt ? new Date(duplicate.lastPackageCreatedAt).toLocaleString() : "none yet"}</p>
    <p className="muted">Available package types: {duplicate.availablePackageTypes.length ? duplicate.availablePackageTypes.map((item) => item.replaceAll("_", " ")).join(", ") : "none yet"}</p>
    <p className="muted">Alternative packages reuse the existing analysis, so they process faster.</p>
    <button className="button" disabled={busy || !completedJob?.id} onClick={onReuse}>Reuse Existing Package</button>
    <button className="button secondary" disabled={busy} onClick={() => onAlternative("high_energy")}>Create Alternative Package</button>
    <button className="button secondary" disabled={busy} onClick={onCustom}>Create Custom Package</button>
    {originalProjectId && <a className="button secondary" href={`/projects/${originalProjectId}/social-production`}>Open Original Project</a>}
    {!completedJob?.id && <p className="warning">No completed package exists yet, but you can create an alternative or custom package from the saved analysis when available.</p>}
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
  const [duplicate, setDuplicate] = useState<DuplicateSummary | null>(null);
  const [packageJob, setPackageJob] = useState<PackageJob | null>(null);
  const [packageStatus, setPackageStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthState>("loading");
  const [archivedSessions, setArchivedSessions] = useState<ArchivedUploadSession[]>([]);
  const [packageOptions, setPackageOptions] = useState<PackageOptions>(defaultPackageOptions);
  const [matchTeamA, setMatchTeamA] = useState("");
  const [matchTeamB, setMatchTeamB] = useState("");
  const [matchLeague, setMatchLeague] = useState("");
  const [matchDate, setMatchDate] = useState("");
  const auth = useAuthSession();

  function persistCurrentSession(patch: Partial<SavedUploadSession> = {}) {
    const video = patch.uploadedVideo ?? uploadedVideo;
    if (!video) return;
    saveUploadSession({
      savedAt: new Date().toISOString(),
      projectUrl: patch.projectUrl ?? (projectUrl || `/projects/${video.project_id}/social-production`),
      uploadedVideo: video,
      packageJob: patch.packageJob !== undefined ? patch.packageJob : packageJob,
      duplicate: patch.duplicate !== undefined ? patch.duplicate : duplicate,
      status: patch.status ?? status,
      packageStatus: patch.packageStatus ?? packageStatus,
    });
  }

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
    setArchivedSessions(loadArchivedUploadSessions());
  }, [auth.email, auth.session?.access_token, auth.status]);

  useEffect(() => {
    if (auth.status !== "authenticated" || !auth.session?.access_token || uploadedVideo) return;
    const saved = loadSavedUploadSession();
    if (!saved) return;
    setUploadedVideo(saved.uploadedVideo);
    setProjectUrl(saved.projectUrl || `/projects/${saved.uploadedVideo.project_id}/social-production`);
    setPackageJob(saved.packageJob ?? null);
    setDuplicate(saved.duplicate ?? null);
    setProgress((current) => ({ ...current, percent: 100, state: "complete" }));
    setStatus(saved.status || "Restored your saved upload. You can continue package production.");
    setPackageStatus(saved.packageStatus || "Restored saved package state.");
    void refreshDuplicateStatus(saved.uploadedVideo.id).catch(() => undefined);
    if (saved.packageJob?.id) void refreshPackageJob(saved.packageJob.id).catch(() => undefined);
  }, [auth.session?.access_token, auth.status, uploadedVideo]);

  useEffect(() => {
    if (!auth.session?.access_token || !packageJob?.id || ["completed", "failed"].includes(String(packageJob.status))) return;
    const timer = window.setInterval(() => {
      void refreshPackageJob(packageJob.id!);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [auth.session?.access_token, packageJob?.id, packageJob?.status]);

  useEffect(() => {
    if (!uploadedVideo) return;
    persistCurrentSession();
  }, [uploadedVideo, duplicate, packageJob?.id, packageJob?.status, packageJob?.progress, packageJob?.stage, packageStatus, projectUrl, status]);

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
    if (isSameLocalFile(file, audioFile)) {
      setAudioFile(null);
      setAudioProgress({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "skipped" });
      setStatus("The optional audio file must be a separate audio track, not the same file as the video. I removed it; click Upload Existing Video again.");
      return;
    }
    setBusy(true);
    setProgress({ percent: 0, loadedBytes: 0, totalBytes: file.size, speedBytesPerSecond: 0, etaSeconds: null, state: "preparing" });
    setAudioProgress({ percent: 0, loadedBytes: 0, totalBytes: audioFile?.size ?? 0, speedBytesPerSecond: 0, etaSeconds: null, state: audioFile ? "preparing" : "idle" });
    setProjectUrl("");
    setUploadedVideo(null);
    setDuplicate(null);
    setPackageJob(null);
    setPackageStatus("");
    saveUploadSession(null);

    try {
      if (!auth.session?.access_token) throw new Error("Checking your sign-in. Try again in a moment.");
      const accessToken = auth.session.access_token;
      setProgress((current) => ({ ...current, state: "preparing" }));
      setStatus(selectedProjectId === "new" ? "Creating project..." : "Preparing selected project...");
      const created = await resolveProject(file);
      const contentType = contentTypeForVideo(file);
      const audioContentType = audioFile ? contentTypeForAudio(audioFile) : null;

      setStatus("Requesting signed R2 upload URL...");
      const signed = await apiFetch<SignedUpload>("/uploads/create-signed-url", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: file.name, contentType }),
      }, accessToken);
      const signedAudio = audioFile && audioContentType ? await apiFetch<SignedUpload>("/uploads/create-signed-url", {
        method: "POST",
        body: JSON.stringify({ projectId: created.project.id, filename: audioFile.name, contentType: audioContentType }),
      }, accessToken) : null;

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
      }, accessToken);
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
      const completeUpload = (includeAudioSource: boolean) => apiFetch<CompletedUpload>("/uploads/complete", {
        method: "POST",
        body: JSON.stringify({
          projectId: created.project.id,
          filename: file.name,
          contentType,
          storageKey: signed.key,
          sizeBytes: file.size,
          audio_source: includeAudioSource && audioFile && signedAudio && audioContentType ? {
            object_key: signedAudio.key,
            filename: audioFile.name,
            content_type: audioContentType,
            size_bytes: audioFile.size,
          } : undefined,
        }),
      }, accessToken);
      let audioSourceSkipped = false;
      let completed: CompletedUpload;
      try {
        completed = await completeUpload(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!message.includes("audio_sidecar_missing_audio")) throw error;
        setStatus("Optional audio did not contain an audio stream, so VideoBlitzer is saving the video without that sidecar.");
        audioSourceSkipped = true;
        completed = await completeUpload(false);
      }

      setProgress((current) => ({ ...current, state: "complete" }));
      if (audioFile) setAudioProgress((current) => ({ ...current, state: audioSourceSkipped ? "skipped" : "complete" }));
      setUploadedVideo(completed.video);
      setDuplicate(completed.duplicate ?? null);
      const audioSkipNote = audioSourceSkipped ? " Optional audio was ignored because it had no audio stream." : "";
      const nextStatus = completed.duplicate ? `This video appears to match a previous upload.${audioSkipNote}` : completed.video.has_video === true ? `Upload verified. Ready to produce package.${audioSkipNote}` : "This file contains audio only. Social media video packages require a video stream.";
      const nextProjectUrl = `/projects/${created.project.id}/social-production`;
      setStatus(nextStatus);
      setProjectUrl(nextProjectUrl);
      saveUploadSession({
        savedAt: new Date().toISOString(),
        projectUrl: nextProjectUrl,
        uploadedVideo: completed.video,
        packageJob: null,
        duplicate: completed.duplicate ?? null,
        status: nextStatus,
        packageStatus: "",
      });
    } catch (error) {
      setProgress((current) => ({ ...current, state: "failed" }));
      if (audioFile) setAudioProgress((current) => ({ ...current, state: "failed" }));
      setStatus(error instanceof Error ? error.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function toggleOutput(output: PackageOptions["outputs"][number], checked: boolean) {
    setPackageOptions((current) => {
      const outputs = checked ? [...new Set([...current.outputs, output])] : current.outputs.filter((item) => item !== output);
      return { ...current, outputs: outputs.length ? outputs : current.outputs };
    });
  }

  function buildPackageOptions(): PackageOptions {
    const matchLookup = {
      teamA: matchTeamA.trim() || undefined,
      teamB: matchTeamB.trim() || undefined,
      league: matchLeague.trim() || undefined,
      matchDate: matchDate || undefined,
    };
    return {
      ...packageOptions,
      goalRunupSeconds: Math.max(60, Number(packageOptions.goalRunupSeconds) || 75),
      videoKickoffSecond: Math.max(0, Number(packageOptions.videoKickoffSecond) || 0),
      secondHalfKickoffSecond: packageOptions.secondHalfKickoffSecond === undefined ? undefined : Math.max(0, Number(packageOptions.secondHalfKickoffSecond) || 0),
      matchLookup: matchLookup.teamA && matchLookup.teamB && matchLookup.matchDate ? matchLookup : undefined,
    };
  }

  async function confirmMatchDataForPackage(projectId: string, options: PackageOptions) {
    if (!auth.session?.access_token || !options.useMatchData || !options.matchLookup) return null;
    setPackageStatus("Retrieving match timeline before queueing package...");
    const timeline = await apiFetch<MatchTimelineResponse>("/match-intelligence/timeline", {
      method: "POST",
      body: JSON.stringify({
        sport: "Soccer",
        provider: "API-Football",
        teamA: options.matchLookup.teamA,
        teamB: options.matchLookup.teamB,
        league: options.matchLookup.league,
        matchDate: options.matchLookup.matchDate,
      }),
    }, auth.session.access_token);
    if (!timeline.events?.length) {
      setPackageStatus(timeline.warning || "No provider match events found. The worker will use any confirmed match data already saved, then fallback candidates.");
      return timeline;
    }
    await apiFetch("/match-data/confirm", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        data: {
          source: "upload_package_options",
          provider: timeline.provider,
          attribution: timeline.attribution,
          complianceNote: timeline.complianceNote,
          fixture: timeline.fixture,
          stats: timeline.stats,
          events: timeline.events,
          outputs: timeline.outputs,
          matchLookup: options.matchLookup,
          confirmedAt: new Date().toISOString(),
        },
      }),
    }, auth.session.access_token);
    setPackageStatus(`Confirmed ${timeline.events.length} match events for clipping.`);
    return timeline;
  }

  async function producePackage(packageMode: PackageMode) {
    if (!auth.session?.access_token || !uploadedVideo) return;
    setPackageBusy(true);
    setPackageStatus("");
    try {
      const options = buildPackageOptions();
      await confirmMatchDataForPackage(uploadedVideo.project_id, options);
      const response = await apiFetch<PackageJobResponse>("/packages/generate", {
        method: "POST",
        body: JSON.stringify({ projectId: uploadedVideo.project_id, videoId: uploadedVideo.id, packageMode, packageOptions: options }),
      }, auth.session.access_token);
      setPackageJob({ id: response.job_id, status: response.status, stage: "queued", progress: 0 });
      setPackageStatus(`${packageMode === "fast" ? "Fast Package" : "High Quality Package"} queued: ${response.job_id}. Processing has started.`);
      persistCurrentSession({ packageJob: { id: response.job_id, status: response.status, stage: "queued", progress: 0 }, packageStatus: `${packageMode === "fast" ? "Fast Package" : "High Quality Package"} queued: ${response.job_id}. Processing has started.` });
      await refreshPackageJob(response.job_id).catch(() => undefined);
    } catch (error) {
      setPackageStatus(friendlyPackageError(error));
    } finally {
      setPackageBusy(false);
    }
  }

  async function reuseExistingPackage() {
    if (!auth.session?.access_token || !duplicate) return;
    const completedJob = duplicate.packageJobs?.find((job) => job.status === "completed" && job.artifact_object_key);
    if (!completedJob?.id) {
      setPackageStatus("No completed package is available to reuse yet.");
      return;
    }
    setPackageBusy(true);
    try {
      const response = await apiFetch<{ downloadUrl?: string | null; packageJob?: PackageJob }>(`/packages/${completedJob.id}/reuse`, { method: "POST" }, auth.session.access_token);
      if (response.packageJob) setPackageJob(response.packageJob);
      if (response.downloadUrl) openDownloadUrl(response.downloadUrl);
      setPackageStatus("Reused existing package. No package credits charged. Large ZIP downloads may show as .crdownload until Chrome finishes.");
    } catch (error) {
      setPackageStatus(friendlyPackageError(error));
    } finally {
      setPackageBusy(false);
    }
  }

  async function createAlternativePackage(variant: PackageVariant) {
    if (!auth.session?.access_token || !uploadedVideo) return;
    setPackageBusy(true);
    try {
      const options = buildPackageOptions();
      await confirmMatchDataForPackage(uploadedVideo.project_id, options);
      const response = await apiFetch<PackageJobResponse>("/packages/generate-alternative", {
        method: "POST",
        body: JSON.stringify({ projectId: uploadedVideo.project_id, videoId: uploadedVideo.id, packageMode: "fast", packageVariant: variant, packageOptions: options }),
      }, auth.session.access_token);
      setPackageJob({ id: response.job_id, status: response.status, stage: "queued", progress: 0 });
      setPackageStatus(`Alternative package queued: ${response.job_id}. It will reuse saved analysis when available.`);
      persistCurrentSession({ packageJob: { id: response.job_id, status: response.status, stage: "queued", progress: 0 }, packageStatus: `Alternative package queued: ${response.job_id}. It will reuse saved analysis when available.` });
    } catch (error) {
      setPackageStatus(friendlyPackageError(error));
    } finally {
      setPackageBusy(false);
    }
  }

  async function createCustomPackage() {
    if (!auth.session?.access_token || !uploadedVideo) return;
    setPackageBusy(true);
    try {
      const options = buildPackageOptions();
      await confirmMatchDataForPackage(uploadedVideo.project_id, options);
      const response = await apiFetch<PackageJobResponse>("/packages/generate-custom", {
        method: "POST",
        body: JSON.stringify({
          projectId: uploadedVideo.project_id,
          videoId: uploadedVideo.id,
          packageMode: "fast",
          packageOptions: {
            ...options,
            targetPlatform: options.outputs.join(", "),
            tonePreset: "high_energy",
            clipDurationPreference: "short",
            numberOfClips: 8,
            includeCaptions: options.includeCaptions,
            focusType: "big_plays",
          },
        }),
      }, auth.session.access_token);
      setPackageJob({ id: response.job_id, status: response.status, stage: "queued", progress: 0 });
      setPackageStatus(`Custom package queued: ${response.job_id}. It will reuse saved analysis when available.`);
      persistCurrentSession({ packageJob: { id: response.job_id, status: response.status, stage: "queued", progress: 0 }, packageStatus: `Custom package queued: ${response.job_id}. It will reuse saved analysis when available.` });
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

  async function refreshDuplicateStatus(videoId: string) {
    if (!auth.session?.access_token) return;
    const response = await apiFetch<DuplicateStatusResponse>(`/videos/${videoId}/duplicate-status`, {}, auth.session.access_token);
    setDuplicate(duplicateFromStatus(response));
  }

  function restoreSavedSession(session: SavedUploadSession) {
    setUploadedVideo(session.uploadedVideo);
    setProjectUrl(session.projectUrl || `/projects/${session.uploadedVideo.project_id}/social-production`);
    setPackageJob(session.packageJob ?? null);
    setDuplicate(session.duplicate ?? null);
    setProgress((current) => ({ ...current, percent: 100, state: "complete" }));
    setStatus(session.status || "Restored archived work. You can continue from here.");
    setPackageStatus(session.packageStatus || "Restored saved package state.");
    saveUploadSession(session);
    void refreshDuplicateStatus(session.uploadedVideo.id).catch(() => undefined);
    if (session.packageJob?.id) void refreshPackageJob(session.packageJob.id).catch(() => undefined);
  }

  function clearCurrentWork() {
    const saved = uploadedVideo ? {
      savedAt: new Date().toISOString(),
      projectUrl: projectUrl || `/projects/${uploadedVideo.project_id}/social-production`,
      uploadedVideo,
      packageJob,
      duplicate,
      status,
      packageStatus,
    } satisfies SavedUploadSession : loadSavedUploadSession();
    const shouldClear = window.confirm("Clear this page's current upload/package state? VideoBlitzer will archive it first, and the server project/package will not be deleted.");
    if (!shouldClear) return;
    if (saved) setArchivedSessions(archiveUploadSession(saved));
    saveUploadSession(null);
    setUploadedVideo(null);
    setDuplicate(null);
    setPackageJob(null);
    setPackageStatus("");
    setProjectUrl("");
    setProgress({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "idle" });
    setAudioProgress({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "idle" });
    setStatus(saved ? "Cleared this page and archived the work below. You can restore it anytime." : "Cleared this page.");
  }

  function removeArchivedSession(archiveId: string) {
    const next = archivedSessions.filter((session) => session.archiveId !== archiveId);
    saveArchivedUploadSessions(next);
    setArchivedSessions(next);
  }

  async function downloadPackageZip() {
    if (!auth.session?.access_token || !packageJob?.id) return;
    setDownloadBusy(true);
    try {
      const response = await apiFetch<{ downloadUrl: string | null }>(`/packages/${packageJob.id}/download`, {}, auth.session.access_token);
      if (!response.downloadUrl) throw new Error("Package ZIP is not available yet.");
      openDownloadUrl(response.downloadUrl);
      setPackageStatus("Download started. Large ZIP files can show as .crdownload until Chrome finishes. If it stops, click Download Package ZIP again.");
    } catch (error) {
      setPackageStatus(friendlyPackageError(error));
    } finally {
      setDownloadBusy(false);
    }
  }

  function renderPackageOptionsPanel() {
    return <div className="card">
      <h3>Package Options</h3>
      <p className="muted">Package output is fixed: one 16:9 highlights edit and one 9:16 goals/big-chance reel. If separate audio was uploaded, the merged master is added automatically.</p>
      <label><input type="checkbox" checked={packageOptions.useMatchData} onChange={(event) => setPackageOptions((current) => ({ ...current, useMatchData: event.target.checked }))} /> Use match data for clip timing</label><br />
      <label><input type="checkbox" checked={packageOptions.includeGoalClips} onChange={(event) => setPackageOptions((current) => ({ ...current, includeGoalClips: event.target.checked }))} /> Goal clips with buildup</label><br />
      <label><input type="checkbox" checked={packageOptions.includeKeyMoments} onChange={(event) => setPackageOptions((current) => ({ ...current, includeKeyMoments: event.target.checked }))} /> Other key moments</label><br />
      <label><input type="checkbox" checked={packageOptions.includeCaptions} onChange={(event) => setPackageOptions((current) => ({ ...current, includeCaptions: event.target.checked, burnCaptions: event.target.checked ? current.burnCaptions : false }))} /> Captions</label><br />
      <label><input type="checkbox" checked={packageOptions.burnCaptions} disabled={!packageOptions.includeCaptions} onChange={(event) => setPackageOptions((current) => ({ ...current, burnCaptions: event.target.checked }))} /> Burn captions into clips</label><br />
      <label><input type="checkbox" checked={packageOptions.subtleZoom} onChange={(event) => setPackageOptions((current) => ({ ...current, subtleZoom: event.target.checked }))} /> Subtle zoom/crop</label><br />
      <label><input type="checkbox" checked={packageOptions.voiceModulation} onChange={(event) => setPackageOptions((current) => ({ ...current, voiceModulation: event.target.checked }))} /> Light voice modulation</label>
      <br /><br />
      <label>Goal buildup seconds</label>
      <input className="input" type="number" min={60} value={packageOptions.goalRunupSeconds} onChange={(event) => setPackageOptions((current) => ({ ...current, goalRunupSeconds: Number(event.target.value) }))} />
      <br /><br />
      <label>Match lookup for event timing</label>
      <div className="grid grid-2">
        <input className="input" value={matchTeamA} onChange={(event) => setMatchTeamA(event.target.value)} placeholder="Team A" />
        <input className="input" value={matchTeamB} onChange={(event) => setMatchTeamB(event.target.value)} placeholder="Team B" />
        <input className="input" value={matchLeague} onChange={(event) => setMatchLeague(event.target.value)} placeholder="League (optional)" />
        <input className="input" type="date" value={matchDate} onChange={(event) => setMatchDate(event.target.value)} />
      </div>
      <br />
      <label>Video kickoff second</label>
      <input className="input" type="number" min={0} value={packageOptions.videoKickoffSecond} onChange={(event) => setPackageOptions((current) => ({ ...current, videoKickoffSecond: Number(event.target.value) }))} />
      <p className="muted">If the video starts before kickoff, set the video second where match time 0:00 begins. Add match teams/date to fetch factual event minutes before package creation.</p>
    </div>;
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
        <input className="input" type="file" accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={(event) => {
          const nextFile = event.target.files?.[0] ?? null;
          setFile(nextFile);
          if (isSameLocalFile(nextFile, audioFile)) {
            setAudioFile(null);
            setAudioProgress({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "skipped" });
            setStatus("Removed optional audio because it matched the selected video. Use this field only for a separate audio track.");
          }
        }} />
        {file && <p className="muted">Selected: {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
        <br /><br />
        <label>Optional separate audio file</label>
        <input className="input" type="file" accept=".mp3,.mp4,.wav,.m4a,.aac,.ogg,.flac,.webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/flac,audio/webm,video/mp4" onChange={(event) => {
          const nextAudioFile = event.target.files?.[0] ?? null;
          if (isSameLocalFile(file, nextAudioFile)) {
            event.currentTarget.value = "";
            setAudioFile(null);
            setAudioProgress({ percent: 0, loadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, state: "skipped" });
            setStatus("That is the same file as the video. Optional audio must be a separate audio track, so it was not attached.");
            return;
          }
          setAudioFile(nextAudioFile);
        }} />
        {audioFile && <p className="muted">Optional audio: {audioFile.name} · {(audioFile.size / 1024 / 1024).toFixed(1)} MB</p>}
        <p className="muted">After upload reaches 100%, VideoBlitzer verifies the video and optional audio objects before enabling package production. Optional audio is only for a separate audio track; if your video already has audio, leave this empty.</p>
        {audioFile && <p className="warning">If the video already contains audio, VideoBlitzer will ask before replacing it with this separate audio file.</p>}
        <button className="button" onClick={startUpload} disabled={busy}>{busy ? "Uploading..." : "Upload Existing Video"}</button>
        <p className={progress.state === "failed" ? "warning" : progress.state === "complete" ? "status" : "muted"}>{status}</p>
        {uploadedVideo && <p className="status">Saved. If the browser refreshes, this upload and package job will be restored here.</p>}
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
        {uploadedVideo && renderPackageOptionsPanel()}
        {uploadedVideo && duplicate && <DuplicateDetectedPanel duplicate={duplicate} busy={packageBusy} onReuse={() => void reuseExistingPackage()} onAlternative={(variant) => void createAlternativePackage(variant)} onCustom={() => void createCustomPackage()} />}
        {uploadedVideo && !duplicate && <div className="card">
          <h3>Produce Package</h3>
          {uploadedVideo.has_video === true
            ? <p className="status">Upload verified. Ready to produce package.</p>
            : <p className="warning">This file contains audio only. Social media video packages require a video stream.</p>}
          <p className="muted">Has video: {uploadedVideo.has_video === true ? "yes" : "no"} · Has audio: {uploadedVideo.has_audio === true ? "yes" : "no"}</p>
          {audioFile && <p className="status">Separate audio uploaded. The package worker will replace the video's original audio with this track before creating clips and exports.</p>}
          <p className="muted">Duration: {typeof uploadedVideo.duration_seconds === "number" ? `${uploadedVideo.duration_seconds.toFixed(1)}s` : "unknown"} · Resolution: {uploadedVideo.width && uploadedVideo.height ? `${uploadedVideo.width}x${uploadedVideo.height}` : "none"} · Codec: {uploadedVideo.video_codec ?? "no video"} / {uploadedVideo.audio_codec ?? "no audio"}</p>
          <button className="button" onClick={() => void producePackage("fast")} disabled={packageBusy || uploadedVideo.has_video !== true}>{packageBusy ? "Queueing..." : "Produce Fast Package"}</button>
          <button className="button secondary" onClick={() => void producePackage("high_quality")} disabled={packageBusy || uploadedVideo.has_video !== true}>High Quality Package</button>
          {projectUrl && <a className="button secondary" href={projectUrl}>Open Social Media Production</a>}
          {packageStatus && <p className={isPackageWarning(packageStatus) ? "warning" : "muted"}>{packageStatus}</p>}
        </div>}
      </div>
      <div className="card">
        <h3>Package Creation</h3>
        <p className="muted">After upload verification, click Produce Package and watch each processing stage here. Keep this page open to follow long game videos through ZIP creation.</p>
        {uploadedVideo && <p className="status">Current work is saved. You can refresh and continue from this package state.</p>}
        <PackageProgressPanel job={packageJob} onDownload={() => void downloadPackageZip()} downloadBusy={downloadBusy} />
        {projectUrl && <p><a className="button secondary" href={projectUrl}>Open Social Media Production</a></p>}
        {(uploadedVideo || packageJob) && <button className="button secondary" onClick={clearCurrentWork}>Clear Current Page State</button>}
        <p className="muted">Clear only resets this page. It archives the work first and does not delete the server project, video, package job, or ZIP.</p>
        <div className="card">
          <h3>Archived Work</h3>
          {archivedSessions.length ? archivedSessions.map((session) => <div className="card" key={session.archiveId}>
            <strong>{session.label}</strong>
            <p className="muted">Saved {new Date(session.savedAt).toLocaleString()} · Project {session.uploadedVideo.project_id.slice(0, 8)} · Package {session.packageJob?.id ? session.packageJob.id.slice(0, 8) : "not started"}</p>
            <button className="button secondary" onClick={() => restoreSavedSession(session)}>Restore Here</button>
            {session.projectUrl && <a className="button secondary" href={session.projectUrl}>Open Project</a>}
            <button className="button secondary" onClick={() => removeArchivedSession(session.archiveId)}>Remove Archive</button>
          </div>) : <p className="muted">No archived upload work in this browser yet.</p>}
        </div>
      </div>
    </div>
  </section>;
}
