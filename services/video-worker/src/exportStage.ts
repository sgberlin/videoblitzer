import { exportPresets, type ExportPreset } from "@videoblitzer/export-presets";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand, type CommandProgress } from "./packageCommand";
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
const fastSocialClipFormatIds = new Set(["instagram_reels", "youtube_standard", "square_social"]);
const outputFormatIds: Record<string, Set<string>> = {
  vertical: new Set(["instagram_reels", "tiktok", "youtube_shorts", "facebook_reels"]),
  landscape: new Set(["youtube_standard"]),
  square: new Set(["square_social"]),
};

export function selectPackagePresets(requestedPresetIds: string[] = []) {
  const ids = requestedPresetIds.length ? requestedPresetIds : defaultPresetIds;
  return exportPresets.filter((preset) => ids.includes(preset.id));
}

function filterForPreset(preset: ExportPreset) {
  if (preset.aspectRatio === "source") {
    return `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2`;
  }
  if (preset.aspectRatio === "9:16") {
    return "split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28[bg];[fg]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,unsharp=5:5:0.25";
  }
  return `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=increase,crop=${preset.width}:${preset.height}`;
}

function folderForPreset(preset: ExportPreset) {
  if (preset.aspectRatio === "9:16") return "clips/vertical_9x16";
  if (preset.aspectRatio === "1:1") return "clips/square_1x1";
  return "clips/landscape_16x9";
}

function audioArgs(hasAudio: boolean, bitrate = "128k") {
  return hasAudio ? ["-c:a", "aac", "-b:a", bitrate] : ["-an"];
}

type ProgressReporter = (progress: CommandProgress & { label?: string; current?: number; total?: number }) => void | Promise<void>;

function ffmpegProgressArgs() {
  return ["-nostats", "-progress", "pipe:1"];
}

export async function createNormalizedMaster(inputPath: string, outputPath: string, hasAudio = true, durationSeconds?: number | null, onProgress?: ProgressReporter) {
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
    "-i", inputPath,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    ...audioArgs(hasAudio, "192k"),
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: durationSeconds ?? undefined, onProgress });
}

export async function createNormalizedMasterWithAudio(videoPath: string, audioPath: string, outputPath: string, durationSeconds?: number | null, onProgress?: ProgressReporter) {
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
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
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: durationSeconds ?? undefined, onProgress });
}

export async function createFastNormalizedMaster(inputPath: string, outputPath: string, hasAudio = true, durationSeconds?: number | null, onProgress?: ProgressReporter) {
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
    "-i", inputPath,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-c:v", "copy",
    ...(hasAudio ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: durationSeconds ?? undefined, onProgress });
}

export async function createFastNormalizedMasterWithAudio(videoPath: string, audioPath: string, outputPath: string, durationSeconds?: number | null, onProgress?: ProgressReporter) {
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-shortest",
    "-c:v", "copy",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: durationSeconds ?? undefined, onProgress });
}

export async function renderPresetExport(inputPath: string, outputPath: string, preset: ExportPreset, hasAudio = true, durationSeconds?: number | null, onProgress?: ProgressReporter, audioFilter?: string) {
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
    "-i", inputPath,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-vf", filterForPreset(preset),
    ...(hasAudio && audioFilter ? ["-af", audioFilter] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    ...audioArgs(hasAudio),
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: durationSeconds ?? undefined, onProgress });
}

function escapeDrawText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function clipFilter(width: number, height: number, options: { subtleZoom?: boolean; caption?: string | null } = {}) {
  const zoom = options.subtleZoom ? 1.08 : 1;
  const captionFilter = options.caption
    ? `,drawtext=text='${escapeDrawText(options.caption)}':x=(w-text_w)/2:y=h-(text_h*3):fontsize=${height >= 1800 ? 54 : 38}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=18`
    : "";
  if (width === 1080 && height === 1920) {
    const scaledWidth = Math.round(1080 * zoom);
    const scaledHeight = Math.round(1920 * zoom);
    return `scale=${scaledWidth}:${scaledHeight}:force_original_aspect_ratio=increase,crop=1080:1920,unsharp=5:5:0.35${captionFilter}`;
  }
  if (width === 1080 && height === 1080) {
    const scaled = Math.round(1080 * zoom);
    return `scale=${scaled}:${scaled}:force_original_aspect_ratio=increase,crop=1080:1080,unsharp=5:5:0.25${captionFilter}`;
  }
  if (options.subtleZoom) return `scale=2074:1166:force_original_aspect_ratio=increase,crop=1920:1080,unsharp=5:5:0.25${captionFilter}`;
  return `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,unsharp=5:5:0.25${captionFilter}`;
}

