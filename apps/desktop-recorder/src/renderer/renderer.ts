import type { RecorderSettings, RecorderSource, SaveRecordingResult, RecordingManifest, RecordingChunkRecord } from "../types";

const preferredMimes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const qualityBitrates = { standard: 5_000_000, high: 10_000_000, match: 15_000_000 } as const;

let sources: RecorderSource[] = [];
let selectedSource: RecorderSource | null = null;
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let startedAt = 0;
let timerInterval: number | undefined;
let lastBlob: Blob | null = null;
let savedFile: SaveRecordingResult | null = null;
let selectedMime = "video/webm";
let selectedMode = "browser";
let sourceFilter: "screen" | "window" | "browser" = "screen";
let markers: Array<{ time: string; label: string; note: string; seconds?: number; createdAt?: string }> = [];
let activeManifest: RecordingManifest | null = null;
let chunkIndex = 0;
let appVersion = "0.1.0";
let platformLabel = "unknown";
let combineVideoPath = "";
let combineAudioPath = "";
let activeUploadXhr: XMLHttpRequest | null = null;
interface MatchEvent { id: string; minute: number; stoppageMinute?: number; period: string; team?: string; player?: string; assistingPlayer?: string; eventType: string; description: string; source: string; confidence: string; importanceScore: number; ignored?: boolean; }
type HighlightLength = "5" | "15" | "25";
interface HighlightSegment { order: number; title: string; targetSeconds: number; matchMinute: string; sourceTimestamp: string; reason: string; voiceoverPrompt: string; captionIdea: string; }
interface HighlightPackage { highlightLength: HighlightLength; label: string; targetDurationSeconds: number; editOutline: string; segments: HighlightSegment[]; titleIdea: string; thumbnailPrompt: string; exportRecommendation: string; }
interface HighlightMoment { title: string; eventType: string; description: string; importanceScore: number; matchMinute: string; sourceTimestamp: string; reason: string; team?: string; player?: string; }
let matchEvents: MatchEvent[] = [];
let matchClockAtRecordingStartSeconds: number | null = null;
let selectedHighlightLength: HighlightLength = "15";
let renderedHighlightPackages: HighlightPackage[] = [];
const suggestedEventIds = new Set<string>();
let micMeterInterval: number | undefined;
let paused = false;
let settings: RecorderSettings = { apiUrl: "https://api.videoblitzer.com", rememberToken: false, quality: "standard", includeMicrophone: false, includeSystemAudio: false };

function el<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
function setText(id: string, text: string) { el(id).textContent = text; }
function setStatus(text: string) { setText("recordingStatus", text); }
function showElement(id: string, show: boolean) { el<HTMLElement>(id).style.display = show ? "" : "none"; }
function timestamp() {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function extensionForMime(mime: string) { return mime.startsWith("video/mp4") ? "mp4" : "webm"; }
function contentTypeForMime(mime: string) { return mime.startsWith("video/mp4") ? "video/mp4" : "video/webm"; }
function contentTypeForFilePath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  return "video/webm";
}
function rawFormatForContentType(contentType: string) {
  if (contentType === "video/mp4") return "mp4";
  if (contentType === "video/quicktime") return "mov";
  if (contentType === "video/x-matroska") return "mkv";
  return "webm";
}
function slug(value: string) { return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "VideoBlitzer"; }
function filenameForMime(mime: string) {
  const stamp = timestamp().slice(0, 16);
  if (selectedMode === "match") {
    const teamA = el<HTMLInputElement>("teamA").value.trim();
    const teamB = el<HTMLInputElement>("teamB").value.trim();
    const base = teamA && teamB ? `${slug(teamA)}_vs_${slug(teamB)}` : "VideoBlitzer_Match";
    return `${base}_${stamp}.${extensionForMime(mime)}`;
  }
  if (selectedMode === "browser") return `VideoBlitzer_ScreenCapture_${stamp}.${extensionForMime(mime)}`;
  return `VideoBlitzer_Recording_${stamp}.${extensionForMime(mime)}`;
}
function selectedToken() { return (el<HTMLTextAreaElement>("accessToken").value || "").trim(); }
function apiUrl() { return (el<HTMLInputElement>("apiUrl").value || "https://api.videoblitzer.com").replace(/\/$/, ""); }
function headers(token: string) { return { "Content-Type": "application/json", Authorization: `Bearer ${token}` }; }

function updateTimer() {
  if (!startedAt) { setText("timer", "00:00"); return; }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  checkMatchSuggestions(elapsed);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  setText("timer", `${minutes}:${seconds}`);
  setText("durationLabel", `${minutes}:${seconds}`);
}

function updateUploadProgress(value: number) {
  el<HTMLDivElement>("uploadBar").style.width = `${value}%`;
  setText("uploadPercent", `${value}%`);
}

function safeApiError(body: string, fallback: string) {
  try { return (JSON.parse(body) as { error?: string }).error ?? fallback; } catch { return body || fallback; }
}

function friendlyCaptureError(error: unknown) {
  const message = error instanceof Error ? error.message : "Could not start capture.";
  const lower = message.toLowerCase();
  if (lower.includes("not enough disk space")) return `${message} Free disk space before starting another capture.`;
  if (lower.includes("screen recording permission")) return message.replace("VideoBlitzer Recorder", "VideoBlitzer Screen Recorder");
  if (lower.includes("permission") || lower.includes("denied")) return "Capture permission was blocked. Grant Screen Recording permission for VideoBlitzer Screen Recorder, then restart the app and try again.";
  return message;
}

function friendlyUploadError(error: unknown) {
  const message = error instanceof Error ? error.message : "Upload failed.";
  if (message.toLowerCase().includes("insufficient credits")) return `${message} Ask an owner to add credits or retry with owner unlimited mode.`;
  if (message.toLowerCase().includes("conversion")) return `${message} The local recording is still saved; retry upload or check the project workspace for conversion status.`;
  return `${message} The local file is still saved. You can retry upload after fixing network, auth, or API issues.`;
}

async function api<T>(path: string, init: RequestInit = {}) {
  const token = selectedToken();
  if (!token) throw new Error("Paste a Supabase access token before uploading.");
  const response = await fetch(`${apiUrl()}${path}`, { ...init, headers: { ...headers(token), ...init.headers } });
  if (!response.ok) throw new Error(safeApiError(await response.text(), `API request failed with ${response.status}`));
  return response.json() as Promise<T>;
}

async function checkApi() {
  try {
    const response = await fetch(`${apiUrl()}/health`);
    setText("apiStatus", response.ok ? "API: online" : "API: unavailable");
  } catch { setText("apiStatus", "API: offline"); }
  const auth = el("authStatus");
  auth.textContent = selectedToken() ? "Auth: token ready" : "Auth: token required";
  auth.classList.toggle("success", Boolean(selectedToken()));
  auth.classList.toggle("warning", !selectedToken());
}

function configureMimeOptions() {
  const options = preferredMimes.filter((mime) => MediaRecorder.isTypeSupported(mime));
  if (MediaRecorder.isTypeSupported("video/mp4")) options.push("video/mp4 (experimental native)");
  const select = el<HTMLSelectElement>("mimeSelect");
  select.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.startsWith("video/mp4") ? "video/mp4" : option;
    node.textContent = option;
    select.appendChild(node);
  }
  selectedMime = options[0]?.startsWith("video/mp4") ? "video/mp4" : options[0] ?? "video/webm";
  select.value = selectedMime;
  setText("selectedMimeLabel", selectedMime);
  select.addEventListener("change", () => { selectedMime = select.value; setText("selectedMimeLabel", selectedMime); });
}

