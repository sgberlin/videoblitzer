import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeStage, probeDurationSeconds } from "./analyzeStage";
import { bundleStage, uploadPackageZip } from "./bundleStage";
import { createFastNormalizedMaster, createFastNormalizedMasterWithAudio, createFinalEdit, createNormalizedMaster, createNormalizedMasterWithAudio, exportStage, socialClipStage } from "./exportStage";
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

function clampProgress(value: number) {
  return Math.min(99, Math.max(0, Math.round(value)));
}

function stageProgressReporter(input: {
  client: WorkerClient;
  job: PackageJob;
  stage: string;
  startProgress: number;
  endProgress: number;
  throttleMs?: number;
}) {
  let lastUpdateAt = 0;
  let lastProgress = -1;
  return async (progress: { percent: number; seconds?: number; label?: string; current?: number; total?: number }) => {
    const nowMs = Date.now();
    const stagePercent = Math.min(100, Math.max(0, Math.round(progress.percent)));
    const overallProgress = Math.max(lastProgress, clampProgress(input.startProgress + ((input.endProgress - input.startProgress) * stagePercent) / 100));
    if (overallProgress === lastProgress && nowMs - lastUpdateAt < (input.throttleMs ?? 4000)) return;
    if (nowMs - lastUpdateAt < (input.throttleMs ?? 4000) && stagePercent < 100) return;
    lastUpdateAt = nowMs;
    lastProgress = overallProgress;
    await updatePackageState(input.client, input.job.id, "processing", {
      progress: overallProgress,
      stage: input.stage,
      last_heartbeat_at: new Date().toISOString(),
      output: {
        stage: input.stage,
        stageUpdatedAt: new Date().toISOString(),
        stageProgressPercent: stagePercent,
        ffmpegSeconds: typeof progress.seconds === "number" ? Number(progress.seconds.toFixed(1)) : undefined,
        itemLabel: progress.label,
        itemIndex: progress.current,
        itemTotal: progress.total,
      },
    });
  };
}

function packageMode(job: PackageJob) {
  return job.input?.packageMode === "high_quality" ? "high_quality" : "fast";
}

function packageVariant(job: PackageJob) {
  return String(job.package_variant ?? job.input?.packageVariant ?? "standard_highlights");
}

function packageOptions(job: PackageJob) {
  const options = job.package_options ?? job.input?.packageOptions;
  return typeof options === "object" && options !== null ? options as Record<string, unknown> : {};
}

function optionBoolean(options: Record<string, unknown>, key: string, fallback: boolean) {
  return typeof options[key] === "boolean" ? options[key] as boolean : fallback;
}

function optionNumber(options: Record<string, unknown>, key: string, fallback: number) {
  const value = Number(options[key]);
  return Number.isFinite(value) ? value : fallback;
}

function packageOutputs(options: Record<string, unknown>) {
  const raw = Array.isArray(options.outputs) ? options.outputs.map(String) : ["vertical", "landscape", "square"];
  const allowed = new Set(["vertical", "landscape", "square"]);
  const outputs = raw.filter((item) => allowed.has(item));
  return outputs.length ? outputs : ["vertical", "landscape", "square"];
}

function presetIdsForOutputs(options: Record<string, unknown>, requestedPresetIds: string[]) {
  if (requestedPresetIds.length) return requestedPresetIds;
  const ids: string[] = [];
  const outputs = new Set(packageOutputs(options));
  if (outputs.has("landscape")) ids.push("youtube_16_9_1080p");
  if (outputs.has("vertical")) ids.push("shorts_9_16_1080x1920");
  if (outputs.has("square")) ids.push("square_1_1_1080");
  return ids;
}

type MatchTimelineEvent = {
  id?: string;
  minute?: number;
  stoppageMinute?: number;
  team?: string;
  player?: string;
  assistingPlayer?: string;
  eventType?: string;
  description?: string;
  confidence?: string;
  importanceScore?: number;
  period?: string;
};

