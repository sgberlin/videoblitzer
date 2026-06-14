import type { RecorderSettings, RecorderSource, SaveRecordingResult, RecordingManifest, RecordingChunkRecord } from "../types";

const preferredMimes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const qualityBitrates = { standard: 5_000_000, high: 10_000_000, match: 15_000_000 } as const;

let sources: RecorderSource[] = [];
let selectedSource: RecorderSource | null = null;
let stream: MediaStream | null = null;
let audioStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let audioRecorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let chunkSaveChain: Promise<void> = Promise.resolve();
let audioChunkSaveChain: Promise<void> = Promise.resolve();
let startedAt = 0;
let timerInterval: number | undefined;
let lastBlob: Blob | null = null;
let savedFile: SaveRecordingResult | null = null;
let selectedMime = "video/webm";
let selectedMode = "browser";
let sourceFilter: "screen" | "window" | "browser" = "screen";
let markers: Array<{ time: string; label: string; note: string; seconds?: number; createdAt?: string }> = [];
let activeManifest: RecordingManifest | null = null;
let activeAudioManifest: RecordingManifest | null = null;
let chunkIndex = 0;
let audioChunkIndex = 0;
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
let settings: RecorderSettings = { apiUrl: "https://api.videoblitzer.com", rememberToken: false, quality: "standard", includeMicrophone: true, includeSystemAudio: false };
type RecorderScreen = "capture" | "upload" | "download" | "advanced";
let activeScreen: RecorderScreen = "capture";
let lastConnectionResult = "not tested";
let authConnected = false;
let secureStorageAvailable = false;
let preloadLoaded = false;
let bridgeAvailable = false;
let lastSidebarClick = "none";
let sourceCount = 0;
let lastSourceRefreshError = "none";
let recentRecordings: SaveRecordingResult[] = [];
let micMonitorStream: MediaStream | null = null;
let micAudioContext: AudioContext | null = null;
let previewStream: MediaStream | null = null;
let previewHealthInterval: number | undefined;
let recordingHealthInterval: number | undefined;
let captureAudioContext: AudioContext | null = null;

function bridge() {
  return window.videoBlitzerRecorder;
}

function startupLog(message: string, details?: Record<string, unknown>) {
  try { window.videoBlitzerRecorder?.startupLog(message, details); } catch { /* logging must not break renderer startup */ }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => startupLog("renderer DOMContentLoaded"));
} else {
  startupLog("renderer DOMContentLoaded", { readyState: document.readyState });
}
startupLog("renderer script loaded");

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

function updateDiagnostics() {
  const build = window.__VB_BUILD_INFO__;
  const screenLabel = activeScreen.replace(/^./, (char) => char.toUpperCase());
  const buildText = build ? `${build.version} ${build.commit} ${build.builtAt}` : `${appVersion} unknown`;
  setText("diagBuildIdentity", buildText);
  setText("diagEnvironment", location.href.includes("app.asar") ? "packaged" : build?.environment ?? "dev");
  setText("buildFooter", `Build: ${buildText}`);
  setText("diagPreloadLoaded", preloadLoaded ? "yes" : "no");
  setText("diagBridgeAvailable", bridgeAvailable ? "yes" : "no");
  setText("diagSafeStorage", secureStorageAvailable ? "yes" : "no");
  setText("activeScreenName", `Screen: ${screenLabel}`);
  setText("diagActiveScreen", screenLabel);
  setText("diagLastSidebarClick", lastSidebarClick);
  setText("diagApiUrl", apiUrl());
  setText("diagTokenPresent", selectedToken() ? "yes" : "no");
  setText("diagConnectionResult", lastConnectionResult);
  setText("diagSourceCount", String(sourceCount));
  setText("diagSourceError", lastSourceRefreshError);
  const storageMode = el<HTMLInputElement>("rememberToken").checked ? (secureStorageAvailable ? "keychain" : "unavailable") : "session only";
  setText("diagTokenStorage", storageMode);
  const warning = el("tokenStorageWarning");
  if (el<HTMLInputElement>("rememberToken").checked && !secureStorageAvailable) {
    warning.textContent = "Secure keychain storage is unavailable. Token will not be persisted after restart.";
  } else if (el<HTMLInputElement>("rememberToken").checked) {
    warning.textContent = "Token will be encrypted with OS secure storage on this device.";
  } else {
    warning.textContent = "Token is kept for this session only unless Remember token is enabled.";
  }
}

function setAuthDisplay(text: string, connected: boolean) {
  for (const id of ["authStatus", "setupAuthStatus"]) {
    const node = el(id);
    node.textContent = text;
    node.classList.toggle("success", connected);
    node.classList.toggle("warning", !connected);
  }
}

function selectedMicLabel() {
  const select = el<HTMLSelectElement>("micSelect");
  return select.selectedOptions[0]?.textContent || "Default microphone";
}

function stopPreviewStream() {
  stopHealthMonitor("preview");
  previewStream?.getTracks().forEach((track) => track.stop());
  previewStream = null;
}

function stopHealthMonitor(kind: "preview" | "recording") {
  if (kind === "preview" && previewHealthInterval) {
    window.clearInterval(previewHealthInterval);
    previewHealthInterval = undefined;
  }
  if (kind === "recording" && recordingHealthInterval) {
    window.clearInterval(recordingHealthInterval);
    recordingHealthInterval = undefined;
    captureAudioContext?.close().catch(() => undefined);
    captureAudioContext = null;
  }
}

function sampleVideoSignal(video: HTMLVideoElement) {
  if (!video.videoWidth || !video.videoHeight) return { ready: false, brightness: 0, contrast: 0 };
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * canvas.width));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { ready: false, brightness: 0, contrast: 0 };
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let total = 0;
  let totalSquared = 0;
  for (let index = 0; index < data.length; index += 4) {
    const value = ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0)) / 3;
    total += value;
    totalSquared += value * value;
  }
  const pixels = data.length / 4;
  const brightness = total / pixels;
  const variance = totalSquared / pixels - brightness * brightness;
  return { ready: true, brightness, contrast: Math.sqrt(Math.max(variance, 0)) };
}

