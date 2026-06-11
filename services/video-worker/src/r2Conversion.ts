import "dotenv/config";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ConvertWebmToMp4Input {
  bucket?: string;
  sourceObjectKey: string;
  targetObjectKey: string;
}

function r2Client() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials are required on the worker host.");
  return new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
}

function runFfmpeg(inputPath: string, outputPath: string) {
  const args = ["-y", "-i", inputPath, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputPath];
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-2000)}`)));
  });
}

export async function convertWebmToMp4FromR2(input: ConvertWebmToMp4Input) {
  const bucket = input.bucket ?? process.env.R2_BUCKET_NAME ?? "videoblitzer-videos";
  const client = r2Client();
  const workdir = await mkdtemp(join(tmpdir(), "videoblitzer-convert-"));
  const webmPath = join(workdir, "input.webm");
  const mp4Path = join(workdir, "output.mp4");

  try {
    const source = await client.send(new GetObjectCommand({ Bucket: bucket, Key: input.sourceObjectKey }));
    if (!source.Body || !("pipe" in source.Body)) throw new Error("R2 source object body is not streamable.");
    await pipeline(source.Body as NodeJS.ReadableStream, createWriteStream(webmPath));
    await runFfmpeg(webmPath, mp4Path);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.targetObjectKey, Body: createReadStream(mp4Path), ContentType: "video/mp4" }));
    return { status: "completed", bucket, sourceObjectKey: input.sourceObjectKey, targetObjectKey: input.targetObjectKey };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