function eventText(event: MatchTimelineEvent) {
  return [event.eventType, event.description].filter(Boolean).join(" ").toLowerCase();
}

function isGoalEvent(event: MatchTimelineEvent) {
  const text = eventText(event);
  return text.includes("goal") || text.includes("penalty scored");
}

function isKeyMomentEvent(event: MatchTimelineEvent) {
  const text = eventText(event);
  return isGoalEvent(event) || text.includes("penalty") || text.includes("red card") || text.includes("var") || text.includes("big chance") || text.includes("shot on target");
}

function normalizeMatchEvents(value: unknown): MatchTimelineEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((event) => event as Record<string, unknown>)
    .map((event) => ({
      id: typeof event.id === "string" ? event.id : undefined,
      minute: Number(event.minute),
      stoppageMinute: event.stoppageMinute === undefined ? undefined : Number(event.stoppageMinute),
      team: typeof event.team === "string" ? event.team : undefined,
      player: typeof event.player === "string" ? event.player : undefined,
      assistingPlayer: typeof event.assistingPlayer === "string" ? event.assistingPlayer : undefined,
      eventType: typeof event.eventType === "string" ? event.eventType : typeof event.type === "string" ? event.type : undefined,
      description: typeof event.description === "string" ? event.description : typeof event.note === "string" ? event.note : undefined,
      confidence: typeof event.confidence === "string" ? event.confidence : undefined,
      importanceScore: event.importanceScore === undefined ? undefined : Number(event.importanceScore),
      period: typeof event.period === "string" ? event.period : undefined,
    }))
    .filter((event) => Number.isFinite(event.minute));
}