function safeName(value: string, maxLength = 80) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, maxLength) || "clip";
}

function safeFileName(...parts: string[]) {
  return `${parts.map((part) => safeName(part, 42)).filter(Boolean).join("_").slice(0, 160)}.mp4`;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (!item) return;
      await worker(item, index);
    }
  });
  await Promise.all(workers);
}

export async function renderSocialClip(inputPath: string, outputPath: string, clip: ClipPlanItem, format: typeof socialClipFormats[number], hasAudio = true, onProgress?: ProgressReporter, options: { subtleZoom?: boolean; burnCaption?: boolean } = {}) {
  const duration = Math.max(1, clip.endSeconds - clip.startSeconds);
  const caption = options.burnCaption ? clip.note || clip.label : null;
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
    "-ss", clip.startSeconds.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", inputPath,
    "-map", "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-vf", clipFilter(format.width, format.height, { subtleZoom: options.subtleZoom, caption }),
    ...(hasAudio ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    ...audioArgs(hasAudio),
    "-movflags", "+faststart",
    outputPath,
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: duration, onProgress });
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

function concatPath(value: string) {
  return value.replace(/'/g, "'\\''");
}

function srtTimestamp(seconds: number) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function escapeSubtitleText(value: string) {
  return value.replace(/\r?\n/g, " ").replace(/[{}]/g, "").slice(0, 96);
}

function eventOverlayText(clip: ClipPlanItem) {
  const note = clip.note?.trim();
  const label = clip.label.trim();
  if (note && !note.toLowerCase().includes(label.toLowerCase())) {
    return `${label} - ${note}`;
  }
  return label || note || "Highlight";
}

function escapeFilterPath(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function createFinalEdit(input: {
  masterPath: string;
  outputPath: string;
  clipPlan: ClipPlanItem[];
  workdir: string;
  hasAudio?: boolean;
  onProgress?: ProgressReporter;
  audioFilter?: string;
  burnCaptions?: boolean;
  captionFontSize?: number;
}) {
  const editListPath = path.join(input.workdir, "final-edit.concat.txt");
  const subtitlePath = path.join(input.workdir, `${path.basename(input.outputPath)}.srt`);
  const clips = input.clipPlan
    .filter((clip) => Number.isFinite(clip.startSeconds) && Number.isFinite(clip.endSeconds) && clip.endSeconds > clip.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (!clips.length) throw new Error("No clips are available for the final edited video.");
  const concatList = clips
    .map((clip) => `file '${concatPath(input.masterPath)}'\ninpoint ${clip.startSeconds.toFixed(3)}\noutpoint ${clip.endSeconds.toFixed(3)}`)
    .join("\n");
  const durationSeconds = clips.reduce((sum, clip) => sum + Math.max(0, clip.endSeconds - clip.startSeconds), 0);
  await writeFile(editListPath, `${concatList}\n`, "utf8");
  if (input.burnCaptions) {
    let cursor = 0;
    const srt = clips.map((clip, index) => {
      const duration = Math.max(0, clip.endSeconds - clip.startSeconds);
      const start = cursor;
      const end = Math.min(cursor + duration, cursor + 7);
      cursor += duration;
      return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${escapeSubtitleText(eventOverlayText(clip))}\n`;
    }).join("\n");
    await writeFile(subtitlePath, srt, "utf8");
  }
  const captionFontSize = Math.max(18, Math.min(72, Math.round(input.captionFontSize ?? 28)));
  const captionFilter = input.burnCaptions ? `subtitles='${escapeFilterPath(subtitlePath)}':force_style='Fontsize=${captionFontSize},PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=1,Shadow=0,Alignment=8,MarginV=36'` : null;
  await runCommand("ffmpeg", [
    "-y",
    ...ffmpegProgressArgs(),
    "-f", "concat",
    "-safe", "0",
    "-i", editListPath,
    "-map", "0:v:0",
    ...(input.hasAudio ? ["-map", "0:a:0?"] : []),
    ...(captionFilter ? ["-vf", captionFilter] : []),
    ...(input.hasAudio && input.audioFilter ? ["-af", input.audioFilter] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    ...audioArgs(input.hasAudio ?? true, "192k"),
    "-movflags", "+faststart",
    input.outputPath,
  ], { timeoutMs: ffmpegTimeoutMs, progressDurationSeconds: durationSeconds, onProgress: input.onProgress });
  return { durationSeconds };
}

export async function exportStage(input: {
  masterPath: string;
  exportsDir: string;
  requestedPresetIds: string[];
  userId: string;
  projectId: string;
  packageJobId: string;
  hasAudio?: boolean;
  durationSeconds?: number;
  onProgress?: ProgressReporter;
  audioFilter?: string;
}) {
  const selectedPresets = selectPackagePresets(input.requestedPresetIds);
  if (!selectedPresets.length) throw new Error("No valid export presets were selected for package generation.");

  const artifacts: Array<ExportArtifact & { filePath: string }> = [];
  for (const [index, preset] of selectedPresets.entries()) {
    const fileName = `${preset.id}.mp4`;
    const filePath = path.join(input.exportsDir, fileName);
    await renderPresetExport(input.masterPath, filePath, preset, input.hasAudio ?? true, input.durationSeconds, (progress) => input.onProgress?.({
      ...progress,
      percent: Math.round(((index + progress.percent / 100) / selectedPresets.length) * 100),
      label: preset.label,
      current: index + 1,
      total: selectedPresets.length,
    }), input.audioFilter);
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
      metadata: { presetId: preset.id, socialStandard: preset.target, folder: folderForPreset(preset) },
    });
    await input.onProgress?.({ percent: Math.round(((index + 1) / selectedPresets.length) * 100), seconds: input.durationSeconds ?? 0, label: preset.label, current: index + 1, total: selectedPresets.length });
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
  hasAudio?: boolean;
  onProgress?: ProgressReporter;
  fastMode?: boolean;
  clipRenderConcurrency?: number;
  outputs?: string[];
  subtleZoom?: boolean;
  burnCaptions?: boolean;
}) {
  const clipArtifacts: Array<ExportArtifact & { filePath: string }> = [];
  const thumbnailArtifacts: Array<ExportArtifact & { filePath: string }> = [];
  type ClipRenderTask = { clip: ClipPlanItem; format: typeof socialClipFormats[number]; duration: number; durationLabel: string; titleSlug: string };

  const allowedFormatIds = new Set((input.outputs?.length ? input.outputs : ["vertical", "landscape", "square"]).flatMap((output) => [...(outputFormatIds[output] ?? new Set<string>())]));
  const formatAllowed = (format: typeof socialClipFormats[number]) => allowedFormatIds.size === 0 || allowedFormatIds.has(format.id);
  const totalRenders = input.clipPlan.reduce((sum, clip) => {
    const formats = socialClipFormats.filter((format) => formatAllowed(format) && (input.fastMode ? fastSocialClipFormatIds.has(format.id) : clip.platformFit.includes(format.platform) || format.platform === "youtube_standard" || format.platform === "social_square"));
    return sum + formats.length;
  }, 0);
  let completedRenders = 0;
  const renderTasks: ClipRenderTask[] = [];

  for (const clip of input.clipPlan) {
    const duration = Math.max(1, clip.endSeconds - clip.startSeconds);
    const durationLabel = `${Math.round(duration)}s`;
    const titleSlug = safeName(clip.label);
    const formats = socialClipFormats.filter((format) => formatAllowed(format) && (input.fastMode ? fastSocialClipFormatIds.has(format.id) : clip.platformFit.includes(format.platform) || format.platform === "youtube_standard" || format.platform === "social_square"));
    renderTasks.push(...formats.map((format) => ({ clip, format, duration, durationLabel, titleSlug })));

    const thumbnailDir = path.join(input.workdir, "thumbnails");
    const thumbnailName = `${safeName(`${clip.id}-${titleSlug}`, 150)}.jpg`;
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

  await runWithConcurrency(renderTasks, input.clipRenderConcurrency ?? 1, async ({ clip, format, duration, durationLabel, titleSlug }, renderIndex) => {
    const folder = path.join(input.workdir, "clips", format.folder);
    const fileName = safeFileName(format.platform, durationLabel, clip.id, titleSlug);
    const filePath = path.join(folder, fileName);
    await mkdir(folder, { recursive: true });
    await renderSocialClip(input.masterPath, filePath, clip, format, input.hasAudio ?? true, (progress) => input.onProgress?.({
      ...progress,
      percent: Math.round(((renderIndex + progress.percent / 100) / Math.max(1, totalRenders)) * 100),
      label: `${format.label} ${clip.label}`,
      current: renderIndex + 1,
      total: totalRenders,
    }), { subtleZoom: input.subtleZoom, burnCaption: input.burnCaptions });
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
    completedRenders += 1;
    await input.onProgress?.({ percent: Math.round((completedRenders / Math.max(1, totalRenders)) * 100), seconds: duration, label: `${format.label} ${clip.label}`, current: completedRenders, total: totalRenders });
  });

  return { clipArtifacts, thumbnailArtifacts };
}
