import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, shell, systemPreferences } from "electron";
import { copyFile, mkdir, readFile, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { ClipInput, CombineVideoAudioInput, CropOverlayState, RecorderSettings, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingInput } from "./types";

const startupLogPath = path.join(os.homedir(), "Library", "Logs", "VideoBlitzer", "recorder.log");

function logStartup(message: string, details?: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(startupLogPath), { recursive: true });
    appendFileSync(startupLogPath, `${new Date().toISOString()} ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`);
  } catch {
    // Startup logging must never block the recorder from opening.
  }
}

function writeFatalLog(label: string, error: unknown) {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  logStartup(label, { message });
  try { writeFileSync("/tmp/videoblitzer-recorder-fatal.log", `${new Date().toISOString()} ${label}\n${message}\n`); } catch { /* best effort fatal logging */ }
}

process.on("uncaughtException", (error) => writeFatalLog("uncaughtException", error));
process.on("unhandledRejection", (error) => writeFatalLog("unhandledRejection", error));
logStartup("main module loaded", { packaged: app.isPackaged, appPath: app.getAppPath() });

function resolveBundledTool(packageName: "ffmpeg-static" | "ffprobe-static") {
  try {
    // Keep native tool package resolution out of top-level imports so startup can log failures.
    const resolved = require(packageName) as string | { path?: string; default?: string | { path?: string } } | null;
    if (typeof resolved === "string") return resolved;
    if (typeof resolved?.default === "string") return resolved.default;
    if (resolved?.path) return resolved.path;
    if (typeof resolved?.default === "object" && resolved.default?.path) return resolved.default.path;
    logStartup("media tool package had no usable path", { packageName });
  } catch (error) {
    logStartup("media tool package resolution failed", { packageName, message: error instanceof Error ? error.message : String(error) });
  }
  return undefined;
}

const defaultSettings: RecorderSettings = {
  apiUrl: "https://api.videoblitzer.com",
  rememberToken: false,
  quality: "standard",
  includeMicrophone: true,
  includeSystemAudio: false,
  autoUpload: false,
  resolution: "source",
  frameRate: 60,
};
function userConfigPath() { return path.join(app.getPath("userData"), "recorder-settings.json"); }
function sessionsRoot() { return path.join(app.getPath("userData"), "recording-sessions"); }
function validateFilename(filename: string) { return filename.replace(/[^a-zA-Z0-9._ -]/g, "_").trim().replace(/\s+/g, "_"); }
function sessionDir(sessionId: string, outputFolder?: string) { return path.join(outputFolder || sessionsRoot(), sessionId); }
const allowedPaths = new Set<string>();
const allowedFolders = new Set<string>();
const ffmpegPath = resolveBundledTool("ffmpeg-static") || "ffmpeg";
const ffprobePath = resolveBundledTool("ffprobe-static") || "ffprobe";
logStartup("media tool paths resolved", { ffmpegPath, ffprobePath });
let nativeScreenCapture: { process: ReturnType<typeof spawn>; filePath: string; stderr: string } | null = null;
let mainWindow: BrowserWindow | null = null;

function rememberPath(filePath: string) {
  allowedPaths.add(path.resolve(filePath));
  allowedFolders.add(path.resolve(path.dirname(filePath)));
}

function rememberFolder(folderPath: string) {
  allowedFolders.add(path.resolve(folderPath));
}

