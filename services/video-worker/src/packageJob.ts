import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeStage } from "./analyzeStage";
import { bundleStage, uploadPackageZip } from "./bundleStage";
import { createNormalizedMaster, exportStage } from "./exportStage";
import { downloadR2File, uploadFileToR2 } from "./packageStorage";
import type { ExportArtifact, PackageJob, PackageManifest, PackageStatus, VideoRow } from "./packageTypes";

const workerId = `package-${process.pid}-${randomUUID()}`;
const maxAttempts = Number(process.env.PACKAGE_WORKER_MAX_ATTEMPTS ?? process.env.VIDEO_WORKER_MAX_ATTEMPTS ?? 3);
const packageCreditCost = Number(process.env.PACKAGE_WORKER_SOCIAL_CONTENT_PACK_COST ?? 5);

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
  await updatePackageState(client, job.id, "processing", {
    progress,
    output: {
      stage,
      stageUpdatedAt: new Date().toISOString(),
      ...extra,
    },
  });
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
    .select("id,project_id,storage_key,source_object_key,source_format,markers")
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
    })),
    packageSummary: `Generated ${exports.length} preset exports and ${clipPlan.length} planned clips.`,
    complianceNote: "Generated from project-owned media and factual timeline markers.",
  };
}

async function processPackageJob(client: WorkerClient, job: PackageJob) {
  const workdir = await mkdtemp(path.join(tmpdir(), "videoblitzer-package-"));
  try {
    await cleanupPreviousPackageRows(client, job);
    const video = await fetchPackageVideo(client, job);
    const sourceObjectKey = String((job.input?.sourceObjectKey as string | undefined) ?? video.storage_key ?? video.source_object_key ?? "");
    if (!sourceObjectKey) throw new Error("Package job source object key is missing.");

    const sourcePath = path.join(workdir, "source-input");
    const normalizedMasterPath = path.join(workdir, "normalized-master.mp4");
    const exportsDir = path.join(workdir, "exports");
    await mkdir(exportsDir, { recursive: true });

    await markStage(client, job, "download_source", 15, { sourceObjectKey });
    await downloadR2File(sourceObjectKey, sourcePath);

    await markStage(client, job, "normalize_master", 25);
    await createNormalizedMaster(sourcePath, normalizedMasterPath);
    const masterObjectKey = `packages/masters/${job.user_id}/${job.project_id}/${job.id}/normalized-master.mp4`;
    await uploadFileToR2(normalizedMasterPath, masterObjectKey, "video/mp4");

    await markStage(client, job, "analyze", 40);
    const analysis = await analyzeStage(normalizedMasterPath, video.markers ?? []);
    await persistClipPlan(client, job, analysis.clipPlan);

    await markStage(client, job, "preset_exports", 65, { clipPlanCount: analysis.clipPlan.length });
    const requestedPresetIds = Array.isArray(job.input?.presetIds) ? (job.input?.presetIds as string[]) : [];
    const exportArtifactsWithPaths = await exportStage({
      masterPath: normalizedMasterPath,
      exportsDir,
      requestedPresetIds,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
    });
    const exportArtifacts = exportArtifactsWithPaths.map(({ filePath: _filePath, ...artifact }) => artifact);
    await persistExports(client, job, exportArtifacts);

    const socialPackage = socialContentForPackage(job, analysis.clipPlan, exportArtifacts);
    await persistSocialPackage(client, job, socialPackage);

    await markStage(client, job, "bundle_artifact", 85, { exportCount: exportArtifacts.length });
    const manifest: PackageManifest = {
      packageJobId: job.id,
      projectId: job.project_id,
      videoId: job.video_id,
      sourceObjectKey,
      generatedAt: new Date().toISOString(),
      analysis: { durationSeconds: analysis.durationSeconds },
      normalizedMaster: { objectKey: masterObjectKey, fileName: "normalized-master.mp4" },
      clipPlan: analysis.clipPlan,
      exports: exportArtifacts,
      socialPackage,
    };
    const { zipPath } = await bundleStage({
      workdir,
      manifest,
      normalizedMasterPath,
      exports: exportArtifactsWithPaths,
    });
    const artifactObjectKey = await uploadPackageZip({
      zipPath,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
    });

    const output = {
      stage: "completed",
      packageJobId: job.id,
      artifactObjectKey,
      normalizedMasterObjectKey: masterObjectKey,
      exportCount: exportArtifacts.length,
      clipPlanCount: analysis.clipPlan.length,
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
