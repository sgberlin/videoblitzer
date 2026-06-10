import { createHighlightCandidate } from "@videoblitzer/highlight-engine";
import { clipCommand, extractFrameCommand, probeCommand, shortsExportCommand } from "./ffmpeg";

export async function analyzeVideo(projectId: string, inputPath: string) {
  return { projectId, status: "metadata_ready", probe: probeCommand(inputPath), candidates: createHighlightCandidates(projectId) };
}

export function extractFrames(inputPath: string, outputPattern = "frames/%06d.jpg") { return extractFrameCommand(inputPath, outputPattern, 1); }
export function extractAudioWaveform(projectId: string) { return { projectId, waveformPeaks: [], mode: "placeholder" }; }
export function detectAudioSpikes() { return [{ time: 42, confidence: "Medium", source: "audio_spike" }]; }
export function detectSceneChanges() { return [{ time: 18, confidence: "Low", source: "scene_change" }]; }
export function createHighlightCandidates(projectId: string) { return [createHighlightCandidate({ id: crypto.randomUUID(), projectId, eventTime: 42, label: "Crowd and mic reaction spike", signals: ["audio_spike", "mic_reaction"] })]; }
export function createClips(inputPath: string, outputPath: string) { return clipCommand(inputPath, outputPath, 30, 20); }
export function createShortsExport(inputPath: string, outputPath: string) { return shortsExportCommand(inputPath, outputPath, "action_follow"); }
export function burnCaptions(projectId: string) { return { projectId, status: "caption_burn_in_placeholder" }; }
export function createThumbnailFrames(projectId: string) { return { projectId, frames: [], status: "thumbnail_frame_placeholder" }; }
export function renderFinalExport(projectId: string) { return { projectId, status: "mock_export_record_created" }; }

console.log("VideoBlitzer video worker ready");
