import type { CropMode } from "@videoblitzer/export-presets";

export interface FfmpegCommand {
  bin: "ffmpeg" | "ffprobe";
  args: string[];
}

export function probeCommand(inputPath: string): FfmpegCommand {
  return { bin: "ffprobe", args: ["-v", "error", "-show_format", "-show_streams", "-of", "json", inputPath] };
}

export function extractFrameCommand(inputPath: string, outputPattern: string, fps = 1): FfmpegCommand {
  return { bin: "ffmpeg", args: ["-i", inputPath, "-vf", `fps=${fps}`, outputPattern] };
}

export function clipCommand(inputPath: string, outputPath: string, startSeconds: number, durationSeconds: number): FfmpegCommand {
  return { bin: "ffmpeg", args: ["-ss", String(startSeconds), "-i", inputPath, "-t", String(durationSeconds), "-c:v", "libx264", "-c:a", "aac", outputPath] };
}

export function verticalCropFilter(mode: CropMode) {
  if (mode === "scoreboard_safe") return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:0:0";
  if (mode === "facecam_gameplay") return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
}

export function shortsExportCommand(inputPath: string, outputPath: string, cropMode: CropMode): FfmpegCommand {
  return { bin: "ffmpeg", args: ["-i", inputPath, "-vf", verticalCropFilter(cropMode), "-c:v", "libx264", "-c:a", "aac", outputPath] };
}
