import type { RecorderSettings, RecorderSource, SaveRecordingResult } from "../types";

declare global {
  interface Window {
    videoBlitzerRecorder: {
      getSources(): Promise<RecorderSource[]>;
      saveRecording(arrayBuffer: ArrayBuffer, filename: string, outputFolder?: string): Promise<SaveRecordingResult>;
      selectOutputFolder(): Promise<string | undefined>;
      openFileLocation(filePath: string): Promise<{ ok: true }>;
      getAppVersion(): Promise<string>;
      getSettings(): Promise<RecorderSettings>;
      saveSettings(settings: RecorderSettings): Promise<{ ok: true }>;
    };
  }
}
export {};