async function loadSettings() {
  settings = await window.videoBlitzerRecorder.getSettings();
  el<HTMLInputElement>("apiUrl").value = settings.apiUrl;
  el<HTMLTextAreaElement>("accessToken").value = settings.token ?? "";
  el<HTMLInputElement>("rememberToken").checked = settings.rememberToken;
  el<HTMLInputElement>("includeMic").checked = settings.includeMicrophone;
  el<HTMLInputElement>("systemAudioToggle").checked = Boolean(settings.includeSystemAudio);
  el<HTMLSelectElement>("quality").value = settings.quality;
  el<HTMLSelectElement>("resolution").value = settings.resolution ?? "source";
  el<HTMLSelectElement>("frameRate").value = String(settings.frameRate ?? 60);
  el<HTMLInputElement>("existingProjectId").value = settings.existingProjectId ?? "";
  if (settings.selectedMicDeviceId) el<HTMLSelectElement>("micSelect").value = settings.selectedMicDeviceId;
  updateAudioStatus();
  if (settings.outputFolder) setText("outputFolder", settings.outputFolder);
}

async function saveSettings() {
  settings = {
    apiUrl: apiUrl(),
    outputFolder: settings.outputFolder,
    rememberToken: el<HTMLInputElement>("rememberToken").checked,
    token: selectedToken(),
    quality: el<HTMLSelectElement>("quality").value as RecorderSettings["quality"],
    resolution: el<HTMLSelectElement>("resolution").value as RecorderSettings["resolution"],
    frameRate: Number(el<HTMLSelectElement>("frameRate").value) as RecorderSettings["frameRate"],
    includeMicrophone: el<HTMLInputElement>("includeMic").checked,
    includeSystemAudio: el<HTMLInputElement>("systemAudioToggle").checked,
    selectedMicDeviceId: el<HTMLSelectElement>("micSelect").value || undefined,
    existingProjectId: el<HTMLInputElement>("existingProjectId").value.trim() || undefined,
    autoUpload: false,
  };
  await window.videoBlitzerRecorder.saveSettings(settings);
  await checkApi();
}

async function refreshSources() {
  setStatus("Loading sources");
  sources = await window.videoBlitzerRecorder.getSources();
  const list = el<HTMLDivElement>("sources");
  list.innerHTML = "";
  const visibleSources = sources.filter((source) => sourceFilter === "browser" ? source.kind === "browser" : source.id.startsWith(sourceFilter));
  for (const source of visibleSources) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "source-card";
    if (source.kind === "browser") card.classList.add("browser-source");
    card.dataset.sourceId = source.id;
    card.innerHTML = `<img src="${source.thumbnail}" alt=""><strong>${source.name}</strong><br><small>${source.id}</small>`;
    card.addEventListener("click", () => selectSource(source));
    list.appendChild(card);
  }
  if (!visibleSources.length) list.innerHTML = `<div class="source-card"><strong>No ${sourceFilter === "screen" ? "screens" : sourceFilter === "browser" ? "browser windows" : "windows"} found</strong><small>Try refreshing sources or checking capture permissions.</small></div>`;
  const onlySource = visibleSources[0];
  if (visibleSources.length === 1 && onlySource) selectSource(onlySource);
  setStatus(visibleSources.length ? "Source selected" : "Idle");
}

function selectSource(source: RecorderSource) {
  selectedSource = source;
  setText("selectedSourceLabel", source.name);
  setText("sourceStatus", "Ready");
  setText("reviewSource", source.name);
  [...document.querySelectorAll(".source-card")].forEach((node) => node.classList.toggle("selected", (node as HTMLElement).dataset.sourceId === source.id));
  el<HTMLButtonElement>("startRecording").disabled = false;
  el("previewPlaceholder").textContent = "Source ready. Preview appears when recording starts.";
  setStatus("Source selected");
}

async function buildStream() {
  if (!selectedSource) throw new Error("Select a screen or window before recording.");
  const resolution = el<HTMLSelectElement>("resolution").value;
  const resolutionConstraints: Record<string, number> = resolution === "720p" ? { maxWidth: 1280, maxHeight: 720 } : resolution === "1080p" ? { maxWidth: 1920, maxHeight: 1080 } : resolution === "1440p" ? { maxWidth: 2560, maxHeight: 1440 } : resolution === "2160p" ? { maxWidth: 3840, maxHeight: 2160 } : {};
  const frameRate = Number(el<HTMLSelectElement>("frameRate").value) || 60;
  const videoConstraints = {
    audio: el<HTMLInputElement>("systemAudioToggle").checked ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSource.id } } : false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: selectedSource.id,
        maxFrameRate: frameRate,
        ...resolutionConstraints,
      },
    },
  } as unknown as MediaStreamConstraints;

  const displayStream = await navigator.mediaDevices.getUserMedia(videoConstraints).catch((error) => {
    if (navigator.userAgent.includes("Mac")) {
      throw new Error("Screen recording permission is required. Enable it in System Settings -> Privacy & Security -> Screen Recording, then restart VideoBlitzer Screen Recorder.");
    }
    throw new Error(`Could not capture the selected source: ${error instanceof Error ? error.message : "permission denied"}`);
  });

  const tracks = [...displayStream.getVideoTracks(), ...displayStream.getAudioTracks()];
  if (el<HTMLInputElement>("includeMic").checked) {
    try {
      const deviceId = el<HTMLSelectElement>("micSelect").value;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
      tracks.push(...mic.getAudioTracks());
    } catch {
      setText("uploadStatus", "Microphone permission was blocked or unavailable. Continuing with screen video only; enable microphone permission and retry if narration is required.");
    }
  }
  const finalStream = new MediaStream(tracks);
  const hasAudio = finalStream.getAudioTracks().length > 0;
  setText("systemAudioStatus", el<HTMLInputElement>("systemAudioToggle").checked ? (displayStream.getAudioTracks().length ? "System audio: detected" : "System audio: not detected") : "System audio: off");
  setText("audioStatus", hasAudio ? "Audio detected" : "No audio detected");
  if (!hasAudio) setText("micWarning", "No audio was detected. On macOS, use a source that exposes audio or a virtual audio device. On Windows, try full-screen capture or another source. You can continue video-only.");
  if (el<HTMLInputElement>("systemAudioToggle").checked && !displayStream.getAudioTracks().length && el<HTMLInputElement>("includeMic").checked) setText("micWarning", "Only microphone audio detected. System audio may be unavailable for this source, operating system, or protected content.");
  return finalStream;
}

