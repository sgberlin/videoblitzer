import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RecorderSettings, SaveRecordingInput } from "./types";

const defaultSettings: RecorderSettings = {
  apiUrl: "https://api.videoblitzer.com",
  rememberToken: false,
  quality: "standard",
  includeMicrophone: false,
};

function userConfigPath() { return path.join(app.getPath("userData"), "recorder-settings.json"); }

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

function validateFilename(filename: string) { return filename.replace(/[^a-zA-Z0-9._-]/g, "_"); }

function createWindow() {
  const window = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 720,
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
  ipcMain.handle("get-settings", readSettings);
  ipcMain.handle("save-settings", (_event, settings: RecorderSettings) => writeSettings(settings));
  ipcMain.handle("get-sources", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    return sources.map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  ipcMain.handle("select-output-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
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
  ipcMain.handle("open-file-location", async (_event, filePath: string) => {
    if (!filePath) throw new Error("File path is required.");
    await shell.showItemInFolder(filePath);
    return { ok: true };
  });
  createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
