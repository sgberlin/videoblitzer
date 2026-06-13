import { createServiceClient } from "../supabase";

export function expectedRawUploadPrefix(userId: string, projectId: string) {
  return `uploads/raw/${userId}/${projectId}/`;
}

export function isExpectedRawUploadKey(userId: string, projectId: string, objectKey: string) {
  return objectKey.startsWith(expectedRawUploadPrefix(userId, projectId));
}

export async function userOwnsProject(userId: string, projectId: string) {
  const supabase = createServiceClient();
  if (!supabase) return true;
  const { data, error } = await supabase.from("projects").select("id").eq("id", projectId).eq("owner_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function userOwnsVideo(userId: string, videoId: string) {
  const supabase = createServiceClient();
  if (!supabase) return true;
  const { data, error } = await supabase.from("videos").select("id").eq("id", videoId).eq("owner_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
