import { createClient } from "@supabase/supabase-js";
import { appConfig } from "./config";

export function createBrowserSupabaseClient() {
  if (!appConfig.supabaseUrl || !appConfig.supabasePublishableKey) return null;
  return createClient(appConfig.supabaseUrl, appConfig.supabasePublishableKey);
}