function isAllowedPath(filePath: string) {
  const resolved = path.resolve(filePath);
  return allowedPaths.has(resolved) || [...allowedFolders].some((folder) => {
    const root = path.resolve(folder);
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function ensureAllowedFolder(folderPath: string) {
  const resolved = path.resolve(folderPath);
  if (!isAllowedPath(resolved)) throw new Error("Output folder must be selected in VideoBlitzer Screen Recorder before it can be used.");
  return resolved;
}

async function uniqueFilePath(outputFolder: string, filename: string) {
  const parsed = path.parse(validateFilename(filename));
  let candidate = path.join(outputFolder, `${parsed.name}${parsed.ext}`);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = path.join(outputFolder, `${parsed.name}_${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function ensureDiskSpace(outputFolder: string, requiredBytes: number) {
  const stats = await statfs(outputFolder);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const safetyBytes = 256 * 1024 * 1024;
  if (availableBytes < requiredBytes + safetyBytes) {
    throw new Error(`Not enough disk space in ${outputFolder}. Free at least ${Math.ceil((requiredBytes + safetyBytes - availableBytes) / 1024 / 1024)} MB and try again.`);
  }
}

function validateSessionId(sessionId: string) {
  if (!/^[a-zA-Z0-9._-]{8,80}$/.test(sessionId)) throw new Error("Invalid recording session id.");
}

async function readSettings(): Promise<RecorderSettings> {
  try {
    const raw = JSON.parse(await readFile(userConfigPath(), "utf8")) as RecorderSettings;
    for (const root of raw.outputRoots ?? []) rememberFolder(root);
    if (raw.outputFolder) rememberFolder(raw.outputFolder);
    let tokenStorageMode: RecorderSettings["tokenStorageMode"] = "session_only";
    if (raw.rememberToken && raw.tokenEncrypted) {
      tokenStorageMode = safeStorage.isEncryptionAvailable() ? "keychain" : "unavailable";
    }
    // Do not decrypt the remembered token during startup. macOS shows a Keychain
    // prompt for decryptString, which feels like a permission prompt on every launch.
    return { ...defaultSettings, ...raw, rememberToken: false, token: undefined, tokenEncrypted: undefined, tokenStorageMode };
  } catch {
    return defaultSettings;
  }
}

async function writeSettings(settings: RecorderSettings) {
  const roots = Array.from(new Set([...(settings.outputRoots ?? []), settings.outputFolder].filter(Boolean) as string[]));
  roots.forEach(rememberFolder);
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const tokenEncrypted = settings.rememberToken && settings.token && canEncrypt ? safeStorage.encryptString(settings.token).toString("base64") : undefined;
  const tokenStorageMode: RecorderSettings["tokenStorageMode"] = settings.rememberToken ? (canEncrypt && tokenEncrypted ? "keychain" : "unavailable") : "session_only";
  const safeSettings = { ...settings, outputRoots: roots, token: undefined, tokenEncrypted, tokenStorageMode };
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(userConfigPath(), JSON.stringify(safeSettings, null, 2));
  return { ok: true };
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1800)}`)));
  });
}

async function ffprobeMediaMetadata(filePath: string) {
  return new Promise<{ durationSeconds: number | null; format?: string; streams: Array<{ index?: number; type?: string; codec?: string; durationSeconds?: number | null; channels?: number | null; sampleRate?: string; width?: number; height?: number }>; error?: string }>((resolve) => {
    const child = spawn(ffprobePath, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ durationSeconds: null, streams: [], error: error.message }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<Record<string, unknown>> };
        resolve({
          durationSeconds: Number.isFinite(Number(parsed.format?.duration)) ? Number(parsed.format?.duration) : null,
          format: parsed.format?.format_name,
          streams: (parsed.streams ?? []).map((stream) => ({
            index: typeof stream.index === "number" ? stream.index : undefined,
            type: typeof stream.codec_type === "string" ? stream.codec_type : undefined,
            codec: typeof stream.codec_name === "string" ? stream.codec_name : undefined,
            durationSeconds: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null,
            channels: typeof stream.channels === "number" ? stream.channels : null,
            sampleRate: typeof stream.sample_rate === "string" ? stream.sample_rate : undefined,
            width: typeof stream.width === "number" ? stream.width : undefined,
            height: typeof stream.height === "number" ? stream.height : undefined,
          })),
        });
      } catch (error) {
        resolve({ durationSeconds: null, streams: [], error: stderr || (error instanceof Error ? error.message : "ffprobe failed") });
      }
    });
  });
}

async function ffprobeDuration(filePath: string) {
  return (await ffprobeMediaMetadata(filePath)).durationSeconds;
}

async function saveManifest(input: SaveManifestInput) {
  validateSessionId(input.manifest.sessionId);
  if (input.outputFolder) ensureAllowedFolder(input.outputFolder);
  const dir = sessionDir(input.manifest.sessionId, input.outputFolder);
  await mkdir(dir, { recursive: true });
  rememberFolder(dir);
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(input.manifest, null, 2));
  return { ok: true, manifestPath: path.join(dir, "manifest.json") };
}

async function readManifest(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as RecordingManifest;
}

