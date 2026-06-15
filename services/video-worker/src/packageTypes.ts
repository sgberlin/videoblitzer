import type { ExportPreset } from "@videoblitzer/export-presets";

export type PackageStatus = "queued" | "processing" | "completed" | "failed";

export type PackageJob = {
  id: string;
  project_id: string;
  video_id: string | null;
  user_id: string;
  status: string;
  attempts?: number | null;
  input?: Record<string, unknown> | null;
};

export type VideoRow = {
  id: string;
  project_id: string;
  storage_key: string | null;
  source_object_key: string | null;
  source_format: string | null;
  markers: Array<{ seconds?: number; label?: string; note?: string; createdAt?: string }>;
};

export type ClipPlanItem = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  label: string;
  note?: string;
};

export type AnalysisResult = {
  durationSeconds: number;
  clipPlan: ClipPlanItem[];
};

export type ExportArtifact = {
  presetId: string;
  label: string;
  objectKey: string;
  fileName: string;
  width: number;
  height: number;
  target: string;
};

export type SelectedPreset = ExportPreset;

export type PackageManifest = {
  packageJobId: string;
  projectId: string;
  videoId: string | null;
  sourceObjectKey: string;
  generatedAt: string;
  analysis: Pick<AnalysisResult, "durationSeconds">;
  normalizedMaster: {
    objectKey: string;
    fileName: string;
  };
  clipPlan: ClipPlanItem[];
  exports: ExportArtifact[];
  socialPackage: Record<string, unknown>;
};
