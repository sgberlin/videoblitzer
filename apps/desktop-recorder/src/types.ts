export interface RecorderSource { id: string; name: string; thumbnail: string; }
export interface RecorderSettings { apiUrl: string; outputFolder?: string; rememberToken: boolean; token?: string; quality: "standard" | "high" | "match"; includeMicrophone: boolean; }
export interface SaveRecordingInput { arrayBuffer: ArrayBuffer; filename: string; outputFolder?: string; }
export interface SaveRecordingResult { filePath: string; sizeBytes: number; }