async function startRecording() {
  try {
    if (!el<HTMLInputElement>("permissionConfirm").checked) throw new Error("Confirm that you are authorized to record this content before starting.");
    if (!settings.outputFolder) throw new Error("Choose and save an output folder before recording so local files are recoverable.");
    await saveSettings();
    stream = await buildStream();
    const preview = el<HTMLVideoElement>("preview");
    const recordingPreview = el<HTMLVideoElement>("recordingPreview");
    preview.srcObject = stream;
    recordingPreview.srcObject = stream;
    el("preview").parentElement?.classList.add("has-video");
    chunks = [];
    chunkIndex = 0;
    activeManifest = createManifest();
    await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder });
    lastBlob = null;
    savedFile = null;
    const quality = el<HTMLSelectElement>("quality").value as keyof typeof qualityBitrates;
    recorder = new MediaRecorder(stream, { mimeType: selectedMime, videoBitsPerSecond: qualityBitrates[quality], audioBitsPerSecond: 128_000 });
    recorder.ondataavailable = (event) => { if (event.data.size) { chunks.push(event.data); void saveChunk(event.data); } };
    recorder.onstop = () => void finishRecording();
    recorder.start(30_000);
    markers = [];
    renderMarkers();
    startedAt = Date.now();
    timerInterval = window.setInterval(updateTimer, 500);
    el<HTMLButtonElement>("startRecording").disabled = true;
    el<HTMLButtonElement>("stopRecording").disabled = false;
    el<HTMLButtonElement>("pauseRecording").disabled = false;
    el("recBadge").classList.add("active");
    startMicMeter();
    setStatus("Recording");
  } catch (error) {
    setStatus("Idle");
    setText("uploadStatus", friendlyCaptureError(error));
  }
}

function stopRecording() {
  if (!recorder || recorder.state === "inactive") return;
  setStatus("Stopping");
  recorder.stop();
  el<HTMLButtonElement>("stopRecording").disabled = true;
  el<HTMLButtonElement>("pauseRecording").disabled = true;
}

async function finishRecording() {
  window.clearInterval(timerInterval);
  timerInterval = undefined;
  stopMicMeter();
  el("recBadge").classList.remove("active");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  const blob = new Blob(chunks, { type: contentTypeForMime(selectedMime) });
  lastBlob = blob;
  const fileName = filenameForMime(selectedMime);
  const buffer = await blob.arrayBuffer();
  savedFile = await window.videoBlitzerRecorder.saveRecording(buffer, fileName, settings.outputFolder);
  if (activeManifest) { activeManifest.completedAt = new Date().toISOString(); activeManifest.finalFilePath = savedFile.filePath; activeManifest.durationEstimateSeconds = Math.floor((Date.now() - startedAt) / 1000); activeManifest.markers = markers; await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder }); }
  setText("savedPath", savedFile.filePath);
  setText("fileSize", `${(savedFile.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  setText("audioStatus", el<HTMLInputElement>("includeMic").checked ? "Microphone requested" : "Video only / source audio if available");
  const playback = el<HTMLVideoElement>("playback");
  playback.src = URL.createObjectURL(blob);
  setStatus("Saved locally");
  setText("uploadStatus", `Saved ${fileName} locally. Upload after recording when ready.`);
  el<HTMLButtonElement>("openLocation").disabled = false;
  el<HTMLButtonElement>("uploadRecording").disabled = false;
  el<HTMLButtonElement>("exportMp4").disabled = false;
  el<HTMLButtonElement>("generateTranscript").disabled = false;
  el<HTMLButtonElement>("generateClips").disabled = false;
  el<HTMLButtonElement>("generateCaptions").disabled = false;
  el<HTMLButtonElement>("startRecording").disabled = !selectedSource;
}

function uploadToSignedUrl(blob: Blob, signedUrl: string, requiredHeaders: Record<string, string> | undefined, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeUploadXhr = xhr;
    el<HTMLButtonElement>("cancelUpload").disabled = false;
    xhr.open("PUT", signedUrl);
    const headerValue = requiredHeaders?.["Content-Type"] ?? blob.type;
    if (headerValue) xhr.setRequestHeader("Content-Type", headerValue);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onload = () => { activeUploadXhr = null; el<HTMLButtonElement>("cancelUpload").disabled = true; xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload to R2 failed with status ${xhr.status}.`)); };
    xhr.onabort = () => { activeUploadXhr = null; el<HTMLButtonElement>("cancelUpload").disabled = true; reject(new Error("Upload cancelled. Local file is still available and can be retried.")); };
    xhr.onerror = () => { activeUploadXhr = null; el<HTMLButtonElement>("cancelUpload").disabled = true; reject(new Error("Upload failed. Check your connection and try again.")); };
    xhr.send(blob);
  });
}

async function uploadRecording() {
  if (!savedFile) { setText("uploadStatus", "Record, recover, combine, or import a local video file first."); return; }
  try {
    await saveSettings();
    updateUploadProgress(0);
    if (activeManifest) { activeManifest.uploadStatus = "uploading"; await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder }).catch(() => undefined); }
    setText("uploadStatus", "Creating or selecting VideoBlitzer project...");
    const metadata = collectMetadata();
    const title = metadata.matchMetadata.matchTitle || (selectedMode === "match" ? `${metadata.matchMetadata.teamA || "Team A"} vs ${metadata.matchMetadata.teamB || "Team B"}` : `Browser recording ${timestamp()}`);
    const existingProjectId = el<HTMLInputElement>("existingProjectId").value.trim();
    const created = existingProjectId ? { project: { id: existingProjectId, title } } : await api<{ project: { id: string; title: string } }>("/projects", { method: "POST", body: JSON.stringify({ title, source_type: "desktop_recorder", recording_mode: selectedMode, source_label: selectedSource?.name, source_url: metadata.matchMetadata.sourceUrl, permission_confirmed: metadata.permission.permissionConfirmed, permission_confirmed_at: metadata.permission.confirmedAt, recording_metadata: metadata.recordingMetadata, match_metadata: metadata.matchMetadata, source_metadata: { sourceLabel: selectedSource?.name, sourcePlatform: metadata.matchMetadata.sourcePlatform } }) });
    setText("projectId", created.project.id);

    const filename = savedFile.filePath.split(/[\\/]/).pop() ?? filenameForMime(selectedMime);
    const contentType = contentTypeForFilePath(savedFile.filePath);
    const rawFormat = rawFormatForContentType(contentType);
    const uploadBlob = lastBlob ?? new Blob([(await window.videoBlitzerRecorder.readLocalFile(savedFile.filePath)).arrayBuffer], { type: contentType });
    setText("uploadStatus", "Requesting signed R2 upload URL...");
    const signed = await api<{ signedUrl?: string; uploadUrl?: string; objectKey?: string; key?: string; requiredHeaders?: Record<string, string> }>("/uploads/create-signed-url", { method: "POST", body: JSON.stringify({ projectId: created.project.id, filename, contentType }) });
    const signedUrl = signed.signedUrl ?? signed.uploadUrl;
    const objectKey = signed.objectKey ?? signed.key;
    if (!signedUrl || !objectKey) throw new Error("API did not return a signed upload URL.");

    setText("uploadStatus", `Uploading ${rawFormat.toUpperCase()} directly to Cloudflare R2...`);
    await uploadToSignedUrl(uploadBlob, signedUrl, signed.requiredHeaders, updateUploadProgress);
    setText("objectKey", objectKey);

    setText("uploadStatus", "Saving video record and queuing backend work...");
    const completed = await api<{ video: { id: string }; conversion_job?: { id: string; status: string } }>("/uploads/complete", { method: "POST", body: JSON.stringify({ project_id: created.project.id, object_key: objectKey, filename, content_type: contentType, size_bytes: savedFile.sizeBytes, raw_format: rawFormat, desired_export_format: rawFormat === "webm" ? "mp4" : undefined, recording_mode: selectedMode, source_type: "desktop_recorder", source_label: selectedSource?.name, source_url: metadata.matchMetadata.sourceUrl, permission_confirmed: metadata.permission.permissionConfirmed, permission_confirmed_at: metadata.permission.confirmedAt, recording_metadata: metadata.recordingMetadata, match_metadata: metadata.matchMetadata, markers, chunk_manifest: activeManifest ?? {}, local_original_filename: filename, original_mime_type: contentType, duration_seconds: activeManifest?.durationEstimateSeconds }) });
    if (!completed.conversion_job) {
      if (rawFormat === "webm") await api("/exports/convert", { method: "POST", body: JSON.stringify({ project_id: created.project.id, video_id: completed.video.id, source_object_key: objectKey, source_format: "webm", target_format: "mp4" }) });
    }
    await api("/jobs/analyze", { method: "POST", body: JSON.stringify({ projectId: created.project.id, videoId: completed.video.id }) });
    if (activeManifest) { activeManifest.uploadStatus = "uploaded"; await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder }); }
    setText("uploadStatus", rawFormat === "webm" ? "Uploaded. MP4 conversion and analysis are queued for backend processing." : "Uploaded. Analysis is queued for backend processing.");
    el("projectLink").innerHTML = `<a href="https://app.videoblitzer.com/projects/${created.project.id}/overview">Open project in web app</a>`;
    setStatus("Uploaded");
  } catch (error) {
    if (activeManifest) { activeManifest.uploadStatus = "failed"; await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder }).catch(() => undefined); }
    setStatus("Upload failed");
    setText("uploadStatus", friendlyUploadError(error));
  }
}

