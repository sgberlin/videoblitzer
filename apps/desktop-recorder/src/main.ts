import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, shell } from "electron";
import { copyFile, mkdir, readFile, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import type { ClipInput, CombineVideoAudioInput, RecorderSettings, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingInput } from "./types";

const defaultSettings: RecorderSettings = {
  apiUrl: "https://api.videoblitzer.com",
  rememberToken: false,
  quality: "standard",
  includeMicrophone: false,
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
const ffmpegPath = ffmpegStatic || "ffmpeg";
const ffprobePath = ffprobeStatic.path || "ffprobe";

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
    let token: string | undefined;
    if (raw.rememberToken && raw.tokenEncrypted && safeStorage.isEncryptionAvailable()) {
      token = safeStorage.decryptString(Buffer.from(raw.tokenEncrypted, "base64"));
    }
    return { ...defaultSettings, ...raw, token, tokenEncrypted: undefined };
  } catch {
    return defaultSettings;
  }
}

async function writeSettings(settings: RecorderSettings) {
  const roots = Array.from(new Set([...(settings.outputRoots ?? []), settings.outputFolder].filter(Boolean) as string[]));
  roots.forEach(rememberFolder);
  const tokenEncrypted = settings.rememberToken && settings.token && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(settings.token).toString("base64") : undefined;
  const safeSettings = { ...settings, outputRoots: roots, token: undefined, tokenEncrypted };
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

async function ffprobeDuration(filePath: string) {
  return new Promise<number | null>((resolve) => {
    const child = spawn(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const value = Number(stdout.trim());
      resolve(Number.isFinite(value) ? value : null);
    });
  });
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
      if (manifest && manifest.uploadStatus !== "uploaded" && !manifest.completedAt) sessions.push(manifest);
    }
  }
  return sessions;
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    title: "VideoBlitzer Screen Recorder",
    backgroundColor: "#061018",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
}

app.whenReady().then(() => {
  rememberFolder(sessionsRoot());
  rememberFolder(app.getPath("videos"));
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-platform", () => process.platform);
  ipcMain.handle("get-settings", readSettings);
  ipcMain.handle("save-settings", (_event, settings: RecorderSettings) => writeSettings(settings));
  ipcMain.handle("get-sources", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources.map((source) => {
      const lower = source.name.toLowerCase();
      const isBrowser = ["chrome", "safari", "firefox", "edge", "brave", "browser"].some((label) => lower.includes(label));
      return { id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), kind: source.id.startsWith("screen") ? "screen" : isBrowser ? "browser" : "window" };
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
    return { durationSeconds: await ffprobeDuration(filePath) };
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
    const offsetArgs = input.offsetSeconds >= 0 ? ["-itsoffset", String(input.offsetSeconds), "-i", input.audioPath] : ["-i", input.audioPath, "-itsoffset", String(Math.abs(input.offsetSeconds))];
    const args = input.offsetSeconds >= 0
      ? ["-y", "-i", input.videoPath, ...offsetArgs, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", ...(input.trimToShortest ? ["-shortest"] : []), "-movflags", "+faststart", outputPath]
      : ["-y", ...offsetArgs, "-i", input.videoPath, "-map", "1:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", ...(input.trimToShortest ? ["-shortest"] : []), "-movflags", "+faststart", outputPath];
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
  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