async function loadConfirmedMatchEvents(client: WorkerClient, job: PackageJob) {
  const { data, error } = await client
    .from("match_data")
    .select("data,confirmed")
    .eq("project_id", job.project_id)
    .eq("user_id", job.user_id)
    .eq("confirmed", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const matchData = data?.data as Record<string, unknown> | null | undefined;
  return normalizeMatchEvents(matchData?.events ?? (matchData?.timeline as Record<string, unknown> | undefined)?.events ?? matchData?.manualEvents);
}

function eventVideoSecond(event: MatchTimelineEvent, options: Record<string, unknown>) {
  const kickoffSecond = optionNumber(options, "videoKickoffSecond", 0);
  const secondHalfKickoffSecond = options.secondHalfKickoffSecond === undefined ? undefined : optionNumber(options, "secondHalfKickoffSecond", NaN);
  const extra = Number.isFinite(event.stoppageMinute) ? Number(event.stoppageMinute) * 60 : 0;
  if (event.period === "second_half" && Number.isFinite(secondHalfKickoffSecond)) return Number(secondHalfKickoffSecond) + Math.max(0, Number(event.minute) - 45) * 60 + extra;
  return kickoffSecond + Math.max(0, Number(event.minute)) * 60 + extra;
}

function clipPlanFromMatchEvents(events: MatchTimelineEvent[], durationSeconds: number, options: Record<string, unknown>): PackageManifest["clipPlan"] {
  if (!optionBoolean(options, "useMatchData", true)) return [];
  const includeGoals = optionBoolean(options, "includeGoalClips", true);
  const includeKeyMoments = optionBoolean(options, "includeKeyMoments", true);
  const goalRunup = Math.max(60, optionNumber(options, "goalRunupSeconds", 75));
  const keyRunup = Math.max(20, optionNumber(options, "keyMomentRunupSeconds", 40));
  const safeDuration = Math.max(1, durationSeconds || 1);

  return events
    .filter((event) => includeGoals && isGoalEvent(event) || includeKeyMoments && !isGoalEvent(event) && isKeyMomentEvent(event))
    .sort((a, b) => {
      const scoreDiff = Number(b.importanceScore ?? 0) - Number(a.importanceScore ?? 0);
      return scoreDiff || eventVideoSecond(a, options) - eventVideoSecond(b, options);
    })
    .slice(0, Math.max(1, optionNumber(options, "numberOfClips", 8)))
    .map((event, index) => {
      const goal = isGoalEvent(event);
      const eventSecond = eventVideoSecond(event, options);
      const startSeconds = Math.max(0, eventSecond - (goal ? goalRunup : keyRunup));
      const endSeconds = Math.min(safeDuration, eventSecond + (goal ? 25 : 18));
      const player = event.player ? ` - ${event.player}` : "";
      const team = event.team ? ` (${event.team})` : "";
      const minute = `${event.minute}${event.stoppageMinute ? `+${event.stoppageMinute}` : ""}'`;
      const label = `${event.eventType ?? (goal ? "Goal" : "Key moment")} ${minute}${player}${team}`;
      const confidence = event.confidence === "high" || event.confidence === "manual" ? 0.94 : event.confidence === "medium" ? 0.78 : 0.65;
      return {
        id: `match-event-${index + 1}-${String(event.id ?? event.minute).replace(/[^a-zA-Z0-9-]/g, "")}`,
        startSeconds,
        endSeconds: Math.max(endSeconds, Math.min(safeDuration, startSeconds + 20)),
        label,
        note: event.description ?? label,
        confidence,
        reason: `${goal ? `Goal clip with ${Math.round(goalRunup)} seconds of buildup.` : "Confirmed match-data key moment."} Event mapped from match minute ${minute}.`,
        suggestedClipType: goal ? "extended_highlight" : "story_highlight",
        platformFit: ["instagram_reels", "tiktok", "youtube_shorts", "facebook_reels", "youtube_standard", "social_square"],
      } satisfies PackageManifest["clipPlan"][number];
    })
    .filter((clip) => clip.endSeconds > clip.startSeconds);
}

function finalEditTargetDuration(sourceDurationSeconds: number) {
  if (sourceDurationSeconds >= 75 * 60) return 18 * 60;
  if (sourceDurationSeconds >= 20 * 60) {
    const reduction = Math.min(4 * 60, Math.max(2 * 60, sourceDurationSeconds * 0.12));
    return Math.max(60, sourceDurationSeconds - reduction);
  }
  return Math.max(30, sourceDurationSeconds * 0.85);
}

function mergeClipRanges(clips: PackageManifest["clipPlan"]): PackageManifest["clipPlan"] {
  const sorted = [...clips].sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: PackageManifest["clipPlan"] = [];
  for (const clip of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || clip.startSeconds > previous.endSeconds + 2) {
      merged.push({ ...clip });
      continue;
    }
    previous.endSeconds = Math.max(previous.endSeconds, clip.endSeconds);
    previous.confidence = Math.max(previous.confidence, clip.confidence);
    previous.label = previous.label.includes(clip.label) ? previous.label : `${previous.label} / ${clip.label}`.slice(0, 140);
    previous.reason = `${previous.reason} ${clip.reason}`;
  }
  return merged;
}

function createDurationFillers(input: { durationSeconds: number; existing: PackageManifest["clipPlan"]; targetDuration: number }) {
  const existingDuration = input.existing.reduce((sum, clip) => sum + Math.max(0, clip.endSeconds - clip.startSeconds), 0);
  const missing = input.targetDuration - existingDuration;
  if (missing <= 30) return [];
  const fillerCount = Math.min(8, Math.max(1, Math.ceil(missing / 120)));
  const fillerDuration = Math.min(150, Math.max(45, missing / fillerCount));
  const occupied = input.existing.map((clip) => ({ start: clip.startSeconds, end: clip.endSeconds }));
  const fillers: PackageManifest["clipPlan"] = [];
  for (let index = 0; index < fillerCount; index += 1) {
    const center = input.durationSeconds * ((index + 1) / (fillerCount + 1));
    const startSeconds = Math.max(0, center - fillerDuration / 2);
    const endSeconds = Math.min(input.durationSeconds, startSeconds + fillerDuration);
    const overlaps = occupied.some((range) => startSeconds < range.end && endSeconds > range.start);
    if (overlaps) continue;
    fillers.push({
      id: `final-edit-context-${index + 1}`,
      startSeconds,
      endSeconds,
      label: `Context sequence ${index + 1}`,
      confidence: 0.5,
      reason: "Added to make the final edited video the requested length while preserving game flow.",
      suggestedClipType: "extended_highlight",
      platformFit: ["youtube_standard", "facebook"],
    });
  }
  return fillers;
}

