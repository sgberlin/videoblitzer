import { appConfig } from "./config";
import { createBrowserSupabaseClient } from "./supabase";
import { authDebug, clearStaleAuthErrors, resolveSupabaseSession } from "./auth";

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

  const session = await resolveSupabaseSession();
  if (session?.access_token) return session.access_token;

  throw new Error("Your login session is not active yet. Open the latest magic link from your email, or request a new code.");
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  authDebug("api request", { path, hasAuthorizationHeader: Boolean(token), apiUrl: appConfig.apiUrl });
  const response = await fetch(`${appConfig.apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!response.ok) {
    const message = friendlyApiError(await response.text(), `Request failed with status ${response.status}.`);
    throw new Error(message);
  }
  clearStaleAuthErrors();
  return response.json() as Promise<T>;
}

export async function authedApiFetch<T>(path: string, init: RequestInit = {}) {
  return apiFetch<T>(path, init, await getAccessToken());
}
