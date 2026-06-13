import { createHighlightCandidate } from "@videoblitzer/highlight-engine";
import { clipCommand, extractFrameCommand, probeCommand, shortsExportCommand } from "./ffmpeg";
import { createClient } from "@supabase/supabase-js";
import { convertWebmToMp4FromR2 } from "./r2Conversion";
export { convertWebmToMp4FromR2 } from "./r2Conversion";

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

type ExportJob = {
  id: string;
  project_id: string;
  video_id?: string | null;
  user_id: string;
  source_object_key: string;
  target_object_key: string;
  source_format: string;
  target_format: string;
  status: string;
};

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
}

function workerEnabled() {
  return process.env.VIDEOBLITZER_WORKER_DAEMON === "1" || process.argv.includes("--daemon");
}

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = serviceKey();
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY are required for the video worker daemon.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function markJob(id: string, status: "queued" | "processing" | "completed" | "failed", patch: Record<string, unknown> = {}) {
  const client = supabase();
  await client.from("jobs").update({ status, updated_at: new Date().toISOString(), ...patch }).eq("id", id);
  await client.from("export_jobs").update({ status, ...(status === "completed" ? { completed_at: new Date().toISOString() } : {}), ...(patch.error ? { error_message: String(patch.error) } : {}) }).eq("id", id);
}

async function claimQueuedExportJob() {
  const client = supabase();
  const { data: candidates, error } = await client.from("export_jobs").select("*").eq("status", "queued").order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(error.message);
  const candidate = candidates?.[0] as ExportJob | undefined;
  if (!candidate) return null;
  const { data: claimed, error: claimError } = await client.from("export_jobs").update({ status: "processing" }).eq("id", candidate.id).eq("status", "queued").select("*").maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return null;
  await client.from("jobs").update({ status: "processing", progress: 10, updated_at: new Date().toISOString() }).eq("id", candidate.id);
  if (candidate.video_id) await client.from("videos").update({ conversion_status: "processing" }).eq("id", candidate.video_id);
  return claimed as ExportJob;
}

export async function processOneExportJob() {
  const client = supabase();
  const job = await claimQueuedExportJob();
  if (!job) return { processed: false };

  try {
    if (job.source_format !== "webm" || job.target_format !== "mp4") throw new Error(`Unsupported conversion ${job.source_format} -> ${job.target_format}`);
    await client.from("jobs").update({ progress: 35, updated_at: new Date().toISOString() }).eq("id", job.id);
    const result = await convertWebmToMp4FromR2({ sourceObjectKey: job.source_object_key, targetObjectKey: job.target_object_key });
    await client.from("jobs").update({ status: "completed", progress: 100, output: result, error: null, updated_at: new Date().toISOString() }).eq("id", job.id);
    await client.from("export_jobs").update({ status: "completed", completed_at: new Date().toISOString(), error_message: null }).eq("id", job.id);
    if (job.video_id) await client.from("videos").update({ conversion_status: "completed", storage_key: job.target_object_key }).eq("id", job.video_id);
    return { processed: true, jobId: job.id, status: "completed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown conversion failure";
    await markJob(job.id, "failed", { progress: 100, error: message });
    if (job.video_id) await client.from("videos").update({ conversion_status: "failed" }).eq("id", job.video_id);
    return { processed: true, jobId: job.id, status: "failed", error: message };
  }
}

export async function startWorkerDaemon() {
  const intervalMs = Number(process.env.VIDEO_WORKER_POLL_MS ?? 5000);
  console.log(`VideoBlitzer video worker daemon polling every ${intervalMs}ms`);
  for (;;) {
    try {
      const result = await processOneExportJob();
      if (result.processed) console.log("[video-worker] processed", result);
    } catch (error) {
      console.error("[video-worker] poll failed", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (workerEnabled()) {
  void startWorkerDaemon();
} else {
  console.log("VideoBlitzer video worker ready. Start with --daemon or VIDEOBLITZER_WORKER_DAEMON=1 to process export_jobs.");
}
