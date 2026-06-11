import type { RecorderSettings, RecorderSource, SaveRecordingResult } from "../types";

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
let settings: RecorderSettings = { apiUrl: "https://api.videoblitzer.com", rememberToken: false, quality: "standard", includeMicrophone: false };

function el<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
function setText(id: string, text: string) { el(id).textContent = text; }
function setStatus(text: string) { setText("recordingStatus", text); }
function timestamp() {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function extensionForMime(mime: string) { return mime.startsWith("video/mp4") ? "mp4" : "webm"; }
function contentTypeForMime(mime: string) { return mime.startsWith("video/mp4") ? "video/mp4" : "video/webm"; }
function filenameForMime(mime: string) { return `videoblitzer-recording-${timestamp()}.${extensionForMime(mime)}`; }
function selectedToken() { return (el<HTMLTextAreaElement>("accessToken").value || "").trim(); }
function apiUrl() { return (el<HTMLInputElement>("apiUrl").value || "https://api.videoblitzer.com").replace(/\/$/, ""); }
function headers(token: string) { return { "Content-Type": "application/json", Authorization: `Bearer ${token}` }; }

function updateTimer() {
  if (!startedAt) { setText("timer", "00:00"); return; }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  setText("timer", `${minutes}:${seconds}`);
}

function updateUploadProgress(value: number) {
  el<HTMLDivElement>("uploadBar").style.width = `${value}%`;
  setText("uploadPercent", `${value}%`);
}

function safeApiError(body: string, fallback: string) {
  try { return (JSON.parse(body) as { error?: string }).error ?? fallback; } catch { return body || fallback; }
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
  setText("authStatus", selectedToken() ? "Auth: token ready" : "Auth: token required");
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
  select.addEventListener("change", () => { selectedMime = select.value; });
}

async function loadSettings() {
  settings = await window.videoBlitzerRecorder.getSettings();
  el<HTMLInputElement>("apiUrl").value = settings.apiUrl;
  el<HTMLTextAreaElement>("accessToken").value = settings.token ?? "";
  el<HTMLInputElement>("rememberToken").checked = settings.rememberToken;
  el<HTMLInputElement>("includeMic").checked = settings.includeMicrophone;
  el<HTMLSelectElement>("quality").value = settings.quality;
  if (settings.outputFolder) setText("outputFolder", settings.outputFolder);
}

async function saveSettings() {
  settings = {
    apiUrl: apiUrl(),
    outputFolder: settings.outputFolder,
    rememberToken: el<HTMLInputElement>("rememberToken").checked,
    token: selectedToken(),
    quality: el<HTMLSelectElement>("quality").value as RecorderSettings["quality"],
    includeMicrophone: el<HTMLInputElement>("includeMic").checked,
  };
  await window.videoBlitzerRecorder.saveSettings(settings);
  await checkApi();
}

async function refreshSources() {
  setStatus("Loading sources");
  sources = await window.videoBlitzerRecorder.getSources();
  const list = el<HTMLDivElement>("sources");
  list.innerHTML = "";
  for (const source of sources) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "source-card";
    card.innerHTML = `<img src="${source.thumbnail}" alt=""><strong>${source.name}</strong><br><small>${source.id}</small>`;
    card.addEventListener("click", () => selectSource(source));
    list.appendChild(card);
  }
  const onlySource = sources[0];
  if (sources.length === 1 && onlySource) selectSource(onlySource);
  setStatus(sources.length ? "Source selected" : "Idle");
}

function selectSource(source: RecorderSource) {
  selectedSource = source;
  setText("selectedSourceLabel", source.name);
  [...document.querySelectorAll(".source-card")].forEach((node, index) => node.classList.toggle("selected", sources[index]?.id === source.id));
  el<HTMLButtonElement>("startRecording").disabled = false;
  setStatus("Source selected");
}

async function buildStream() {
  if (!selectedSource) throw new Error("Select a screen or window before recording.");
  const videoConstraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: selectedSource.id,
        maxFrameRate: 60,
      },
    },
  } as unknown as MediaStreamConstraints;

  const displayStream = await navigator.mediaDevices.getUserMedia(videoConstraints).catch((error) => {
    if (navigator.userAgent.includes("Mac")) {
      throw new Error("Screen recording permission is required. Enable it in System Settings → Privacy & Security → Screen Recording, then restart VideoBlitzer Recorder.");
    }
    throw new Error(`Could not capture the selected source: ${error instanceof Error ? error.message : "permission denied"}`);
  });

  const tracks = [...displayStream.getVideoTracks(), ...displayStream.getAudioTracks()];
  if (el<HTMLInputElement>("includeMic").checked) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      tracks.push(...mic.getAudioTracks());
    } catch {
      setText("uploadStatus", "Microphone permission failed. Continuing with screen video only.");
    }
  }
  return new MediaStream(tracks);
}

async function startRecording() {
  try {
    await saveSettings();
    stream = await buildStream();
    const preview = el<HTMLVideoElement>("preview");
    preview.srcObject = stream;
    chunks = [];
    lastBlob = null;
    savedFile = null;
    const quality = el<HTMLSelectElement>("quality").value as keyof typeof qualityBitrates;
    recorder = new MediaRecorder(stream, { mimeType: selectedMime, videoBitsPerSecond: qualityBitrates[quality], audioBitsPerSecond: 128_000 });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => void finishRecording();
    recorder.start(1000);
    startedAt = Date.now();
    timerInterval = window.setInterval(updateTimer, 500);
    el<HTMLButtonElement>("startRecording").disabled = true;
    el<HTMLButtonElement>("stopRecording").disabled = false;
    setStatus("Recording");
  } catch (error) {
    setStatus("Idle");
    setText("uploadStatus", error instanceof Error ? error.message : "Could not start recording.");
  }
}

