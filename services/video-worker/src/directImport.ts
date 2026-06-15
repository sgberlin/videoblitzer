import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Readable, Transform } from "node:stream";

type ImportJob = {
  id: string;
  user_id: string;
  project_id: string;
  source_url: string;
  source_type: string;
  status: string;
  attempts?: number | null;
  source_metadata?: Record<string, unknown> | null;
};

const workerId = `import-${process.pid}-${crypto.randomUUID()}`;
const maxAttempts = Number(process.env.IMPORT_WORKER_MAX_ATTEMPTS ?? 3);
const maxBytes = Number(process.env.IMPORT_MAX_BYTES ?? 1024 * 1024 * 1024);
const requestTimeoutMs = Number(process.env.IMPORT_REQUEST_TIMEOUT_MS ?? 30000);
const redirectLimit = Number(process.env.IMPORT_REDIRECT_LIMIT ?? 3);
const blockedPlatformHosts = /(^|\.)((youtube\.com)|(youtu\.be)|(vimeo\.com)|(twitch\.tv)|(facebook\.com)|(instagram\.com)|(tiktok\.com)|(x\.com)|(twitter\.com))$/i;

class ByteLimitTransform extends Transform {
  bytesRead = 0;
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.bytesRead += chunk.byteLength;
    if (this.bytesRead > maxBytes) return callback(new Error(`Source file exceeds max import size of ${maxBytes} bytes.`));
    return callback(null, chunk);
  }
}

function r2Client() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials are required on the worker host.");
  return new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

