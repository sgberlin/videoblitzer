"use client";

export type LoginCooldownReason = "sent_success" | "rate_limit_429";

export interface LoginCooldownState {
  until: number;
  reason: LoginCooldownReason;
}

export const LOGIN_COOLDOWN_STORAGE_KEY = "videoblitzer:otpCooldown";

const LEGACY_COOLDOWN_KEYS = ["videoblitzer:lastOtpRequestAt", "videoblitzer:otpCooldownUntil"];

function isCooldownState(value: unknown): value is LoginCooldownState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LoginCooldownState>;
  return typeof state.until === "number" && (state.reason === "sent_success" || state.reason === "rate_limit_429");
}

export function clearLoginCooldown() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LOGIN_COOLDOWN_STORAGE_KEY);
  for (const key of LEGACY_COOLDOWN_KEYS) window.localStorage.removeItem(key);
}

export function writeLoginCooldown(state: LoginCooldownState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOGIN_COOLDOWN_STORAGE_KEY, JSON.stringify(state));
  for (const key of LEGACY_COOLDOWN_KEYS) window.localStorage.removeItem(key);
}

export function readPersistedLoginCooldown() {
  if (typeof window === "undefined") return null;
  for (const key of LEGACY_COOLDOWN_KEYS) window.localStorage.removeItem(key);

  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOGIN_COOLDOWN_STORAGE_KEY) ?? "null") as unknown;
    if (!isCooldownState(parsed) || parsed.until <= Date.now()) {
      clearLoginCooldown();
      return null;
    }

    if (parsed.reason !== "rate_limit_429") {
      clearLoginCooldown();
      return null;
    }

    return parsed;
  } catch {
    clearLoginCooldown();
    return null;
  }
}
