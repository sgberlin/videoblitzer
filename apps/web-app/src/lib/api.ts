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

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function exchangeMagicLinkCodeIfPresent(supabase: NonNullable<ReturnType<typeof createBrowserSupabaseClient>>) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return;

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;

  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
}

export async function getAccessToken() {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) throw new Error("Supabase publishable configuration is required for private beta access.");

  await exchangeMagicLinkCodeIfPresent(supabase);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const token = data.session?.access_token;
    if (token) return token;
    await delay(200);
  }

  throw new Error("Your login session is not active yet. Open the latest magic link from your email, or request a new code.");
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
