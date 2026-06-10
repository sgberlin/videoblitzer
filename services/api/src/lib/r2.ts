import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

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

export async function createSignedUploadUrl(userId: string, filename: string, contentType: string) {
  const safeName = sanitizeFilename(filename);
  const key = `uploads/${userId}/${crypto.randomUUID()}-${safeName}`;
  const client = createR2Client();
  if (!client) return { key, uploadUrl: null, expiresIn: 900, mode: "configuration_required" };
  const command = new PutObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
  return { key, uploadUrl, expiresIn: 900, mode: "signed_url" };
}
