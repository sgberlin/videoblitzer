import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeStage } from "./analyzeStage";
import { bundleStage, uploadPackageZip } from "./bundleStage";
import { createNormalizedMaster, createNormalizedMasterWithAudio, exportStage, socialClipStage } from "./exportStage";
import { downloadR2File, uploadFileToR2, verifyR2File } from "./packageStorage";
import type { ExportArtifact, PackageJob, PackageManifest, PackageStatus, VideoRow } from "./packageTypes";

const workerId = `package-${process.pid}-${randomUUID()}`;
const maxAttempts = Number(process.env.PACKAGE_WORKER_MAX_ATTEMPTS ?? process.env.VIDEO_WORKER_MAX_ATTEMPTS ?? 3);
const packageCreditCost = Number(process.env.PACKAGE_WORKER_SOCIAL_CONTENT_PACK_COST ?? 5);
const stageTimeoutMinutes = Number(process.env.PACKAGE_WORKER_STAGE_TIMEOUT_MINUTES ?? 240);
type ExportArtifactWithPath = ExportArtifact & { filePath: string };

function serviceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
}

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = serviceKey();
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY are required for package worker.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type WorkerClient = ReturnType<typeof supabase>;

async function updatePackageState(
  client: WorkerClient,
  jobId: string,
  status: PackageStatus,
  patch: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  const packagePatch = {
    status,
    updated_at: now,
    locked_at: status === "processing" ? patch.locked_at ?? now : null,
    worker_id: status === "processing" ? patch.worker_id ?? workerId : null,
    last_heartbeat_at: status === "processing" ? now : patch.last_heartbeat_at ?? null,
    ...(status === "completed" ? { completed_at: now } : {}),
    ...patch,
  };
  const { error: packageError } = await client.from("package_jobs").update(packagePatch).eq("id", jobId);
  if (packageError) throw new Error(packageError.message);

  const { error: mirrorError } = await client
    .from("jobs")
    .update({
      status,
      updated_at: now,
      ...(status === "completed" ? { progress: 100 } : {}),
      ...("error_message" in patch ? { error: patch.error_message } : {}),
      ...("output" in patch ? { output: patch.output } : {}),
      ...("progress" in patch ? { progress: patch.progress } : {}),
    })
    .eq("id", jobId);
  if (mirrorError) throw new Error(mirrorError.message);
}

async function markStage(client: WorkerClient, job: PackageJob, stage: string, progress: number, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await updatePackageState(client, job.id, "processing", {
    progress,
    stage,
    stage_started_at: now,
    last_heartbeat_at: now,
    deadline_at: new Date(Date.now() + stageTimeoutMinutes * 60_000).toISOString(),
    output: {
      stage,
      stageUpdatedAt: now,
      ...extra,
    },
  });
}

async function heartbeat(client: WorkerClient, job: PackageJob, stage: string) {
  const now = new Date().toISOString();
  await client.from("package_jobs").update({ last_heartbeat_at: now, locked_at: now, stage, updated_at: now }).eq("id", job.id);
}

async function withHeartbeat<T>(client: WorkerClient, job: PackageJob, stage: string, operation: () => Promise<T>) {
  const everyMs = Number(process.env.PACKAGE_WORKER_HEARTBEAT_MS ?? 60_000);
  const interval = setInterval(() => {
    void heartbeat(client, job, stage).catch((error) => console.error("[package-worker] heartbeat failed", error instanceof Error ? error.message : error));
  }, everyMs);
  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}

async function refundPackageCreditIfTerminal(client: WorkerClient, job: PackageJob, attempts: number, reason: string) {
  if (attempts < maxAttempts || packageCreditCost <= 0) return;
  await client.rpc("refund_credits_atomic", {
    p_user_id: job.user_id,
    p_project_id: job.project_id,
    p_action: "social_content_pack_refund",
    p_amount: packageCreditCost,
    p_metadata: { reason, packageJobId: job.id },
  }).throwOnError();
}