function finalEditClipPlan(clipPlan: PackageManifest["clipPlan"], durationSeconds: number, options: Record<string, unknown>) {
  const explicitTarget = optionNumber(options, "finalVideoTargetSeconds", NaN);
  const targetDuration = Number.isFinite(explicitTarget) ? Math.max(30, explicitTarget) : finalEditTargetDuration(durationSeconds);
  const expanded = clipPlan.map((clip) => {
    const eventCenter = (clip.startSeconds + clip.endSeconds) / 2;
    const desiredDuration = durationSeconds >= 75 * 60 ? Math.max(75, Math.min(150, targetDuration / Math.max(6, clipPlan.length))) : Math.max(60, Math.min(240, targetDuration / Math.max(4, clipPlan.length)));
    const startSeconds = Math.max(0, eventCenter - desiredDuration * 0.65);
    const endSeconds = Math.min(durationSeconds, startSeconds + desiredDuration);
    return { ...clip, startSeconds, endSeconds, reason: `${clip.reason} Included in condensed final edit.` };
  });
  const withFillers = [...expanded, ...createDurationFillers({ durationSeconds, existing: expanded, targetDuration })];
  const merged = mergeClipRanges(withFillers);
  let total = 0;
  const selected: PackageManifest["clipPlan"] = [];
  for (const clip of merged.sort((a, b) => a.startSeconds - b.startSeconds)) {
    if (total >= targetDuration) break;
    const remaining = targetDuration - total;
    const duration = clip.endSeconds - clip.startSeconds;
    selected.push(duration > remaining + 15 ? { ...clip, endSeconds: clip.startSeconds + remaining } : clip);
    total += Math.min(duration, remaining);
  }
  return { clipPlan: selected.filter((clip) => clip.endSeconds > clip.startSeconds), targetDuration };
}

function isSchemaCacheMissingColumn(error: unknown) {
  const message = typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : String(error);
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  return code === "42703" || code === "PGRST204" || (message.includes("Could not find") && message.includes("schema cache"));
}

