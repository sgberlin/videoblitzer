export type RecorderMode = "browser" | "match" | "screen" | "sports" | "business" | "training" | "upload" | "link";
export interface RecorderSource { id: string; name: string; thumbnail: string; kind?: "screen" | "window" | "browser"; }
export interface RecorderSettings { apiUrl: string; outputFolder?: string; outputRoots?: string[]; rememberToken: boolean; token?: string; tokenEncrypted?: string; tokenStorageMode?: "keychain" | "session_only" | "unavailable"; quality: "standard" | "high" | "match"; includeMicrophone: boolean; includeSystemAudio?: boolean; selectedMicDeviceId?: string; selectedSystemAudioDeviceId?: string; autoUpload?: boolean; resolution?: "source" | "720p" | "1080p" | "1440p" | "2160p"; frameRate?: 30 | 60; existingProjectId?: string; }
export interface SaveRecordingInput { arrayBuffer: ArrayBuffer; filename: string; outputFolder?: string; }
export interface SaveRecordingResult { filePath: string; sizeBytes: number; }
export interface RecordingChunkRecord { index: number; filename: string; filePath: string; sizeBytes: number; durationEstimateSeconds?: number; createdAt: string; }
export interface RecordingManifest { sessionId: string; mode: string; sourceLabel?: string; createdAt: string; completedAt?: string; chunks: RecordingChunkRecord[]; durationEstimateSeconds?: number; audioSettings: Record<string, unknown>; markers: Array<Record<string, unknown>>; metadata: Record<string, unknown>; uploadStatus: "local_only" | "uploading" | "uploaded" | "failed"; outputFolder?: string; finalFilePath?: string; }
export interface SaveChunkInput { sessionId: string; arrayBuffer: ArrayBuffer; filename: string; outputFolder?: string; index: number; durationEstimateSeconds?: number; }
export interface SaveManifestInput { manifest: RecordingManifest; outputFolder?: string; }
export interface MediaStreamMetadata { index?: number; type?: string; codec?: string; durationSeconds?: number | null; channels?: number | null; sampleRate?: string; width?: number; height?: number; }
export interface MediaMetadata { durationSeconds: number | null; format?: string; streams: MediaStreamMetadata[]; error?: string; }
export interface ClipInput { sourcePath: string; outputFolder?: string; filename: string; startSeconds: number; durationSeconds?: number; endSeconds?: number; exactCut?: boolean; }
export interface CombineVideoAudioInput { videoPath: string; audioPath: string; outputFolder?: string; filename: string; offsetSeconds: number; trimToShortest: boolean; }
