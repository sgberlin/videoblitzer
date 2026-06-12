export type RecorderMode = "browser" | "match" | "screen" | "sports" | "business" | "training" | "upload" | "link";
export interface RecorderSource { id: string; name: string; thumbnail: string; kind?: "screen" | "window" | "browser"; }
export interface RecorderSettings { apiUrl: string; outputFolder?: string; rememberToken: boolean; token?: string; quality: "standard" | "high" | "match"; includeMicrophone: boolean; includeSystemAudio?: boolean; selectedMicDeviceId?: string; autoUpload?: boolean; }
export interface SaveRecordingInput { arrayBuffer: ArrayBuffer; filename: string; outputFolder?: string; }
export interface SaveRecordingResult { filePath: string; sizeBytes: number; }
export interface RecordingChunkRecord { index: number; filename: string; filePath: string; sizeBytes: number; durationEstimateSeconds?: number; createdAt: string; }
export interface RecordingManifest { sessionId: string; mode: string; sourceLabel?: string; createdAt: string; completedAt?: string; chunks: RecordingChunkRecord[]; durationEstimateSeconds?: number; audioSettings: Record<string, unknown>; markers: Array<Record<string, unknown>>; metadata: Record<string, unknown>; uploadStatus: "local_only" | "uploading" | "uploaded" | "failed"; outputFolder?: string; finalFilePath?: string; }
export interface SaveChunkInput { sessionId: string; arrayBuffer: ArrayBuffer; filename: string; outputFolder?: string; index: number; durationEstimateSeconds?: number; }
export interface SaveManifestInput { manifest: RecordingManifest; outputFolder?: string; }
export interface MediaMetadata { durationSeconds: number | null; format?: string; error?: string; }
export interface ClipInput { sourcePath: string; outputFolder?: string; filename: string; startSeconds: number; durationSeconds?: number; endSeconds?: number; exactCut?: boolean; }
export interface CombineVideoAudioInput { videoPath: string; audioPath: string; outputFolder?: string; filename: string; offsetSeconds: number; trimToShortest: boolean; }