function canCopyVideoForFastMaster(video: VideoRow, job: PackageJob) {
  const sourceFormat = String((job.input?.sourceFormat as string | undefined) ?? video.source_format ?? "").toLowerCase();
  const codec = String((job.input?.videoCodec as string | undefined) ?? video.video_codec ?? "").toLowerCase();
  return sourceFormat === "mp4" && ["h264", "avc1"].includes(codec);
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
    .select("id,project_id,storage_key,source_object_key,source_format,markers,file_sha256,duplicate_of_video_id,analysis_status,analysis_metadata,verification_metadata")
    .eq("id", job.video_id)
    .eq("owner_id", job.user_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Package video was not found.");
  const verification = ((data as VideoRow).verification_metadata ?? {}) as Record<string, unknown>;
  const media = (verification.media ?? {}) as Record<string, unknown>;
  const audioSource = (verification.audioSource ?? {}) as Record<string, unknown>;
  const hasAudioSource = Object.keys(audioSource).length > 0;
  return {
    ...data,
    has_video: job.input?.hasVideo ?? media.has_video ?? false,
    has_audio: job.input?.hasAudio ?? (hasAudioSource ? true : media.has_audio ?? false),
    duration_seconds: job.input?.durationSeconds ?? media.duration_seconds ?? null,
    file_sha256: job.input?.fileSha256 ?? data.file_sha256 ?? verification.fileSha256 ?? null,
    duplicate_of_video_id: job.input?.duplicateSourceVideoId ?? data.duplicate_of_video_id ?? verification.duplicateOfVideoId ?? null,
    audio_source_object_key: job.input?.audioSourceObjectKey ?? audioSource.objectKey ?? null,
    audio_source_metadata: (job.input?.audioSourceMetadata as Record<string, unknown> | undefined) ?? (hasAudioSource ? audioSource : {}),
  } as VideoRow;
}

function clipPlanFromAnalysisRow(row: Record<string, unknown>): PackageManifest["clipPlan"] {
  const candidateMoments = Array.isArray(row.candidate_moments) ? row.candidate_moments : [];
  return candidateMoments
    .map((candidate, index) => {
      const item = candidate as Record<string, unknown>;
      const startSeconds = Number(item.startSeconds ?? item.start_seconds ?? 0);
      const endSeconds = Number(item.endSeconds ?? item.end_seconds ?? startSeconds + 30);
      return {
        id: String(item.id ?? `reused-${index + 1}`),
        startSeconds,
        endSeconds,
        label: String(item.label ?? `Reused highlight ${index + 1}`),
        note: typeof item.note === "string" ? item.note : undefined,
        confidence: Number(item.confidence ?? 0.5),
        reason: String(item.reason ?? "Reused saved analysis from a previous upload."),
        suggestedClipType: (["quick_moment", "short_highlight", "story_highlight", "extended_highlight"].includes(String(item.suggestedClipType)) ? item.suggestedClipType : "short_highlight") as PackageManifest["clipPlan"][number]["suggestedClipType"],
        platformFit: Array.isArray(item.platformFit) ? item.platformFit.map(String) : ["instagram_reels", "tiktok", "youtube_shorts"],
      };
    })
    .filter((item) => Number.isFinite(item.startSeconds) && Number.isFinite(item.endSeconds) && item.endSeconds > item.startSeconds);
}

async function loadReusableAnalysis(client: WorkerClient, job: PackageJob, video: VideoRow) {
  const analysisId = String(job.analysis_id ?? job.input?.analysisId ?? "");
  if (analysisId) {
    const { data, error } = await client.from("video_analysis").select("*").eq("id", analysisId).eq("user_id", job.user_id).eq("status", "completed").maybeSingle();
    if (error) {
      if (isSchemaCacheMissingColumn(error)) return null;
      throw new Error(error.message);
    }
    if (data) return data as Record<string, unknown>;
  }
  const sourceHash = String(job.input?.fileSha256 ?? video.file_sha256 ?? "");
  if (!sourceHash) return null;
  const { data, error } = await client.from("video_analysis").select("*").eq("user_id", job.user_id).eq("source_hash", sourceHash).eq("status", "completed").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    if (isSchemaCacheMissingColumn(error)) return null;
    throw new Error(error.message);
  }
  return (data as Record<string, unknown> | null) ?? null;
}

async function persistVideoAnalysis(client: WorkerClient, job: PackageJob, video: VideoRow, analysis: PackageManifest["analysis"] & { clipPlan: PackageManifest["clipPlan"] }) {
  const sourceHash = String(job.input?.fileSha256 ?? video.file_sha256 ?? "");
  if (!sourceHash) return null;
  const analysisId = randomUUID();
  const { error } = await client.from("video_analysis").insert({
    id: analysisId,
    video_id: video.duplicate_of_video_id ?? video.id,
    user_id: job.user_id,
    project_id: job.project_id,
    source_hash: sourceHash,
    status: "completed",
    duration_seconds: analysis.durationSeconds,
    scene_changes: [],
    audio_peaks: [],
    motion_scores: [],
    candidate_moments: analysis.clipPlan,
    transcript_metadata: {},
  });
  if (error) {
    if (isSchemaCacheMissingColumn(error)) return null;
    throw new Error(error.message);
  }
  await Promise.all([
    client.from("package_jobs").update({ analysis_id: analysisId, reuse_analysis: false }).eq("id", job.id),
    client.from("videos").update({ analysis_status: "completed", analysis_metadata: { analysisId, candidateMomentCount: analysis.clipPlan.length, sourceHash } }).eq("id", video.duplicate_of_video_id ?? video.id).eq("owner_id", job.user_id),
  ]);
  return analysisId;
}

