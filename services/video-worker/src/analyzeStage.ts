import type { AnalysisResult, ClipPlanItem, VideoRow } from "./packageTypes";
import { runCommand } from "./packageCommand";

export async function probeDurationSeconds(inputPath: string) {
  const { stdout } = await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath]);
  const parsed = Number(stdout.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createClipPlan(durationSeconds: number, markers: VideoRow["markers"]): ClipPlanItem[] {
  const safeDuration = Math.max(1, durationSeconds || 1);
  const normalizedMarkers = (markers ?? [])
    .map((marker) => ({ seconds: Number(marker.seconds ?? NaN), label: marker.label ?? "Marker", note: marker.note }))
    .filter((marker) => Number.isFinite(marker.seconds))
    .slice(0, 12);

  if (normalizedMarkers.length) {
    return normalizedMarkers.map((marker, index) => {
      const startSeconds = Math.max(0, (marker.seconds || 0) - 6);
      const endSeconds = Math.min(safeDuration, startSeconds + 16);
      return { id: `marker-${index + 1}`, startSeconds, endSeconds, label: marker.label || "Marker", note: marker.note };
    });
  }

  return [0.12, 0.45, 0.78].map((point, index) => {
    const center = safeDuration * point;
    const startSeconds = Math.max(0, center - 8);
    const endSeconds = Math.min(safeDuration, startSeconds + 16);
    return { id: `auto-${index + 1}`, startSeconds, endSeconds, label: `Auto moment ${index + 1}` };
  });
}

export async function analyzeStage(inputPath: string, markers: VideoRow["markers"]): Promise<AnalysisResult> {
  const durationSeconds = await probeDurationSeconds(inputPath);
  return {
    durationSeconds,
    clipPlan: createClipPlan(durationSeconds, markers),
  };
}
