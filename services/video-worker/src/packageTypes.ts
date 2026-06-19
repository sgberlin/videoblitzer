import type { ExportPreset } from "@videoblitzer/export-presets";

export type PackageStatus = "queued" | "processing" | "completed" | "failed";

export type PackageJob = {
  id: string;
  project_id: string;
  video_id: string | null;
  user_id: string;
  status: string;
  attempts?: number | null;
  analysis_id?: string | null;
  package_variant?: string | null;
  package_options?: Record<string, unknown> | null;
  reuse_analysis?: boolean | null;
  source_video_id?: string | null;
  duplicate_source_video_id?: string | null;
  input?: Record<string, unknown> | null;
};

export type VideoRow = {
  id: string;
  project_id: string;
  storage_key: string | null;
  source_object_key: string | null;
  source_format: string | null;
  has_video?: boolean | null;
  has_audio?: boolean | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  audio_source_object_key?: string | null;
  audio_source_filename?: string | null;
  audio_source_content_type?: string | null;
  audio_source_size_bytes?: number | null;
  audio_source_metadata?: Record<string, unknown> | null;
  verification_metadata?: Record<string, unknown> | null;
  file_sha256?: string | null;
  duplicate_of_video_id?: string | null;
  analysis_status?: string | null;
  analysis_metadata?: Record<string, unknown> | null;
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
  audioSourceObjectKey?: string | null;
  generatedAt: string;
  packageMode?: "fast" | "high_quality";
  packageVariant?: string;
  analysisId?: string | null;
  reuseAnalysis?: boolean;
  packageOptions?: Record<string, unknown>;
  packageFormula?: Record<string, unknown>;
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
