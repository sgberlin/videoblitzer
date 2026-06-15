import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { jobRateLimit } from "../middleware/rateLimit";
import { createServiceClient } from "../supabase";
import { userOwnsProject, userOwnsVideo } from "../lib/ownership";

export const jobsRouter = Router();
jobsRouter.use(requireAuth, jobRateLimit);

jobsRouter.post("/analyze", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), videoId: z.string().uuid().optional() }).parse(req.body);
  try {
    if (!await userOwnsProject(req.user!.id, body.projectId)) return res.status(404).json({ error: "Project not found" });
    if (body.videoId && !await userOwnsVideo(req.user!.id, body.videoId)) return res.status(404).json({ error: "Video not found" });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Ownership check failed" });
  }
  const job = { id: crypto.randomUUID(), project_id: body.projectId, user_id: req.user!.id, type: "analyze", status: "completed", progress: 100, input: { videoId: body.videoId }, output: { status: "metadata_ready", note: "Analyze worker is not enabled yet; upload metadata is stored for downstream workflows." } };
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  {
    const { error } = await supabase.from("jobs").insert(job);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from("projects").update({ status: "uploaded", updated_at: new Date().toISOString() }).eq("id", body.projectId).eq("owner_id", req.user!.id);
    await supabase.from("usage_events").insert({ user_id: req.user!.id, project_id: body.projectId, event_name: "analyze_job_created", metadata: { jobId: job.id, videoId: body.videoId } });
  }
  return res.status(201).json({ job });
});

jobsRouter.post("/export", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), presetId: z.string(), cropMode: z.string() }).parse(req.body);
  try {
    if (!await userOwnsProject(req.user!.id, body.projectId)) return res.status(404).json({ error: "Project not found" });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Ownership check failed" });
  }
  return res.status(501).json({ error: "Generic export jobs are not enabled yet. Use WebM to MP4 conversion from uploaded videos.", code: "export_worker_not_enabled", requested: body });
});

jobsRouter.get("/:id", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data, error } = await supabase.from("jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Job not found" });
  return res.json({ job: data });
});

jobsRouter.post("/:id/retry", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data: existing, error: lookupError } = await supabase.from("jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  if (!existing) return res.status(404).json({ error: "Job not found" });
  if (existing.status !== "failed") return res.status(409).json({ error: "Only failed jobs can be retried.", code: "job_not_retryable" });
  if ((existing.attempts ?? 0) >= 3) return res.status(409).json({ error: "Retry limit reached.", code: "retry_limit_reached" });
  const nextAttempts = (existing.attempts ?? 0) + 1;
  const { data, error } = await supabase.from("jobs").update({ status: "queued", progress: 0, error: null, attempts: nextAttempts, updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", req.user!.id).select("*").maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (data?.type === "convert_mp4") await supabase.from("export_jobs").update({ status: "queued", error_message: null, attempts: nextAttempts, locked_at: null, worker_id: null, updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", req.user!.id).eq("status", "failed");
  if (data?.type === "social_content_pack") {
    await supabase
      .from("package_jobs")
      .update({
        status: "queued",
        progress: 0,
        error_message: null,
        attempts: nextAttempts,
        locked_at: null,
        worker_id: null,
        artifact_object_key: null,
        output: {},
        manifest_json: {},
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id)
      .eq("status", "failed");
  }
  return res.json({ job: data });
});