async function failPackageJob(client: WorkerClient, job: PackageJob, message: string) {
  const attempts = Number(job.attempts ?? 0);
  await updatePackageState(client, job.id, "failed", {
    progress: 100,
    error_message: message,
    output: {
      stage: "failed",
      failedAt: new Date().toISOString(),
      attempts,
      error: message,
    },
  });
  await refundPackageCreditIfTerminal(client, job, attempts, message).catch(() => undefined);
}

async function requeueStalePackageJobs(client: WorkerClient) {
  const leaseMinutes = Number(process.env.PACKAGE_WORKER_LEASE_MINUTES ?? process.env.VIDEO_WORKER_LEASE_MINUTES ?? 30);
  const staleBefore = new Date(Date.now() - leaseMinutes * 60_000).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("package_jobs")
    .select("id,attempts,video_id,user_id,project_id")
    .eq("status", "processing")
    .lt("locked_at", staleBefore);
  if (error) throw new Error(error.message);

  for (const staleJob of data ?? []) {
    const job = staleJob as PackageJob;
    const attempts = Number(job.attempts ?? 0);
    if (attempts >= maxAttempts) {
      await failPackageJob(client, job, "Retry limit reached after stale package worker lease.");
      continue;
    }
    const { error: packageError } = await client
      .from("package_jobs")
      .update({
        status: "queued",
        locked_at: null,
        worker_id: null,
        error_message: "Requeued after stale package worker lease.",
        updated_at: now,
      })
      .eq("id", job.id);
    if (packageError) throw new Error(packageError.message);

    const { error: mirrorError } = await client
      .from("jobs")
      .update({
        status: "queued",
        error: "Requeued after stale package worker lease.",
        updated_at: now,
      })
      .eq("id", job.id);
    if (mirrorError) throw new Error(mirrorError.message);
  }
}

async function claimQueuedPackageJob(client: WorkerClient) {
  await requeueStalePackageJobs(client);
  const { data: candidates, error } = await client
    .from("package_jobs")
    .select("*")
    .eq("status", "queued")
    .lt("attempts", maxAttempts)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const candidate = candidates?.[0] as PackageJob | undefined;
  if (!candidate) return null;

  const nextAttempts = (candidate.attempts ?? 0) + 1;
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await client
    .from("package_jobs")
    .update({
      status: "processing",
      progress: 5,
      attempts: nextAttempts,
      locked_at: now,
      worker_id: workerId,
      updated_at: now,
      error_message: null,
    })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return null;

  const { error: mirrorError } = await client
    .from("jobs")
    .update({
      status: "processing",
      progress: 5,
      attempts: nextAttempts,
      updated_at: now,
      error: null,
    })
    .eq("id", candidate.id);
  if (mirrorError) throw new Error(mirrorError.message);

  return claimed as PackageJob;
}