function startHealthMonitor(kind: "preview" | "recording", video: HTMLVideoElement, inputStream: MediaStream, statusId: string) {
  stopHealthMonitor(kind);
  let analyser: AnalyserNode | null = null;
  let audioData: Uint8Array<ArrayBuffer> | null = null;
  const audioTracks = inputStream.getAudioTracks();
  if (kind === "recording" && audioTracks.length) {
    captureAudioContext = new AudioContext();
    analyser = captureAudioContext.createAnalyser();
    analyser.fftSize = 256;
    captureAudioContext.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
    audioData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  }
  const interval = window.setInterval(() => {
    const signal = sampleVideoSignal(video);
    const videoStatus = !signal.ready
      ? "video starting"
      : signal.brightness > 8 || signal.contrast > 4
        ? `video signal ok (${Math.round(signal.brightness)} brightness)`
        : "video signal is very dark";
    let audioStatus = audioTracks.length ? `${audioTracks.length} audio track(s)` : "no audio track";
    if (analyser && audioData) {
      analyser.getByteFrequencyData(audioData);
      const average = audioData.reduce((sum, value) => sum + value, 0) / Math.max(audioData.length, 1);
      audioStatus = average > 2 ? `audio signal ok (${Math.round(average)} level)` : "audio track present, low signal";
    }
    setText(statusId, `${kind === "preview" ? "Preview" : "Recording"} health: ${videoStatus}; ${audioStatus}.`);
  }, 1000);
  if (kind === "preview") previewHealthInterval = interval;
  else recordingHealthInterval = interval;
}

async function updateMicrophonePermissionStatus(request = false) {
  try {
    const result = request ? await bridge().requestMicrophonePermission() : await bridge().microphonePermissionStatus();
    setText("micPermissionStatus", `Permission: ${result.status}${"granted" in result ? (result.granted ? " (granted)" : " (not granted)") : ""}`);
    return result.status;
  } catch (error) {
    setText("micPermissionStatus", `Permission: ${error instanceof Error ? error.message : "unknown"}`);
    return "unknown";
  }
}

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

