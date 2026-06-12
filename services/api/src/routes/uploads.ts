import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { uploadRateLimit } from "../middleware/rateLimit";
import { createSignedUploadUrl } from "../lib/r2";
import { createConversionJob } from "./exports";
import { createServiceClient } from "../supabase";

const allowedTypes = ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"] as const;
const metadataSchema = z.record(z.string(), z.unknown()).optional();
const markerSchema = z.array(z.record(z.string(), z.unknown())).max(500).optional();
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
  const body = z.object({
    projectId: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
    filename: z.string(),
    contentType: z.enum(allowedTypes).optional(),
    content_type: z.enum(allowedTypes).optional(),
    storageKey: z.string().optional(),
    object_key: z.string().optional(),
    sizeBytes: z.number().optional(),
    size_bytes: z.number().optional(),
    raw_format: z.literal("webm").optional(),
    desired_export_format: z.literal("mp4").optional(),
    recording_mode: z.string().max(80).optional(),
    source_type: z.string().max(80).optional(),
    source_label: z.string().max(300).optional(),
    source_url: z.string().max(2000).optional(),
    permission_confirmed: z.boolean().optional(),
    permission_confirmed_at: z.string().optional(),
    recording_metadata: metadataSchema,
    match_metadata: metadataSchema,
    markers: markerSchema,
    chunk_manifest: metadataSchema,
    import_metadata: metadataSchema,
    local_original_filename: z.string().max(300).optional(),
    original_mime_type: z.string().max(120).optional(),
    duration_seconds: z.number().nonnegative().optional(),
  }).parse(req.body);
  const projectId = body.projectId ?? body.project_id;
  const contentType = body.contentType ?? body.content_type;
  const storageKey = body.storageKey ?? body.object_key;
  const sizeBytes = body.sizeBytes ?? body.size_bytes;
  if (!projectId || !contentType || !storageKey) return res.status(400).json({ error: "project_id, object_key, and content_type are required" });
  const supabase = createServiceClient();
  const permissionConfirmedAt = body.permission_confirmed ? body.permission_confirmed_at ?? new Date().toISOString() : undefined;
  const video = { id: crypto.randomUUID(), project_id: projectId, owner_id: req.user!.id, user_id: req.user!.id, filename: body.filename, original_filename: body.filename, mime_type: contentType, content_type: contentType, storage_key: storageKey, source_object_key: storageKey, source_format: body.raw_format ?? "webm", desired_export_format: body.desired_export_format ?? "mp4", size_bytes: sizeBytes, status: "uploaded", recording_mode: body.recording_mode, source_type: body.source_type, source_label: body.source_label, source_url: body.source_url, permission_confirmed: body.permission_confirmed ?? false, permission_confirmed_at: permissionConfirmedAt, recording_metadata: body.recording_metadata ?? {}, match_metadata: body.match_metadata ?? {}, markers: body.markers ?? [], chunk_manifest: body.chunk_manifest ?? {}, import_metadata: body.import_metadata ?? {}, local_original_filename: body.local_original_filename, original_mime_type: body.original_mime_type ?? contentType, duration_seconds: body.duration_seconds, conversion_status: (body.desired_export_format ?? "mp4") === "mp4" ? "queued" : "not_requested" };
  let conversionJob = null;
  if (supabase) {
    const { error } = await supabase.from("videos").insert(video);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from("projects").update({ status: "uploaded", updated_at: new Date().toISOString(), recording_mode: body.recording_mode, source_label: body.source_label, source_url: body.source_url, permission_confirmed: body.permission_confirmed ?? false, permission_confirmed_at: permissionConfirmedAt, recording_metadata: body.recording_metadata ?? {}, match_metadata: body.match_metadata ?? {}, source_metadata: { sourceType: body.source_type, sourceLabel: body.source_label, sourceUrl: body.source_url }, import_metadata: body.import_metadata ?? {} }).eq("id", projectId).eq("owner_id", req.user!.id);
    await supabase.from("usage_events").insert({ user_id: req.user!.id, project_id: projectId, event_name: "video_uploaded", metadata: { filename: body.filename, storageKey, sizeBytes, rawFormat: body.raw_format ?? "webm", markers: body.markers ?? [], recordingMode: body.recording_mode, permissionConfirmed: body.permission_confirmed ?? false } });
    if ((body.desired_export_format ?? "mp4") === "mp4" && (body.raw_format ?? "webm") === "webm") {
      conversionJob = await createConversionJob({ projectId, videoId: video.id, userId: req.user!.id, sourceObjectKey: storageKey, sourceFormat: "webm", targetFormat: "mp4" });
    }
  }
  return res.status(201).json({ video, conversion_job: conversionJob });
});
