import { appConfig } from "./config";

export async function apiFetch<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${appConfig.apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