function updatePackageSummary() {
  setText("finalPackagePath", savedFile?.filePath ?? "No processed package yet.");
  setText("finalPackageSize", savedFile ? `${(savedFile.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "--");
  setText("finalPackageObjectKey", el("objectKey").textContent?.trim() || "Not uploaded.");
  setText("finalPackageAudio", el("audioStatus").textContent?.trim() || "Record and process a clip to verify streams.");
  setText("finalPackageProbe", el("mediaProbeOutput").textContent?.trim() || "Media verification appears here after recording.");
  const projectHtml = el("projectLink").innerHTML.trim();
  el("finalPackageProjectLink").innerHTML = projectHtml || "Not uploaded.";
  el<HTMLButtonElement>("openProjectFromPackage").disabled = !projectHtml;
}

function renderMediaMetadata(meta: { durationSeconds: number | null; format?: string; streams: Array<{ type?: string; codec?: string; durationSeconds?: number | null; channels?: number | null; sampleRate?: string; width?: number; height?: number }>; error?: string }) {
  const audioStreams = meta.streams.filter((stream) => stream.type === "audio");
  const videoStreams = meta.streams.filter((stream) => stream.type === "video");
  const lines = [
    `format: ${meta.format ?? "unknown"}`,
    `duration: ${meta.durationSeconds?.toFixed(2) ?? "unknown"}s`,
    `video streams: ${videoStreams.length}`,
    ...videoStreams.map((stream, index) => `  video ${index + 1}: ${stream.codec ?? "unknown"} ${stream.width ?? "?"}x${stream.height ?? "?"}`),
    `audio streams: ${audioStreams.length}`,
    ...audioStreams.map((stream, index) => `  audio ${index + 1}: ${stream.codec ?? "unknown"} channels=${stream.channels ?? "?"} sampleRate=${stream.sampleRate ?? "?"} duration=${stream.durationSeconds?.toFixed(2) ?? "unknown"}s`),
    ...(meta.error ? [`error: ${meta.error}`] : []),
  ];
  setText("mediaProbeOutput", lines.join("\n"));
  setText("audioStatus", audioStreams.length ? `Audio stream detected: ${audioStreams.map((stream) => stream.codec ?? "unknown").join(", ")}` : "Warning: no audio stream detected");
  if (!audioStreams.length) setText("micWarning", "Warning: this recording has no audio track. Check microphone permission, selected input, and Include microphone audio.");
}

function rememberRecording(recording: SaveRecordingResult) {
  recentRecordings = [recording, ...recentRecordings.filter((item) => item.filePath !== recording.filePath)].slice(0, 8);
  renderRecentRecordings();
}

function selectRecording(recording: SaveRecordingResult) {
  savedFile = recording;
  lastBlob = null;
  setText("savedPath", recording.filePath);
  setText("fileSize", `${(recording.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  el<HTMLButtonElement>("openLocation").disabled = false;
  el<HTMLButtonElement>("uploadRecording").disabled = false;
  setText("uploadStatus", "Recording selected. Upload to VideoBlitzer when ready.");
  updatePackageSummary();
  void window.videoBlitzerRecorder.mediaMetadata(recording.filePath).then((meta) => { renderMediaMetadata(meta); updatePackageSummary(); }).catch((error) => setText("mediaProbeOutput", error instanceof Error ? error.message : "Could not inspect media."));
}

function renderRecentRecordings() {
  const list = el("recentRecordings");
  if (!recentRecordings.length) { list.textContent = "No recent recordings yet."; return; }
  list.innerHTML = "";
  for (const recording of recentRecordings) {
    const row = document.createElement("div");
    row.className = "timeline-item";
    row.innerHTML = `<strong>${recording.filePath.split(/[\\/]/).pop() ?? "Recording"}</strong><br><span class="path">${recording.filePath}</span><br><span>${(recording.sizeBytes / 1024 / 1024).toFixed(1)} MB</span> `;
    const button = document.createElement("button");
    button.className = "ghost-button";
    button.type = "button";
    button.textContent = "Select for upload";
    button.addEventListener("click", () => selectRecording(recording));
    row.appendChild(button);
    list.appendChild(row);
  }
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
    setText("setupApiStatus", response.ok ? "API: online" : "API: unavailable");
  } catch { setText("apiStatus", "API: offline"); setText("setupApiStatus", "API: offline"); }
  if (!selectedToken()) authConnected = false;
  setAuthDisplay(selectedToken() ? (authConnected ? "Auth: connected" : "Auth: token ready") : "Auth: token required", Boolean(selectedToken()) && authConnected);
  updateDiagnostics();
}

async function testConnection() {
  try {
    await checkApi();
    if (!selectedToken()) throw new Error("Paste a Supabase access token first.");
    const response = await fetch(`${apiUrl()}/dashboard`, { headers: headers(selectedToken()) });
    if (!response.ok) throw new Error(safeApiError(await response.text(), `Dashboard check failed with ${response.status}`));
    authConnected = true;
    lastConnectionResult = `connected at ${new Date().toLocaleTimeString()}`;
    setAuthDisplay("Auth: connected", true);
    setText("uploadStatus", "Recorder connection test passed.");
  } catch (error) {
    authConnected = false;
    lastConnectionResult = error instanceof Error ? error.message : "connection test failed";
    setAuthDisplay(selectedToken() ? "Auth: token failed" : "Auth: token required", false);
    setText("uploadStatus", lastConnectionResult);
  } finally {
    updateDiagnostics();
  }
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
  if (!bridgeAvailable) {
    lastConnectionResult = "Electron bridge unavailable. Preload did not initialize.";
    updateDiagnostics();
    return;
  }
  secureStorageAvailable = (await bridge().secureStorageStatus()).encryptionAvailable;
  settings = await bridge().getSettings();
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
  if (settings.selectedSystemAudioDeviceId) el<HTMLSelectElement>("systemAudioSelect").value = settings.selectedSystemAudioDeviceId;
  lastConnectionResult = settings.tokenStorageMode === "unavailable" ? "secure storage unavailable; paste token again" : "not tested";
  updateAudioStatus();
  if (settings.outputFolder) setText("outputFolder", settings.outputFolder);
  updateDiagnostics();
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
    selectedSystemAudioDeviceId: el<HTMLSelectElement>("systemAudioSelect").value || undefined,
    existingProjectId: el<HTMLInputElement>("existingProjectId").value.trim() || undefined,
    autoUpload: false,
  };
  settings.tokenStorageMode = settings.rememberToken ? (secureStorageAvailable ? "keychain" : "unavailable") : "session_only";
  if (!bridgeAvailable) throw new Error("Electron bridge unavailable. Cannot save settings.");
  await bridge().saveSettings(settings);
  await checkApi();
}

async function refreshSources() {
  setStatus("Loading sources");
  try {
    if (!bridgeAvailable) throw new Error("Electron bridge unavailable.");
    sources = await bridge().getSources();
    sourceCount = sources.length;
    lastSourceRefreshError = "none";
  } catch (error) {
    sources = [];
    sourceCount = 0;
    lastSourceRefreshError = error instanceof Error ? error.message : "source refresh failed";
    setStatus("Source refresh failed");
    updateDiagnostics();
  }
  const list = el<HTMLDivElement>("sources");
  list.innerHTML = "";
  const visibleSources = sources.filter((source) => sourceFilter === "browser" ? source.kind === "browser" : source.id.startsWith(sourceFilter));
  updateDiagnostics();
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
  el("previewPlaceholder").textContent = "Starting live preview...";
  setStatus("Source selected");
  void startSourcePreview();
}

async function startSourcePreview() {
  if (!selectedSource) return;
  stopPreviewStream();
  const previewConstraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: selectedSource.id,
        maxFrameRate: 30,
      },
    },
  } as unknown as MediaStreamConstraints;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia(previewConstraints);
    const preview = el<HTMLVideoElement>("preview");
    preview.srcObject = previewStream;
    await preview.play().catch(() => undefined);
    el("preview").parentElement?.classList.add("has-video");
    el("previewPlaceholder").textContent = "";
    startHealthMonitor("preview", preview, previewStream, "previewHealthStatus");
  } catch (error) {
    el("preview").parentElement?.classList.remove("has-video");
    el("previewPlaceholder").textContent = "Live preview unavailable. Start Capture can still request screen permission.";
    setText("previewHealthStatus", "Preview health: unavailable.");
    setText("uploadStatus", error instanceof Error ? friendlyCaptureError(error) : "Live preview could not start.");
  }
}

