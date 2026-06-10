import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { uploadRateLimit } from "../middleware/rateLimit";
import { createSignedUploadUrl } from "../lib/r2";
import { createServiceClient } from "../supabase";

const allowedTypes = ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"] as const;
export const uploadsRouter = Router();
uploadsRouter.use(requireAuth, uploadRateLimit);

uploadsRouter.post("/create-signed-url", async (req, res) => {
  const body = z.object({ filename: z.string().min(1), contentType: z.enum(allowedTypes), projectId: z.string().uuid() }).parse(req.body);
  const supabase = createServiceClient();
  if (supabase) {
    const { data, error } = await supabase.from("projects").select("id").eq("id", body.projectId).eq("owner_id", req.user!.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Project not found" });
  }

  const signed = await createSignedUploadUrl(req.user!.id, body.projectId, body.filename, body.contentType);
  if (!signed.uploadUrl) return res.status(503).json({ error: "R2 upload signing is not configured on the API server.", signed });
  return res.json(signed);
});

uploadsRouter.post("/complete", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), filename: z.string(), contentType: z.enum(allowedTypes), storageKey: z.string(), sizeBytes: z.number().optional() }).parse(req.body);
  const supabase = createServiceClient();
  const video = { id: crypto.randomUUID(), project_id: body.projectId, owner_id: req.user!.id, filename: body.filename, mime_type: body.contentType, storage_key: body.storageKey, size_bytes: body.sizeBytes, status: "uploaded" };
  if (supabase) {
    const { error } = await supabase.from("videos").insert(video);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from("projects").update({ status: "uploaded", updated_at: new Date().toISOString() }).eq("id", body.projectId).eq("owner_id", req.user!.id);
    await supabase.from("usage_events").insert({ user_id: req.user!.id, project_id: body.projectId, event_name: "video_uploaded", metadata: { filename: body.filename, storageKey: body.storageKey, sizeBytes: body.sizeBytes } });
  }
  return res.status(201).json({ video });
});
