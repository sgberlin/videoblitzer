import { exportPresets, type ExportPreset } from "@videoblitzer/export-presets";
import path from "node:path";
import { runCommand } from "./packageCommand";
import { uploadFileToR2 } from "./packageStorage";
import type { ExportArtifact } from "./packageTypes";

const defaultPresetIds = ["youtube_16_9_1080p", "shorts_9_16_1080x1920", "square_1_1_1080"];

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
  ]);
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
  ]);
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
    });
  }
  return artifacts;
}
