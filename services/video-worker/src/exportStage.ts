import { exportPresets, type ExportPreset } from "@videoblitzer/export-presets";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./packageCommand";
import { uploadFileToR2 } from "./packageStorage";
import type { ClipPlanItem, ExportArtifact } from "./packageTypes";

const defaultPresetIds = ["youtube_16_9_1080p", "shorts_9_16_1080x1920", "square_1_1_1080"];
const ffmpegTimeoutMs = Number(process.env.PACKAGE_FFMPEG_TIMEOUT_MS ?? 4 * 60 * 60 * 1000);

const socialClipFormats = [
  { id: "instagram_reels", label: "Instagram Reels", platform: "instagram_reels", folder: "vertical_9x16", width: 1080, height: 1920, aspectRatio: "9:16" },
  { id: "tiktok", label: "TikTok", platform: "tiktok", folder: "vertical_9x16", width: 1080, height: 1920, aspectRatio: "9:16" },
  { id: "youtube_shorts", label: "YouTube Shorts", platform: "youtube_shorts", folder: "vertical_9x16", width: 1080, height: 1920, aspectRatio: "9:16" },
  { id: "facebook_reels", label: "Facebook Reels", platform: "facebook_reels", folder: "vertical_9x16", width: 1080, height: 1920, aspectRatio: "9:16" },
  { id: "youtube_standard", label: "YouTube Standard", platform: "youtube_standard", folder: "landscape_16x9", width: 1920, height: 1080, aspectRatio: "16:9" },
  { id: "square_social", label: "Square Social", platform: "social_square", folder: "square_1x1", width: 1080, height: 1080, aspectRatio: "1:1" },
] as const;

export function selectPackagePresets(requestedPresetIds: string[] = []) {
  const ids = requestedPresetIds.length ? requestedPresetIds : defaultPresetIds;
  return exportPresets.filter((preset) => ids.includes(preset.id));
}

function filterForPreset(preset: ExportPreset) {
  if (preset.aspectRatio === "source") {
    return `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`;
  }
  return `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=increase,crop=${preset.width}:${preset.height}`;
}

export async function createNormalizedMaster(inputPath: string, outputPath: string) {
  await runCommand("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs });
}

export async function createNormalizedMasterWithAudio(videoPath: string, audioPath: string, outputPath: string) {
  await runCommand("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-shortest",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs });
}

export async function renderPresetExport(inputPath: string, outputPath: string, preset: ExportPreset) {
  await runCommand("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-vf", filterForPreset(preset),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs });
}

function clipFilter(width: number, height: number) {
  if (width === 1080 && height === 1920) {
    return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,unsharp=5:5:0.35";
  }
  if (width === 1080 && height === 1080) {
    return "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,unsharp=5:5:0.25";
  }
  return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,unsharp=5:5:0.25";
}

function safeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "clip";
}

export async function renderSocialClip(inputPath: string, outputPath: string, clip: ClipPlanItem, format: typeof socialClipFormats[number]) {
  const duration = Math.max(1, clip.endSeconds - clip.startSeconds);
  await runCommand("ffmpeg", [
    "-y",
    "-ss", clip.startSeconds.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", inputPath,
    "-vf", clipFilter(format.width, format.height),
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs });
}

export async function renderThumbnail(inputPath: string, outputPath: string, clip: ClipPlanItem) {
  const middle = clip.startSeconds + Math.max(0.5, (clip.endSeconds - clip.startSeconds) / 2);
  await runCommand("ffmpeg", [
    "-y",
    "-ss", middle.toFixed(3),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=1280:-1",
    outputPath,
  ], { timeoutMs: Math.min(ffmpegTimeoutMs, 10 * 60 * 1000) });
}

