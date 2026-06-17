import { Router } from "express";
import { ZodError, z } from "zod";
import { requireAuth } from "../middleware/auth";
import { jobRateLimit } from "../middleware/rateLimit";
import { createServiceClient } from "../supabase";
import { getOwnedVideo, hydrateVideoMetadata, isSchemaCacheMissingColumn, userOwnsProject } from "../lib/ownership";
import { createSignedDownloadUrl } from "../lib/r2";
import { enforceCredits, refundCredits } from "../lib/creditLedger";

const packageInputSchema = z.object({
  projectId: z.string().uuid(),
  videoId: z.string().uuid().optional(),
  presetIds: z.array(z.string().min(2).max(80)).max(12).optional(),
  includeClipPlan: z.boolean().default(true),
});
const extendedVideoSelect = "id,project_id,owner_id,storage_key,source_object_key,source_format,content_type,mime_type,verification_status,verified_at,verified_size_bytes,has_video,has_audio,video_codec,audio_codec,duration_seconds,width,height,audio_source_object_key,audio_source_filename,audio_source_content_type,audio_source_size_bytes,audio_source_metadata,verification_metadata";
const baseVideoSelect = "id,project_id,owner_id,storage_key,source_object_key,source_format,content_type,mime_type,verification_status,verified_at,verified_size_bytes,verification_metadata";
type PackageVideo = {
  id: string;
  project_id: string;
  storage_key?: string | null;
  source_object_key?: string | null;
  source_format?: string | null;
  content_type?: string | null;
  mime_type?: string | null;
  verification_status?: string | null;
  verified_at?: string | null;
  verified_size_bytes?: number | null;
  has_video?: boolean | null;
  has_audio?: boolean | null;
  video_codec?: string | null;
  audio_codec?: string | null;
  duration_seconds?: number | null;
  width?: number | null;
  height?: number | null;
  audio_source_object_key?: string | null;
  audio_source_filename?: string | null;
  audio_source_content_type?: string | null;
  audio_source_size_bytes?: number | null;
  audio_source_metadata?: Record<string, unknown> | null;
};

export const packagesRouter = Router();
packagesRouter.use(requireAuth, jobRateLimit);

function isMissingEnqueueRpc(error: unknown) {
  const message = typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : String(error);
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  return code === "PGRST202" || message.includes("enqueue_package_job_atomic") || message.includes("function") && message.includes("not found");
}

async function enqueuePackageJobDirect(input: {
  supabase: NonNullable<ReturnType<typeof createServiceClient>>;
  jobId: string;
  projectId: string;
  videoId: string;
  userId: string;
  jobInput: Record<string, unknown>;
}) {
  const packageRow = {
    id: input.jobId,
    project_id: input.projectId,
    video_id: input.videoId,
    user_id: input.userId,
    status: "queued",
    progress: 0,
    stage: "queued",
    input: input.jobInput,
    stage_started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
  const packageInsert = await input.supabase.from("package_jobs").insert(packageRow);
  if (packageInsert.error) {
    if (!isSchemaCacheMissingColumn(packageInsert.error)) throw new Error(packageInsert.error.message);
    const fallbackInsert = await input.supabase.from("package_jobs").insert({
      id: input.jobId,
      project_id: input.projectId,
      video_id: input.videoId,
      user_id: input.userId,
      status: "queued",
      progress: 0,
      input: input.jobInput,
    });
    if (fallbackInsert.error) throw new Error(fallbackInsert.error.message);
  }
  const mirrorInsert = await input.supabase.from("jobs").insert({
    id: input.jobId,
    project_id: input.projectId,
    user_id: input.userId,
    type: "social_content_pack",
    status: "queued",
    progress: 0,
    input: input.jobInput,
    output: { stage: "queued" },
  });
  if (mirrorInsert.error) throw new Error(mirrorInsert.error.message);
}

async function latestOwnedVideoForProject(userId: string, projectId: string) {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Supabase service role is required.");
  const { data, error } = await supabase
    .from("videos")
    .select(extendedVideoSelect)
    .eq("project_id", projectId)
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!error) return hydrateVideoMetadata(data);
  if (!isSchemaCacheMissingColumn(error)) throw new Error(error.message);
  const fallback = await supabase
    .from("videos")
    .select(baseVideoSelect)
    .eq("project_id", projectId)
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback.error) throw new Error(fallback.error.message);
  return hydrateVideoMetadata(fallback.data);
}