function isPrivateIpv6(ip: string) {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

async function assertPublicHttpUrl(sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https URLs are supported.");
  if (url.username || url.password) throw new Error("URL must not include credentials.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || blockedPlatformHosts.test(url.hostname)) throw new Error("This source host is not allowed for direct import.");
  const parsedIp = net.isIP(url.hostname);
  const addresses = parsedIp ? [{ address: url.hostname, family: parsedIp }] : await lookup(url.hostname, { all: true, verbatim: false });
  for (const record of addresses) {
    if (record.family === 4 && isPrivateIpv4(record.address)) throw new Error("Private IPv4 addresses are not allowed.");
    if (record.family === 6 && isPrivateIpv6(record.address)) throw new Error("Private IPv6 addresses are not allowed.");
  }
}

function sourceFormat(sourceUrl: string, contentType: string): "mp4" | "mov" | "webm" | "mkv" {
  const extension = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase();
  const byUrl = extension === "mp4" || extension === "mov" || extension === "webm" || extension === "mkv" ? extension : null;
  if (byUrl) return byUrl;
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  if (normalized === "video/x-matroska") return "mkv";
  return "mp4";
}

async function fetchWithValidatedRedirects(sourceUrl: string, redirects = 0): Promise<Response> {
  if (redirects > redirectLimit) throw new Error("Redirect limit exceeded.");
  await assertPublicHttpUrl(sourceUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(sourceUrl, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "VideoBlitzerDirectImport/1.0" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response did not include a location.");
      return fetchWithValidatedRedirects(new URL(location, sourceUrl).toString(), redirects + 1);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function claimQueuedImportJob(client: SupabaseClient) {
  const leaseMinutes = Number(process.env.IMPORT_WORKER_LEASE_MINUTES ?? 30);
  const staleBefore = new Date(Date.now() - leaseMinutes * 60_000).toISOString();
  await client.from("import_jobs").update({ status: "queued", locked_at: null, worker_id: null, error_message: "Requeued after stale worker lease.", updated_at: new Date().toISOString() }).eq("status", "processing").lt("locked_at", staleBefore).lt("attempts", maxAttempts);

  const { data: candidates, error } = await client.from("import_jobs").select("*").eq("status", "queued").lt("attempts", maxAttempts).order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(error.message);
  const candidate = candidates?.[0] as ImportJob | undefined;
  if (!candidate) return null;
  const nextAttempts = (candidate.attempts ?? 0) + 1;
  const { data: claimed, error: claimError } = await client.from("import_jobs").update({ status: "processing", progress: 5, attempts: nextAttempts, locked_at: new Date().toISOString(), worker_id: workerId, updated_at: new Date().toISOString() }).eq("id", candidate.id).eq("status", "queued").select("*").maybeSingle();
  if (claimError) throw new Error(claimError.message);
  return claimed as ImportJob | null;
}

export async function processOneImportJob(client: SupabaseClient) {
  const job = await claimQueuedImportJob(client);
  if (!job) return { processed: false };
  const bucket = process.env.R2_BUCKET_NAME ?? "videoblitzer-videos";

  try {
    const response = await fetchWithValidatedRedirects(job.source_url);
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("video/")) throw new Error(`Source content type must be video/*, got ${contentType || "unknown"}.`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) throw new Error(`Source file exceeds max import size of ${maxBytes} bytes.`);
    if (!response.body) throw new Error("Source response body is empty.");

    const format = sourceFormat(job.source_url, contentType);
    const objectKey = `uploads/raw/${job.user_id}/${job.project_id}/imports/${job.id}.${format}`;
    await client.from("import_jobs").update({ progress: 25, r2_object_key: objectKey, source_metadata: { ...(job.source_metadata ?? {}), contentType, contentLength, finalUrl: response.url }, updated_at: new Date().toISOString() }).eq("id", job.id);

    const byteLimit = new ByteLimitTransform();
    await r2Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(byteLimit),
      ContentType: contentType,
      ContentLength: contentLength || undefined,
      Metadata: { user_id: job.user_id, project_id: job.project_id, import_job_id: job.id },
    }));
    const importedBytes = byteLimit.bytesRead || contentLength;

    const videoId = crypto.randomUUID();
    const needsConversion = format === "webm";
    await client.from("videos").insert({
      id: videoId,
      project_id: job.project_id,
      owner_id: job.user_id,
      user_id: job.user_id,
      filename: `direct-import-${job.id}.${format}`,
      original_filename: `direct-import-${job.id}.${format}`,
      mime_type: contentType,
      content_type: contentType,
      storage_key: objectKey,
      source_object_key: objectKey,
      source_format: format,
      desired_export_format: needsConversion ? "mp4" : undefined,
      source_type: "direct_media_url",
      source_url: job.source_url,
      permission_confirmed: true,
      size_bytes: importedBytes || undefined,
      verification_status: "verified",
      verified_at: new Date().toISOString(),
      verified_size_bytes: importedBytes || undefined,
      verified_content_type: contentType,
      verification_metadata: { mode: "direct_import_worker", objectKey, importJobId: job.id },
      import_metadata: { importJobId: job.id, sourceUrl: job.source_url, contentLength: importedBytes, contentType },
      conversion_status: needsConversion ? "queued" : "not_requested",
      status: "uploaded",
    });
    await client.from("upload_verifications").insert({
      user_id: job.user_id,
      project_id: job.project_id,
      video_id: videoId,
      object_key: objectKey,
      expected_size_bytes: importedBytes || undefined,
      verified_size_bytes: importedBytes || undefined,
      expected_content_type: contentType,
      verified_content_type: contentType,
      status: "verified",
      metadata: { mode: "direct_import_worker", importJobId: job.id },
      verified_at: new Date().toISOString(),
    });
    await client.from("projects").update({ status: "uploaded", source_type: "direct_media_url", source_url: job.source_url, permission_confirmed: true, updated_at: new Date().toISOString(), import_metadata: { importJobId: job.id, sourceUrl: job.source_url } }).eq("id", job.project_id).eq("owner_id", job.user_id);
    await client.from("usage_events").insert({ user_id: job.user_id, project_id: job.project_id, event_name: "direct_url_import_completed", metadata: { importJobId: job.id, sourceUrl: job.source_url, objectKey, contentLength: importedBytes, contentType } });

    if (needsConversion) {
      const exportJobId = crypto.randomUUID();
      const targetObjectKey = `exports/mp4/${job.user_id}/${job.project_id}/${videoId}.mp4`;
      await client.from("export_jobs").insert({ id: exportJobId, project_id: job.project_id, video_id: videoId, user_id: job.user_id, source_object_key: objectKey, target_object_key: targetObjectKey, source_format: "webm", target_format: "mp4", status: "queued" });
      await client.from("jobs").insert({ id: exportJobId, project_id: job.project_id, user_id: job.user_id, type: "convert_mp4", status: "queued", progress: 0, input: { sourceObjectKey: objectKey, targetObjectKey, sourceFormat: "webm", targetFormat: "mp4", importJobId: job.id }, output: {} });
    }

    await client.from("import_jobs").update({ status: "completed", progress: 100, error_message: null, r2_object_key: objectKey, locked_at: null, worker_id: null, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
    await client.from("import_audits").insert({ user_id: job.user_id, project_id: job.project_id, source_url: job.source_url, import_method: "direct_media_url", permission_confirmed: true, file_name: `direct-import-${job.id}.${format}`, file_size: importedBytes || undefined, metadata: { result: "completed", importJobId: job.id, r2ObjectKey: objectKey, contentType } });
    return { processed: true, jobId: job.id, status: "completed", videoId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown direct import failure.";
    await client.from("import_jobs").update({ status: "failed", progress: 100, error_message: message, locked_at: null, worker_id: null, updated_at: new Date().toISOString() }).eq("id", job.id);
    await client.from("import_audits").insert({ user_id: job.user_id, project_id: job.project_id, source_url: job.source_url, import_method: "direct_media_url", permission_confirmed: true, metadata: { result: "failed", importJobId: job.id, error: message } });
    return { processed: true, jobId: job.id, status: "failed", error: message };
  }
}
