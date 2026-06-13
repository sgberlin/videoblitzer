import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";
import { userOwnsProject } from "../lib/ownership";
import { isBlockedVideoPlatformUrl, isDirectMediaUrl, validateDirectMediaImportUrl } from "../lib/directMediaImport";

export const sourceImportRouter = Router();
sourceImportRouter.use(requireAuth);

function requireImporter(req: Request, res: Response) {
  if (!["owner", "admin"].includes(req.user?.role ?? "")) {
    res.status(403).json({ error: "Source Import is restricted to designated admin users." });
    return false;
  }
  return true;
}

sourceImportRouter.post("/metadata", async (req, res) => {
  if (!requireImporter(req, res)) return;
  const body = z.object({ sourceUrl: z.string().url(), permissionConfirmed: z.boolean() }).parse(req.body);
  if (!body.permissionConfirmed) return res.status(400).json({ error: "Permission confirmation is required before importing or inspecting a source." });
  const url = new URL(body.sourceUrl);
  const isYoutubeLike = isBlockedVideoPlatformUrl(body.sourceUrl);
  return res.json({
    metadata: {
      sourceUrl: body.sourceUrl,
      sourceName: url.hostname,
      title: url.pathname.split("/").filter(Boolean).pop() ?? url.hostname,
      thumbnail: null,
      duration: null,
      directMediaFile: isDirectMediaUrl(body.sourceUrl),
      metadataOnly: isYoutubeLike && !isDirectMediaUrl(body.sourceUrl),
      note: isYoutubeLike && !isDirectMediaUrl(body.sourceUrl) ? "Metadata only. Upload an authorized source file or provide a permitted direct media file URL; arbitrary video downloading is not supported." : "Direct/public media URL may be imported only when permitted by the source and user rights.",
    },
  });
});

sourceImportRouter.post("/direct", async (req, res) => {
  if (!requireImporter(req, res)) return;
  const body = z.object({
    projectId: z.string().uuid(),
    sourceUrl: z.string().url().max(2000),
    permissionConfirmed: z.boolean(),
    sourceMetadata: z.record(z.string(), z.unknown()).optional(),
  }).parse(req.body);
  if (!body.permissionConfirmed) return res.status(400).json({ error: "Permission confirmation is required before importing a direct media URL." });
  try {
    if (!await userOwnsProject(req.user!.id, body.projectId)) return res.status(404).json({ error: "Project not found" });
    await validateDirectMediaImportUrl(body.sourceUrl);
  } catch (error) {
    return res.status(isBlockedVideoPlatformUrl(body.sourceUrl) ? 400 : 422).json({ error: error instanceof Error ? error.message : "Direct media URL validation failed." });
  }

  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const importJob = {
    id: crypto.randomUUID(),
    user_id: req.user!.id,
    project_id: body.projectId,
    source_url: body.sourceUrl,
    source_type: "direct_media_url",
    status: "queued",
    progress: 0,
    source_metadata: body.sourceMetadata ?? {},
  };
  const { error } = await supabase.from("import_jobs").insert(importJob);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from("import_audits").insert({
    user_id: req.user!.id,
    project_id: body.projectId,
    source_url: body.sourceUrl,
    import_method: "direct_media_url",
    permission_confirmed: true,
    ip_address: req.ip,
    user_agent: req.headers["user-agent"],
    metadata: { result: "queued", importJobId: importJob.id, sourceType: "direct_media_url" },
  });
  return res.status(202).json({ importJob });
});

sourceImportRouter.post("/audit", async (req, res) => {
  if (!requireImporter(req, res)) return;
  const body = z.object({
    projectId: z.string().uuid().optional(),
    sourceUrl: z.string().max(2000).optional(),
    importMethod: z.enum(["direct_file_upload", "cloud_storage_url", "direct_media_url", "local_recording", "metadata_only"]),
    permissionConfirmed: z.boolean(),
    fileName: z.string().max(300).optional(),
    fileSize: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).parse(req.body);
  if (!body.permissionConfirmed) return res.status(400).json({ error: "Permission confirmation is required." });
  if (body.importMethod === "direct_media_url" && body.sourceUrl && !isDirectMediaUrl(body.sourceUrl)) return res.status(400).json({ error: "Direct URL is not a supported media file URL." });
  if (body.projectId) {
    try {
      if (!await userOwnsProject(req.user!.id, body.projectId)) return res.status(404).json({ error: "Project not found" });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Ownership check failed" });
    }
  }

  const audit = {
    id: crypto.randomUUID(),
    user_id: req.user!.id,
    project_id: body.projectId,
    source_url: body.sourceUrl,
    import_method: body.importMethod,
    permission_confirmed: body.permissionConfirmed,
    file_name: body.fileName,
    file_size: body.fileSize,
    ip_address: req.ip,
    user_agent: req.headers["user-agent"],
    metadata: body.metadata ?? {},
  };
  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("import_audits").insert(audit);
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ audit });
});

sourceImportRouter.post("/:id/retry", async (req, res) => {
  if (!requireImporter(req, res)) return;
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data: existing, error: lookupError } = await supabase.from("import_jobs").select("*").eq("id", req.params.id).eq("user_id", req.user!.id).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  if (!existing) return res.status(404).json({ error: "Import job not found" });
  if (existing.status !== "failed") return res.status(409).json({ error: "Only failed import jobs can be retried.", code: "import_job_not_retryable" });
  if ((existing.attempts ?? 0) >= 3) return res.status(409).json({ error: "Retry limit reached.", code: "retry_limit_reached" });
  const { data, error } = await supabase.from("import_jobs").update({ status: "queued", progress: 0, error_message: null, locked_at: null, worker_id: null, updated_at: new Date().toISOString() }).eq("id", req.params.id).eq("user_id", req.user!.id).select("*").maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from("import_audits").insert({ user_id: req.user!.id, project_id: existing.project_id, source_url: existing.source_url, import_method: "direct_media_url", permission_confirmed: true, ip_address: req.ip, user_agent: req.headers["user-agent"], metadata: { result: "retry_queued", importJobId: existing.id } });
  return res.json({ importJob: data });
});
