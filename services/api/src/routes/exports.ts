import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";
import { getOwnedVideo, isExpectedRawUploadKey, userOwnsProject } from "../lib/ownership";
import { enforceCredits, refundCredits } from "../lib/creditLedger";
import { createSignedDownloadUrl } from "../lib/r2";

export const exportsRouter = Router();
exportsRouter.use(requireAuth);

export async function createConversionJob(input: { projectId: string; videoId?: string; userId: string; sourceObjectKey: string; sourceFormat: "webm"; targetFormat: "mp4"; skipCreditCheck?: boolean }) {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Supabase service role is required.");
  let chargedCost = 0;
  if (supabase && !input.skipCreditCheck) {
    const { data: profile, error: profileError } = await supabase.from("profiles").select("is_unlimited").eq("id", input.userId).maybeSingle();
    if (profileError) throw new Error(profileError.message);
    const creditResult = await enforceCredits({ userId: input.userId, projectId: input.projectId, action: "video_conversion_mp4", isUnlimited: Boolean(profile?.is_unlimited), metadata: { sourceObjectKey: input.sourceObjectKey, targetFormat: input.targetFormat } });
    if (!creditResult.ok) throw new Error(`Insufficient credits. MP4 conversion requires ${creditResult.cost} credits.`);
    chargedCost = creditResult.cost;
  }
  const job = {
    id: crypto.randomUUID(),
    project_id: input.projectId,
    video_id: input.videoId,
    user_id: input.userId,
    source_object_key: input.sourceObjectKey,
    target_object_key: `exports/mp4/${input.userId}/${input.projectId}/${crypto.randomUUID()}.mp4`,
    source_format: input.sourceFormat,
    target_format: input.targetFormat,
    status: "queued",
  };

  try {
    const { error } = await supabase.from("export_jobs").insert(job);
    if (error) throw new Error(error.message);
    const { error: mirrorError } = await supabase.from("jobs").insert({ id: job.id, project_id: input.projectId, user_id: input.userId, type: "convert_mp4", status: "queued", progress: 0, input: { sourceObjectKey: input.sourceObjectKey, targetObjectKey: job.target_object_key, sourceFormat: input.sourceFormat, targetFormat: input.targetFormat }, output: {} });
    if (mirrorError) throw new Error(mirrorError.message);
  } catch (error) {
    try {
      await supabase.from("export_jobs").delete().eq("id", job.id).eq("status", "queued");
    } catch {
      // Best-effort cleanup; refund is more important if the queue insert was only partially durable.
    }
    if (chargedCost > 0) await refundCredits({ userId: input.userId, projectId: input.projectId, action: "video_conversion_mp4", cost: chargedCost, metadata: { reason: "conversion_queue_failed", sourceObjectKey: input.sourceObjectKey } }).catch(() => undefined);
    throw error;
  }

  return job;
}

exportsRouter.post("/convert", async (req, res) => {
  const body = z.object({
    project_id: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    video_id: z.string().uuid().optional(),
    videoId: z.string().uuid().optional(),
    source_object_key: z.string().min(1).optional(),
    sourceObjectKey: z.string().min(1).optional(),
    source_format: z.literal("webm").optional(),
    sourceFormat: z.literal("webm").optional(),
    target_format: z.literal("mp4").optional(),
    targetFormat: z.literal("mp4").optional(),
  }).parse(req.body);

  const projectId = body.projectId ?? body.project_id;
  const videoId = body.videoId ?? body.video_id;
  if (!projectId || !videoId) return res.status(400).json({ error: "project_id and video_id are required" });
  try {
    if (!await userOwnsProject(req.user!.id, projectId)) return res.status(404).json({ error: "Project not found" });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : "Ownership check failed" });
  }

  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  let video;
  try {
    video = await getOwnedVideo(req.user!.id, videoId);
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : "Video ownership check failed" });
  }
  if (!video || video.project_id !== projectId) return res.status(404).json({ error: "Video not found" });
  if ((video.source_format ?? "").toLowerCase() !== "webm") return res.status(400).json({ error: "Only WebM videos can be queued for MP4 conversion.", code: "unsupported_conversion_source" });
  const sourceObjectKey = video.source_object_key ?? video.storage_key;
  if (!sourceObjectKey || !isExpectedRawUploadKey(req.user!.id, projectId, sourceObjectKey)) return res.status(400).json({ error: "Video source key does not match the authenticated project.", code: "invalid_video_source_key" });

  try {
    const job = await createConversionJob({ projectId, videoId, userId: req.user!.id, sourceObjectKey, sourceFormat: "webm", targetFormat: "mp4" });
    return res.status(202).json({ job_id: job.id, status: job.status, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue conversion.";
    const status = message.toLowerCase().includes("insufficient credits") ? 402 : 500;
    return res.status(status).json({ error: message, code: status === 402 ? "insufficient_credits" : "conversion_queue_failed" });
  }
});

exportsRouter.get("/:id/download", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data, error } = await supabase.from("export_jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Export job not found" });
  if (data.status !== "completed" || !data.target_object_key) return res.status(409).json({ error: "MP4 conversion is not completed yet." });
  const signed = await createSignedDownloadUrl(data.target_object_key);
  if (!signed.downloadUrl) return res.status(503).json({ error: "R2 downloads are not configured.", signed });
  return res.json(signed);
});
