import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export function r2Client() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials are required on worker host.");
  return new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
}

export function r2Bucket() {
  return process.env.R2_BUCKET_NAME ?? "videoblitzer-videos";
}

export async function downloadR2File(objectKey: string, outputPath: string) {
  const source = await r2Client().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: objectKey }));
  if (!source.Body || !("pipe" in source.Body)) throw new Error("R2 source object is not streamable.");
  await pipeline(source.Body as NodeJS.ReadableStream, createWriteStream(outputPath));
}

export async function uploadFileToR2(sourcePath: string, objectKey: string, contentType: string) {
  await r2Client().send(new PutObjectCommand({
    Bucket: r2Bucket(),
    Key: objectKey,
    Body: createReadStream(sourcePath),
    ContentType: contentType,
  }));
}
