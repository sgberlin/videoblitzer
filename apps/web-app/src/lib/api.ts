import { appConfig } from "./config";
import { createBrowserSupabaseClient } from "./supabase";

function friendlyApiError(body: string, fallback: string) {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? fallback;
  } catch {
    return body || fallback;
  }
}

export async function getAccessToken() {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) throw new Error("Supabase publishable configuration is required for private beta access.");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in with your private-beta email before continuing.");
  return token;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${appConfig.apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(friendlyApiError(await response.text(), `Request failed with status ${response.status}.`));
  return response.json() as Promise<T>;
}

export async function authedApiFetch<T>(path: string, init: RequestInit = {}) {
  return apiFetch<T>(path, init, await getAccessToken());
}
