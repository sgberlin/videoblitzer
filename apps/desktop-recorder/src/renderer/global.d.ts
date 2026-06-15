import type { ClipInput, CombineVideoAudioInput, CropOverlayState, MediaMetadata, RecorderSettings, RecorderSource, RecordingChunkRecord, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingResult } from "../types";

declare global {
  interface Window {
    videoBlitzerRecorder: {
      getSources(): Promise<RecorderSource[]>;
      getPlatform(): Promise<NodeJS.Platform>;
      secureStorageStatus(): Promise<{ encryptionAvailable: boolean }>;
      microphonePermissionStatus(): Promise<{ status: string }>;
      requestMicrophonePermission(): Promise<{ granted: boolean; status: string }>;
      showCropOverlay(aspect: CropOverlayState["aspect"]): Promise<CropOverlayState>;
      hideCropOverlay(): Promise<CropOverlayState>;
      lockCropOverlay(locked: boolean): Promise<CropOverlayState>;
      getCropOverlayState(): Promise<CropOverlayState>;
      onCropOverlayState(callback: (state: CropOverlayState) => void): () => void;
      hideRecorderWindow(): Promise<{ ok: true }>;
      showRecorderWindow(): Promise<{ ok: true }>;
      startNativeScreenCapture(input: { outputFolder?: string; filename?: string; displayId?: string; frameRate?: number }): Promise<{ ok: true; filePath: string }>;
      stopNativeScreenCapture(): Promise<SaveRecordingResult>;
      saveRecording(arrayBuffer: ArrayBuffer, filename: string, outputFolder?: string): Promise<SaveRecordingResult>;
      saveRecordingChunk(input: SaveChunkInput): Promise<RecordingChunkRecord>;
      saveManifest(input: SaveManifestInput): Promise<{ ok: true; manifestPath: string }>;
      listRecoverableSessions(): Promise<RecordingManifest[]>;
      recoverSession(manifest: RecordingManifest, outputFolder?: string): Promise<SaveRecordingResult>;
      selectOutputFolder(): Promise<string | undefined>;
      selectMediaFile(kind: "video" | "audio" | "any"): Promise<string | undefined>;
      mediaMetadata(filePath: string): Promise<MediaMetadata>;
      readLocalFile(filePath: string): Promise<{ arrayBuffer: ArrayBuffer; sizeBytes: number }>;
      uploadLocalFile(filePath: string, signedUrl: string, headers?: Record<string, string>): Promise<{ ok: true }>;
      createClip(input: ClipInput): Promise<SaveRecordingResult>;
      combineVideoAudio(input: CombineVideoAudioInput): Promise<SaveRecordingResult>;
      copyLocalFile(sourcePath: string, outputFolder?: string): Promise<SaveRecordingResult>;
      openFileLocation(filePath: string): Promise<{ ok: true }>;
      openExternal(url: string): Promise<{ ok: true }>;
      getAppVersion(): Promise<string>;
      getSettings(): Promise<RecorderSettings>;
      saveSettings(settings: RecorderSettings): Promise<{ ok: true }>;
      startupLog(message: string, details?: Record<string, unknown>): void;
    };
  }
  interface Window {
    __VB_BUILD_INFO__?: { version: string; commit: string; builtAt: string; environment: string };
  }
}
export {};
