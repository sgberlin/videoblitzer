import { appConfig } from "./config";
import { createBrowserSupabaseClient } from "./supabase";
import { authDebug, clearStaleAuthErrors, resolveSupabaseSession } from "./auth";

function friendlyApiError(body: string, fallback: string) {
  try {
    const parsed = JSON.parse(body) as { error?: string; code?: string; creditCost?: number; balance?: number };
    if (parsed.code === "email_not_allowed") return "email_not_allowed: This email is not approved for the VideoBlitzer private beta.";
    if (parsed.code === "token_verify_failed") return "token_verify_failed: Your session expired or could not be verified. Request a new magic link.";
    if (parsed.code === "missing_auth_header" || parsed.code === "invalid_auth_header") return "missing_auth_header: Please sign in again.";
    if (parsed.code === "insufficient_credits") return `insufficient_credits: ${parsed.error ?? "This action requires more credits."}`;
    return parsed.code ? `${parsed.code}: ${parsed.error ?? fallback}` : parsed.error ?? fallback;
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