function varyClipPlanForPackage(clipPlan: PackageManifest["clipPlan"], job: PackageJob) {
  const variant = packageVariant(job);
  const options = packageOptions(job);
  const requestedCount = typeof options.numberOfClips === "number" ? Math.min(30, Math.max(1, Math.round(options.numberOfClips))) : undefined;
  const focusType = typeof options.focusType === "string" ? options.focusType.replaceAll("_", " ") : "";
  const sorted = [...clipPlan].sort((a, b) => {
    if (variant === "high_energy" || variant === "tiktok_first" || variant === "instagram_reels" || variant === "youtube_shorts") return b.confidence - a.confidence || (a.endSeconds - a.startSeconds) - (b.endSeconds - b.startSeconds);
    if (variant === "coach_review" || variant === "defensive_plays") return (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds);
    return a.startSeconds - b.startSeconds;
  });
  const limit = requestedCount ?? (variant === "high_energy" || variant === "tiktok_first" ? 6 : sorted.length);
  return sorted.slice(0, limit).map((clip, index) => ({
    ...clip,
    id: `${clip.id}-${variant}-${index + 1}`,
    reason: [
      Boolean(job.input?.reuseAnalysis ?? job.reuse_analysis) ? "Reused saved analysis." : "Fresh analysis.",
      variant === "custom" ? "User custom focus." : variant === "standard_highlights" ? "Standard highlight selection." : "Alternative pacing and style.",
      variant.includes("tiktok") || variant.includes("instagram") || variant.includes("youtube") ? "Platform-specific selection." : "",
      focusType ? `Focus: ${focusType}.` : "",
      clip.reason,
    ].filter(Boolean).join(" "),
  }));
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
  const variant = packageVariant(job);
  return {
    packageJobId: job.id,
    source: "package_worker",
    packageVariant: variant,
    packageOptions: packageOptions(job),
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
    packageSummary: `Generated ${exports.length} preset exports and ${clipPlan.length} planned clips for ${variant.replaceAll("_", " ")}.`,
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
    const hasAudioForExports = Boolean(audioSourceObjectKey || video.has_audio);
    let sourceDurationSeconds = typeof video.duration_seconds === "number" && Number.isFinite(video.duration_seconds) && video.duration_seconds > 0 ? video.duration_seconds : undefined;
    const mode = packageMode(job);
    const variant = packageVariant(job);
    const options = packageOptions(job);
    const outputs = packageOutputs(options);
    const includeMaster = optionBoolean(options, "includeMaster", true);
    const includeCaptions = optionBoolean(options, "includeCaptions", true);
    const burnCaptions = includeCaptions && optionBoolean(options, "burnCaptions", false);
    const subtleZoom = optionBoolean(options, "subtleZoom", true);
    const useFastCopyMaster = mode === "fast" && canCopyVideoForFastMaster(video, job);

    const sourcePath = path.join(workdir, "source-input");
    const audioSourcePath = path.join(workdir, "audio-sidecar-input");
    const normalizedMasterPath = path.join(workdir, "normalized-master.mp4");
    const finalEditPath = path.join(workdir, "final-edit.mp4");
    const exportsDir = path.join(workdir, "exports");
    await mkdir(exportsDir, { recursive: true });

    await markStage(client, job, "download_source", 15, { sourceObjectKey, audioSourceObjectKey: audioSourceObjectKey || undefined });
    await withHeartbeat(client, job, "download_source", async () => {
      await downloadR2File(sourceObjectKey, sourcePath);
      if (audioSourceObjectKey) await downloadR2File(audioSourceObjectKey, audioSourcePath);
    });
    if (!sourceDurationSeconds) {
      sourceDurationSeconds = await probeDurationSeconds(sourcePath).catch(() => undefined);
    }

    await markStage(client, job, "normalize_master", 25, {
      audioSidecar: Boolean(audioSourceObjectKey),
      packageMode: mode,
      fastCopyMaster: useFastCopyMaster,
      stageProgressPercent: 0,
      itemLabel: "Merging and normalizing media",
      itemIndex: 1,
      itemTotal: 1,
      durationSeconds: sourceDurationSeconds,
    });
    const reportNormalizeProgress = stageProgressReporter({ client, job, stage: "normalize_master", startProgress: 25, endProgress: 40 });
    await withHeartbeat(client, job, "normalize_master", () => {
      if (useFastCopyMaster && audioSourceObjectKey) return createFastNormalizedMasterWithAudio(sourcePath, audioSourcePath, normalizedMasterPath, sourceDurationSeconds, reportNormalizeProgress);
      if (useFastCopyMaster) return createFastNormalizedMaster(sourcePath, normalizedMasterPath, hasAudioForExports, sourceDurationSeconds, reportNormalizeProgress);
      return audioSourceObjectKey
        ? createNormalizedMasterWithAudio(sourcePath, audioSourcePath, normalizedMasterPath, sourceDurationSeconds, reportNormalizeProgress)
        : createNormalizedMaster(sourcePath, normalizedMasterPath, hasAudioForExports, sourceDurationSeconds, reportNormalizeProgress);
    });
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

    await markStage(client, job, "analyze", 40, { reuseAnalysis: Boolean(job.input?.reuseAnalysis ?? job.reuse_analysis), packageVariant: variant });
    const reusableAnalysis = Boolean(job.input?.reuseAnalysis ?? job.reuse_analysis) ? await loadReusableAnalysis(client, job, video) : null;
    const reusableClipPlan = reusableAnalysis ? clipPlanFromAnalysisRow(reusableAnalysis) : [];
    const canUseReusableAnalysis = Boolean(reusableAnalysis && reusableClipPlan.length);
    const matchClipPlan = await loadConfirmedMatchEvents(client, job)
      .then((events) => clipPlanFromMatchEvents(events, sourceDurationSeconds ?? 0, options))
      .catch((error) => {
        console.warn("[package-worker] match data clip plan unavailable", error instanceof Error ? error.message : error);
        return [];
      });
    const rawAnalysis = matchClipPlan.length
      ? {
        durationSeconds: sourceDurationSeconds ?? await probeDurationSeconds(normalizedMasterPath),
        clipPlan: matchClipPlan,
      }
      : canUseReusableAnalysis
      ? {
        durationSeconds: Number(reusableAnalysis!.duration_seconds ?? sourceDurationSeconds ?? 0),
        clipPlan: reusableClipPlan,
      }
      : await withHeartbeat(client, job, "analyze", () => analyzeStage(normalizedMasterPath, video.markers ?? []));
    const reusedAnalysisForClipPlan = !matchClipPlan.length && canUseReusableAnalysis;
    const analysis = {
      durationSeconds: rawAnalysis.durationSeconds,
      clipPlan: varyClipPlanForPackage(rawAnalysis.clipPlan, job),
    };
    const analysisId = reusedAnalysisForClipPlan && reusableAnalysis?.id ? String(reusableAnalysis.id) : await persistVideoAnalysis(client, job, video, analysis);
    await persistClipPlan(client, job, analysis.clipPlan);

    const { clipPlan: editClipPlan, targetDuration: finalEditTargetSeconds } = finalEditClipPlan(analysis.clipPlan, analysis.durationSeconds, options);
    await markStage(client, job, "final_edit", 50, { targetDurationSeconds: finalEditTargetSeconds, editClipCount: editClipPlan.length });
    const reportFinalEditProgress = stageProgressReporter({ client, job, stage: "final_edit", startProgress: 50, endProgress: 55 });
    const finalEdit = await withHeartbeat(client, job, "final_edit", () => createFinalEdit({
      masterPath: normalizedMasterPath,
      outputPath: finalEditPath,
      clipPlan: editClipPlan,
      workdir,
      hasAudio: hasAudioForExports,
      onProgress: reportFinalEditProgress,
    }));

    await markStage(client, job, "rendering_clips", 55, { clipPlanCount: analysis.clipPlan.length });
    const reportClipProgress = stageProgressReporter({ client, job, stage: "rendering_clips", startProgress: 55, endProgress: 70 });
    const { clipArtifacts, thumbnailArtifacts } = await withHeartbeat(client, job, "rendering_clips", () => socialClipStage({
      masterPath: normalizedMasterPath,
      workdir,
      clipPlan: analysis.clipPlan,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
      hasAudio: hasAudioForExports,
      onProgress: reportClipProgress,
      fastMode: mode === "fast",
      clipRenderConcurrency: mode === "fast" ? Number(process.env.PACKAGE_FAST_CLIP_CONCURRENCY ?? 2) : 1,
      outputs,
      subtleZoom,
      burnCaptions,
    }));

    await markStage(client, job, "preset_exports", 70, { clipAssetCount: clipArtifacts.length });
    const requestedPresetIds = Array.isArray(job.input?.presetIds) ? (job.input?.presetIds as string[]) : [];
    const selectedPresetIds = presetIdsForOutputs(options, requestedPresetIds);
    const reportExportProgress = stageProgressReporter({ client, job, stage: "preset_exports", startProgress: 70, endProgress: 82 });
    const exportArtifactsWithPaths = await withHeartbeat(client, job, "preset_exports", () => exportStage({
      masterPath: finalEditPath,
      exportsDir,
      requestedPresetIds: selectedPresetIds,
      userId: job.user_id,
      projectId: job.project_id,
      packageJobId: job.id,
      hasAudio: hasAudioForExports,
      durationSeconds: finalEdit.durationSeconds,
      onProgress: reportExportProgress,
    }));
    const exportArtifacts = exportArtifactsWithPaths.map(({ filePath: _filePath, ...artifact }) => artifact);
    await persistExports(client, job, exportArtifacts);

    const socialPackage = socialContentForPackage(job, analysis.clipPlan, exportArtifacts);
    const textAssets = includeCaptions ? await createTextAssets({ workdir, job, clipPlan: analysis.clipPlan, socialPackage }) : [];
    await persistSocialPackage(client, job, socialPackage);

    await markStage(client, job, "validating_assets", 82, { exportCount: exportArtifacts.length, clipAssetCount: clipArtifacts.length });
    const assetsWithPaths = [...(includeMaster ? [masterAsset] : []), ...exportArtifactsWithPaths, ...clipArtifacts, ...thumbnailArtifacts, ...textAssets];
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
      packageMode: mode,
      packageVariant: variant,
      analysisId,
      reuseAnalysis: reusedAnalysisForClipPlan,
      packageOptions: options,
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
      normalizedMasterPath: includeMaster ? normalizedMasterPath : undefined,
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
      includeMaster,
      finalEditDurationSeconds: finalEdit.durationSeconds,
      finalEditTargetSeconds,
      finalEditClipCount: editClipPlan.length,
      exportCount: exportArtifacts.length,
      clipPlanCount: analysis.clipPlan.length,
      assetCount: validatedAssets.length + 1,
      packageMode: mode,
      packageVariant: variant,
      packageOptions: options,
      analysisId,
      reuseAnalysis: reusedAnalysisForClipPlan,
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
