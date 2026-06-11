import { contextBridge, ipcRenderer } from "electron";
import type { RecorderSettings, SaveRecordingInput } from "./types";

contextBridge.exposeInMainWorld("videoBlitzerRecorder", {
  getSources: () => ipcRenderer.invoke("get-sources"),
  saveRecording: (arrayBuffer: ArrayBuffer, filename: string, outputFolder?: string) => ipcRenderer.invoke("save-recording", { arrayBuffer, filename, outputFolder } satisfies SaveRecordingInput),
  selectOutputFolder: () => ipcRenderer.invoke("select-output-folder"),
  openFileLocation: (filePath: string) => ipcRenderer.invoke("open-file-location", filePath),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: RecorderSettings) => ipcRenderer.invoke("save-settings", settings),
});
