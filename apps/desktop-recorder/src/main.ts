import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from "electron";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ClipInput, CombineVideoAudioInput, RecorderSettings, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingInput } from "./types";

const defaultSettings: RecorderSettings = {
  apiUrl: "https://api.videoblitzer.com",
  rememberToken: false,
  quality: "standard",
  includeMicrophone: false,
  includeSystemAudio: false,
  autoUpload: false,
};

function userConfigPath() { return path.join(app.getPath("userData"), "recorder-settings.json"); }
function sessionsRoot() { return path.join(app.getPath("userData"), "recording-sessions"); }
function validateFilename(filename: string) { return filename.replace(/[^a-zA-Z0-9._ -]/g, "_").trim().replace(/\s+/g, "_"); }
function manifestPath(sessionId: string, outputFolder?: string) { return path.join(outputFolder || sessionsRoot(), sessionId, "manifest.json"); }
function sessionDir(sessionId: string, outputFolder?: string) { return path.join(outputFolder || sessionsRoot(), sessionId); }

async function readSettings(): Promise<RecorderSettings> {
  try {
    const raw = JSON.parse(await readFile(userConfigPath(), "utf8")) as RecorderSettings;
    return { ...defaultSettings, ...raw, token: raw.rememberToken ? raw.token : undefined };
  } catch {
    return defaultSettings;
  }
}

async function writeSettings(settings: RecorderSettings) {
  const safeSettings = { ...settings, token: settings.rememberToken ? settings.token : undefined };
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
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], { stdio: ["ignore", "pipe", "pipe"] });
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
  const dir = sessionDir(input.manifest.sessionId, input.outputFolder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(input.manifest, null, 2));
  return { ok: true, manifestPath: path.join(dir, "manifest.json") };
}

async function readManifest(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as RecordingManifest;
}

async function listRecoverableSessions() {
  const roots = [sessionsRoot(), app.getPath("videos")];
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
  const outputName = validateFilename(`${manifest.sessionId}_recovered.webm`);
  const outputPath = path.join(outputFolder || app.getPath("videos"), outputName);
  const listPath = path.join(sessionDir(manifest.sessionId, manifest.outputFolder), "concat.txt");
  const chunkLines = manifest.chunks.filter((chunk) => existsSync(chunk.filePath)).map((chunk) => `file '${chunk.filePath.replace(/'/g, "'\\''")}'`).join("\n");
  if (!chunkLines) throw new Error("No readable chunks were found. Check that the output folder is still available.");
  await writeFile(listPath, chunkLines);
  await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
  return { filePath: outputPath, sizeBytes: (await stat(outputPath)).size };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    title: "VideoBlitzer Recorder",
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
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("select-media-file", async (_event, kind: "video" | "audio" | "any") => {
    const filters = kind === "video" ? [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm"] }] : kind === "audio" ? [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "ogg", "flac"] }] : [{ name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "wav", "mp3", "m4a", "aac", "ogg", "flac"] }];
    const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("save-recording", async (_event, input: SaveRecordingInput) => {
    if (!input?.arrayBuffer || !input.filename) throw new Error("Recording data and filename are required.");
    const outputFolder = input.outputFolder || app.getPath("videos");
    if (!existsSync(outputFolder)) await mkdir(outputFolder, { recursive: true });
    const filePath = path.join(outputFolder, validateFilename(input.filename));
    const buffer = Buffer.from(new Uint8Array(input.arrayBuffer));
    await writeFile(filePath, buffer);
    return { filePath, sizeBytes: buffer.byteLength };
  });
  ipcMain.handle("save-recording-chunk", async (_event, input: SaveChunkInput) => {
    const dir = sessionDir(input.sessionId, input.outputFolder);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, validateFilename(input.filename));
    const buffer = Buffer.from(new Uint8Array(input.arrayBuffer));
    await writeFile(filePath, buffer);
    return { index: input.index, filename: path.basename(filePath), filePath, sizeBytes: buffer.byteLength, durationEstimateSeconds: input.durationEstimateSeconds, createdAt: new Date().toISOString() };
  });
  ipcMain.handle("save-manifest", (_event, input: SaveManifestInput) => saveManifest(input));
  ipcMain.handle("list-recoverable-sessions", listRecoverableSessions);
  ipcMain.handle("recover-session", (_event, manifest: RecordingManifest, outputFolder?: string) => recoverSession(manifest, outputFolder));
  ipcMain.handle("media-metadata", async (_event, filePath: string) => ({ durationSeconds: await ffprobeDuration(filePath) }));
  ipcMain.handle("create-clip", async (_event, input: ClipInput) => {
    if (!input.sourcePath || !existsSync(input.sourcePath)) throw new Error("Choose an existing source recording before creating a clip.");
    if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0) throw new Error("Clip start must be a valid timestamp.");
    const outputFolder = input.outputFolder || path.dirname(input.sourcePath);
    await mkdir(outputFolder, { recursive: true });
    const outputPath = path.join(outputFolder, validateFilename(input.filename));
    const duration = input.durationSeconds ?? (input.endSeconds && input.endSeconds > input.startSeconds ? input.endSeconds - input.startSeconds : undefined);
    const args = ["-y", "-ss", String(input.startSeconds), "-i", input.sourcePath, ...(duration ? ["-t", String(duration)] : []), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", outputPath];
    await runCommand("ffmpeg", args);
    return { filePath: outputPath, sizeBytes: (await stat(outputPath)).size };
  });
  ipcMain.handle("combine-video-audio", async (_event, input: CombineVideoAudioInput) => {
    if (!input.videoPath || !existsSync(input.videoPath)) throw new Error("Select a supported video file.");
    if (!input.audioPath || !existsSync(input.audioPath)) throw new Error("Select a supported audio file.");
    if (!Number.isFinite(input.offsetSeconds)) throw new Error("Audio offset must be a valid number of seconds.");
    const outputFolder = input.outputFolder || path.dirname(input.videoPath);
    await mkdir(outputFolder, { recursive: true });
    const outputPath = path.join(outputFolder, validateFilename(input.filename));
    const offsetArgs = input.offsetSeconds >= 0 ? ["-itsoffset", String(input.offsetSeconds), "-i", input.audioPath] : ["-i", input.audioPath, "-itsoffset", String(Math.abs(input.offsetSeconds))];
    const args = input.offsetSeconds >= 0
      ? ["-y", "-i", input.videoPath, ...offsetArgs, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", ...(input.trimToShortest ? ["-shortest"] : []), "-movflags", "+faststart", outputPath]
      : ["-y", ...offsetArgs, "-i", input.videoPath, "-map", "1:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", ...(input.trimToShortest ? ["-shortest"] : []), "-movflags", "+faststart", outputPath];
    await runCommand("ffmpeg", args);
    return { filePath: outputPath, sizeBytes: (await stat(outputPath)).size };
  });
  ipcMain.handle("copy-local-file", async (_event, sourcePath: string, outputFolder?: string) => {
    if (!existsSync(sourcePath)) throw new Error("Selected file does not exist.");
    const destinationFolder = outputFolder || app.getPath("videos");
    await mkdir(destinationFolder, { recursive: true });
    const destination = path.join(destinationFolder, validateFilename(path.basename(sourcePath)));
    await copyFile(sourcePath, destination);
    return { filePath: destination, sizeBytes: (await stat(destination)).size };
  });
  ipcMain.handle("open-file-location", async (_event, filePath: string) => {
    if (!filePath) throw new Error("File path is required.");
    await shell.showItemInFolder(filePath);
    return { ok: true };
  });
  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
