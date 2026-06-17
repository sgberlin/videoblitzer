import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { uploadRateLimit } from "../middleware/rateLimit";
import { createSignedUploadUrl, sha256R2Object, verifyR2Object } from "../lib/r2";
import { createConversionJob } from "./exports";
import { createServiceClient } from "../supabase";
import { isExpectedRawUploadKey, isSchemaCacheMissingColumn, userOwnsProject } from "../lib/ownership";
import { enforceCredits, refundCredits } from "../lib/creditLedger";
import type { CreditAction } from "../lib/credits";
import { duplicateUploadCreditPolicy, matchesDuplicateIdentity } from "../lib/duplicateDetection";
import { probeR2MediaObject } from "../lib/mediaProbe";

const allowedTypes = ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"] as const;
const allowedAudioTypes = ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/flac"] as const;
const allowedAudioSidecarTypes = [...allowedAudioTypes, "video/mp4", "video/quicktime"] as const;
const allowedUploadTypes = [...allowedTypes, ...allowedAudioTypes] as const;
const sourceFormats = ["mp4", "mov", "mkv", "webm"] as const;
const metadataSchema = z.record(z.string(), z.unknown()).optional();
const markerSchema = z.array(z.record(z.string(), z.unknown())).max(500).optional();
export const uploadsRouter = Router();
uploadsRouter.use(requireAuth, uploadRateLimit);

type DuplicateSummary = {
  originalVideo: Record<string, unknown>;
  originalProject: Record<string, unknown> | null;
  packageCount: number;
  completedPackageCount: number;
  availablePackageTypes: string[];
  lastPackageCreatedAt: string | null;
  packageJobs?: Array<Record<string, unknown>>;
};

function sourceFormatForContentType(contentType: string): typeof sourceFormats[number] {
  if (contentType === "video/quicktime") return "mov";
  if (contentType === "video/x-matroska") return "mkv";
  if (contentType === "video/webm") return "webm";
  return "mp4";
}

const uploadVerificationSchema = z.object({
  projectId: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  videoId: z.string().uuid().optional(),
  video_id: z.string().uuid().optional(),
  storageKey: z.string().optional(),
  object_key: z.string().optional(),
  contentType: z.enum(allowedUploadTypes).optional(),
  content_type: z.enum(allowedUploadTypes).optional(),
  sizeBytes: z.number().optional(),
  size_bytes: z.number().optional(),
});

async function verifyUploadedObjectForUser(input: {
  userId: string;
  projectId: string;
  videoId?: string;
  storageKey: string;
  contentType?: string;
  sizeBytes?: number;
}) {
  if (!await userOwnsProject(input.userId, input.projectId)) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  if (!isExpectedRawUploadKey(input.userId, input.projectId, input.storageKey)) throw Object.assign(new Error("Upload object key does not match the authenticated project."), { statusCode: 400, code: "invalid_upload_key" });
  const r2Object = await verifyR2Object(input.storageKey);
  if (!r2Object.exists) throw Object.assign(new Error("Uploaded object was not found in R2. Retry the upload before producing a package."), { statusCode: 400, code: "missing_uploaded_object" });
  if (typeof input.sizeBytes === "number" && r2Object.sizeBytes !== null && Math.abs(r2Object.sizeBytes - input.sizeBytes) > 1) {
    throw Object.assign(new Error("Uploaded object size does not match the expected size."), { statusCode: 400, code: "upload_size_mismatch" });
  }
  if (input.contentType && r2Object.contentType && r2Object.contentType !== input.contentType) {
    throw Object.assign(new Error("Uploaded object content type does not match the expected content type."), { statusCode: 400, code: "upload_content_type_mismatch" });
  }
  return r2Object;
}