packagesRouter.post("/generate", async (req, res) => {
  try {
    const body = packageInputSchema.parse(req.body);
    if (!await userOwnsProject(req.user!.id, body.projectId)) return res.status(404).json({ error: "Project not found" });

    const video = (body.videoId
      ? await getOwnedVideo(req.user!.id, body.videoId)
      : await latestOwnedVideoForProject(req.user!.id, body.projectId)) as PackageVideo | null;
    if (!video) return res.status(404).json({ error: "No uploaded video is available for this project yet." });
    if (video.project_id !== body.projectId) return res.status(400).json({ error: "Selected video does not belong to the requested project." });
    if (video.verification_status !== "verified") {
      return res.status(409).json({
        error: "Upload must be verified before producing a package.",
        code: "upload_not_verified",
        verificationStatus: video.verification_status ?? "unverified",
      });
    }
    if (video.has_video !== true) {
      return res.status(409).json({
        error: "This file contains audio only. Social media video packages require a video stream.",
        code: "audio_only_source_not_supported",
        hasVideo: Boolean(video.has_video),
        hasAudio: Boolean(video.has_audio),
      });
    }

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
      verifiedAt: video.verified_at,
      verifiedSizeBytes: video.verified_size_bytes,
      hasVideo: video.has_video,
      hasAudio: video.has_audio,
      videoCodec: video.video_codec,
      audioCodec: video.audio_codec,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      audioSourceObjectKey: video.audio_source_object_key,
      audioSourceFilename: video.audio_source_filename,
      audioSourceContentType: video.audio_source_content_type,
      audioSourceSizeBytes: video.audio_source_size_bytes,
      audioSourceMetadata: video.audio_source_metadata,
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
      if (enqueueError) {
        if (!isMissingEnqueueRpc(enqueueError) && !isSchemaCacheMissingColumn(enqueueError)) throw new Error(enqueueError.message);
        await enqueuePackageJobDirect({ supabase, jobId, projectId: body.projectId, videoId: video.id, userId: req.user!.id, jobInput });
      }
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
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        code: "validation_failed",
        details: error.issues,
      });
    }
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "package_generate_failed";
    return res.status(statusCode).json({
      error: error instanceof Error ? error.message : "Could not start package generation.",
      code,
    });
  }
});

packagesRouter.get("/:id", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const [{ data, error }, assets] = await Promise.all([
    supabase.from("package_jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle(),
    supabase.from("package_assets").select("*").eq("package_job_id", req.params.id).eq("user_id", req.user!.id).order("created_at", { ascending: true }),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  if (assets.error) return res.status(500).json({ error: assets.error.message });
  if (!data) return res.status(404).json({ error: "Package job not found" });
  return res.json({ packageJob: data, assets: assets.data ?? [] });
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
      stage: "queued",
      stage_started_at: new Date().toISOString(),
      last_heartbeat_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .select("*")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from("package_assets").delete().eq("package_job_id", req.params.id).eq("user_id", req.user!.id);

  await supabase
    .from("jobs")
    .update({ status: "queued", progress: 0, error: null, output: {}, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .eq("type", "social_content_pack");
  await supabase.rpc("write_audit_log", { p_actor_id: req.user!.id, p_action: "package_job_retry", p_target_type: "package_job", p_target_id: req.params.id, p_metadata: { projectId: existing.project_id, attempts: existing.attempts ?? 0 } });

  return res.json({ packageJob: data });
});