async function buildVideoStream() {
  if (!selectedSource) throw new Error("Select a screen or window before recording.");
  const resolution = el<HTMLSelectElement>("resolution").value;
  const resolutionConstraints: Record<string, number> = resolution === "720p" ? { maxWidth: 1280, maxHeight: 720 } : resolution === "1080p" ? { maxWidth: 1920, maxHeight: 1080 } : resolution === "1440p" ? { maxWidth: 2560, maxHeight: 1440 } : resolution === "2160p" ? { maxWidth: 3840, maxHeight: 2160 } : {};
  const frameRate = Number(el<HTMLSelectElement>("frameRate").value) || 60;
  const videoConstraints = {
    audio: false,
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

  setText("systemAudioStatus", el<HTMLInputElement>("systemAudioToggle").checked ? "System audio: recording from routed input" : "System audio: off");
  return displayStream;
}

async function buildRoutedAudioStream() {
  const tracks: MediaStreamTrack[] = [];
  if (el<HTMLInputElement>("systemAudioToggle").checked) {
    const deviceId = el<HTMLSelectElement>("systemAudioSelect").value;
    if (!deviceId) throw new Error("Select a routed system audio input such as BlackHole or Loopback before starting guaranteed audio capture.");
    const routedAudio = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
    tracks.push(...routedAudio.getAudioTracks());
    setText("systemAudioStatus", `System audio: attached from ${el<HTMLSelectElement>("systemAudioSelect").selectedOptions[0]?.textContent ?? "selected input"}`);
  }
  if (el<HTMLInputElement>("includeMic").checked) {
    try {
      await updateMicrophonePermissionStatus(true);
      const deviceId = el<HTMLSelectElement>("micSelect").value;
      const mic = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
      tracks.push(...mic.getAudioTracks());
      setText("micTrackStatus", "Audio track attached: yes");
      setText("micDeviceStatus", `Input: ${selectedMicLabel()}`);
    } catch {
      setText("micTrackStatus", "Audio track attached: no");
      setText("uploadStatus", "Microphone permission was blocked or unavailable. Continuing with screen video only; enable microphone permission and retry if narration is required.");
    }
  }
  const finalStream = new MediaStream(tracks);
  const hasAudio = finalStream.getAudioTracks().length > 0;
  setText("audioStatus", hasAudio ? "Separate audio recorder ready" : "No audio detected");
  if (!hasAudio) setText("micWarning", "No audio was detected. On macOS, use a source that exposes audio or a virtual audio device. On Windows, try full-screen capture or another source. You can continue video-only.");
  if (!tracks.length) throw new Error("No audio tracks were available for separate audio recording.");
  return finalStream;
}

async function getMicrophoneStream() {
  await updateMicrophonePermissionStatus(true);
  const deviceId = el<HTMLSelectElement>("micSelect").value;
  const mic = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
  setText("micDeviceStatus", `Input: ${selectedMicLabel()}`);
  setText("micTrackStatus", `Audio track attached: ${mic.getAudioTracks().length ? "yes" : "no"}`);
  return mic;
}

async function enableMicrophoneMonitoring() {
  if (!el<HTMLInputElement>("includeMic").checked || micMonitorStream) return;
  try {
    setText("micWarning", "Requesting microphone access...");
    await startMicMeter();
    setText("micStatus", "Microphone: enabled");
    setText("micWarning", "Microphone enabled. The meter responds to input and narration will attach when recording starts.");
  } catch (error) {
    setText("micTrackStatus", "Audio track attached: no");
    setText("micWarning", error instanceof Error ? `Microphone unavailable: ${error.message}` : "Microphone unavailable.");
  }
}

async function startRecording() {
  try {
    if (!el<HTMLInputElement>("permissionConfirm").checked) throw new Error("Confirm that you are authorized to record this content before starting.");
    if (!settings.outputFolder) throw new Error("Choose and save an output folder before recording so local files are recoverable.");
    await saveSettings();
    stopPreviewStream();
    stopMicMeter();
    stream = await buildVideoStream();
    audioStream = await buildRoutedAudioStream().catch((error) => {
      setText("audioStatus", error instanceof Error ? `Separate audio unavailable: ${error.message}` : "Separate audio unavailable");
      return null;
    });
    const preview = el<HTMLVideoElement>("preview");
    const recordingPreview = el<HTMLVideoElement>("recordingPreview");
    preview.srcObject = stream;
    recordingPreview.srcObject = stream;
    await recordingPreview.play().catch(() => undefined);
    el("preview").parentElement?.classList.add("has-video");
    startHealthMonitor("recording", recordingPreview, stream, "recordingHealthStatus");
    chunks = [];
    chunkSaveChain = Promise.resolve();
    audioChunkSaveChain = Promise.resolve();
    chunkIndex = 0;
    audioChunkIndex = 0;
    activeManifest = createManifest();
    activeAudioManifest = audioStream ? createManifest() : null;
    if (activeAudioManifest) {
      activeAudioManifest.mode = `${selectedMode}_separate_audio`;
      activeAudioManifest.sourceLabel = el<HTMLSelectElement>("systemAudioSelect").selectedOptions[0]?.textContent ?? "Routed audio";
    }
    await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder });
    if (activeAudioManifest) await window.videoBlitzerRecorder.saveManifest({ manifest: activeAudioManifest, outputFolder: settings.outputFolder });
    lastBlob = null;
    savedFile = null;
    const quality = el<HTMLSelectElement>("quality").value as keyof typeof qualityBitrates;
    recorder = new MediaRecorder(stream, { mimeType: selectedMime, videoBitsPerSecond: qualityBitrates[quality] });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunkSaveChain = chunkSaveChain.then(() => saveChunk(event.data));
    };
    recorder.onstop = () => void finishRecording();
    if (audioStream && activeAudioManifest) {
      const audioMime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      audioRecorder = new MediaRecorder(audioStream, { mimeType: audioMime, audioBitsPerSecond: 160_000 });
      audioRecorder.ondataavailable = (event) => {
        if (event.data.size) audioChunkSaveChain = audioChunkSaveChain.then(() => saveAudioChunk(event.data));
      };
    }
    startedAt = Date.now();
    recorder.start(30_000);
    audioRecorder?.start(30_000);
    markers = [];
    renderMarkers();
    timerInterval = window.setInterval(updateTimer, 500);
    el<HTMLButtonElement>("startRecording").disabled = true;
    el<HTMLButtonElement>("stopRecording").disabled = false;
    el<HTMLButtonElement>("pauseRecording").disabled = false;
    el("recBadge").classList.add("active");
    if (!audioStream) startMicMeter();
    setStatus("Recording");
  } catch (error) {
    setStatus("Idle");
    setText("uploadStatus", friendlyCaptureError(error));
  }
}