async function findDuplicateVideo(input: {
  supabase: NonNullable<ReturnType<typeof createServiceClient>>;
  userId: string;
  fileSha256: string;
  verifiedSizeBytes: number | null;
  durationSeconds: number | null;
}) {
  if (!input.fileSha256 || input.verifiedSizeBytes === null || input.durationSeconds === null) return null;
  const { data, error } = await input.supabase
    .from("videos")
    .select("id,project_id,owner_id,filename,original_filename,created_at,duration_seconds,verified_size_bytes,file_sha256")
    .eq("owner_id", input.userId)
    .eq("file_sha256", input.fileSha256)
    .eq("verified_size_bytes", input.verifiedSizeBytes)
    .order("created_at", { ascending: true });
  if (error) {
    if (isSchemaCacheMissingColumn(error)) return null;
    throw new Error(error.message);
  }
  return (data ?? []).find((candidate) => matchesDuplicateIdentity(
    {
      userId: input.userId,
      fileSha256: String(candidate.file_sha256 ?? ""),
      verifiedSizeBytes: typeof candidate.verified_size_bytes === "number" ? candidate.verified_size_bytes : Number(candidate.verified_size_bytes ?? NaN),
      durationSeconds: typeof candidate.duration_seconds === "number" ? candidate.duration_seconds : Number(candidate.duration_seconds ?? NaN),
    },
    { userId: input.userId, fileSha256: input.fileSha256, verifiedSizeBytes: input.verifiedSizeBytes, durationSeconds: input.durationSeconds },
  )) ?? null;
}

async function duplicateSummary(input: {
  supabase: NonNullable<ReturnType<typeof createServiceClient>>;
  originalVideo: Record<string, unknown> | null;
  userId: string;
}): Promise<DuplicateSummary | null> {
  if (!input.originalVideo?.id) return null;
  const videoId = String(input.originalVideo.id);
  const projectId = typeof input.originalVideo.project_id === "string" ? input.originalVideo.project_id : "";
  const [project, packageJobs] = await Promise.all([
    projectId ? input.supabase.from("projects").select("id,title,created_at").eq("id", projectId).eq("owner_id", input.userId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    input.supabase.from("package_jobs").select("id,status,package_variant,created_at,completed_at,artifact_object_key,input,output").eq("video_id", videoId).eq("user_id", input.userId).order("created_at", { ascending: false }),
  ]);
  if (project.error) throw new Error(project.error.message);
  if (packageJobs.error) {
    if (isSchemaCacheMissingColumn(packageJobs.error)) return {
      originalVideo: input.originalVideo,
      originalProject: project.data,
      packageCount: 0,
      completedPackageCount: 0,
      availablePackageTypes: [],
      lastPackageCreatedAt: null,
    };
    throw new Error(packageJobs.error.message);
  }
  const jobs = packageJobs.data ?? [];
  return {
    originalVideo: input.originalVideo,
    originalProject: project.data,
    packageCount: jobs.length,
    completedPackageCount: jobs.filter((job) => job.status === "completed").length,
    availablePackageTypes: [...new Set(jobs.map((job) => String(job.package_variant ?? (job.input as Record<string, unknown> | null)?.packageVariant ?? "standard_highlights")))],
    lastPackageCreatedAt: jobs[0]?.created_at ?? null,
    packageJobs: jobs,
  };
}

uploadsRouter.post("/verify", async (req, res) => {
  const body = uploadVerificationSchema.parse(req.body);
  const projectId = body.projectId ?? body.project_id;
  const videoId = body.videoId ?? body.video_id;
  const storageKey = body.storageKey ?? body.object_key;
  const contentType = body.contentType ?? body.content_type;
  const sizeBytes = body.sizeBytes ?? body.size_bytes;
  if (!projectId || !storageKey) return res.status(400).json({ error: "project_id and object_key are required" });
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });

  try {
    const r2Object = await verifyUploadedObjectForUser({ userId: req.user!.id, projectId, videoId, storageKey, contentType, sizeBytes });
    const media = await probeR2MediaObject(storageKey);
    const verifiedAt = new Date().toISOString();
    const verification = {
      id: crypto.randomUUID(),
      user_id: req.user!.id,
      project_id: projectId,
      video_id: videoId,
      object_key: storageKey,
      expected_size_bytes: sizeBytes,
      verified_size_bytes: r2Object.sizeBytes,
      expected_content_type: contentType,
      verified_content_type: r2Object.contentType,
      status: "verified",
      metadata: { mode: r2Object.exists ? "head_object_and_ffprobe" : "missing", media },
      verified_at: verifiedAt,
    };
    const { error: verificationError } = await supabase.from("upload_verifications").insert(verification);
    if (verificationError) throw new Error(verificationError.message);
    if (videoId) {
      await supabase
        .from("videos")
        .update({
          verification_status: "verified",
          verified_at: verifiedAt,
          verified_size_bytes: r2Object.sizeBytes,
          verified_content_type: r2Object.contentType,
          has_video: media.has_video,
          has_audio: media.has_audio,
          video_codec: media.video_codec,
          audio_codec: media.audio_codec,
          duration_seconds: media.duration_seconds,
          width: media.width,
          height: media.height,
          verification_metadata: { objectKey: storageKey, expectedSizeBytes: sizeBytes, media },
        })
        .eq("id", videoId)
        .eq("owner_id", req.user!.id);
    }
    await supabase.rpc("write_audit_log", {
      p_actor_id: req.user!.id,
      p_action: "upload_verified",
      p_target_type: videoId ? "video" : "upload_object",
      p_target_id: videoId ?? storageKey,
      p_metadata: { projectId, storageKey, expectedSizeBytes: sizeBytes, verifiedSizeBytes: r2Object.sizeBytes, media },
    });
    return res.json({
      ok: true,
      state: "complete",
      message: "Upload verified. Ready to produce package.",
      verification,
      r2Object,
      media,
    });
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "upload_verification_failed";
    await supabase.from("upload_verifications").insert({
      user_id: req.user!.id,
      project_id: projectId,
      video_id: videoId,
      object_key: storageKey,
      expected_size_bytes: sizeBytes,
      expected_content_type: contentType,
      status: "failed",
      error_message: error instanceof Error ? error.message : "Upload verification failed.",
    });
    return res.status(statusCode).json({ error: error instanceof Error ? error.message : "Upload verification failed.", code });
  }
});

