import { contextBridge, ipcRenderer } from "electron";
import type { ClipInput, CombineVideoAudioInput, CropOverlayState, RecorderSettings, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingInput } from "./types";

ipcRenderer.send("startup-log", "preload loaded", { bridge: "videoBlitzerRecorder" });

contextBridge.exposeInMainWorld("videoBlitzerRecorder", {
  getSources: () => ipcRenderer.invoke("get-sources"),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  secureStorageStatus: () => ipcRenderer.invoke("secure-storage-status"),
  microphonePermissionStatus: () => ipcRenderer.invoke("microphone-permission-status"),
  requestMicrophonePermission: () => ipcRenderer.invoke("request-microphone-permission"),
  showCropOverlay: (aspect: CropOverlayState["aspect"]) => ipcRenderer.invoke("show-crop-overlay", aspect),
  hideCropOverlay: () => ipcRenderer.invoke("hide-crop-overlay"),
  lockCropOverlay: (locked: boolean) => ipcRenderer.invoke("lock-crop-overlay", locked),
  getCropOverlayState: () => ipcRenderer.invoke("get-crop-overlay-state"),
  onCropOverlayState: (callback: (state: CropOverlayState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CropOverlayState) => callback(state);
    ipcRenderer.on("crop-overlay-state", listener);
    return () => ipcRenderer.removeListener("crop-overlay-state", listener);
  },
  hideRecorderWindow: () => ipcRenderer.invoke("hide-recorder-window"),
  showRecorderWindow: () => ipcRenderer.invoke("show-recorder-window"),
  startNativeScreenCapture: (input: { outputFolder?: string; filename?: string; displayId?: string; frameRate?: number }) => ipcRenderer.invoke("start-native-screen-capture", input),
  stopNativeScreenCapture: () => ipcRenderer.invoke("stop-native-screen-capture"),
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