function parseMatchClock(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map(Number);
    const min = parts[0];
    const sec = parts[1];
    if (typeof min === "number" && typeof sec === "number" && Number.isFinite(min) && Number.isFinite(sec)) return min * 60 + sec;
  }
  const minutes = Number(trimmed);
  return Number.isFinite(minutes) ? Math.round(minutes * 60) : null;
}

function formatSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const seconds = (safe % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function eventMinuteLabel(event: MatchEvent) {
  return `${event.minute}${event.stoppageMinute ? `+${event.stoppageMinute}` : "'"}`;
}

function eventRecordingTimestamp(event: MatchEvent) {
  if (matchClockAtRecordingStartSeconds === null) return eventMinuteLabel(event);
  return formatSeconds(event.minute * 60 + (event.stoppageMinute ?? 0) * 60 - matchClockAtRecordingStartSeconds);
}

function renderMatchTimeline() {
  const container = el("matchTimelineCards");
  const visible = matchEvents.filter((event) => !event.ignored).sort((a, b) => b.importanceScore - a.importanceScore || a.minute - b.minute);
  if (!visible.length) { container.innerHTML = `<p class="hint">Fetch provider data or add manual events.</p>`; renderIntelligenceOutputs(); return; }
  container.innerHTML = "";
  for (const event of visible) {
    const card = document.createElement("article");
    card.className = "timeline-card";
    card.innerHTML = `<header><span class="minute-badge">${eventMinuteLabel(event)}</span><span class="importance-badge">Importance ${event.importanceScore}</span></header><strong>${event.eventType}</strong><p>${[event.team, event.player].filter(Boolean).join(" · ") || "Match event"}</p><p class="hint">${event.description}</p><p class="hint">Source: ${event.source} · Confidence: ${event.confidence}${matchClockAtRecordingStartSeconds !== null ? ` · Recording ${eventRecordingTimestamp(event)}` : ""}</p><div class="timeline-actions"><button data-action="marker">Add as marker</button><button data-action="comment">Comment on this</button><button data-action="clip">Clip idea</button><button data-action="ignore">Ignore</button></div>`;
    card.querySelector('[data-action="marker"]')?.addEventListener("click", () => addMarker(event.eventType, event.description, eventRecordingTimestamp(event)));
    card.querySelector('[data-action="comment"]')?.addEventListener("click", () => addMarker("Commentary", `Comment on ${event.description}`, eventRecordingTimestamp(event)));
    card.querySelector('[data-action="clip"]')?.addEventListener("click", () => addMarker("Clip This", `${event.eventType}: ${event.description}`, eventRecordingTimestamp(event)));
    card.querySelector('[data-action="ignore"]')?.addEventListener("click", () => { event.ignored = true; renderMatchTimeline(); });
    container.appendChild(card);
  }
  renderIntelligenceOutputs();
}

function manualImportanceFor(type: string) {
  const key = type.toLowerCase();
  if (key.includes("goal")) return 10;
  if (key.includes("red") || key.includes("penalty")) return 9;
  if (key.includes("chance")) return 8;
  if (key.includes("shot")) return 6;
  if (key.includes("yellow")) return 5;
  if (key.includes("sub")) return 4;
  return 3;
}

function addManualMatchEvent() {
  const minute = Number(el<HTMLInputElement>("manualMinute").value);
  const eventType = el<HTMLInputElement>("manualEventType").value.trim();
  const note = el<HTMLInputElement>("manualNote").value.trim();
  const importanceInput = Number(el<HTMLInputElement>("manualImportance").value);
  if (!Number.isFinite(minute) || !eventType) { setText("miStatus", "Add a minute and event type for manual entry."); return; }
  matchEvents.push({ id: crypto.randomUUID(), minute, period: minute <= 45 ? "first_half" : "second_half", eventType, description: note || eventType, source: "manual", confidence: "manual", importanceScore: Number.isFinite(importanceInput) && importanceInput > 0 ? importanceInput : manualImportanceFor(eventType) });
  renderMatchTimeline();
  setText("miStatus", "Manual event added.");
}

async function fetchMatchTimeline() {
  try {
    setText("miStatus", "Fetching factual match timeline...");
    const response = await api<{ events: MatchEvent[]; warning?: string; complianceNote: string; outputs?: unknown }>("/match-intelligence/timeline", {
      method: "POST",
      body: JSON.stringify({
        sport: "Soccer",
        league: el<HTMLInputElement>("miLeague").value,
        teamA: el<HTMLInputElement>("miTeamA").value,
        teamB: el<HTMLInputElement>("miTeamB").value,
        matchDate: el<HTMLInputElement>("miDate").value,
        matchUrl: el<HTMLInputElement>("miUrl").value,
        provider: el<HTMLSelectElement>("miProvider").value,
        manualEvents: [],
      }),
    });
    matchEvents = response.events ?? [];
    renderMatchTimeline();
    setText("miStatus", response.warning || `${matchEvents.length} factual events loaded. ${response.complianceNote}`);
  } catch (error) {
    setText("miStatus", error instanceof Error ? error.message : "Could not load match timeline. Use manual entry.");
  }
}

function alignMatchClock() {
  const parsed = parseMatchClock(el<HTMLInputElement>("matchClockInput").value);
  if (parsed === null) { setText("alignmentStatus", "Enter a match minute like 12:30."); return; }
  matchClockAtRecordingStartSeconds = parsed;
  setText("alignmentStatus", `Recording start aligned to match clock ${formatSeconds(parsed)}.`);
  renderMatchTimeline();
}

function checkMatchSuggestions(recordingElapsedSeconds: number) {
  if (matchClockAtRecordingStartSeconds === null || !["match", "sports"].includes(selectedMode)) return;
  const currentMatchSeconds = matchClockAtRecordingStartSeconds + recordingElapsedSeconds;
  for (const event of matchEvents) {
    if (event.ignored || suggestedEventIds.has(event.id) || event.importanceScore < 6) continue;
    const eventSeconds = event.minute * 60 + (event.stoppageMinute ?? 0) * 60;
    if (eventSeconds >= currentMatchSeconds && eventSeconds - currentMatchSeconds <= 30) {
      suggestedEventIds.add(event.id);
      addMarker("Upcoming match moment", `${eventMinuteLabel(event)} ${event.eventType}: ${event.description}`, formatSeconds(recordingElapsedSeconds));
      setText("miStatus", `Suggested marker: ${event.eventType} at ${eventMinuteLabel(event)}.`);
    }
  }
}

const highlightConfigs: Record<HighlightLength, { label: string; targetDurationSeconds: number; introSeconds: number; closingSeconds: number; minScore: number; maxMoments: number; editOutline: string; exportRecommendation: string; }> = {
  "5": { label: "Essential", targetDurationSeconds: 300, introSeconds: 20, closingSeconds: 30, minScore: 8, maxMoments: 6, editOutline: "Fast-paced essential cut: goals, penalties, red cards, VAR decisions, biggest chances, and final reaction only.", exportRecommendation: "Export 1080p or 4K MP4 plus vertical shorts for the top moments." },
  "15": { label: "Balanced", targetDurationSeconds: 900, introSeconds: 45, closingSeconds: 75, minScore: 6, maxMoments: 12, editOutline: "Balanced YouTube structure: match story, essential events, momentum shifts, tactical points, key substitutions, controversies, and recap.", exportRecommendation: "Export a primary 16:9 YouTube MP4, chapters enabled, plus 2-4 short-form derivatives." },
  "25": { label: "Deep Analysis", targetDurationSeconds: 1500, introSeconds: 90, closingSeconds: 150, minScore: 3, maxMoments: 22, editOutline: "Deep tactical breakdown with buildup explanation, player notes, momentum swings, medium events, and final verdict.", exportRecommendation: "Export long-form 16:9 MP4 with chapters, full captions, and separate tactical clips." },
};

function formatHms(totalSeconds: number) {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((safe % 3600) / 60).toString().padStart(2, "0");
  const seconds = (safe % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function markerTimestampToHms(value: string) {
  const parts = value.split(":").map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return formatHms((parts[0] ?? 0) * 60 + (parts[1] ?? 0));
  if (parts.length === 3 && parts.every(Number.isFinite)) return formatHms((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0));
  return value;
}

function eventSourceTimestamp(event: MatchEvent) {
  if (matchClockAtRecordingStartSeconds === null) return eventMinuteLabel(event);
  return formatHms(event.minute * 60 + (event.stoppageMinute ?? 0) * 60 - matchClockAtRecordingStartSeconds);
}

function scoreByRules(eventType: string, fallback = 3) {
  const key = eventType.toLowerCase();
  if (key.includes("clip this")) return 10;
  if (key.includes("goal")) return 10;
  if (key.includes("red card") || key.includes("red")) return 9;
  if (key.includes("penalty")) return 9;
  if (key.includes("var")) return 8;
  if (key.includes("big chance") || key.includes("big chances")) return 8;
  if (key.includes("tactical")) return 7;
  if (key.includes("shot on target")) return 6;
  if (key.includes("yellow")) return 5;
  if (key.includes("substitution") || key.includes("sub")) return 4;
  if (key.includes("note") || key.includes("question") || key.includes("important")) return Math.max(fallback, 3);
  return fallback;
}

function collectHighlightMoments() {
  const eventMoments: HighlightMoment[] = matchEvents.filter((event) => !event.ignored).map((event) => ({
    title: `${eventMinuteLabel(event)} ${event.eventType}`,
    eventType: event.eventType,
    description: event.description,
    importanceScore: Math.max(event.importanceScore, scoreByRules(event.eventType, event.importanceScore)),
    matchMinute: eventMinuteLabel(event),
    sourceTimestamp: eventSourceTimestamp(event),
    reason: `${event.source} factual event with ${event.confidence} confidence`,
    team: event.team,
    player: event.player,
  }));
  const markerMoments: HighlightMoment[] = markers.map((marker) => ({
    title: marker.label,
    eventType: marker.label,
    description: marker.note || marker.label,
    importanceScore: scoreByRules(marker.label, marker.note ? 3 : 3),
    matchMinute: marker.time.includes("'") ? marker.time : "Manual marker",
    sourceTimestamp: markerTimestampToHms(marker.time),
    reason: marker.note ? `User marker: ${marker.note}` : "User marker from recording timeline",
  }));
  return [...eventMoments, ...markerMoments].sort((a, b) => b.importanceScore - a.importanceScore || a.sourceTimestamp.localeCompare(b.sourceTimestamp));
}

function buildHighlightPackage(length: HighlightLength): HighlightPackage {
  const config = highlightConfigs[length];
  const moments = collectHighlightMoments().filter((moment) => moment.importanceScore >= config.minScore).slice(0, config.maxMoments);
  const storyMoments = moments.length ? moments : collectHighlightMoments().slice(0, Math.min(4, config.maxMoments));
  const middleBudget = Math.max(60, config.targetDurationSeconds - config.introSeconds - config.closingSeconds);
  const perMomentSeconds = storyMoments.length ? Math.max(20, Math.floor(middleBudget / storyMoments.length)) : middleBudget;
  const segments: HighlightSegment[] = [
    { order: 1, title: "Opening context", targetSeconds: config.introSeconds, matchMinute: "0'", sourceTimestamp: "00:00:00", reason: "Sets up the match story", voiceoverPrompt: "Explain the stakes, expected tactical setup, and what viewers should watch for.", captionIdea: `${config.label} highlights: match setup and stakes.` },
    ...storyMoments.map((moment, index) => ({
      order: index + 2,
      title: moment.title,
      targetSeconds: perMomentSeconds,
      matchMinute: moment.matchMinute,
      sourceTimestamp: moment.sourceTimestamp,
      reason: moment.reason,
      voiceoverPrompt: voiceoverForMoment(moment, length),
      captionIdea: `${moment.matchMinute} ${moment.eventType}: add your original read on why it mattered.`,
    })),
    { order: storyMoments.length + 2, title: length === "25" ? "Final analysis and verdict" : "Final reaction and recap", targetSeconds: config.closingSeconds, matchMinute: "FT", sourceTimestamp: savedFile ? formatHms(Math.floor((Date.now() - startedAt) / 1000)) : "End", reason: "Closes the match narrative", voiceoverPrompt: length === "25" ? "Summarize tactical lessons, player notes, momentum swings, and final verdict." : "Recap the decisive moments and give a concise final reaction.", captionIdea: "Final verdict from the match." },
  ];
  const titleSeed = storyMoments[0]?.team || el<HTMLInputElement>("miTeamA").value || "Match";
  return {
    highlightLength: length,
    label: config.label,
    targetDurationSeconds: config.targetDurationSeconds,
    editOutline: config.editOutline,
    segments,
    titleIdea: `${titleSeed} ${config.label} Highlights (${length} min)` ,
    thumbnailPrompt: `${config.label} soccer highlight thumbnail with scoreboard energy, key player reaction, bold minute callouts, premium dark VideoBlitzer style.`,
    exportRecommendation: config.exportRecommendation,
  };
}

function voiceoverForMoment(moment: HighlightMoment, length: HighlightLength) {
  if (length === "5") return `Keep it tight: say what happened, why it mattered, and move to the next moment.`;
  if (length === "15") return `Explain the event, the momentum impact, and the tactical or player context behind it.`;
  return `Break down the buildup, player decisions, tactical context, alternate options, and how this changed the match story.`;
}

function renderHighlightPackages(lengths: HighlightLength[]) {
  renderedHighlightPackages = lengths.map(buildHighlightPackage);
  renderIntelligenceOutputs();
  const labels = renderedHighlightPackages.map((pkg) => `${pkg.highlightLength}-min ${pkg.label}`).join(", ");
  setText("miStatus", `Generated highlight package plan: ${labels}.`);
}

function setHighlightDepth(length: HighlightLength) {
  selectedHighlightLength = length;
  document.querySelectorAll(".depth-card").forEach((card) => card.classList.toggle("selected", (card as HTMLElement).dataset.length === length));
}

function renderHighlightPackage(packagePlan: HighlightPackage) {
  return `<div class="highlight-package"><strong>${packagePlan.highlightLength} min - ${packagePlan.label}</strong><p class="hint">${packagePlan.editOutline}</p><p class="hint">Target duration: ${packagePlan.targetDurationSeconds}s</p>${packagePlan.segments.map((segment) => `<div class="highlight-segment"><strong>${segment.order}. ${segment.title} (${segment.targetSeconds}s)</strong><p class="hint">${segment.matchMinute} · ${segment.sourceTimestamp}<br>${segment.reason}<br>Voiceover: ${segment.voiceoverPrompt}<br>Caption: ${segment.captionIdea}</p></div>`).join("")}<div class="output-block"><strong>Title idea</strong><p class="hint">${packagePlan.titleIdea}</p></div><div class="output-block"><strong>Thumbnail prompt</strong><p class="hint">${packagePlan.thumbnailPrompt}</p></div><div class="output-block"><strong>Export recommendation</strong><p class="hint">${packagePlan.exportRecommendation}</p></div></div>`;
}

function renderIntelligenceOutputs() {
  const output = el("intelligenceOutputs");
  const important = matchEvents.filter((event) => !event.ignored).sort((a, b) => b.importanceScore - a.importanceScore).slice(0, 6);
  const packages = renderedHighlightPackages.map(renderHighlightPackage).join("");
  if (!important.length && !markers.length && !packages) { output.innerHTML = `<p class="hint">Match Intelligence outputs will appear after timeline events are loaded.</p>`; return; }
  const markerTimeline = markers.map((marker) => `${marker.time} - ${marker.label}${marker.note ? `: ${marker.note}` : ""}`).join("<br>") || "Add markers during recording or from event cards.";
  const baseOutputs = important.length ? `<div class="output-block"><strong>Marker timeline</strong><p class="hint">${markerTimeline}</p></div><div class="output-block"><strong>Commentary outline</strong><p class="hint">${important.map((event) => `Explain ${event.eventType} at ${eventMinuteLabel(event)} using your own analysis.`).join("<br>")}</p></div><div class="output-block"><strong>Suggested clips</strong><p class="hint">${important.map((event) => `${eventMinuteLabel(event)} ${event.eventType} (${event.importanceScore}/10)`).join("<br>")}</p></div><div class="output-block"><strong>Title ideas</strong><p class="hint">${important.slice(0,3).map((event) => `${event.team || "Match"} ${event.eventType} Changed The Game`).join("<br>")}</p></div><div class="output-block"><strong>Caption ideas</strong><p class="hint">${important.slice(0,3).map((event) => `${eventMinuteLabel(event)} ${event.eventType}. Add your original take before publishing.`).join("<br>")}</p></div><div class="output-block"><strong>Chapters</strong><p class="hint">${important.map((event) => `${eventRecordingTimestamp(event)} ${event.eventType}`).join("<br>")}</p></div><div class="output-block"><strong>Tactical questions</strong><p class="hint">${important.map((event) => `What changed tactically around ${eventMinuteLabel(event)}?`).join("<br>")}</p></div><div class="output-block"><strong>Short-form video plan</strong><p class="hint">Lead with the highest-importance event, add context, then close with your original analysis. Use 9:16 clips for the top ${Math.min(important.length, 5)} moments.</p></div>` : `<div class="output-block"><strong>Marker timeline</strong><p class="hint">${markerTimeline}</p></div>`;
  output.innerHTML = `${baseOutputs}${packages ? `<div class="output-block"><strong>Generated highlight/edit plans</strong></div>${packages}` : ""}`;
}

function collectMetadata() {
  const permissionConfirmed = el<HTMLInputElement>("permissionConfirm").checked;
  const matchMetadata = {
    matchTitle: el<HTMLInputElement>("matchTitle").value.trim(),
    gameType: el<HTMLInputElement>("gameType").value.trim(),
    teamA: el<HTMLInputElement>("teamA").value.trim(),
    teamB: el<HTMLInputElement>("teamB").value.trim(),
    competition: el<HTMLInputElement>("competition").value.trim(),
    sourcePlatform: el<HTMLInputElement>("sourcePlatform").value.trim(),
    sourceUrl: el<HTMLInputElement>("sourceUrl").value.trim(),
    matchDate: el<HTMLInputElement>("matchDate").value,
    notes: el<HTMLTextAreaElement>("sessionNotes").value.trim(),
  };
  return {
    matchMetadata,
    permission: { permissionConfirmed, confirmedAt: permissionConfirmed ? new Date().toISOString() : undefined, sourceLabel: selectedSource?.name, appVersion, recordingMode: selectedMode },
    recordingMetadata: { mode: selectedMode, sourceLabel: selectedSource?.name, appVersion, platform: platformLabel, audioSettings: audioSettings(), sentenceAwareEditing: { preserveCompleteSentences: true, handlesSeconds: [1, 3], manualOverride: el<HTMLInputElement>("manualCutOverride").checked } },
  };
}

function audioSettings() {
  return { includeMicrophone: el<HTMLInputElement>("includeMic").checked, includeSystemAudio: el<HTMLInputElement>("systemAudioToggle").checked, microphoneDeviceId: el<HTMLSelectElement>("micSelect").value || "default" };
}

function createManifest(): RecordingManifest {
  const metadata = collectMetadata();
  return { sessionId: crypto.randomUUID(), mode: selectedMode, sourceLabel: selectedSource?.name, createdAt: new Date().toISOString(), chunks: [], audioSettings: audioSettings(), markers: [], metadata, uploadStatus: "local_only", outputFolder: settings.outputFolder };
}

async function saveChunk(blob: Blob) {
  if (!activeManifest) return;
  const index = ++chunkIndex;
  try {
    const chunk = await window.videoBlitzerRecorder.saveRecordingChunk({ sessionId: activeManifest.sessionId, arrayBuffer: await blob.arrayBuffer(), filename: `${activeManifest.sessionId}_chunk_${String(index).padStart(4, "0")}.webm`, outputFolder: settings.outputFolder, index, durationEstimateSeconds: 30 });
    activeManifest.chunks.push(chunk);
    activeManifest.markers = markers;
    await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder });
  } catch (error) {
    setText("uploadStatus", error instanceof Error ? `Chunk write failed: ${error.message}. Stop recording and check disk permissions.` : "Chunk write failed. Stop recording and check disk permissions.");
  }
}

async function populateMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = el<HTMLSelectElement>("micSelect");
    const current = select.value;
    select.innerHTML = `<option value="">Default microphone</option>`;
    for (const device of devices.filter((item) => item.kind === "audioinput")) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${select.length}`;
      select.appendChild(option);
    }
    select.value = settings.selectedMicDeviceId ?? current;
  } catch {
    setText("micWarning", "Microphone devices could not be listed. Grant microphone permission and try again.");
  }
}

function updateAudioStatus() {
  setText("micStatus", el<HTMLInputElement>("includeMic").checked ? "Microphone: on" : "Microphone: off");
  setText("systemAudioStatus", el<HTMLInputElement>("systemAudioToggle").checked ? "System audio: requested" : "System audio: off");
}

function updatePermissionStatus() {
  const ok = el<HTMLInputElement>("permissionConfirm").checked;
  setText("permissionStatus", ok ? "Permission confirmed" : "Permission required");
  el("permissionStatus").classList.toggle("success", ok);
  el("permissionStatus").classList.toggle("warning", !ok);
}

async function renderRecoveries() {
  const list = el("recoveryList");
  const sessions = await window.videoBlitzerRecorder.listRecoverableSessions().catch(() => []);
  if (!sessions.length) { list.textContent = "No unfinished sessions found yet."; return; }
  list.innerHTML = "";
  for (const session of sessions) {
    const node = document.createElement("div");
    node.className = "timeline-item";
    node.innerHTML = `<strong>${session.mode} · ${session.createdAt}</strong><br><span>${session.sourceLabel ?? "Unknown source"} · ${session.chunks.length} chunks</span><br><button class="ghost-button">Recover recording</button>`;
    node.querySelector("button")?.addEventListener("click", async () => {
      try {
        const recovered = await window.videoBlitzerRecorder.recoverSession(session, settings.outputFolder);
        savedFile = recovered;
        activeManifest = { ...session, finalFilePath: recovered.filePath };
        lastBlob = null;
        setText("savedPath", recovered.filePath);
        setText("uploadStatus", "Recovered recording locally. Review and upload when ready.");
        el<HTMLButtonElement>("uploadRecording").disabled = false;
      } catch (error) { setText("uploadStatus", error instanceof Error ? error.message : "Could not recover recording."); }
    });
    list.appendChild(node);
  }
}

async function createQuickClip(durationSeconds: number) {
  if (!savedFile) { setText("uploadStatus", "Save a local recording before creating clips."); return; }
  try {
    const marker = markers[markers.length - 1];
    const start = Math.max(0, (marker?.seconds ?? 0) - 3);
    const name = `${slug(el<HTMLInputElement>("teamA").value || "VideoBlitzer")}_${slug(marker?.label ?? "Clip")}_${formatHms(start).replace(/:/g, "-")}_${durationSeconds}s.mp4`;
    const clip = await window.videoBlitzerRecorder.createClip({ sourcePath: savedFile.filePath, outputFolder: settings.outputFolder, filename: name, startSeconds: start, durationSeconds, exactCut: el<HTMLInputElement>("manualCutOverride").checked });
    setText("uploadStatus", `Clip saved locally: ${clip.filePath}`);
  } catch (error) { setText("uploadStatus", error instanceof Error ? `Clip creation failed: ${error.message}` : "Clip creation failed."); }
}

async function createClipAroundMarker() { await createQuickClip(30); }

async function selectCombineFile(kind: "video" | "audio") {
  const file = await window.videoBlitzerRecorder.selectMediaFile(kind);
  if (!file) return;
  const meta = await window.videoBlitzerRecorder.mediaMetadata(file);
  if (kind === "video") { combineVideoPath = file; setText("combineVideoPath", `${file} · duration ${meta.durationSeconds?.toFixed(1) ?? "unknown"}s`); }
  else { combineAudioPath = file; setText("combineAudioPath", `${file} · duration ${meta.durationSeconds?.toFixed(1) ?? "unknown"}s`); }
}

async function combineMedia() {
  try {
    if (!combineVideoPath || !combineAudioPath) throw new Error("Select both a video file and an audio file.");
    const offset = Number(el<HTMLInputElement>("audioOffset").value);
    if (!Number.isFinite(offset)) throw new Error("Audio offset must be a valid number.");
    const output = await window.videoBlitzerRecorder.combineVideoAudio({ videoPath: combineVideoPath, audioPath: combineAudioPath, outputFolder: settings.outputFolder, filename: `VideoBlitzer_Combined_${timestamp()}.mp4`, offsetSeconds: offset, trimToShortest: el<HTMLInputElement>("trimShortest").checked });
    savedFile = output;
    lastBlob = null;
    setText("savedPath", output.filePath);
    setText("combineStatus", `Combined MP4 saved: ${output.filePath}`);
    el<HTMLButtonElement>("uploadRecording").disabled = false;
  } catch (error) { setText("combineStatus", error instanceof Error ? error.message : "Failed to combine video and audio."); }
}

async function fetchImportMetadata() {
  try {
    const sourceUrl = el<HTMLInputElement>("importSourceUrl").value.trim();
    if (!sourceUrl) throw new Error("Enter a source URL.");
    const response = await api<{ metadata: unknown }>("/source-import/metadata", { method: "POST", body: JSON.stringify({ sourceUrl, permissionConfirmed: el<HTMLInputElement>("importPermissionConfirm").checked }) });
    el("importMetadataOutput").textContent = JSON.stringify(response.metadata, null, 2);
  } catch (error) { el("importMetadataOutput").textContent = error instanceof Error ? error.message : "Could not fetch source metadata."; }
}

async function auditSourceImport() {
  try {
    const response = await api<{ audit: unknown }>("/source-import/audit", { method: "POST", body: JSON.stringify({ sourceUrl: el<HTMLInputElement>("importSourceUrl").value.trim(), importMethod: el<HTMLSelectElement>("importMethod").value, permissionConfirmed: el<HTMLInputElement>("importPermissionConfirm").checked, metadata: { source: "desktop_recorder" } }) });
    el("importMetadataOutput").textContent = JSON.stringify(response.audit, null, 2);
  } catch (error) { el("importMetadataOutput").textContent = error instanceof Error ? error.message : "Could not store import audit."; }
}

function markerSet() {
  const universal = ["Clip This", "Important", "Question", "Mistake"];
  const byMode: Record<string, string[]> = {
    match: ["Goal", "Save", "Foul", "Key Moment", "Start", "End", "Custom Note"],
    sports: ["Goal", "Save", "Foul", "Key Moment", "Start", "End", "Custom Note"],
    browser: ["Clip This", "Key Moment", "Start", "End", "Custom Note"],
    business: ["Feature", "Customer Pain", "Objection", "Pricing", "CTA"],
    training: ["Step", "Warning", "Example", "Recap"],
    screen: ["Feature", "Question", "CTA"],
    link: ["Clip This", "Important"],
    upload: ["Clip This", "Important"],
  };
  return [...universal, ...(byMode[selectedMode] ?? [])];
}

function addMarker(label: string, noteOverride?: string, timeOverride?: string) {
  const note = noteOverride ?? el<HTMLInputElement>("noteInput").value.trim();
  const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : undefined;
  markers.push({ time: timeOverride ?? el("timer").textContent ?? "00:00", label, note, seconds, createdAt: new Date().toISOString() });
  if (activeManifest) { activeManifest.markers = markers; void window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder }); }
  el<HTMLInputElement>("noteInput").value = "";
  renderMarkers();
}

function renderMarkerButtons() {
  const grid = el<HTMLDivElement>("markerButtons");
  grid.innerHTML = "";
  for (const label of markerSet()) {
    const button = document.createElement("button");
    button.className = "marker-button";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => addMarker(label));
    grid.appendChild(button);
  }
}

function renderMarkers() {
  const timeline = el("markerTimeline");
  if (!markers.length) { timeline.textContent = "Markers will appear here while you record."; return; }
  timeline.innerHTML = markers.map((marker) => `<div class="timeline-item"><strong>${marker.time}</strong> · ${marker.label}${marker.note ? `<br><span>${marker.note}</span>` : ""}</div>`).join("");
  renderIntelligenceOutputs();
}

function startMicMeter() {
  const meter = el("micMeter");
  meter.classList.add("active");
  micMeterInterval = window.setInterval(() => { meter.style.width = `${20 + Math.round(Math.random() * 70)}%`; }, 240);
}

function stopMicMeter() {
  window.clearInterval(micMeterInterval);
  el("micMeter").classList.remove("active");
  el<HTMLElement>("micMeter").style.width = "8%";
}

function pauseOrResume() {
  if (!recorder) return;
  const button = el<HTMLButtonElement>("pauseRecording");
  if (recorder.state === "recording") { recorder.pause(); paused = true; button.textContent = "Resume"; setStatus("Paused"); return; }
  if (recorder.state === "paused") { recorder.resume(); paused = false; button.textContent = "Pause"; setStatus("Recording"); }
}

function selectMode(mode: string) {
  selectedMode = mode;
  const label = mode.replace(/-/g, " ").replace(/^./, (char) => char.toUpperCase());
  const modeLabels: Record<string, string> = { browser: "Record Browser or App Window", match: "Capture Match Video", screen: "Screen Walkthrough", business: "Business Demo", training: "Training Video", upload: "Upload Existing Video" };
  setText("selectedModeLabel", modeLabels[mode] ?? label);
  document.querySelectorAll(".mode-card").forEach((card) => card.classList.toggle("selected", (card as HTMLElement).dataset.mode === mode));
  renderMarkerButtons();
}

function setupPremiumInteractions() {
  document.querySelectorAll("[data-scroll]").forEach((button) => button.addEventListener("click", () => {
    const target = (button as HTMLElement).dataset.scroll;
    if (target) el(target).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll(".mode-card").forEach((card) => card.addEventListener("click", () => selectMode((card as HTMLElement).dataset.mode ?? "browser")));
  el("screenTab").addEventListener("click", () => { sourceFilter = "screen"; el("screenTab").classList.add("active"); el("windowTab").classList.remove("active"); el("browserTab").classList.remove("active"); void refreshSources(); });
  el("windowTab").addEventListener("click", () => { sourceFilter = "window"; el("windowTab").classList.add("active"); el("screenTab").classList.remove("active"); el("browserTab").classList.remove("active"); void refreshSources(); });
  el("browserTab").addEventListener("click", () => { sourceFilter = "browser"; el("browserTab").classList.add("active"); el("screenTab").classList.remove("active"); el("windowTab").classList.remove("active"); void refreshSources(); });
  el("pauseRecording").addEventListener("click", pauseOrResume);
  el("cancelUpload").addEventListener("click", () => activeUploadXhr?.abort());
  el("testMic").addEventListener("click", () => { startMicMeter(); window.setTimeout(stopMicMeter, 1800); setText("micWarning", "Mic test complete. If the meter moved, input is available."); });
  el("refreshRecovery").addEventListener("click", () => void renderRecoveries());
  el("clip15").addEventListener("click", () => void createQuickClip(15));
  el("clip30").addEventListener("click", () => void createQuickClip(30));
  el("clip60").addEventListener("click", () => void createQuickClip(60));
  el("clipMarker").addEventListener("click", () => void createClipAroundMarker());
  el("selectCombineVideo").addEventListener("click", () => void selectCombineFile("video"));
  el("selectCombineAudio").addEventListener("click", () => void selectCombineFile("audio"));
  el("combineMedia").addEventListener("click", () => void combineMedia());
  el("fetchImportMetadata").addEventListener("click", () => void fetchImportMetadata());
  el("auditSourceImport").addEventListener("click", () => void auditSourceImport());
  ["includeMic", "systemAudioToggle", "micSelect"].forEach((id) => el(id).addEventListener("change", () => { updateAudioStatus(); void saveSettings(); }));
  el("permissionConfirm").addEventListener("change", updatePermissionStatus);
  el("fetchMatchTimeline").addEventListener("click", () => void fetchMatchTimeline());
  el("addManualEvent").addEventListener("click", addManualMatchEvent);
  el("alignMatchClock").addEventListener("click", alignMatchClock);
  document.querySelectorAll(".depth-card").forEach((card) => card.addEventListener("click", () => setHighlightDepth(((card as HTMLElement).dataset.length ?? "15") as HighlightLength)));
  el("generateEssential").addEventListener("click", () => { setHighlightDepth("5"); renderHighlightPackages(["5"]); });
  el("generateBalanced").addEventListener("click", () => { setHighlightDepth("15"); renderHighlightPackages(["15"]); });
  el("generateDeepAnalysis").addEventListener("click", () => { setHighlightDepth("25"); renderHighlightPackages(["25"]); });
  el("generateAllHighlights").addEventListener("click", () => renderHighlightPackages(["5", "15", "25"]));
  ["exportMp4", "generateTranscript", "generateClips", "generateCaptions"].forEach((id) => el(id).addEventListener("click", () => setText("uploadStatus", "Upload to VideoBlitzer first. Backend generation actions will run from the project workspace.")));
}

async function init() {
  appVersion = await window.videoBlitzerRecorder.getAppVersion();
  platformLabel = await window.videoBlitzerRecorder.getPlatform();
  configureMimeOptions();
  await loadSettings();
  await checkApi();
  el("refreshSources").addEventListener("click", () => void refreshSources());
  el("startRecording").addEventListener("click", () => void startRecording());
  el("stopRecording").addEventListener("click", stopRecording);
  el("uploadRecording").addEventListener("click", () => void uploadRecording());
  el("openLocation").addEventListener("click", () => { if (savedFile) void window.videoBlitzerRecorder.openFileLocation(savedFile.filePath); });
  el("selectFolder").addEventListener("click", async () => { const folder = await window.videoBlitzerRecorder.selectOutputFolder(); if (folder) { settings.outputFolder = folder; setText("outputFolder", folder); await saveSettings(); } });
  ["apiUrl", "accessToken", "rememberToken", "includeMic", "quality", "resolution", "frameRate", "existingProjectId"].forEach((id) => el(id).addEventListener("change", () => void saveSettings()));
  setupPremiumInteractions();
  selectMode((document.querySelector(".mode-card.selected") as HTMLElement | null)?.dataset.mode ?? "browser");
  renderMarkerButtons();
  await populateMicrophones();
  void refreshSources();
  void renderRecoveries();
  updatePermissionStatus();
}

void init();