export async function exportStage(input: {
  masterPath: string;
  exportsDir: string;
  requestedPresetIds: string[];
  userId: string;
  projectId: string;
  packageJobId: string;
}) {
  const selectedPresets = selectPackagePresets(input.requestedPresetIds);
  if (!selectedPresets.length) throw new Error("No valid export presets were selected for package generation.");

  const artifacts: Array<ExportArtifact & { filePath: string }> = [];
  for (const preset of selectedPresets) {
    const fileName = `${preset.id}.mp4`;
    const filePath = path.join(input.exportsDir, fileName);
    await renderPresetExport(input.masterPath, filePath, preset);
    const objectKey = `packages/exports/${input.userId}/${input.projectId}/${input.packageJobId}/${fileName}`;
    await uploadFileToR2(filePath, objectKey, "video/mp4");
    artifacts.push({
      presetId: preset.id,
      label: preset.label,
      objectKey,
      fileName,
      filePath,
      width: preset.width,
      height: preset.height,
      target: preset.target,
      assetType: "full_export",
      platform: preset.target,
      aspectRatio: preset.aspectRatio,
      validationStatus: "pending",
      metadata: { presetId: preset.id, socialStandard: preset.target },
    });
  }
  return artifacts;
}

export async function socialClipStage(input: {
  masterPath: string;
  workdir: string;
  clipPlan: ClipPlanItem[];
  userId: string;
  projectId: string;
  packageJobId: string;
}) {
  const clipArtifacts: Array<ExportArtifact & { filePath: string }> = [];
  const thumbnailArtifacts: Array<ExportArtifact & { filePath: string }> = [];

  for (const clip of input.clipPlan) {
    const duration = Math.max(1, clip.endSeconds - clip.startSeconds);
    const durationLabel = `${Math.round(duration)}s`;
    const titleSlug = safeName(clip.label);
    const formats = socialClipFormats.filter((format) => clip.platformFit.includes(format.platform) || format.platform === "youtube_standard" || format.platform === "social_square");

    for (const format of formats) {
      const folder = path.join(input.workdir, "clips", format.folder);
      const fileName = `${format.platform}_${durationLabel}_${clip.id}_${titleSlug}.mp4`;
      const filePath = path.join(folder, fileName);
      await mkdir(folder, { recursive: true });
      await renderSocialClip(input.masterPath, filePath, clip, format);
      const objectKey = `packages/assets/${input.userId}/${input.projectId}/${input.packageJobId}/clips/${format.folder}/${fileName}`;
      await uploadFileToR2(filePath, objectKey, "video/mp4");
      clipArtifacts.push({
        presetId: format.id,
        label: `${format.label} ${clip.label}`,
        objectKey,
        fileName,
        filePath,
        width: format.width,
        height: format.height,
        target: format.label,
        assetType: "clip",
        platform: format.platform,
        clipId: clip.id,
        durationSeconds: duration,
        aspectRatio: format.aspectRatio,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        confidence: clip.confidence,
        validationStatus: "pending",
        metadata: { reason: clip.reason, suggestedClipType: clip.suggestedClipType, folder: `clips/${format.folder}` },
      });
    }

    const thumbnailDir = path.join(input.workdir, "thumbnails");
    const thumbnailName = `${clip.id}_${titleSlug}.jpg`;
    const thumbnailPath = path.join(thumbnailDir, thumbnailName);
    await mkdir(thumbnailDir, { recursive: true });
    await renderThumbnail(input.masterPath, thumbnailPath, clip);
    const thumbnailKey = `packages/assets/${input.userId}/${input.projectId}/${input.packageJobId}/thumbnails/${thumbnailName}`;
    await uploadFileToR2(thumbnailPath, thumbnailKey, "image/jpeg");
    thumbnailArtifacts.push({
      presetId: "thumbnail",
      label: `Thumbnail for ${clip.label}`,
      objectKey: thumbnailKey,
      fileName: thumbnailName,
      filePath: thumbnailPath,
      width: 1280,
      height: 720,
      target: "Thumbnail",
      assetType: "thumbnail",
      platform: "all",
      clipId: clip.id,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      confidence: clip.confidence,
      validationStatus: "pending",
      metadata: { reason: clip.reason, folder: "thumbnails" },
    });
  }

  return { clipArtifacts, thumbnailArtifacts };
}
