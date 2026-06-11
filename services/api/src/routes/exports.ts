import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const exportsRouter = Router();
exportsRouter.use(requireAuth);

export async function createConversionJob(input: { projectId: string; videoId?: string; userId: string; sourceObjectKey: string; sourceFormat: "webm"; targetFormat: "mp4" }) {
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

  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("export_jobs").insert(job);
    if (error) throw new Error(error.message);
    await supabase.from("jobs").insert({ id: job.id, project_id: input.projectId, user_id: input.userId, type: "convert_mp4", status: "queued", progress: 0, input: { sourceObjectKey: input.sourceObjectKey, targetObjectKey: job.target_object_key, sourceFormat: input.sourceFormat, targetFormat: input.targetFormat }, output: {} });
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
  const sourceObjectKey = body.sourceObjectKey ?? body.source_object_key;
  const videoId = body.videoId ?? body.video_id;
  if (!projectId || !sourceObjectKey) return res.status(400).json({ error: "project_id and source_object_key are required" });

  const supabase = createServiceClient();
  if (supabase) {
    const { data, error } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", req.user!.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Project not found" });
  }

  const job = await createConversionJob({ projectId, videoId, userId: req.user!.id, sourceObjectKey, sourceFormat: "webm", targetFormat: "mp4" });
  return res.status(202).json({ job_id: job.id, status: job.status, job });
});
