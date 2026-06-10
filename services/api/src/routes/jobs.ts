import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { jobRateLimit } from "../middleware/rateLimit";
import { createServiceClient } from "../supabase";

export const jobsRouter = Router();
jobsRouter.use(requireAuth, jobRateLimit);

jobsRouter.post("/analyze", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), videoId: z.string().uuid().optional() }).parse(req.body);
  const job = { id: crypto.randomUUID(), project_id: body.projectId, user_id: req.user!.id, type: "analyze", status: "queued", progress: 0, input: { videoId: body.videoId }, output: {} };
  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("jobs").insert(job);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from("projects").update({ status: "analyzing", updated_at: new Date().toISOString() }).eq("id", body.projectId).eq("owner_id", req.user!.id);
    await supabase.from("usage_events").insert({ user_id: req.user!.id, project_id: body.projectId, event_name: "analyze_job_created", metadata: { jobId: job.id, videoId: body.videoId } });
  }
  return res.status(202).json({ job });
});

jobsRouter.post("/export", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), presetId: z.string(), cropMode: z.string() }).parse(req.body);
  const job = { id: crypto.randomUUID(), project_id: body.projectId, user_id: req.user!.id, type: "export", status: "queued", progress: 0, input: { presetId: body.presetId, cropMode: body.cropMode }, output: {} };
  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("jobs").insert(job);
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.status(202).json({ job });
});

jobsRouter.get("/:id", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ job: { id: req.params.id, status: "queued", progress: 0 } });
  const { data, error } = await supabase.from("jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Job not found" });
  return res.json({ job: data });
});

jobsRouter.post("/:id/retry", async (req, res) => {
  const supabase = createServiceClient();
  if (supabase) {
    const { data, error } = await supabase.from("jobs").update({ status: "queued", progress: 0, error: null, attempts: 1, updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", req.user!.id).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ job: data });
  }
  return res.json({ job: { id: req.params.id, status: "queued", attempts: 1 } });
});