function stopRecording() {
  if (!recorder || recorder.state === "inactive") return;
  setStatus("Stopping");
  if (audioRecorder && audioRecorder.state !== "inactive") audioRecorder.stop();
  window.setTimeout(() => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, 120);
  el<HTMLButtonElement>("stopRecording").disabled = true;
  el<HTMLButtonElement>("pauseRecording").disabled = true;
}

async function finishRecording() {
  try {
    window.clearInterval(timerInterval);
    timerInterval = undefined;
    stopMicMeter();
    stopHealthMonitor("recording");
    setText("recordingHealthStatus", "Recording health: finalized.");
    el("recBadge").classList.remove("active");
    stream?.getTracks().forEach((track) => track.stop());
    audioStream?.getTracks().forEach((track) => track.stop());
    stream = null;
    audioStream = null;
    await chunkSaveChain;
    await audioChunkSaveChain;
    const fileName = filenameForMime(selectedMime);
    lastBlob = null;
    if (!activeManifest) throw new Error("Recording manifest was not available for finalization.");
    activeManifest.markers = markers;
    activeManifest.durationEstimateSeconds = Math.floor((Date.now() - startedAt) / 1000);
    await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder });
    const videoFile = await window.videoBlitzerRecorder.recoverSession(activeManifest, settings.outputFolder);
    let audioFile: SaveRecordingResult | null = null;
    if (activeAudioManifest?.chunks.length) {
      activeAudioManifest.completedAt = new Date().toISOString();
      activeAudioManifest.durationEstimateSeconds = activeManifest.durationEstimateSeconds;
      await window.videoBlitzerRecorder.saveManifest({ manifest: activeAudioManifest, outputFolder: settings.outputFolder });
      audioFile = await window.videoBlitzerRecorder.recoverSession(activeAudioManifest, settings.outputFolder);
    }
    savedFile = audioFile
      ? await window.videoBlitzerRecorder.combineVideoAudio({ videoPath: videoFile.filePath, audioPath: audioFile.filePath, outputFolder: settings.outputFolder, filename: `VideoBlitzer_Synced_${timestamp()}.mp4`, offsetSeconds: 0, trimToShortest: true })
      : videoFile;
    rememberRecording(savedFile);
    activeManifest.completedAt = new Date().toISOString();
    activeManifest.finalFilePath = savedFile.filePath;
    activeManifest.metadata = { ...activeManifest.metadata, separateCapture: { videoPath: videoFile.filePath, audioPath: audioFile?.filePath, mergedPath: savedFile.filePath, audioOffsetSeconds: 0, trimToShortest: Boolean(audioFile) } };
    await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder });
    setText("savedPath", savedFile.filePath);
    setText("fileSize", `${(savedFile.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
    const mediaMeta = await window.videoBlitzerRecorder.mediaMetadata(savedFile.filePath);
    renderMediaMetadata(mediaMeta);
    updatePackageSummary();
    setStatus("Saved locally");
    setText("uploadStatus", audioFile ? `Saved synced MP4 from separate video/audio capture. Upload when ready.` : `Saved ${fileName} locally. Upload after recording when ready.`);
    el<HTMLButtonElement>("openLocation").disabled = false;
    el<HTMLButtonElement>("uploadRecording").disabled = false;
    el<HTMLButtonElement>("startRecording").disabled = !selectedSource;
    showScreen("upload");
  } catch (error) {
    setStatus("Save failed");
    stopHealthMonitor("recording");
    audioStream?.getTracks().forEach((track) => track.stop());
    audioStream = null;
    setText("uploadStatus", error instanceof Error ? `Could not finalize recording: ${error.message}. Use crash recovery to recover saved chunks.` : "Could not finalize recording. Use crash recovery to recover saved chunks.");
    el<HTMLButtonElement>("startRecording").disabled = !selectedSource;
  }
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
    setText("uploadStatus", "Requesting signed R2 upload URL...");
    const signed = await api<{ signedUrl?: string; uploadUrl?: string; objectKey?: string; key?: string; requiredHeaders?: Record<string, string> }>("/uploads/create-signed-url", { method: "POST", body: JSON.stringify({ projectId: created.project.id, filename, contentType }) });
    const signedUrl = signed.signedUrl ?? signed.uploadUrl;
    const objectKey = signed.objectKey ?? signed.key;
    if (!signedUrl || !objectKey) throw new Error("API did not return a signed upload URL.");

    setText("uploadStatus", `Uploading ${rawFormat.toUpperCase()} directly to Cloudflare R2...`);
    if (lastBlob) await uploadToSignedUrl(lastBlob, signedUrl, signed.requiredHeaders, updateUploadProgress);
    else { await window.videoBlitzerRecorder.uploadLocalFile(savedFile.filePath, signedUrl, signed.requiredHeaders); updateUploadProgress(100); }
    setText("objectKey", objectKey);
    updatePackageSummary();

    setText("uploadStatus", "Saving video record and queuing backend work...");
    const completed = await api<{ video: { id: string }; conversion_job?: { id: string; status: string } }>("/uploads/complete", { method: "POST", body: JSON.stringify({ project_id: created.project.id, object_key: objectKey, filename, content_type: contentType, size_bytes: savedFile.sizeBytes, raw_format: rawFormat, desired_export_format: rawFormat === "webm" ? "mp4" : undefined, recording_mode: selectedMode, source_type: "desktop_recorder", source_label: selectedSource?.name, source_url: metadata.matchMetadata.sourceUrl, permission_confirmed: metadata.permission.permissionConfirmed, permission_confirmed_at: metadata.permission.confirmedAt, recording_metadata: metadata.recordingMetadata, match_metadata: metadata.matchMetadata, markers, chunk_manifest: activeManifest ?? {}, local_original_filename: filename, original_mime_type: contentType, duration_seconds: activeManifest?.durationEstimateSeconds }) });
    if (!completed.conversion_job) {
      if (rawFormat === "webm") await api("/exports/convert", { method: "POST", body: JSON.stringify({ project_id: created.project.id, video_id: completed.video.id, source_object_key: objectKey, source_format: "webm", target_format: "mp4" }) });
    }
    await api("/jobs/analyze", { method: "POST", body: JSON.stringify({ projectId: created.project.id, videoId: completed.video.id }) });
    if (activeManifest) { activeManifest.uploadStatus = "uploaded"; await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: settings.outputFolder }); }
    setText("uploadStatus", rawFormat === "webm" ? "Uploaded. MP4 conversion and analysis are queued for backend processing." : "Uploaded. Analysis is queued for backend processing.");
    el("projectLink").innerHTML = `<a href="https://app.videoblitzer.com/projects/${created.project.id}/overview">Open project in web app</a>`;
    updatePackageSummary();
    setStatus("Uploaded");
    showScreen("download");
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
  if (activeManifest?.finalFilePath && activeManifest.metadata) {
    const stored = activeManifest.metadata as { matchMetadata?: Record<string, string>; permission?: { permissionConfirmed?: boolean; confirmedAt?: string; sourceLabel?: string; recordingMode?: string }; recordingMetadata?: Record<string, unknown> };
    return {
      matchMetadata: stored.matchMetadata ?? {},
      permission: stored.permission ?? { permissionConfirmed: el<HTMLInputElement>("permissionConfirm").checked, confirmedAt: undefined, sourceLabel: activeManifest.sourceLabel, appVersion, recordingMode: activeManifest.mode },
      recordingMetadata: stored.recordingMetadata ?? { mode: activeManifest.mode, sourceLabel: activeManifest.sourceLabel, appVersion, platform: platformLabel, recoveredFromManifest: true },
    };
  }
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
  return { includeMicrophone: el<HTMLInputElement>("includeMic").checked, includeSystemAudio: el<HTMLInputElement>("systemAudioToggle").checked, microphoneDeviceId: el<HTMLSelectElement>("micSelect").value || "default", systemAudioDeviceId: el<HTMLSelectElement>("systemAudioSelect").value || "none" };
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
    if (recorder && recorder.state === "recording") {
      setStatus("Chunk write failed");
      recorder.stop();
    }
  }
}

async function saveAudioChunk(blob: Blob) {
  if (!activeAudioManifest) return;
  const index = ++audioChunkIndex;
  try {
    const chunk = await window.videoBlitzerRecorder.saveRecordingChunk({ sessionId: activeAudioManifest.sessionId, arrayBuffer: await blob.arrayBuffer(), filename: `${activeAudioManifest.sessionId}_audio_chunk_${String(index).padStart(4, "0")}.webm`, outputFolder: settings.outputFolder, index, durationEstimateSeconds: 30 });
    activeAudioManifest.chunks.push(chunk);
    await window.videoBlitzerRecorder.saveManifest({ manifest: activeAudioManifest, outputFolder: settings.outputFolder });
  } catch (error) {
    setText("uploadStatus", error instanceof Error ? `Audio chunk write failed: ${error.message}. Stop recording and check disk permissions.` : "Audio chunk write failed. Stop recording and check disk permissions.");
    if (audioRecorder && audioRecorder.state === "recording") audioRecorder.stop();
  }
}

async function populateMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((item) => item.kind === "audioinput");
    const fillAudioSelect = (selectId: string, defaultLabel: string, currentValue?: string) => {
      const select = el<HTMLSelectElement>(selectId);
      const current = currentValue ?? select.value;
      select.innerHTML = `<option value="">${defaultLabel}</option>`;
      for (const device of audioInputs) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Audio input ${select.length}`;
        select.appendChild(option);
      }
      select.value = current && [...select.options].some((option) => option.value === current) ? current : "";
    };
    fillAudioSelect("micSelect", "Default microphone", settings.selectedMicDeviceId);
    fillAudioSelect("systemAudioSelect", "Select routed audio input", settings.selectedSystemAudioDeviceId);
    if (!settings.selectedSystemAudioDeviceId) {
      const systemSelect = el<HTMLSelectElement>("systemAudioSelect");
      const virtualOption = [...systemSelect.options].find((option) => /blackhole|loopback|soundflower|vb-cable|virtual/i.test(option.textContent ?? ""));
      if (virtualOption) systemSelect.value = virtualOption.value;
    }
    setText("micStatus", audioInputs.length ? `Audio inputs: ${audioInputs.length} found` : "Microphone: no input devices found");
  } catch {
    setText("micWarning", "Microphone devices could not be listed. Grant microphone permission and try again.");
  }
}