function stopRecording() {
  if (!recorder || recorder.state === "inactive") return;
  setStatus("Stopping");
  recorder.stop();
  el<HTMLButtonElement>("stopRecording").disabled = true;
}

async function finishRecording() {
  window.clearInterval(timerInterval);
  timerInterval = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  const blob = new Blob(chunks, { type: contentTypeForMime(selectedMime) });
  lastBlob = blob;
  const fileName = filenameForMime(selectedMime);
  const buffer = await blob.arrayBuffer();
  savedFile = await window.videoBlitzerRecorder.saveRecording(buffer, fileName, settings.outputFolder);
  setText("savedPath", savedFile.filePath);
  setStatus("Saved locally");
  setText("uploadStatus", `Saved ${fileName}. Ready to upload.`);
  el<HTMLButtonElement>("openLocation").disabled = false;
  el<HTMLButtonElement>("uploadRecording").disabled = false;
  el<HTMLButtonElement>("startRecording").disabled = !selectedSource;
}

function uploadToSignedUrl(blob: Blob, signedUrl: string, requiredHeaders: Record<string, string> | undefined, onProgress: (value: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    const headerValue = requiredHeaders?.["Content-Type"] ?? blob.type;
    if (headerValue) xhr.setRequestHeader("Content-Type", headerValue);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 upload failed with status ${xhr.status}`));
    xhr.onerror = () => reject(new Error("R2 upload failed. Check your connection and try again."));
    xhr.send(blob);
  });
}

async function uploadRecording() {
  if (!lastBlob || !savedFile) { setText("uploadStatus", "Record and save a WebM file first."); return; }
  try {
    await saveSettings();
    updateUploadProgress(0);
    setText("uploadStatus", "Creating desktop recorder project...");
    const title = `Desktop recording ${timestamp()}`;
    const created = await api<{ project: { id: string; title: string } }>("/projects", { method: "POST", body: JSON.stringify({ title, source_type: "desktop_recorder" }) });
    setText("projectId", created.project.id);

    const filename = savedFile.filePath.split(/[\\/]/).pop() ?? filenameForMime(selectedMime);
    setText("uploadStatus", "Requesting signed R2 upload URL...");
    const signed = await api<{ signedUrl?: string; uploadUrl?: string; objectKey?: string; key?: string; requiredHeaders?: Record<string, string> }>("/uploads/create-signed-url", { method: "POST", body: JSON.stringify({ projectId: created.project.id, filename, contentType: "video/webm" }) });
    const signedUrl = signed.signedUrl ?? signed.uploadUrl;
    const objectKey = signed.objectKey ?? signed.key;
    if (!signedUrl || !objectKey) throw new Error("API did not return a signed upload URL.");

    setText("uploadStatus", "Uploading WebM directly to Cloudflare R2...");
    await uploadToSignedUrl(lastBlob, signedUrl, signed.requiredHeaders, updateUploadProgress);
    setText("objectKey", objectKey);

    setText("uploadStatus", "Saving video record and queuing MP4 export...");
    const completed = await api<{ video: { id: string }; conversion_job?: { id: string; status: string } }>("/uploads/complete", { method: "POST", body: JSON.stringify({ project_id: created.project.id, object_key: objectKey, filename, content_type: "video/webm", size_bytes: savedFile.sizeBytes, raw_format: "webm", desired_export_format: "mp4" }) });
    if (!completed.conversion_job) {
      await api("/exports/convert", { method: "POST", body: JSON.stringify({ project_id: created.project.id, video_id: completed.video.id, source_object_key: objectKey, source_format: "webm", target_format: "mp4" }) });
    }
    setText("uploadStatus", "Uploaded. MP4 conversion is queued for backend FFmpeg processing.");
    el("projectLink").innerHTML = `<a href="https://app.videoblitzer.com/projects/${created.project.id}/overview">Open project in web app</a>`;
    setStatus("Uploaded");
  } catch (error) {
    setStatus("Upload failed");
    setText("uploadStatus", error instanceof Error ? error.message : "Upload failed.");
  }
}

async function init() {
  configureMimeOptions();
  await loadSettings();
  await checkApi();
  el("refreshSources").addEventListener("click", () => void refreshSources());
  el("startRecording").addEventListener("click", () => void startRecording());
  el("stopRecording").addEventListener("click", stopRecording);
  el("uploadRecording").addEventListener("click", () => void uploadRecording());
  el("openLocation").addEventListener("click", () => { if (savedFile) void window.videoBlitzerRecorder.openFileLocation(savedFile.filePath); });
  el("selectFolder").addEventListener("click", async () => { const folder = await window.videoBlitzerRecorder.selectOutputFolder(); if (folder) { settings.outputFolder = folder; setText("outputFolder", folder); await saveSettings(); } });
  ["apiUrl", "accessToken", "rememberToken", "includeMic", "quality"].forEach((id) => el(id).addEventListener("change", () => void saveSettings()));
  void refreshSources();
}

void init();
