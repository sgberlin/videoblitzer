import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const sourceImportRouter = Router();
sourceImportRouter.use(requireAuth);

function requireImporter(req: Request, res: Response) {
  if (!["owner", "admin"].includes(req.user?.role ?? "")) {
    res.status(403).json({ error: "Source Import is restricted to designated admin users." });
    return false;
  }
  return true;
}

function isDirectMediaUrl(url: string) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && /\.(mp4|mov|mkv|webm|mp3|wav|m4a|aac)(\?|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

sourceImportRouter.post("/metadata", async (req, res) => {
  if (!requireImporter(req, res)) return;
  const body = z.object({ sourceUrl: z.string().url(), permissionConfirmed: z.boolean() }).parse(req.body);
  if (!body.permissionConfirmed) return res.status(400).json({ error: "Permission confirmation is required before importing or inspecting a source." });
  const url = new URL(body.sourceUrl);
  const isYoutubeLike = /youtube\.com|youtu\.be|vimeo\.com|twitch\.tv/i.test(url.hostname);
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
