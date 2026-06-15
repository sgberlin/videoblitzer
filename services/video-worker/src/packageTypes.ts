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
  confidence: number;
  reason: string;
  suggestedClipType: "quick_moment" | "short_highlight" | "story_highlight" | "extended_highlight";
  platformFit: string[];
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
  assetType: "master" | "full_export" | "clip" | "thumbnail" | "caption" | "metadata" | "zip" | "readme";
  platform?: string;
  clipId?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  startSeconds?: number;
  endSeconds?: number;
  confidence?: number;
  validationStatus?: "pending" | "valid" | "failed";
  metadata?: Record<string, unknown>;
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
  assets: ExportArtifact[];
  socialPackage: Record<string, unknown>;
};
