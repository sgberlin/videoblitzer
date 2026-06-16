import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import ffprobeStatic from "ffprobe-static";
import { pipeline } from "node:stream/promises";
import { config } from "../config";
import { createR2Client } from "./r2";

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
};

type FfprobeOutput = {
  streams?: FfprobeStream[];
  format?: { duration?: string };
};

export type MediaStreamMetadata = {
  has_video: boolean;
  has_audio: boolean;
  video_codec: string | null;
  audio_codec: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  probe_metadata: Record<string, unknown>;
};

function numericDuration(value?: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseFfprobeMetadata(raw: FfprobeOutput): MediaStreamMetadata {
  const streams = raw.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    has_video: Boolean(video),
    has_audio: Boolean(audio),
    video_codec: video?.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    duration_seconds: numericDuration(raw.format?.duration) ?? numericDuration(video?.duration) ?? numericDuration(audio?.duration),
    width: typeof video?.width === "number" ? video.width : null,
    height: typeof video?.height === "number" ? video.height : null,
    probe_metadata: { streams },
  };
}

function runFfprobe(inputPath: string) {
  return new Promise<MediaStreamMetadata>((resolve, reject) => {
    const child = spawn(ffprobeStatic.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", inputPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr.slice(-1200)}`));
      try {
        resolve(parseFfprobeMetadata(JSON.parse(stdout) as FfprobeOutput));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function probeR2MediaObject(objectKey: string) {
  const client = createR2Client();
  if (!client) throw new Error("R2 media probing is not configured on the API server.");
  const workdir = await mkdtemp(path.join(tmpdir(), "videoblitzer-probe-"));
  const sourcePath = path.join(workdir, "source-media");
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: objectKey }));
    if (!object.Body || !("pipe" in object.Body)) throw new Error("Uploaded object is not streamable for media probing.");
    await pipeline(object.Body as NodeJS.ReadableStream, createWriteStream(sourcePath));
    return await runFfprobe(sourcePath);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
