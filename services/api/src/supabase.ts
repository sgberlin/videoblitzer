import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

function supabaseServiceKey() {
  return config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_SECRET_KEY;
}

export function supabaseProjectRef() {
  if (!config.SUPABASE_URL) return null;
  try {
    return new URL(config.SUPABASE_URL).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

export function hasExpectedSupabaseProjectRef() {
  if (!config.SUPABASE_PROJECT_REF) return true;
  return supabaseProjectRef() === config.SUPABASE_PROJECT_REF;
}

export function createServiceClient() {
  const key = supabaseServiceKey();
  if (!config.SUPABASE_URL || !key) return null;
  return createClient(config.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function hasSupabaseAuthConfig() {
  return Boolean(config.SUPABASE_URL && supabaseServiceKey());
}

export function hasSupabaseUrl() {
  return Boolean(config.SUPABASE_URL);
}

export function hasSupabaseServiceKey() {
  return Boolean(supabaseServiceKey());
}

export async function verifyBearerToken(token?: string) {
  const key = supabaseServiceKey();
  if (!config.SUPABASE_URL) return { user: null, errorCode: "api_missing_supabase_url" };
  if (!key) return { user: null, errorCode: "api_missing_supabase_service_key" };
  if (!token) return { user: null, errorCode: "missing_auth_header" };
  const supabase = createClient(config.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { user: null, errorCode: "token_verify_failed" };
  return { user: data.user, errorCode: null };
}
