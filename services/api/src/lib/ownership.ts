import { createServiceClient } from "../supabase";

const extendedVideoSelect = "id,project_id,owner_id,storage_key,source_object_key,source_format,content_type,mime_type,verification_status,verified_at,verified_size_bytes,has_video,has_audio,video_codec,audio_codec,duration_seconds,width,height,audio_source_object_key,audio_source_filename,audio_source_content_type,audio_source_size_bytes,audio_source_metadata,verification_metadata";
const baseVideoSelect = "id,project_id,owner_id,storage_key,source_object_key,source_format,content_type,mime_type,verification_status,verified_at,verified_size_bytes,verification_metadata";

export function isSchemaCacheMissingColumn(error: unknown) {
  const message = typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : String(error);
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  return code === "42703" || code === "PGRST204" || (message.includes("Could not find") && message.includes("schema cache"));
}

export function hydrateVideoMetadata<T extends Record<string, unknown> | null>(row: T) {
  if (!row) return row;
  const verification = (row.verification_metadata ?? {}) as Record<string, unknown>;
  const media = (verification.media ?? {}) as Record<string, unknown>;
  const audioSource = (verification.audioSource ?? {}) as Record<string, unknown>;
  const audioSourceMedia = (audioSource.media ?? {}) as Record<string, unknown>;
  const hasAudioSource = Object.keys(audioSource).length > 0;
  return {
    ...row,
    has_video: row.has_video ?? media.has_video ?? false,
    has_audio: row.has_audio ?? (hasAudioSource ? true : media.has_audio ?? false),
    video_codec: row.video_codec ?? media.video_codec ?? null,
    audio_codec: row.audio_codec ?? audioSourceMedia.audio_codec ?? media.audio_codec ?? null,
    duration_seconds: row.duration_seconds ?? media.duration_seconds ?? null,
    width: row.width ?? media.width ?? null,
    height: row.height ?? media.height ?? null,
    audio_source_object_key: row.audio_source_object_key ?? audioSource.objectKey ?? null,
    audio_source_metadata: row.audio_source_metadata ?? (hasAudioSource ? audioSource : {}),
  };
}

export function expectedRawUploadPrefix(userId: string, projectId: string) {
  return `uploads/raw/${userId}/${projectId}/`;
}

export function isExpectedRawUploadKey(userId: string, projectId: string, objectKey: string) {
  return objectKey.startsWith(expectedRawUploadPrefix(userId, projectId));
}

export async function userOwnsProject(userId: string, projectId: string) {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Supabase service role is required for ownership checks.");
  const { data, error } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function userOwnsVideo(userId: string, videoId: string) {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Supabase service role is required for ownership checks.");
  const { data, error } = await supabase.from("videos").select("id").eq("id", videoId).eq("owner_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function getOwnedVideo(userId: string, videoId: string) {
  const supabase = createServiceClient();
  if (!supabase) throw new Error("Supabase service role is required for ownership checks.");
  const { data, error } = await supabase.from("videos").select(extendedVideoSelect).eq("id", videoId).eq("owner_id", userId).maybeSingle();
  if (!error) return hydrateVideoMetadata(data);
  if (!isSchemaCacheMissingColumn(error)) throw error;
  const fallback = await supabase.from("videos").select(baseVideoSelect).eq("id", videoId).eq("owner_id", userId).maybeSingle();
  if (fallback.error) throw fallback.error;
  return hydrateVideoMetadata(fallback.data);
}