function updateAudioStatus() {
  setText("micStatus", el<HTMLInputElement>("includeMic").checked ? "Microphone: on" : "Microphone: off");
  const systemLabel = el<HTMLSelectElement>("systemAudioSelect").selectedOptions[0]?.textContent || "no routed input selected";
  setText("systemAudioStatus", el<HTMLInputElement>("systemAudioToggle").checked ? `System audio: ${systemLabel}` : "System audio: off");
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
        rememberRecording(recovered);
        activeManifest = { ...session, finalFilePath: recovered.filePath, completedAt: new Date().toISOString() };
        markers = (session.markers ?? []) as typeof markers;
        selectedMode = session.mode || selectedMode;
        await window.videoBlitzerRecorder.saveManifest({ manifest: activeManifest, outputFolder: session.outputFolder ?? settings.outputFolder });
        lastBlob = null;
        setText("savedPath", recovered.filePath);
        setText("reviewSource", session.sourceLabel ?? "Recovered source");
        setText("uploadStatus", "Recovered recording locally. Review and upload when ready.");
        el<HTMLButtonElement>("uploadRecording").disabled = false;
        renderMarkers();
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
    rememberRecording(output);
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

async function startMicMeter(inputStream?: MediaStream) {
  const meter = el("micMeter");
  meter.classList.add("active");
  const sourceStream = inputStream ?? await getMicrophoneStream();
  if (!inputStream) micMonitorStream = sourceStream;
  micAudioContext?.close().catch(() => undefined);
  micAudioContext = new AudioContext();
  const analyser = micAudioContext.createAnalyser();
  analyser.fftSize = 256;
  micAudioContext.createMediaStreamSource(sourceStream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  micMeterInterval = window.setInterval(() => {
    analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / Math.max(data.length, 1);
    meter.style.width = `${Math.max(8, Math.min(100, Math.round((average / 128) * 100)))}%`;
  }, 120);
}

function stopMicMeter() {
  if (micMeterInterval) window.clearInterval(micMeterInterval);
  micMeterInterval = undefined;
  micAudioContext?.close().catch(() => undefined);
  micAudioContext = null;
  micMonitorStream?.getTracks().forEach((track) => track.stop());
  micMonitorStream = null;
  el("micMeter").classList.remove("active");
  el<HTMLElement>("micMeter").style.width = "8%";
}

async function testMicrophone() {
  try {
    setText("micWarning", "Testing microphone for 3 seconds...");
    const mic = await getMicrophoneStream();
    await startMicMeter(mic);
    const chunks: BlobPart[] = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const testRecorder = new MediaRecorder(mic, { mimeType });
    testRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve) => { testRecorder.onstop = () => resolve(); });
    testRecorder.start();
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    testRecorder.stop();
    await stopped;
    stopMicMeter();
    mic.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const playback = el<HTMLAudioElement>("micPlayback");
    playback.src = URL.createObjectURL(blob);
    await playback.play().catch(() => undefined);
    setText("micWarning", blob.size > 800 ? `Test Mic recorded ${(blob.size / 1024).toFixed(1)} KB and played it back.` : "Test Mic recorded very little data. Check input level or selected device.");
    setText("micStatus", "Microphone: test complete");
  } catch (error) {
    stopMicMeter();
    setText("micWarning", error instanceof Error ? `Test Mic failed: ${error.message}` : "Test Mic failed.");
    await updateMicrophonePermissionStatus(false);
  }
}

