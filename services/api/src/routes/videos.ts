import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createSignedDownloadUrl } from "../lib/r2";
import { createServiceClient } from "../supabase";

export const videosRouter = Router();
videosRouter.use(requireAuth);

async function duplicateStatusForVideo(input: {
  supabase: NonNullable<ReturnType<typeof createServiceClient>>;
  userId: string;
  videoId: string;
}) {
  const { data: video, error } = await input.supabase
    .from("videos")
    .select("*")
    .eq("id", input.videoId)
    .eq("owner_id", input.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!video) return null;

  const duplicateOfVideoId = typeof video.duplicate_of_video_id === "string" ? video.duplicate_of_video_id : null;
  const originalVideoId = duplicateOfVideoId ?? video.id;
  const [originalVideo, originalProject, packageJobs, assets] = await Promise.all([
    input.supabase.from("videos").select("*").eq("id", originalVideoId).eq("owner_id", input.userId).maybeSingle(),
    input.supabase
      .from("projects")
      .select("id,title,created_at")
      .eq("id", String(video.project_id))
      .eq("owner_id", input.userId)
      .maybeSingle(),
    input.supabase
      .from("package_jobs")
      .select("*")
      .eq("video_id", originalVideoId)
      .eq("user_id", input.userId)
      .order("created_at", { ascending: false }),
    input.supabase
      .from("package_assets")
      .select("*")
      .eq("video_id", originalVideoId)
      .eq("user_id", input.userId)
      .order("created_at", { ascending: false }),
  ]);
  if (originalVideo.error) throw new Error(originalVideo.error.message);
  if (originalProject.error) throw new Error(originalProject.error.message);
  if (packageJobs.error) throw new Error(packageJobs.error.message);
  if (assets.error) throw new Error(assets.error.message);
  const jobs = packageJobs.data ?? [];
  const completedJobs = jobs.filter((job) => job.status === "completed");

  return {
    video,
    duplicateDetected: Boolean(duplicateOfVideoId),
    duplicateOfVideoId,
    originalVideo: originalVideo.data,
    originalProject: originalProject.data,
    packageCount: jobs.length,
    completedPackageCount: completedJobs.length,
    availablePackageTypes: [...new Set(jobs.map((job) => String(job.package_variant ?? (job.input as Record<string, unknown> | null)?.packageVariant ?? "standard_highlights")))],
    lastPackageCreatedAt: jobs[0]?.created_at ?? null,
    packageJobs: jobs,
    packageAssets: assets.data ?? [],
  };
}

videosRouter.get("/:id/duplicate-status", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  try {
    const status = await duplicateStatusForVideo({ supabase, userId: req.user!.id, videoId: req.params.id });
    if (!status) return res.status(404).json({ error: "Video not found" });
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Could not load duplicate status.", code: "duplicate_status_failed" });
  }
});

videosRouter.get("/:id/packages", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data: video, error: videoError } = await supabase.from("videos").select("id,duplicate_of_video_id").eq("id", req.params.id).eq("owner_id", req.user!.id).maybeSingle();
  if (videoError) return res.status(500).json({ error: videoError.message });
  if (!video) return res.status(404).json({ error: "Video not found" });
  const sourceVideoId = video.duplicate_of_video_id ?? video.id;
  const [{ data: packageJobs, error }, assets] = await Promise.all([
    supabase.from("package_jobs").select("*").eq("video_id", sourceVideoId).eq("user_id", req.user!.id).order("created_at", { ascending: false }),
    supabase.from("package_assets").select("*").eq("video_id", sourceVideoId).eq("user_id", req.user!.id).order("created_at", { ascending: false }),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  if (assets.error) return res.status(500).json({ error: assets.error.message });
  const zipJob = (packageJobs ?? []).find((job) => job.status === "completed" && job.artifact_object_key);
  const signed = zipJob?.artifact_object_key ? await createSignedDownloadUrl(zipJob.artifact_object_key) : null;
  return res.json({ sourceVideoId, packageJobs: packageJobs ?? [], packageAssets: assets.data ?? [], latestDownloadUrl: signed?.downloadUrl ?? null });
});
