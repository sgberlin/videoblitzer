import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

export interface R2UsageSummary {
  configured: boolean;
  bucket: string;
  endpointConfigured: boolean;
  totalObjects: number;
  totalBytes: number;
  rawFiles: number;
  exports: number;
  thumbnails: number;
  captions: number;
  lastModified?: string;
  error?: string;
}

export function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

export function createR2Client() {
  if (!config.R2_ENDPOINT || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: "auto",
    endpoint: config.R2_ENDPOINT,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
  });
}

export async function createSignedUploadUrl(userId: string, projectId: string, filename: string, contentType: string) {
  const safeName = sanitizeFilename(filename);
  const key = `uploads/raw/${userId}/${projectId}/${crypto.randomUUID()}-${safeName}`;
  const client = createR2Client();
  if (!client) return { key, uploadUrl: null, expiresIn: 900, mode: "configuration_required" };
  const command = new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    Metadata: {
      user_id: userId,
      project_id: projectId,
      original_filename: safeName,
    },
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
  return { key, uploadUrl, expiresIn: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(), method: "PUT", mode: "signed_url" };
}

export async function readR2Usage(): Promise<R2UsageSummary> {
  const client = createR2Client();
  const summary: R2UsageSummary = {
    configured: Boolean(client),
    bucket: config.R2_BUCKET_NAME,
    endpointConfigured: Boolean(config.R2_ENDPOINT),
    totalObjects: 0,
    totalBytes: 0,
    rawFiles: 0,
    exports: 0,
    thumbnails: 0,
    captions: 0,
  };

  if (!client) return summary;

  try {
    let continuationToken: string | undefined;
    do {
      const response = await client.send(new ListObjectsV2Command({ Bucket: config.R2_BUCKET_NAME, ContinuationToken: continuationToken }));
      for (const object of response.Contents ?? []) {
        const key = object.Key ?? "";
        summary.totalObjects += 1;
        summary.totalBytes += object.Size ?? 0;
        if (key.startsWith("uploads/raw/") || key.startsWith("uploads/")) summary.rawFiles += 1;
        if (key.startsWith("exports/")) summary.exports += 1;
        if (key.startsWith("thumbnails/")) summary.thumbnails += 1;
        if (key.startsWith("captions/")) summary.captions += 1;
        if (object.LastModified && (!summary.lastModified || object.LastModified.toISOString() > summary.lastModified)) {
          summary.lastModified = object.LastModified.toISOString();
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    summary.configured = false;
    summary.error = error instanceof Error ? error.message : "Unable to read R2 bucket metadata.";
  }

  return summary;
}