function pauseOrResume() {
  if (!recorder) return;
  const button = el<HTMLButtonElement>("pauseRecording");
  if (recorder.state === "recording") { recorder.pause(); if (audioRecorder?.state === "recording") audioRecorder.pause(); paused = true; button.textContent = "Resume"; setStatus("Paused"); return; }
  if (recorder.state === "paused") { recorder.resume(); if (audioRecorder?.state === "paused") audioRecorder.resume(); paused = false; button.textContent = "Pause"; setStatus("Recording"); }
}

function selectMode(mode: string) {
  selectedMode = mode;
  const label = mode.replace(/-/g, " ").replace(/^./, (char) => char.toUpperCase());
  const modeLabels: Record<string, string> = { browser: "Record Browser or App Window", match: "Capture Match Video", screen: "Screen Walkthrough", business: "Business Demo", training: "Training Video", upload: "Upload Existing Video" };
  setText("selectedModeLabel", modeLabels[mode] ?? label);
  document.querySelectorAll(".mode-card").forEach((card) => card.classList.toggle("selected", (card as HTMLElement).dataset.mode === mode));
  renderMarkerButtons();
}

const screenSections: Record<RecorderScreen, string[]> = {
  capture: ["homeScreen", "setupScreen", "metadataPermissionPanel", "recordingScreen"],
  upload: ["postScreen"],
  download: ["downloadPackagePanel"],
  advanced: ["setupAuthPanel", "recoveryPanel", "matchIntelligencePanel", "combinePanel", "sourceImportPanel"],
};

