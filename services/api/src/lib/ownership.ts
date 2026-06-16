import { createServiceClient } from "../supabase";

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
  const { data, error } = await supabase.from("videos").select("id,project_id,owner_id,storage_key,source_object_key,source_format,content_type,mime_type,verification_status,verified_at,verified_size_bytes,has_video,has_audio,video_codec,audio_codec,duration_seconds,width,height,audio_source_object_key,audio_source_filename,audio_source_content_type,audio_source_size_bytes,audio_source_metadata").eq("id", videoId).eq("owner_id", userId).maybeSingle();
  if (error) throw error;
  return data;
}
