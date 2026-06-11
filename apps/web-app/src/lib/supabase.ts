import { createClient } from "@supabase/supabase-js";
import { appConfig } from "./config";

let browserSupabaseClient: ReturnType<typeof createClient> | null = null;

export function createBrowserSupabaseClient() {
  if (!appConfig.supabaseUrl || !appConfig.supabasePublishableKey) return null;
  if (!browserSupabaseClient) {
    browserSupabaseClient = createClient(appConfig.supabaseUrl, appConfig.supabasePublishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    });
  }
  return browserSupabaseClient;
}