function showScreen(screen: RecorderScreen) {
  activeScreen = screen;
  lastSidebarClick = screen;
  const allSections = new Set(Object.values(screenSections).flat());
  for (const id of allSections) el(id).classList.toggle("screen-hidden", !screenSections[screen].includes(id));
  document.querySelectorAll("[data-screen]").forEach((button) => {
    const active = (button as HTMLElement).dataset.screen === screen;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  updateDiagnostics();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function diagnosticsSnapshot() {
  const build = window.__VB_BUILD_INFO__;
  return JSON.stringify({
    build,
    preloadLoaded,
    bridgeAvailable,
    safeStorageAvailable: secureStorageAvailable,
    activeScreen,
    lastSidebarClick,
    apiUrl: apiUrl(),
    tokenPresent: Boolean(selectedToken()),
    lastConnectionResult,
    sourceCount,
    lastSourceRefreshError,
    appVersion,
    platformLabel,
  }, null, 2);
}

function setupPremiumInteractions() {
  document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => {
    const target = (button as HTMLElement).dataset.screen;
    if (target === "capture" || target === "upload" || target === "download" || target === "advanced") showScreen(target);
  }));
  startupLog("sidebar handlers attached", { count: document.querySelectorAll("[data-screen]").length });
  document.querySelectorAll(".mode-card").forEach((card) => card.addEventListener("click", () => selectMode((card as HTMLElement).dataset.mode ?? "browser")));
  el("screenTab").addEventListener("click", () => { sourceFilter = "screen"; el("screenTab").classList.add("active"); el("windowTab").classList.remove("active"); el("browserTab").classList.remove("active"); void refreshSources(); });
  el("windowTab").addEventListener("click", () => { sourceFilter = "window"; el("windowTab").classList.add("active"); el("screenTab").classList.remove("active"); el("browserTab").classList.remove("active"); void refreshSources(); });
  el("browserTab").addEventListener("click", () => { sourceFilter = "browser"; el("browserTab").classList.add("active"); el("screenTab").classList.remove("active"); el("windowTab").classList.remove("active"); void refreshSources(); });
  el("pauseRecording").addEventListener("click", pauseOrResume);
  el("cancelUpload").addEventListener("click", () => activeUploadXhr?.abort());
  el("testMic").addEventListener("click", () => void testMicrophone());
  el("refreshRecovery").addEventListener("click", () => void renderRecoveries());
  el("selectCombineVideo").addEventListener("click", () => void selectCombineFile("video"));
  el("selectCombineAudio").addEventListener("click", () => void selectCombineFile("audio"));
  el("combineMedia").addEventListener("click", () => void combineMedia());
  el("fetchImportMetadata").addEventListener("click", () => void fetchImportMetadata());
  el("auditSourceImport").addEventListener("click", () => void auditSourceImport());
  ["includeMic", "systemAudioToggle", "micSelect", "systemAudioSelect"].forEach((id) => el(id).addEventListener("change", () => {
    updateAudioStatus();
    setText("micDeviceStatus", `Input: ${selectedMicLabel()}`);
    if (id === "includeMic" && !el<HTMLInputElement>("includeMic").checked) {
      stopMicMeter();
      setText("micTrackStatus", "Audio track attached: no");
    } else if (id === "includeMic" || id === "micSelect") {
      stopMicMeter();
      void enableMicrophoneMonitoring();
    }
    void saveSettings();
  }));
  el("permissionConfirm").addEventListener("change", updatePermissionStatus);
  el("fetchMatchTimeline").addEventListener("click", () => void fetchMatchTimeline());
  el("addManualEvent").addEventListener("click", addManualMatchEvent);
  el("alignMatchClock").addEventListener("click", alignMatchClock);
  document.querySelectorAll(".depth-card").forEach((card) => card.addEventListener("click", () => setHighlightDepth(((card as HTMLElement).dataset.length ?? "15") as HighlightLength)));
}

async function init() {
  startupLog("renderer JS initialized");
  preloadLoaded = Boolean(window.videoBlitzerRecorder);
  bridgeAvailable = Boolean(window.videoBlitzerRecorder);
  setupPremiumInteractions();
  showScreen("capture");
  updateDiagnostics();
  try {
    if (!bridgeAvailable) throw new Error("Electron preload bridge is unavailable.");
    appVersion = await bridge().getAppVersion();
    platformLabel = await bridge().getPlatform();
  } catch (error) {
    lastConnectionResult = error instanceof Error ? error.message : "preload bridge failed";
    setText("uploadStatus", lastConnectionResult);
  }
  el("refreshSources").addEventListener("click", () => void refreshSources());
  el("startRecording").addEventListener("click", () => void startRecording());
  el("stopRecording").addEventListener("click", stopRecording);
  el("uploadRecording").addEventListener("click", () => void uploadRecording());
  el("openLocation").addEventListener("click", () => { if (savedFile && bridgeAvailable) void bridge().openFileLocation(savedFile.filePath); });
  el("openProjectFromPackage").addEventListener("click", () => {
    const link = el("projectLink").querySelector("a") as HTMLAnchorElement | null;
    if (link?.href && bridgeAvailable) void bridge().openExternal(link.href);
  });
  el("selectFolder").addEventListener("click", async () => { if (!bridgeAvailable) { setText("outputFolder", "Electron bridge unavailable."); return; } const folder = await bridge().selectOutputFolder(); if (folder) { settings.outputFolder = folder; setText("outputFolder", folder); await saveSettings(); } });
  el("saveRecorderSettings").addEventListener("click", () => void saveSettings().then(testConnection));
  el("testConnection").addEventListener("click", () => void testConnection());
  el("clearToken").addEventListener("click", () => { el<HTMLTextAreaElement>("accessToken").value = ""; authConnected = false; void saveSettings(); setAuthDisplay("Auth: token required", false); lastConnectionResult = "token cleared"; updateDiagnostics(); });
  el("openRecorderTokenPage").addEventListener("click", () => { if (bridgeAvailable) void bridge().openExternal("https://app.videoblitzer.com/settings/recorder-token"); else window.open("https://app.videoblitzer.com/settings/recorder-token", "_blank"); });
  el("copyDiagnostics").addEventListener("click", () => { void navigator.clipboard.writeText(diagnosticsSnapshot()).then(() => { lastConnectionResult = "diagnostics copied"; updateDiagnostics(); }).catch(() => { lastConnectionResult = "could not copy diagnostics"; updateDiagnostics(); }); });
  ["apiUrl", "accessToken"].forEach((id) => el(id).addEventListener("input", () => { authConnected = false; void checkApi(); }));
  ["rememberToken", "includeMic", "quality", "resolution", "frameRate", "existingProjectId"].forEach((id) => el(id).addEventListener("change", () => void saveSettings()));
  try {
    configureMimeOptions();
  } catch (error) {
    selectedMime = "video/webm";
    setText("selectedMimeLabel", "video/webm");
    lastConnectionResult = error instanceof Error ? `MediaRecorder setup failed: ${error.message}` : "MediaRecorder setup failed";
  }
  await loadSettings().catch((error) => {
    lastConnectionResult = error instanceof Error ? error.message : "settings load failed";
    updateDiagnostics();
  });
  void updateMicrophonePermissionStatus(false).then(() => {
    window.setTimeout(() => void updateMicrophonePermissionStatus(true), 600);
  });
  await checkApi().catch((error) => {
    lastConnectionResult = error instanceof Error ? error.message : "API check failed";
    updateDiagnostics();
  });
  selectMode((document.querySelector(".mode-card.selected") as HTMLElement | null)?.dataset.mode ?? "browser");
  renderMarkerButtons();
  renderRecentRecordings();
  await populateMicrophones().catch((error) => {
    setText("micStatus", error instanceof Error ? `Microphones unavailable: ${error.message}` : "Microphones unavailable");
  });
  setText("micDeviceStatus", `Input: ${selectedMicLabel()}`);
  void enableMicrophoneMonitoring();
  void refreshSources();
  void renderRecoveries();
  updatePermissionStatus();
  document.body.dataset.recorderReady = "true";
  updateDiagnostics();
}

void init();
