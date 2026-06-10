import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

export function createServiceClient() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) return null;
  return createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
}

export async function verifyBearerToken(token?: string) {
  const supabase = createServiceClient();
  if (!supabase || !token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