async function fetchPackageVideo(client: WorkerClient, job: PackageJob) {
  const { data, error } = await client
    .from("videos")
    .select("id,project_id,storage_key,source_object_key,source_format,has_video,has_audio,video_codec,audio_codec,duration_seconds,width,height,audio_source_object_key,audio_source_filename,audio_source_content_type,audio_source_size_bytes,audio_source_metadata,markers")
    .eq("id", job.video_id)
    .eq("owner_id", job.user_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Package video was not found.");
  return data as VideoRow;
}

async function cleanupPreviousPackageRows(client: WorkerClient, job: PackageJob) {
  await Promise.all([
    client.from("clip_jobs").delete().eq("project_id", job.project_id).eq("user_id", job.user_id).contains("metadata", { packageJobId: job.id }),
    client.from("exports").delete().eq("project_id", job.project_id).eq("user_id", job.user_id).contains("metadata", { packageJobId: job.id }),
    client.from("social_packages").delete().eq("project_id", job.project_id).eq("user_id", job.user_id).contains("content", { packageJobId: job.id }),
    client.from("package_assets").delete().eq("package_job_id", job.id).eq("user_id", job.user_id),
  ]);
}

async function persistClipPlan(client: WorkerClient, job: PackageJob, clipPlan: PackageManifest["clipPlan"]) {
  if (!Boolean(job.input?.includeClipPlan ?? true) || !clipPlan.length) return;
  const { error } = await client.from("clip_jobs").insert(clipPlan.map((clip) => ({
    id: randomUUID(),
    project_id: job.project_id,
    video_id: job.video_id,
    user_id: job.user_id,
    source_timestamp: clip.startSeconds,
    start_seconds: clip.startSeconds,
    end_seconds: clip.endSeconds,
    duration_seconds: clip.endSeconds - clip.startSeconds,
    marker_id: clip.id,
    source_sentence_ids: [],
    manual_override: false,
    status: "planned",
    metadata: { source: "package_worker", packageJobId: job.id, label: clip.label, note: clip.note ?? "" },
  })));
  if (error) throw new Error(error.message);
}

async function persistExports(client: WorkerClient, job: PackageJob, artifacts: ExportArtifact[]) {
  if (!artifacts.length) return;
  const { error } = await client.from("exports").insert(artifacts.map((artifact) => ({
    id: randomUUID(),
    project_id: job.project_id,
    user_id: job.user_id,
    preset_id: artifact.presetId,
    crop_mode: "center",
    status: "completed",
    storage_key: artifact.objectKey,
    metadata: {
      source: "package_worker",
      packageJobId: job.id,
      label: artifact.label,
      width: artifact.width,
      height: artifact.height,
      target: artifact.target,
    },
  })));
  if (error) throw new Error(error.message);
}

async function persistPackageAssets(client: WorkerClient, job: PackageJob, assets: ExportArtifact[]) {
  if (!assets.length) return;
  const { error } = await client.from("package_assets").insert(assets.map((asset) => ({
    id: randomUUID(),
    package_job_id: job.id,
    project_id: job.project_id,
    video_id: job.video_id,
    user_id: job.user_id,
    asset_type: asset.assetType,
    platform: asset.platform,
    clip_id: asset.clipId,
    preset_id: asset.presetId,
    storage_key: asset.objectKey,
    filename: asset.fileName,
    content_type: asset.assetType === "thumbnail" ? "image/jpeg" : asset.assetType === "caption" ? "text/plain" : asset.assetType === "metadata" || asset.assetType === "readme" ? "application/json" : asset.assetType === "zip" ? "application/zip" : "video/mp4",
    duration_seconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    aspect_ratio: asset.aspectRatio,
    start_seconds: asset.startSeconds,
    end_seconds: asset.endSeconds,
    confidence: asset.confidence,
    validation_status: asset.validationStatus ?? "pending",
    metadata: asset.metadata ?? {},
  })));
  if (error) throw new Error(error.message);
}

async function validateR2Assets<T extends ExportArtifact>(assets: T[]) {
  const checked: T[] = [];
  for (const asset of assets) {
    const r2 = await verifyR2File(asset.objectKey);
    checked.push({
      ...asset,
      validationStatus: r2.exists && (r2.sizeBytes ?? 0) > 0 ? "valid" : "failed",
      metadata: { ...(asset.metadata ?? {}), r2SizeBytes: r2.sizeBytes, r2ContentType: r2.contentType },
    } as T);
  }
  const failed = checked.filter((asset) => asset.validationStatus === "failed");
  if (failed.length) throw new Error(`Package asset validation failed for ${failed.map((asset) => asset.fileName).join(", ")}`);
  return checked;
}

function srtTimestamp(seconds: number) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function hookCaption(clip: PackageManifest["clipPlan"][number]) {
  if (clip.confidence < 0.5) return "Candidate highlight - review before posting.";
  if (clip.suggestedClipType === "quick_moment") return "Big moment. Watch this.";
  if (clip.suggestedClipType === "short_highlight") return "Game-changing moment.";
  if (clip.suggestedClipType === "story_highlight") return "Clean build-up. Strong finish.";
  return "Full sequence from the match.";
}

async function createTextAssets(input: {
  workdir: string;
  job: PackageJob;
  clipPlan: PackageManifest["clipPlan"];
  socialPackage: Record<string, unknown>;
}) {
  const assets: ExportArtifactWithPath[] = [];
  const captionsDir = path.join(input.workdir, "captions", "srt");
  const metadataDir = path.join(input.workdir, "metadata");
  await mkdir(captionsDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  for (const clip of input.clipPlan) {
    const caption = hookCaption(clip);
    const srt = `1\n${srtTimestamp(0)} --> ${srtTimestamp(Math.min(clip.endSeconds - clip.startSeconds, 6))}\n${caption}\n`;
    const captionName = `${clip.id}.srt`;
    const captionPath = path.join(captionsDir, captionName);
    await writeFile(captionPath, srt, "utf8");
    const captionKey = `packages/assets/${input.job.user_id}/${input.job.project_id}/${input.job.id}/captions/srt/${captionName}`;
    await uploadFileToR2(captionPath, captionKey, "text/plain");
    assets.push({
      presetId: "srt_caption",
      label: `Caption ${clip.label}`,
      objectKey: captionKey,
      fileName: captionName,
      filePath: captionPath,
      width: 0,
      height: 0,
      target: "Captions",
      assetType: "caption",
      platform: "all",
      clipId: clip.id,
      durationSeconds: clip.endSeconds - clip.startSeconds,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      confidence: clip.confidence,
      aspectRatio: "text",
      validationStatus: "pending",
      metadata: { folder: "captions/srt", captionType: "social_hook", spokenCaptionsAvailable: false },
    });
  }

  const metadataName = "social-media-text.json";
  const metadataPath = path.join(metadataDir, metadataName);
  await writeFile(metadataPath, JSON.stringify(input.socialPackage, null, 2), "utf8");
  const metadataKey = `packages/assets/${input.job.user_id}/${input.job.project_id}/${input.job.id}/metadata/${metadataName}`;
  await uploadFileToR2(metadataPath, metadataKey, "application/json");
  assets.push({
    presetId: "social_metadata",
    label: "Social media text and captions",
    objectKey: metadataKey,
    fileName: metadataName,
    filePath: metadataPath,
    width: 0,
    height: 0,
    target: "Metadata",
    assetType: "metadata",
    platform: "all",
    aspectRatio: "json",
    validationStatus: "pending",
    metadata: { folder: "metadata" },
  });

  return assets;
}

async function persistSocialPackage(client: WorkerClient, job: PackageJob, content: Record<string, unknown>) {
  const { error } = await client.from("social_packages").insert({
    id: randomUUID(),
    project_id: job.project_id,
    user_id: job.user_id,
    language: "English",
    content,
  });
  if (error) throw new Error(error.message);
}

function socialContentForPackage(job: PackageJob, clipPlan: PackageManifest["clipPlan"], exports: ExportArtifact[]) {
  return {
    packageJobId: job.id,
    source: "package_worker",
    titleVariants: ["VideoBlitzer Match Package", "Highlights Package"],
    chapters: clipPlan.map((clip) => ({
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      title: clip.label,
      confidence: clip.confidence,
      reason: clip.reason,
    })),
    captions: clipPlan.map((clip) => ({ clipId: clip.id, caption: hookCaption(clip), hashtags: ["#sports", "#highlights", "#fullgame", "#videoblitzer"] })),
    platformStandards: {
      instagramReels: "9:16 1080x1920, 15-60 sec, burned captions recommended.",
      tiktok: "9:16 1080x1920, 15-60 sec, strong hook caption.",
      youtubeShorts: "9:16 1080x1920, under 60 sec.",
      youtubeStandard: "16:9 1920x1080 landscape highlight/full export.",
      facebookReels: "9:16, captions recommended.",
      xTwitter: "Short caption text and clipped MP4 assets.",
    },
    packageSummary: `Generated ${exports.length} preset exports and ${clipPlan.length} planned clips.`,
    complianceNote: "Generated from project-owned media and factual timeline markers.",
  };
}

function readmeForPackage(manifest: PackageManifest) {
  return `VideoBlitzer Social Media Package\n\nSource video: ${manifest.videoId ?? "unknown"}\nGenerated: ${manifest.generatedAt}\n\nFolders:\n- clips/vertical_9x16: Instagram Reels, TikTok, YouTube Shorts, Facebook Reels\n- clips/landscape_16x9: YouTube standard and landscape assets\n- clips/square_1x1: optional square social clips\n- captions/srt: social hook caption files\n- thumbnails: preview images\n- metadata: titles, descriptions, captions, hashtags\n- manifest.json: machine-readable package details\n\nQuality note:\nCandidate clips include confidence scores and reasons. Low-confidence clips should be reviewed before posting.\n`;
}

async function processPackageJob(client: WorkerClient, job: PackageJob) {
  const workdir = await mkdtemp(path.join(tmpdir(), "videoblitzer-package-"));
  try {
    await cleanupPreviousPackageRows(client, job);
    const video = await fetchPackageVideo(client, job);
    if (video.has_video !== true) {
      throw new Error("audio_only_source_not_supported");
    }
    const sourceObjectKey = String((job.input?.sourceObjectKey as string | undefined) ?? video.storage_key ?? video.source_object_key ?? "");
    if (!sourceObjectKey) throw new Error("Package job source object key is missing.");
    const audioSourceObjectKey = String((job.input?.audioSourceObjectKey as string | undefined) ?? video.audio_source_object_key ?? "");

    const sourcePath = path.join(workdir, "source-input");
    const audioSourcePath = path.join(workdir, "audio-sidecar-input");
    const normalizedMasterPath = path.join(workdir, "normalized-master.mp4");
    const exportsDir = path.join(workdir, "exports");
    await mkdir(exportsDir, { recursive: true });

    await markStage(client, job, "download_source", 15, { sourceObjectKey, audioSourceObjectKey: audioSourceObjectKey || undefined });
    await withHeartbeat(client, job, "download_source", async () => {
      await downloadR2File(sourceObjectKey, sourcePath);
      if (audioSourceObjectKey) await downloadR2File(audioSourceObjectKey, audioSourcePath);
    });

    await markStage(client, job, "normalize_master", 25, { audioSidecar: Boolean(audioSourceObjectKey) });
    await withHeartbeat(client, job, "normalize_master", () => audioSourceObjectKey ? createNormalizedMasterWithAudio(sourcePath, audioSourcePath, normalizedMasterPath) : createNormalizedMaster(sourcePath, normalizedMasterPath));
    const masterObjectKey = `packages/masters/${job.user_id}/${job.project_id}/${job.id}/normalized-master.mp4`;
    await uploadFileToR2(normalizedMasterPath, masterObjectKey, "video/mp4");
    const masterAsset: ExportArtifactWithPath = {
      presetId: "normalized_master",
      label: "Normalized master reference",
      objectKey: masterObjectKey,
      fileName: "normalized-master.mp4",
      filePath: normalizedMasterPath,
      width: 1920,
      height: 1080,
      target: "Master",
      assetType: "master",
      platform: "all",
      aspectRatio: "source",
      validationStatus: "pending",
      metadata: { folder: "master" },
    };

    await markStage(client, job, "analyze", 40);
    const analysis = await withHeartbeat(client, job, "analyze", () => analyzeStage(normalizedMasterPath, video.markers ?? []));
    await persistClipPlan(client, job, analysis.clipPlan);

    await markStage(client, job, "rendering_clips", 55, { clipPlanCount: analysis.clipPlan.length });
    const { clipArtifacts, thumbnailArtifacts } = await withHeartbeat(client, job, "rendering_clips", () => socialClipStage({
      masterPath: normalizedMasterPath,
      workdir,
      clipPlan: analysis.clipPlan,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
    }));

    await markStage(client, job, "preset_exports", 70, { clipAssetCount: clipArtifacts.length });
    const requestedPresetIds = Array.isArray(job.input?.presetIds) ? (job.input?.presetIds as string[]) : [];
    const exportArtifactsWithPaths = await withHeartbeat(client, job, "preset_exports", () => exportStage({
      masterPath: normalizedMasterPath,
      exportsDir,
      requestedPresetIds,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
    }));
    const exportArtifacts = exportArtifactsWithPaths.map(({ filePath: _filePath, ...artifact }) => artifact);
    await persistExports(client, job, exportArtifacts);

    const socialPackage = socialContentForPackage(job, analysis.clipPlan, exportArtifacts);
    const textAssets = await createTextAssets({ workdir, job, clipPlan: analysis.clipPlan, socialPackage });
    await persistSocialPackage(client, job, socialPackage);

    await markStage(client, job, "validating_assets", 82, { exportCount: exportArtifacts.length, clipAssetCount: clipArtifacts.length });
    const assetsWithPaths = [masterAsset, ...exportArtifactsWithPaths, ...clipArtifacts, ...thumbnailArtifacts, ...textAssets];
    const validatedAssets = await validateR2Assets(assetsWithPaths);
    await persistPackageAssets(client, job, validatedAssets.map(({ filePath: _filePath, ...asset }) => asset));

    await markStage(client, job, "building_zip", 90, { assetCount: validatedAssets.length });
    const manifest: PackageManifest = {
      packageJobId: job.id,
      projectId: job.project_id,
      videoId: job.video_id,
      sourceObjectKey,
      audioSourceObjectKey: audioSourceObjectKey || null,
      generatedAt: new Date().toISOString(),
      analysis: { durationSeconds: analysis.durationSeconds },
      normalizedMaster: { objectKey: masterObjectKey, fileName: "normalized-master.mp4" },
      clipPlan: analysis.clipPlan,
      exports: exportArtifacts,
      assets: validatedAssets.map(({ filePath: _filePath, ...asset }) => asset),
      socialPackage,
    };
    const { zipPath } = await withHeartbeat(client, job, "building_zip", () => bundleStage({
      workdir,
      manifest,
      normalizedMasterPath,
      exports: exportArtifactsWithPaths,
      assets: [...clipArtifacts, ...thumbnailArtifacts, ...textAssets],
      readmeText: readmeForPackage(manifest),
    }));
    const artifactObjectKey = await uploadPackageZip({
      zipPath,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
    });
    const zipValidation = await verifyR2File(artifactObjectKey);
    if (!zipValidation.exists || (zipValidation.sizeBytes ?? 0) <= 0) throw new Error("Package ZIP validation failed after upload.");
    const zipAsset: ExportArtifact = {
      presetId: "social_package_zip",
      label: "Download Package ZIP",
      objectKey: artifactObjectKey,
      fileName: "social-package.zip",
      width: 0,
      height: 0,
      target: "Package",
      assetType: "zip",
      platform: "all",
      aspectRatio: "zip",
      validationStatus: "valid",
      metadata: { r2SizeBytes: zipValidation.sizeBytes, r2ContentType: zipValidation.contentType },
    };
    await persistPackageAssets(client, job, [zipAsset]);

    const output = {
      stage: "completed",
      packageJobId: job.id,
      artifactObjectKey,
      normalizedMasterObjectKey: masterObjectKey,
      exportCount: exportArtifacts.length,
      clipPlanCount: analysis.clipPlan.length,
      assetCount: validatedAssets.length + 1,
      exports: exportArtifacts,
    };
    await updatePackageState(client, job.id, "completed", {
      progress: 100,
      artifact_object_key: artifactObjectKey,
      manifest_json: manifest,
      output,
      error_message: null,
    });

    await client.from("usage_events").insert({
      user_id: job.user_id,
      project_id: job.project_id,
      event_name: "package_job_completed",
      metadata: output,
    });

    return { processed: true, jobId: job.id, status: "completed", artifactObjectKey };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function processOnePackageJob() {
  const client = supabase();
  const job = await claimQueuedPackageJob(client);
  if (!job) return { processed: false };

  try {
    return await processPackageJob(client, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown package generation failure.";
    await failPackageJob(client, job, message);
    return { processed: true, jobId: job.id, status: "failed", error: message };
  }
}