async function listRecoverableSessions() {
  const settings = await readSettings();
  const roots = Array.from(new Set([sessionsRoot(), app.getPath("videos"), settings.outputFolder, ...(settings.outputRoots ?? [])].filter(Boolean) as string[]));
  const sessions: RecordingManifest[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of await readdir(root).catch(() => [])) {
      const file = path.join(root, name, "manifest.json");
      if (!existsSync(file)) continue;
      const manifest = await readManifest(file).catch(() => null);
      const chunks = manifest?.chunks ?? [];
      const readableChunks = chunks.filter((chunk) => chunk.filePath && existsSync(chunk.filePath) && isAllowedPath(chunk.filePath));
      if (manifest?.sessionId && manifest.uploadStatus !== "uploaded" && !manifest.completedAt && readableChunks.length) {
        sessions.push({ ...manifest, chunks: readableChunks });
      }
    }
  }
  return sessions.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function recoverSession(manifest: RecordingManifest, outputFolder?: string) {
  if (!manifest.chunks.length) throw new Error("No chunks were found for this recording session.");
  if (manifest.outputFolder) ensureAllowedFolder(manifest.outputFolder);
  if (outputFolder) ensureAllowedFolder(outputFolder);
  const outputName = validateFilename(`${manifest.sessionId}_recovered.webm`);
  const outputPath = path.join(outputFolder || app.getPath("videos"), outputName);
  const listPath = path.join(sessionDir(manifest.sessionId, manifest.outputFolder), "concat.txt");
  const readableChunks = manifest.chunks.filter((chunk) => existsSync(chunk.filePath) && isAllowedPath(chunk.filePath));
  const chunkLines = readableChunks.map((chunk) => `file '${chunk.filePath.replace(/'/g, "'\\''")}'`).join("\n");
  if (!chunkLines) throw new Error("No readable chunks were found. Check that the output folder is still available.");
  await writeFile(listPath, chunkLines);
  try {
    await runCommand(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
    if (await ffprobeDuration(outputPath) === null) throw new Error("Recovered copy output failed validation.");
  } catch {
    await runCommand(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libvpx-vp9", "-b:v", "2M", "-c:a", "libopus", outputPath]);
    if (await ffprobeDuration(outputPath) === null) throw new Error("Recovered recording could not be validated after remux/re-encode.");
  }
  rememberPath(outputPath);
  return { filePath: outputPath, sizeBytes: (await stat(outputPath)).size };
}

function showStartupErrorWindow(title: string, message: string) {
  logStartup("showing startup error window", { title, message });
  const errorWindow = new BrowserWindow({
    width: 900,
    height: 520,
    title: "VideoBlitzer Screen Recorder Startup Error",
    backgroundColor: "#19090b",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const escapedTitle = title.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  const escapedMessage = message.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <head><title>${escapedTitle}</title><style>body{margin:0;background:#19090b;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:40px;line-height:1.5}.card{max-width:760px;border:1px solid #5f232c;border-radius:18px;background:#271014;padding:28px}code{color:#f8b4c0}</style></head>
      <body><div class="card"><h1>${escapedTitle}</h1><p>${escapedMessage}</p><p>Startup log: <code>${startupLogPath}</code></p></div></body>
    </html>
  `)}`);
}

function nativeScreenCaptureHelperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "native", "VideoBlitzerScreenCapture");
  return path.join(app.getAppPath(), "dist", "native", "VideoBlitzerScreenCapture");
}

async function startNativeScreenCapture(input: { outputFolder?: string; filename?: string; displayId?: string; frameRate?: number }) {
  if (nativeScreenCapture) throw new Error("Native screen capture is already running.");
  const outputFolder = input.outputFolder || app.getPath("videos");
  ensureAllowedFolder(outputFolder);
  await mkdir(outputFolder, { recursive: true });
  rememberFolder(outputFolder);
  const filePath = await uniqueFilePath(outputFolder, input.filename || `VideoBlitzer_NativeScreen_${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
  const helperPath = nativeScreenCaptureHelperPath();
  if (!existsSync(helperPath)) throw new Error(`ScreenCaptureKit helper was not found at ${helperPath}. Rebuild the recorder.`);
  const args = ["--output", filePath, "--fps", String(input.frameRate || 60)];
  if (input.displayId) args.push("--display-id", input.displayId);
  const child = spawn(helperPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  nativeScreenCapture = { process: child, filePath, stderr };
  logStartup("native screen capture starting", { helperPath, filePath, displayId: input.displayId });
  return await new Promise<{ ok: true; filePath: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeScreenCapture = null;
      child.kill("SIGTERM");
      reject(new Error(`ScreenCaptureKit helper did not start. ${stderr.slice(-800)}`.trim()));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("VIDEO_BLITZER_SCK_STARTED")) {
        clearTimeout(timer);
        resolve({ ok: true, filePath });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (nativeScreenCapture) nativeScreenCapture.stderr = stderr;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      nativeScreenCapture = null;
      reject(error);
    });
    child.on("close", (code) => {
      if (stdout.includes("VIDEO_BLITZER_SCK_STARTED")) return;
      clearTimeout(timer);
      nativeScreenCapture = null;
      reject(new Error(`ScreenCaptureKit helper exited before capture started (${code}). ${stderr.slice(-800)}`.trim()));
    });
  });
}

async function stopNativeScreenCapture() {
  const capture = nativeScreenCapture;
  if (!capture) throw new Error("Native screen capture is not running.");
  nativeScreenCapture = null;
  capture.process.kill("SIGINT");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      capture.process.kill("SIGTERM");
      resolve();
    }, 8_000);
    capture.process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (!existsSync(capture.filePath)) throw new Error(`Native screen capture did not create ${capture.filePath}. ${capture.stderr.slice(-800)}`.trim());
  const sizeBytes = (await stat(capture.filePath)).size;
  if (!sizeBytes) throw new Error(`Native screen capture created an empty file. ${capture.stderr.slice(-800)}`.trim());
  rememberPath(capture.filePath);
  return { filePath: capture.filePath, sizeBytes };
}

let cropOverlayWindow: BrowserWindow | null = null;
let cropOverlayState: CropOverlayState = { visible: false, locked: false, bounds: { x: 160, y: 120, width: 960, height: 540 }, aspect: "16:9" };

function updateCropOverlayStateFromWindow() {
  if (!cropOverlayWindow || cropOverlayWindow.isDestroyed()) return;
  cropOverlayState = { ...cropOverlayState, visible: cropOverlayWindow.isVisible(), bounds: cropOverlayWindow.getBounds() };
}

function createCropOverlayWindow() {
  if (cropOverlayWindow && !cropOverlayWindow.isDestroyed()) return cropOverlayWindow;
  const primary = screen.getPrimaryDisplay().workArea;
  cropOverlayState.bounds = cropOverlayState.bounds.width > 0 ? cropOverlayState.bounds : { x: primary.x + 160, y: primary.y + 120, width: 960, height: 540 };
  cropOverlayWindow = new BrowserWindow({
    ...cropOverlayState.bounds,
    minWidth: 240,
    minHeight: 135,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "VideoBlitzer Crop Frame",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  cropOverlayWindow.setAlwaysOnTop(true, "screen-saver");
  cropOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  cropOverlayWindow.on("move", updateCropOverlayStateFromWindow);
  cropOverlayWindow.on("resize", updateCropOverlayStateFromWindow);
  cropOverlayWindow.on("show", updateCropOverlayStateFromWindow);
  cropOverlayWindow.on("hide", updateCropOverlayStateFromWindow);
  cropOverlayWindow.on("closed", () => {
    cropOverlayState = { ...cropOverlayState, visible: false };
    cropOverlayWindow = null;
  });
  const overlayPath = path.join(app.getAppPath(), "dist", "renderer", "crop-overlay.html");
  cropOverlayWindow.loadFile(overlayPath).catch((error: unknown) => logStartup("crop overlay load failed", { message: error instanceof Error ? error.message : String(error) }));
  return cropOverlayWindow;
}

function setCropOverlayLocked(locked: boolean) {
  cropOverlayState = { ...cropOverlayState, locked };
  if (!cropOverlayWindow || cropOverlayWindow.isDestroyed()) return;
  cropOverlayWindow.setIgnoreMouseEvents(locked, { forward: true });
  cropOverlayWindow.webContents.send("crop-overlay-state", cropOverlayState);
}

function createWindow() {
  const runNavigationSmoke = process.env.VB_RECORDER_SMOKE_NAVIGATION === "1";
  const smokeScreenshotPath = process.env.VB_RECORDER_SCREENSHOT_PATH;
  logStartup("creating BrowserWindow", { preload: path.join(app.getAppPath(), "dist", "preload.js") });
  const window = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    show: false,
    paintWhenInitiallyHidden: true,
    title: "VideoBlitzer Screen Recorder",
    backgroundColor: "#061018",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;
  logStartup("BrowserWindow created", { id: window.id });
  const showMainWindow = (reason: string) => {
    logStartup("showing BrowserWindow", { id: window.id, reason, visible: window.isVisible(), minimized: window.isMinimized() });
    if (process.platform === "darwin") app.dock?.show();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.moveTop();
  };
  window.once("ready-to-show", () => showMainWindow("ready-to-show"));
  window.on("show", () => logStartup("BrowserWindow shown", { id: window.id }));
  window.on("closed", () => {
    if (mainWindow?.id === window.id) mainWindow = null;
    logStartup("BrowserWindow closed", { id: window.id });
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    logStartup("preload-error", { preloadPath, message: error.message, stack: error.stack });
    showStartupErrorWindow("Preload failed", error.message);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    logStartup("did-fail-load", { errorCode, errorDescription, validatedUrl });
    showStartupErrorWindow("Renderer failed to load", `${errorDescription} (${errorCode})`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logStartup("render-process-gone", details as unknown as Record<string, unknown>);
    showStartupErrorWindow("Renderer process stopped", `${details.reason} (${details.exitCode})`);
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logStartup("renderer console", { level, message, line, sourceId });
  });
  window.webContents.on("did-frame-finish-load", () => {
    void window.webContents.executeJavaScript(`
      ({
        readyState: document.readyState,
        title: document.title,
        rendererScript: Boolean([...document.scripts].find((script) => script.src.includes("renderer.js"))),
        bridge: Boolean(window.videoBlitzerRecorder),
        activeScreen: document.getElementById("diagActiveScreen")?.textContent ?? null,
        bodyClass: document.body?.className ?? null,
      })
    `).then((state) => logStartup("renderer DOM probe", state as Record<string, unknown>)).catch((error: unknown) => {
      logStartup("renderer DOM probe failed", { message: error instanceof Error ? error.message : String(error) });
    });
  });
  window.webContents.on("did-finish-load", () => {
    logStartup("renderer file URL loaded", { url: window.webContents.getURL() });
    showMainWindow("did-finish-load");
  });
  if (runNavigationSmoke) {
    console.log("VIDEO_BLITZER_PACKAGED_SMOKE_START");
    const runSmoke = () => {
      void window.webContents.executeJavaScript(`
        (async () => {
          for (let attempt = 0; attempt < 40 && document.body?.dataset.recorderReady !== "true"; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const visible = (id) => !document.getElementById(id)?.classList.contains("screen-hidden");
          const click = (screen) => {
            document.querySelector('[data-screen="' + screen + '"]').click();
            return {
              screen,
              activeScreen: document.getElementById("diagActiveScreen")?.textContent,
              lastSidebarClick: document.getElementById("diagLastSidebarClick")?.textContent,
              setupVisible: visible("setupScreen"),
              captureVisible: visible("recordingScreen"),
              uploadVisible: visible("postScreen"),
              downloadVisible: visible("downloadPackagePanel"),
              advancedVisible: visible("setupAuthPanel"),
            };
          };
          const result = {
            build: document.getElementById("diagBuildIdentity")?.textContent,
            environment: document.getElementById("diagEnvironment")?.textContent,
            preloadLoaded: document.getElementById("diagPreloadLoaded")?.textContent,
            bridgeAvailable: document.getElementById("diagBridgeAvailable")?.textContent,
            safeStorage: document.getElementById("diagSafeStorage")?.textContent,
            capture: click("capture"),
            upload: click("upload"),
            download: click("download"),
            advanced: click("advanced"),
            requiredControls: ["saveRecorderSettings", "testConnection", "clearToken", "openRecorderTokenPage", "copyDiagnostics", "refreshSources", "startRecording", "stopRecording", "selectFolder", "uploadRecording", "openLocation", "openProjectFromPackage"].every((id) => Boolean(document.getElementById(id))),
            audioDiagnostics: ["micPermissionStatus", "micDeviceStatus", "micTrackStatus", "micMeter", "micPlayback", "mediaProbeOutput"].every((id) => Boolean(document.getElementById(id))),
            diagnosticsVisible: visible("setupAuthPanel") || Boolean(document.getElementById("diagBuildIdentity")?.textContent),
          };
          result.passed = Boolean(
            result.build &&
            result.environment === "packaged" &&
            result.preloadLoaded === "yes" &&
            result.bridgeAvailable === "yes" &&
            result.capture.captureVisible &&
            result.capture.setupVisible &&
            result.upload.uploadVisible &&
            result.download.downloadVisible &&
            result.advanced.advancedVisible &&
            result.requiredControls &&
            result.audioDiagnostics &&
            result.diagnosticsVisible
          );
          return result;
        })();
      `).then((result) => {
        console.log(`VIDEO_BLITZER_PACKAGED_SMOKE ${JSON.stringify(result)}`);
        const finish = () => app.exit(result.passed ? 0 : 1);
        const screenshotPathForScreen = (screen: string) => {
          if (!smokeScreenshotPath) return undefined;
          const parsed = path.parse(smokeScreenshotPath);
          return path.join(parsed.dir, `${parsed.name}-${screen}${parsed.ext || ".png"}`);
        };
        if (smokeScreenshotPath) {
          (async () => {
            for (const screen of ["capture", "upload", "download", "advanced"]) {
              if (window.isDestroyed()) return;
              await window.webContents.executeJavaScript(`document.querySelector('[data-screen="${screen}"]').click()`);
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (window.isDestroyed()) return;
              const image = await window.webContents.capturePage();
              const filePath = screenshotPathForScreen(screen);
              if (filePath) writeFileSync(filePath, image.toPNG());
            }
          })().then(() => {
            logStartup("packaged smoke screenshots written", { smokeScreenshotPath });
            finish();
          }).catch((error: unknown) => {
            logStartup("packaged smoke screenshot failed", { message: error instanceof Error ? error.message : String(error) });
            finish();
          });
        } else {
          finish();
        }
      }).catch((error) => {
        console.error("VIDEO_BLITZER_PACKAGED_SMOKE_FAILED", error);
        app.exit(1);
      });
    };
    window.webContents.on("did-finish-load", () => {
      setTimeout(runSmoke, 1500);
    });
    window.webContents.on("did-fail-load", (_event, _code, description) => {
      console.error("VIDEO_BLITZER_PACKAGED_SMOKE_LOAD_FAILED", description);
      app.exit(1);
    });
    setTimeout(() => {
      if (!window.webContents.isLoading()) runSmoke();
    }, 5000);
  }
  const rendererPath = path.join(app.getAppPath(), "dist", "renderer", "index.html");
  logStartup("loading renderer file", { rendererPath });
  window.loadFile(rendererPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logStartup("loadFile rejected", { message });
    showStartupErrorWindow("Renderer load failed", message);
  });
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) showMainWindow("startup fallback timer");
  }, 2500);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return Promise.race<T>([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function runCaptureDiagnostic() {
  const screenStatus = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "unknown";
  const microphoneStatus = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "unknown";
  const [screenSources, windowSources] = await withTimeout(Promise.all([
    desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true }),
    desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true }),
  ]), 8000, "desktopCapturer.getSources");
  const source = screenSources[0];
  const result: Record<string, unknown> = {
    appPath: app.getAppPath(),
    packaged: app.isPackaged,
    screenPermission: screenStatus,
    microphonePermission: microphoneStatus,
    screenSourceCount: screenSources.length,
    windowSourceCount: windowSources.length,
    selectedSource: source ? { id: source.id, name: source.name, displayId: source.display_id } : null,
  };
  if (!source) {
    console.log(`VIDEO_BLITZER_CAPTURE_DIAGNOSTIC ${JSON.stringify({ ...result, capture: { ok: false, message: "No screen sources returned by desktopCapturer." } })}`);
    app.exit(2);
    return;
  }
  const diagnosticWindow = new BrowserWindow({
    width: 720,
    height: 480,
    title: "VideoBlitzer Capture Diagnostic",
    backgroundColor: "#101827",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await diagnosticWindow.loadURL("data:text/html;charset=utf-8,<html><body style='margin:0;background:#101827;color:white;font:14px system-ui;display:grid;place-items:center;height:100vh'>Running VideoBlitzer capture diagnostic...</body></html>");
  const capture = await withTimeout(diagnosticWindow.webContents.executeJavaScript(`
    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: ${JSON.stringify(source.id)}, maxFrameRate: 10 } }
      });
      const [track] = stream.getVideoTracks();
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      document.body.innerHTML = "";
      document.body.appendChild(video);
      await video.play().catch(() => undefined);
      await new Promise((resolve) => {
        if (video.videoWidth && video.videoHeight) resolve(undefined);
        else video.onloadedmetadata = () => resolve(undefined);
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(160, video.videoWidth || 160);
      canvas.height = Math.min(90, video.videoHeight || 90);
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      let totalLuma = 0;
      for (let index = 0; index < data.length; index += 4) {
        const luma = (data[index] + data[index + 1] + data[index + 2]) / 3;
        totalLuma += luma;
        if (luma > 8) nonBlackPixels += 1;
      }
      const output = {
        ok: true,
        trackReadyState: track.readyState,
        trackMuted: track.muted,
        trackSettings: track.getSettings(),
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        nonBlackPixelRatio: nonBlackPixels / (canvas.width * canvas.height),
        averageLuma: totalLuma / (canvas.width * canvas.height),
      };
      stream.getTracks().forEach((item) => item.stop());
      return output;
    })().catch((error) => ({ ok: false, name: error?.name, message: error?.message }));
  `), 15000, "renderer getUserMedia capture");
  console.log(`VIDEO_BLITZER_CAPTURE_DIAGNOSTIC ${JSON.stringify({ ...result, capture })}`);
  app.exit(capture?.ok ? 0 : 1);
}

app.whenReady().then(() => {
  logStartup("app ready", { packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  if (process.env.VB_RECORDER_CAPTURE_DIAG === "1") {
    void runCaptureDiagnostic().catch((error: unknown) => {
      console.log(`VIDEO_BLITZER_CAPTURE_DIAGNOSTIC ${JSON.stringify({ capture: { ok: false, message: error instanceof Error ? error.message : String(error) } })}`);
      app.exit(1);
    });
    return;
  }
  rememberFolder(sessionsRoot());
  rememberFolder(app.getPath("videos"));
  ipcMain.on("startup-log", (_event, message: string, details?: Record<string, unknown>) => logStartup(message, details));
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-platform", () => process.platform);
  ipcMain.handle("secure-storage-status", () => ({ encryptionAvailable: safeStorage.isEncryptionAvailable() }));
  ipcMain.handle("microphone-permission-status", () => ({ status: process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("microphone") : "unknown" }));
  ipcMain.handle("request-microphone-permission", async () => {
    if (process.platform !== "darwin") return { granted: true, status: "not_required" };
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return { granted, status: systemPreferences.getMediaAccessStatus("microphone") };
  });
  ipcMain.handle("show-crop-overlay", (_event, aspect: CropOverlayState["aspect"] = "16:9") => {
    cropOverlayState = { ...cropOverlayState, aspect, visible: true };
    const overlay = createCropOverlayWindow();
    overlay.setAspectRatio(aspect === "source" ? 0 : aspect === "4:3" ? 4 / 3 : aspect === "9:16" ? 9 / 16 : 16 / 9);
    overlay.showInactive();
    overlay.webContents.send("crop-overlay-state", cropOverlayState);
    updateCropOverlayStateFromWindow();
    return cropOverlayState;
  });
  ipcMain.handle("hide-crop-overlay", () => {
    cropOverlayWindow?.hide();
    updateCropOverlayStateFromWindow();
    return cropOverlayState;
  });
  ipcMain.handle("lock-crop-overlay", (_event, locked: boolean) => {
    setCropOverlayLocked(Boolean(locked));
    return cropOverlayState;
  });
  ipcMain.handle("get-crop-overlay-state", () => {
    updateCropOverlayStateFromWindow();
    return cropOverlayState;
  });
  ipcMain.handle("hide-recorder-window", () => {
    mainWindow?.hide();
    return { ok: true };
  });
  ipcMain.handle("show-recorder-window", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    return { ok: true };
  });
  ipcMain.handle("get-settings", readSettings);
  ipcMain.handle("save-settings", (_event, settings: RecorderSettings) => writeSettings(settings));
  ipcMain.handle("start-native-screen-capture", (_event, input: { outputFolder?: string; filename?: string; displayId?: string; frameRate?: number }) => startNativeScreenCapture(input));
  ipcMain.handle("stop-native-screen-capture", () => stopNativeScreenCapture());
  ipcMain.handle("get-sources", async () => {
    const [screenSources, windowSources] = await Promise.all([
      desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true }),
      desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true }),
    ]);
    const sources = [...screenSources, ...windowSources];
    const displays = screen.getAllDisplays();
    return sources.map((source) => {
      const lower = source.name.toLowerCase();
      const isBrowser = ["chrome", "safari", "firefox", "edge", "brave", "browser"].some((label) => lower.includes(label));
      const display = source.display_id ? displays.find((item) => String(item.id) === source.display_id) : undefined;
      return { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), kind: source.id.startsWith("screen") ? "screen" : isBrowser ? "browser" : "window", displayId: source.display_id, bounds: display?.bounds, scaleFactor: display?.scaleFactor };
    });
  });
  ipcMain.handle("select-output-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled) return undefined;
    const folder = result.filePaths[0];
    if (!folder) return undefined;
    rememberFolder(folder);
    return folder;
  });
  ipcMain.handle("select-media-file", async (_event, kind: "video" | "audio" | "any") => {
    const filters = kind === "video" ? [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm"] }] : kind === "audio" ? [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "ogg", "flac"] }] : [{ name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "wav", "mp3", "m4a", "aac", "ogg", "flac"] }];
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
    if (result.canceled) return undefined;
    const filePath = result.filePaths[0];
    if (!filePath) return undefined;
    rememberPath(filePath);
    return filePath;
  });
  ipcMain.handle("save-recording", async (_event, input: SaveRecordingInput) => {
    if (!input?.arrayBuffer || !input.filename) throw new Error("Recording data and filename are required.");
    const outputFolder = input.outputFolder || app.getPath("videos");
    ensureAllowedFolder(outputFolder);
    if (!existsSync(outputFolder)) await mkdir(outputFolder, { recursive: true });
    rememberFolder(outputFolder);
    const buffer = Buffer.from(new Uint8Array(input.arrayBuffer));
    await ensureDiskSpace(outputFolder, buffer.byteLength);
    const filePath = await uniqueFilePath(outputFolder, input.filename);
    await writeFile(filePath, buffer);
    rememberPath(filePath);
    return { filePath, sizeBytes: buffer.byteLength };
  });
  ipcMain.handle("save-recording-chunk", async (_event, input: SaveChunkInput) => {
    validateSessionId(input.sessionId);
    if (input.outputFolder) ensureAllowedFolder(input.outputFolder);
    const dir = sessionDir(input.sessionId, input.outputFolder);
    await mkdir(dir, { recursive: true });
    rememberFolder(dir);
    const buffer = Buffer.from(new Uint8Array(input.arrayBuffer));
    await ensureDiskSpace(dir, buffer.byteLength);
    const filePath = await uniqueFilePath(dir, input.filename);
    await writeFile(filePath, buffer);
    rememberPath(filePath);
    return { index: input.index, filename: path.basename(filePath), filePath, sizeBytes: buffer.byteLength, durationEstimateSeconds: input.durationEstimateSeconds, createdAt: new Date().toISOString() };
  });
  ipcMain.handle("save-manifest", (_event, input: SaveManifestInput) => saveManifest(input));
  ipcMain.handle("list-recoverable-sessions", listRecoverableSessions);
  ipcMain.handle("recover-session", (_event, manifest: RecordingManifest, outputFolder?: string) => recoverSession(manifest, outputFolder));
  ipcMain.handle("media-metadata", async (_event, filePath: string) => {
    if (!filePath || !isAllowedPath(filePath)) throw new Error("File path is required and must be selected through VideoBlitzer Screen Recorder.");
    return ffprobeMediaMetadata(filePath);
  });
  ipcMain.handle("read-local-file", async (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath) || !isAllowedPath(filePath)) throw new Error("Selected file does not exist or was not created by VideoBlitzer Screen Recorder.");
    const buffer = await readFile(filePath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return { arrayBuffer, sizeBytes: buffer.byteLength };
  });
  ipcMain.handle("upload-local-file", async (_event, input: { filePath: string; signedUrl: string; headers?: Record<string, string> }) => {
    if (!input.filePath || !existsSync(input.filePath) || !isAllowedPath(input.filePath)) throw new Error("Selected file does not exist or is not trusted for upload.");
    const response = await fetch(input.signedUrl, {
      method: "PUT",
      headers: input.headers ?? {},
      body: createReadStream(input.filePath) as unknown as BodyInit,
      // Node's fetch requires this when sending a stream body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new Error(`Upload to R2 failed with status ${response.status}.`);
    return { ok: true };
  });
  ipcMain.handle("create-clip", async (_event, input: ClipInput) => {
    if (!input.sourcePath || !existsSync(input.sourcePath) || !isAllowedPath(input.sourcePath)) throw new Error("Choose an existing source recording before creating a clip.");
    if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0) throw new Error("Clip start must be a valid timestamp.");
    const outputFolder = input.outputFolder || path.dirname(input.sourcePath);
    ensureAllowedFolder(outputFolder);
    await mkdir(outputFolder, { recursive: true });
    rememberFolder(outputFolder);
    const outputPath = await uniqueFilePath(outputFolder, input.filename);
    const duration = input.durationSeconds ?? (input.endSeconds && input.endSeconds > input.startSeconds ? input.endSeconds - input.startSeconds : undefined);
    const args = input.exactCut
      ? ["-y", "-i", input.sourcePath, "-ss", String(input.startSeconds), ...(duration ? ["-t", String(duration)] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", outputPath]
      : ["-y", "-ss", String(input.startSeconds), "-i", input.sourcePath, ...(duration ? ["-t", String(duration)] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", outputPath];
    await runCommand(ffmpegPath, args);
    rememberPath(outputPath);
    return { filePath: outputPath, sizeBytes: (await stat(outputPath)).size };
  });
  ipcMain.handle("combine-video-audio", async (_event, input: CombineVideoAudioInput) => {
    if (!input.videoPath || !existsSync(input.videoPath) || !isAllowedPath(input.videoPath)) throw new Error("Select a supported video file.");
    if (!input.audioPath || !existsSync(input.audioPath) || !isAllowedPath(input.audioPath)) throw new Error("Select a supported audio file.");
    if (!Number.isFinite(input.offsetSeconds)) throw new Error("Audio offset must be a valid number of seconds.");
    const outputFolder = input.outputFolder || path.dirname(input.videoPath);
    ensureAllowedFolder(outputFolder);
    await mkdir(outputFolder, { recursive: true });
    rememberFolder(outputFolder);
    const outputPath = await uniqueFilePath(outputFolder, input.filename);
    const audioFilter = "aresample=async=1:first_pts=0,loudnorm=I=-16:TP=-1.5:LRA=11";
    const offsetArgs = input.offsetSeconds >= 0 ? ["-itsoffset", String(input.offsetSeconds), "-i", input.audioPath] : ["-i", input.audioPath, "-itsoffset", String(Math.abs(input.offsetSeconds))];
    const args = input.offsetSeconds >= 0
      ? ["-y", "-i", input.videoPath, ...offsetArgs, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-af", audioFilter, ...(input.trimToShortest ? ["-shortest"] : []), "-movflags", "+faststart", outputPath]
      : ["-y", ...offsetArgs, "-i", input.videoPath, "-map", "1:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-af", audioFilter, ...(input.trimToShortest ? ["-shortest"] : []), "-movflags", "+faststart", outputPath];
    await runCommand(ffmpegPath, args);
    rememberPath(outputPath);
    return { filePath: outputPath, sizeBytes: (await stat(outputPath)).size };
  });
  ipcMain.handle("copy-local-file", async (_event, sourcePath: string, outputFolder?: string) => {
    if (!existsSync(sourcePath) || !isAllowedPath(sourcePath)) throw new Error("Selected file does not exist or was not selected through VideoBlitzer Screen Recorder.");
    const destinationFolder = outputFolder || app.getPath("videos");
    ensureAllowedFolder(destinationFolder);
    await mkdir(destinationFolder, { recursive: true });
    rememberFolder(destinationFolder);
    const destination = await uniqueFilePath(destinationFolder, path.basename(sourcePath));
    await copyFile(sourcePath, destination);
    rememberPath(destination);
    return { filePath: destination, sizeBytes: (await stat(destination)).size };
  });
  ipcMain.handle("open-file-location", async (_event, filePath: string) => {
    if (!filePath || !isAllowedPath(filePath)) throw new Error("File path is required and must be created or selected by VideoBlitzer Screen Recorder.");
    await shell.showItemInFolder(filePath);
    return { ok: true };
  });
  ipcMain.handle("open-external", async (_event, url: string) => {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Only http and https URLs can be opened.");
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });
  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
