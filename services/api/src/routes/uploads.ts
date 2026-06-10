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
  const body = z.object({ filename: z.string().min(1), contentType: z.enum(allowedTypes), projectId: z.string().uuid().optional() }).parse(req.body);
  const signed = await createSignedUploadUrl(req.user!.id, body.filename, body.contentType);
  return res.json(signed);
});

uploadsRouter.post("/complete", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), filename: z.string(), contentType: z.enum(allowedTypes), storageKey: z.string(), sizeBytes: z.number().optional() }).parse(req.body);
  const supabase = createServiceClient();
  const video = { project_id: body.projectId, owner_id: req.user!.id, filename: body.filename, mime_type: body.contentType, storage_key: body.storageKey, size_bytes: body.sizeBytes, status: "uploaded" };
  if (supabase) await supabase.from("videos").insert(video);
  return res.status(201).json({ video });
});
