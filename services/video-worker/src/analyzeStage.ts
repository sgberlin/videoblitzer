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
      const targetDuration = index % 4 === 0 ? 30 : index % 4 === 1 ? 45 : index % 4 === 2 ? 60 : 15;
      const startSeconds = Math.max(0, (marker.seconds || 0) - 4);
      const endSeconds = Math.min(safeDuration, startSeconds + targetDuration);
      return {
        id: `marker-${index + 1}`,
        startSeconds,
        endSeconds,
        label: marker.label || "Marked game moment",
        note: marker.note,
        confidence: 0.82,
        reason: "Manual marker or recorder marker supplied by the user.",
        suggestedClipType: targetDuration <= 15 ? "quick_moment" : targetDuration <= 30 ? "short_highlight" : targetDuration <= 45 ? "story_highlight" : "extended_highlight",
        platformFit: targetDuration <= 60 ? ["instagram_reels", "tiktok", "youtube_shorts", "facebook_reels"] : ["youtube_standard", "facebook"],
      };
    });
  }

  return [0.12, 0.32, 0.58, 0.82].map((point, index) => {
    const targetDuration = [15, 30, 45, 60][index] ?? 30;
    const center = safeDuration * point;
    const startSeconds = Math.max(0, center - Math.min(8, targetDuration / 3));
    const endSeconds = Math.min(safeDuration, startSeconds + targetDuration);
    return {
      id: `candidate-${targetDuration}s-${index + 1}`,
      startSeconds,
      endSeconds,
      label: `${targetDuration}s candidate highlight`,
      confidence: 0.42,
      reason: "Candidate selected from full-game duration distribution. No transcript/audio marker was available, so this needs review.",
      suggestedClipType: targetDuration <= 15 ? "quick_moment" : targetDuration <= 30 ? "short_highlight" : targetDuration <= 45 ? "story_highlight" : "extended_highlight",
      platformFit: targetDuration <= 60 ? ["instagram_reels", "tiktok", "youtube_shorts", "facebook_reels", "youtube_standard"] : ["youtube_standard"],
    };
  });
}

export async function analyzeStage(inputPath: string, markers: VideoRow["markers"]): Promise<AnalysisResult> {
  const durationSeconds = await probeDurationSeconds(inputPath);
  return {
    durationSeconds,
    clipPlan: createClipPlan(durationSeconds, markers),
  };
}
