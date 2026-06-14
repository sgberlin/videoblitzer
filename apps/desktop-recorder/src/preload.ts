import { contextBridge, ipcRenderer } from "electron";
import type { ClipInput, CombineVideoAudioInput, RecorderSettings, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingInput } from "./types";

ipcRenderer.send("startup-log", "preload loaded", { bridge: "videoBlitzerRecorder" });

contextBridge.exposeInMainWorld("videoBlitzerRecorder", {
  getSources: () => ipcRenderer.invoke("get-sources"),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  secureStorageStatus: () => ipcRenderer.invoke("secure-storage-status"),
  microphonePermissionStatus: () => ipcRenderer.invoke("microphone-permission-status"),
  requestMicrophonePermission: () => ipcRenderer.invoke("request-microphone-permission"),
  saveRecording: (arrayBuffer: ArrayBuffer, filename: string, outputFolder?: string) => ipcRenderer.invoke("save-recording", { arrayBuffer, filename, outputFolder } satisfies SaveRecordingInput),
  saveRecordingChunk: (input: SaveChunkInput) => ipcRenderer.invoke("save-recording-chunk", input),
  saveManifest: (input: SaveManifestInput) => ipcRenderer.invoke("save-manifest", input),
  listRecoverableSessions: () => ipcRenderer.invoke("list-recoverable-sessions"),
  recoverSession: (manifest: RecordingManifest, outputFolder?: string) => ipcRenderer.invoke("recover-session", manifest, outputFolder),
  selectOutputFolder: () => ipcRenderer.invoke("select-output-folder"),
  selectMediaFile: (kind: "video" | "audio" | "any") => ipcRenderer.invoke("select-media-file", kind),
  mediaMetadata: (filePath: string) => ipcRenderer.invoke("media-metadata", filePath),
  readLocalFile: (filePath: string) => ipcRenderer.invoke("read-local-file", filePath),
  uploadLocalFile: (filePath: string, signedUrl: string, headers?: Record<string, string>) => ipcRenderer.invoke("upload-local-file", { filePath, signedUrl, headers }),
  createClip: (input: ClipInput) => ipcRenderer.invoke("create-clip", input),
  combineVideoAudio: (input: CombineVideoAudioInput) => ipcRenderer.invoke("combine-video-audio", input),
  copyLocalFile: (sourcePath: string, outputFolder?: string) => ipcRenderer.invoke("copy-local-file", sourcePath, outputFolder),
  openFileLocation: (filePath: string) => ipcRenderer.invoke("open-file-location", filePath),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: RecorderSettings) => ipcRenderer.invoke("save-settings", settings),
  startupLog: (message: string, details?: Record<string, unknown>) => ipcRenderer.send("startup-log", message, details),
});