uploadsRouter.post("/create-signed-url", async (req, res) => {
  const body = z.object({ filename: z.string().min(1), contentType: z.enum(allowedUploadTypes), projectId: z.string().uuid() }).parse(req.body);
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
    raw_format: z.enum(sourceFormats).optional(),
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
    audio_source: z.object({
      object_key: z.string(),
      filename: z.string(),
      content_type: z.enum(allowedAudioSidecarTypes),
      size_bytes: z.number().optional(),
    }).optional(),
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
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  let r2Object: Awaited<ReturnType<typeof verifyR2Object>>;
  let media: Awaited<ReturnType<typeof probeR2MediaObject>>;
  let audioSource: { r2Object: Awaited<ReturnType<typeof verifyR2Object>>; media: Awaited<ReturnType<typeof probeR2MediaObject>> } | null = null;
  let fileSha256 = "";
  let duplicateOfVideo: Record<string, unknown> | null = null;
  let duplicate: DuplicateSummary | null = null;
  try {
    r2Object = await verifyUploadedObjectForUser({ userId: req.user!.id, projectId, storageKey, contentType, sizeBytes });
    [media, fileSha256] = await Promise.all([probeR2MediaObject(storageKey), sha256R2Object(storageKey)]);
    if (body.audio_source) {
      const audioR2Object = await verifyUploadedObjectForUser({ userId: req.user!.id, projectId, storageKey: body.audio_source.object_key, contentType: body.audio_source.content_type, sizeBytes: body.audio_source.size_bytes });
      const audioMedia = await probeR2MediaObject(body.audio_source.object_key);
      if (audioMedia.has_audio !== true) throw Object.assign(new Error("Optional audio file does not contain an audio stream."), { statusCode: 400, code: "audio_sidecar_missing_audio" });
      audioSource = { r2Object: audioR2Object, media: audioMedia };
    }
    duplicateOfVideo = await findDuplicateVideo({
      supabase,
      userId: req.user!.id,
      fileSha256,
      verifiedSizeBytes: r2Object.sizeBytes,
      durationSeconds: body.duration_seconds ?? media.duration_seconds ?? null,
    });
    duplicate = await duplicateSummary({ supabase, originalVideo: duplicateOfVideo, userId: req.user!.id });
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "upload_verification_failed";
    return res.status(statusCode).json({ error: error instanceof Error ? error.message : "Upload verification failed.", code });
  }
  const permissionConfirmedAt = body.permission_confirmed ? body.permission_confirmed_at ?? new Date().toISOString() : undefined;
  const sourceFormat = body.raw_format ?? sourceFormatForContentType(contentType);
  const desiredExportFormat = sourceFormat === "webm" ? body.desired_export_format ?? "mp4" : body.desired_export_format;
  const needsMp4Conversion = sourceFormat === "webm" && desiredExportFormat === "mp4";
  const duplicateDetected = Boolean(duplicateOfVideo?.id);
  const creditPolicy = duplicateUploadCreditPolicy(duplicateDetected);
  const charged: Array<{ action: CreditAction; cost: number }> = [];
  if (creditPolicy.chargeUploadAnalyze) {
    const creditResult = await enforceCredits({ userId: req.user!.id, projectId, action: "upload_analyze_video", isUnlimited: req.user!.isUnlimited, metadata: { filename: body.filename, sourceFormat, sizeBytes, fileSha256 } });
    if (!creditResult.ok) return res.status(402).json({ error: `Insufficient credits. Upload requires ${creditResult.cost} credits.`, code: "insufficient_credits", creditCost: creditResult.cost, balance: creditResult.balanceAfter });
    charged.push({ action: "upload_analyze_video", cost: creditResult.cost });
  }
  if (needsMp4Conversion && creditPolicy.chargeUploadAnalyze) {
    const conversionCredit = await enforceCredits({ userId: req.user!.id, projectId, action: "video_conversion_mp4", isUnlimited: req.user!.isUnlimited, metadata: { filename: body.filename, sourceObjectKey: storageKey, sourceFormat } });
    if (!conversionCredit.ok) {
      await Promise.all(charged.map((item) => refundCredits({ userId: req.user!.id, projectId, action: item.action, cost: item.cost, metadata: { reason: "conversion_credit_failed", filename: body.filename } }).catch(() => undefined)));
      return res.status(402).json({ error: `Insufficient credits. MP4 conversion requires ${conversionCredit.cost} credits.`, code: "insufficient_credits", creditCost: conversionCredit.cost, balance: conversionCredit.balanceAfter });
    }
    charged.push({ action: "video_conversion_mp4", cost: conversionCredit.cost });
  }
  const verifiedAt = new Date().toISOString();
  const video = { id: crypto.randomUUID(), project_id: projectId, owner_id: req.user!.id, user_id: req.user!.id, filename: body.filename, original_filename: body.filename, mime_type: contentType, content_type: contentType, storage_key: storageKey, source_object_key: storageKey, source_format: sourceFormat, desired_export_format: desiredExportFormat, size_bytes: sizeBytes, status: "uploaded", verification_status: "verified", verified_at: verifiedAt, verified_size_bytes: r2Object.sizeBytes, verified_content_type: r2Object.contentType, file_sha256: fileSha256, fingerprint_status: "not_started", fingerprint_metadata: {}, duplicate_of_video_id: duplicateOfVideo?.id ?? null, analysis_status: duplicateDetected ? "reusable" : "not_started", analysis_metadata: duplicateDetected ? { duplicateOfVideoId: duplicateOfVideo?.id } : {}, has_video: media.has_video, has_audio: audioSource ? true : media.has_audio, video_codec: media.video_codec, audio_codec: audioSource?.media.audio_codec ?? media.audio_codec, duration_seconds: body.duration_seconds ?? media.duration_seconds, width: media.width, height: media.height, verification_metadata: { objectKey: storageKey, expectedSizeBytes: sizeBytes, fileSha256, duplicateOfVideoId: duplicateOfVideo?.id, media, audioSource: audioSource ? { objectKey: body.audio_source?.object_key, media: audioSource.media } : undefined }, audio_source_object_key: body.audio_source?.object_key, audio_source_filename: body.audio_source?.filename, audio_source_content_type: body.audio_source?.content_type, audio_source_size_bytes: audioSource?.r2Object.sizeBytes ?? body.audio_source?.size_bytes, audio_source_metadata: audioSource ? { media: audioSource.media, verifiedSizeBytes: audioSource.r2Object.sizeBytes, verifiedContentType: audioSource.r2Object.contentType } : {}, recording_mode: body.recording_mode, source_type: body.source_type, source_label: body.source_label, source_url: body.source_url, permission_confirmed: body.permission_confirmed ?? false, permission_confirmed_at: permissionConfirmedAt, recording_metadata: body.recording_metadata ?? {}, match_metadata: body.match_metadata ?? {}, markers: body.markers ?? [], chunk_manifest: body.chunk_manifest ?? {}, import_metadata: body.import_metadata ?? {}, local_original_filename: body.local_original_filename, original_mime_type: body.original_mime_type ?? contentType, conversion_status: needsMp4Conversion && !duplicateDetected ? "queued" : "not_requested" };
  const fallbackVideo = { id: video.id, project_id: video.project_id, owner_id: video.owner_id, user_id: video.user_id, filename: video.filename, original_filename: video.original_filename, mime_type: video.mime_type, content_type: video.content_type, storage_key: video.storage_key, source_object_key: video.source_object_key, source_format: video.source_format, desired_export_format: video.desired_export_format, size_bytes: video.size_bytes, status: video.status, verification_status: video.verification_status, verified_at: video.verified_at, verified_size_bytes: video.verified_size_bytes, verified_content_type: video.verified_content_type, verification_metadata: video.verification_metadata, recording_mode: video.recording_mode, source_type: video.source_type, source_label: video.source_label, source_url: video.source_url, permission_confirmed: video.permission_confirmed, permission_confirmed_at: video.permission_confirmed_at, recording_metadata: video.recording_metadata, match_metadata: video.match_metadata, markers: video.markers, chunk_manifest: video.chunk_manifest, import_metadata: video.import_metadata, local_original_filename: video.local_original_filename, original_mime_type: video.original_mime_type, duration_seconds: video.duration_seconds, conversion_status: video.conversion_status };
  let conversionJob = null;
  try {
    const { error } = await supabase.from("videos").insert(video);
    if (error) {
      if (!isSchemaCacheMissingColumn(error)) throw new Error(error.message);
      const fallbackInsert = await supabase.from("videos").insert(fallbackVideo);
      if (fallbackInsert.error) throw new Error(fallbackInsert.error.message);
    }
    await supabase.from("upload_verifications").insert({ id: crypto.randomUUID(), user_id: req.user!.id, project_id: projectId, video_id: video.id, object_key: storageKey, expected_size_bytes: sizeBytes, verified_size_bytes: r2Object.sizeBytes, expected_content_type: contentType, verified_content_type: r2Object.contentType, status: "verified", metadata: { mode: "upload_complete", fileSha256, duplicateDetected, duplicateOfVideoId: duplicateOfVideo?.id, media, audioSource: audioSource?.media }, verified_at: verifiedAt });
    await supabase.from("projects").update({ status: "uploaded", updated_at: new Date().toISOString(), recording_mode: body.recording_mode, source_label: body.source_label, source_url: body.source_url, permission_confirmed: body.permission_confirmed ?? false, permission_confirmed_at: permissionConfirmedAt, recording_metadata: body.recording_metadata ?? {}, match_metadata: body.match_metadata ?? {}, source_metadata: { sourceType: body.source_type, sourceLabel: body.source_label, sourceUrl: body.source_url }, import_metadata: body.import_metadata ?? {} }).eq("id", projectId).eq("owner_id", req.user!.id);
    await supabase.from("usage_events").insert({ user_id: req.user!.id, project_id: projectId, event_name: "video_uploaded", metadata: { filename: body.filename, storageKey, sizeBytes, rawFormat: sourceFormat, markers: body.markers ?? [], recordingMode: body.recording_mode, permissionConfirmed: body.permission_confirmed ?? false } });
    await supabase.rpc("write_audit_log", { p_actor_id: req.user!.id, p_action: "upload_completed", p_target_type: "video", p_target_id: video.id, p_metadata: { projectId, storageKey, verifiedSizeBytes: r2Object.sizeBytes, media, audioSource: audioSource?.media } });
    if (needsMp4Conversion && creditPolicy.chargeUploadAnalyze) {
      conversionJob = await createConversionJob({ projectId, videoId: video.id, userId: req.user!.id, sourceObjectKey: storageKey, sourceFormat: "webm", targetFormat: "mp4", skipCreditCheck: true });
    }
  } catch (error) {
    await Promise.all(charged.map((item) => refundCredits({ userId: req.user!.id, projectId, action: item.action, cost: item.cost, metadata: { reason: "upload_complete_failed", filename: body.filename } }).catch(() => undefined)));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Upload completion failed.", code: "upload_complete_failed" });
  }
  return res.status(201).json({ video, conversion_job: conversionJob, duplicate });
});
