import type { ClipInput, CombineVideoAudioInput, MediaMetadata, RecorderSettings, RecorderSource, RecordingChunkRecord, RecordingManifest, SaveChunkInput, SaveManifestInput, SaveRecordingResult } from "../types";

declare global {
  interface Window {
    videoBlitzerRecorder: {
      getSources(): Promise<RecorderSource[]>;
      getPlatform(): Promise<NodeJS.Platform>;
      saveRecording(arrayBuffer: ArrayBuffer, filename: string, outputFolder?: string): Promise<SaveRecordingResult>;
      saveRecordingChunk(input: SaveChunkInput): Promise<RecordingChunkRecord>;
      saveManifest(input: SaveManifestInput): Promise<{ ok: true; manifestPath: string }>;
      listRecoverableSessions(): Promise<RecordingManifest[]>;
      recoverSession(manifest: RecordingManifest, outputFolder?: string): Promise<SaveRecordingResult>;
      selectOutputFolder(): Promise<string | undefined>;
      selectMediaFile(kind: "video" | "audio" | "any"): Promise<string | undefined>;
      mediaMetadata(filePath: string): Promise<MediaMetadata>;
      createClip(input: ClipInput): Promise<SaveRecordingResult>;
      combineVideoAudio(input: CombineVideoAudioInput): Promise<SaveRecordingResult>;
      copyLocalFile(sourcePath: string, outputFolder?: string): Promise<SaveRecordingResult>;
      openFileLocation(filePath: string): Promise<{ ok: true }>;
      getAppVersion(): Promise<string>;
      getSettings(): Promise<RecorderSettings>;
      saveSettings(settings: RecorderSettings): Promise<{ ok: true }>;
    };
  }
}
export {};
