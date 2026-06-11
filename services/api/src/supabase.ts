import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

function supabaseServiceKey() {
  return config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY;
}

function supabaseAuthKey() {
  return supabaseServiceKey() || config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY;
}

export function createServiceClient() {
  const key = supabaseServiceKey();
  if (!config.SUPABASE_URL || !key) return null;
  return createClient(config.SUPABASE_URL, key, { auth: { persistSession: false } });
}

export function hasSupabaseAuthConfig() {
  return Boolean(config.SUPABASE_URL && supabaseAuthKey());
}

export async function verifyBearerToken(token?: string) {
  const key = supabaseAuthKey();
  if (!config.SUPABASE_URL || !key || !token) return null;
  const supabase = createClient(config.SUPABASE_URL, key, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
