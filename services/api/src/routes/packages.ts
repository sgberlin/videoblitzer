import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { jobRateLimit } from "../middleware/rateLimit";
import { createServiceClient } from "../supabase";
import { getOwnedVideo, userOwnsProject } from "../lib/ownership";
import { createSignedDownloadUrl } from "../lib/r2";
import { enforceCredits, refundCredits } from "../lib/creditLedger";

const packageInputSchema = z.object({
  projectId: z.string().uuid(),
  videoId: z.string().uuid().optional(),
  presetIds: z.array(z.string().min(2).max(80)).max(12).optional(),
  includeClipPlan: z.boolean().default(true),
});

export const packagesRouter = Router();
packagesRouter.use(requireAuth, jobRateLimit);

async function latestOwnedVideoForProject(userId: string, projectId: string) {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Supabase service role is required.");
  const { data, error } = await supabase
    .from("videos")
    .select("id,project_id,owner_id,storage_key,source_object_key,source_format,content_type,mime_type")
    .eq("project_id", projectId)
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

packagesRouter.post("/generate", async (req, res) => {
  const body = packageInputSchema.parse(req.body);
  if (!await userOwnsProject(req.user!.id, body.projectId)) return res.status(404).json({ error: "Project not found" });

  const video = body.videoId
    ? await getOwnedVideo(req.user!.id, body.videoId)
    : await latestOwnedVideoForProject(req.user!.id, body.projectId);
  if (!video) return res.status(404).json({ error: "No uploaded video is available for this project yet." });
  if (video.project_id !== body.projectId) return res.status(400).json({ error: "Selected video does not belong to the requested project." });

  const sourceObjectKey = video.storage_key ?? video.source_object_key;
  if (!sourceObjectKey) return res.status(400).json({ error: "Video source object key is missing." });
  const sourceFormat = ((video.source_format ?? "mp4").toLowerCase() || "mp4");
  const mimeType = video.content_type ?? video.mime_type ?? "video/mp4";

  const creditResult = await enforceCredits({
    userId: req.user!.id,
    projectId: body.projectId,
    action: "social_content_pack",
    isUnlimited: req.user!.isUnlimited,
    metadata: {
      projectId: body.projectId,
      videoId: video.id,
      sourceObjectKey,
      sourceFormat,
      presetIds: body.presetIds ?? [],
    },
  });
  if (!creditResult.ok) {
    return res.status(402).json({
      error: `Insufficient credits. Package generation requires ${creditResult.cost} credits.`,
      code: "insufficient_credits",
      creditCost: creditResult.cost,
      balance: creditResult.balanceAfter,
    });
  }

  const jobId = crypto.randomUUID();
  const jobInput = {
    sourceObjectKey,
    sourceFormat,
    sourceMimeType: mimeType,
    presetIds: body.presetIds ?? ["youtube_16_9_1080p", "shorts_9_16_1080x1920", "square_1_1_1080"],
    includeClipPlan: body.includeClipPlan,
  };
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });

  try {
    const { error: enqueueError } = await supabase.rpc("enqueue_package_job_atomic", {
      p_job_id: jobId,
      p_project_id: body.projectId,
      p_video_id: video.id,
      p_user_id: req.user!.id,
      p_input: jobInput,
    });
    if (enqueueError) throw new Error(enqueueError.message);
    await supabase.from("usage_events").insert({
      user_id: req.user!.id,
      project_id: body.projectId,
      event_name: "package_job_queued",
      metadata: { jobId, videoId: video.id, presetIds: jobInput.presetIds },
    });
  } catch (error) {
    await refundCredits({
      userId: req.user!.id,
      projectId: body.projectId,
      action: "social_content_pack",
      cost: creditResult.cost,
      metadata: {
        reason: "package_queue_failed",
        projectId: body.projectId,
        videoId: video.id,
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not queue package job.", code: "package_queue_failed" });
  }

  return res.status(202).json({
    job_id: jobId,
    status: "queued",
    job: {
      id: jobId,
      project_id: body.projectId,
      video_id: video.id,
      user_id: req.user!.id,
      status: "queued",
      progress: 0,
      input: jobInput,
    },
  });
});

packagesRouter.get("/:id", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data, error } = await supabase.from("package_jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Package job not found" });
  return res.json({ packageJob: data });
});

packagesRouter.get("/:id/download", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data, error } = await supabase
    .from("package_jobs")
    .select("id,status,artifact_object_key,user_id")
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Package job not found" });
  if (data.status !== "completed" || !data.artifact_object_key) {
    return res.status(409).json({ error: "Package artifact is not ready yet." });
  }
  const signed = await createSignedDownloadUrl(data.artifact_object_key);
  if (!signed.downloadUrl) return res.status(503).json({ error: "R2 downloads are not configured.", signed });
  return res.json(signed);
});

packagesRouter.post("/:id/retry", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data: existing, error: lookupError } = await supabase.from("package_jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  if (!existing) return res.status(404).json({ error: "Package job not found" });
  if (existing.status !== "failed") return res.status(409).json({ error: "Only failed package jobs can be retried.", code: "job_not_retryable" });
  if ((existing.attempts ?? 0) >= 3) return res.status(409).json({ error: "Retry limit reached.", code: "retry_limit_reached" });

  const { data, error } = await supabase
    .from("package_jobs")
    .update({
      status: "queued",
      progress: 0,
      error_message: null,
      locked_at: null,
      worker_id: null,
      artifact_object_key: null,
      output: {},
      manifest_json: {},
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .select("*")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  await supabase
    .from("jobs")
    .update({ status: "queued", progress: 0, error: null, output: {}, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .eq("type", "social_content_pack");

  return res.json({ packageJob: data });
});
