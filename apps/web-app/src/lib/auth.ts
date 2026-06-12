
"use client";

import { useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { appConfig } from "./config";
import { createBrowserSupabaseClient } from "./supabase";

export type AuthState = "loading" | "unauthenticated" | "authenticated" | "unauthorized_email" | "invalid_link";

export function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() ?? "";
}

export function clearStaleAuthErrors() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem("videoblitzer:authError");
  window.localStorage.removeItem("videoblitzer:unauthorized");
  window.sessionStorage.removeItem("videoblitzer:authError");
  window.sessionStorage.removeItem("videoblitzer:unauthorized");
}

export function authDebug(label: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(`[VideoBlitzer auth] ${label}`, details);
}

function currentRoute() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname}${window.location.search}`;
}

function cleanAuthParamsFromUrl() {
  const url = new URL(window.location.href);
  ["code", "state", "error", "error_code", "error_description", "access_token", "refresh_token", "expires_in", "token_type", "type"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
}

function callbackErrorFromUrl() {
  const url = new URL(window.location.href);
  const searchError = url.searchParams.get("error") || url.searchParams.get("error_code") || url.searchParams.get("error_description");
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const hashError = hash.get("error") || hash.get("error_code") || hash.get("error_description");
  return searchError || hashError;
}

export async function resolveSupabaseSession({ processCallback = true } = {}) {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) throw new Error("Supabase publishable configuration is required for private beta access.");

  if (typeof window !== "undefined" && processCallback) {
    const callbackError = callbackErrorFromUrl();
    if (callbackError) {
      authDebug("callback error", { callbackError, route: currentRoute() });
      throw new Error("invalid_link");
    }

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      authDebug("exchangeCodeForSession", { hasSession: Boolean(data.session), userEmail: data.session?.user.email, route: currentRoute() });
      if (error) throw new Error("invalid_link");
      clearStaleAuthErrors();
      cleanAuthParamsFromUrl();
      return data.session;
    }

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hash.get("access_token");
    const refreshToken = hash.get("refresh_token");
    if (accessToken && refreshToken) {
      const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      authDebug("setSession from hash", { hasSession: Boolean(data.session), userEmail: data.session?.user.email, route: currentRoute() });
      if (error) throw new Error("invalid_link");
      clearStaleAuthErrors();
      cleanAuthParamsFromUrl();
      return data.session;
    }
  }

  const { data, error } = await supabase.auth.getSession();
  authDebug("getSession", { hasSession: Boolean(data.session), userEmail: data.session?.user.email, route: currentRoute() });
  if (error) throw error;
  if (data.session) clearStaleAuthErrors();
  return data.session;
}

export function useAuthSession() {
  const [state, setState] = useState<{ status: AuthState; session: Session | null; email: string; error: string }>({ status: "loading", session: null, email: "", error: "" });

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) {
      setState({ status: "unauthenticated", session: null, email: "", error: "Supabase publishable configuration is required before login can complete." });
      return;
    }

    let mounted = true;
    resolveSupabaseSession()
      .then((session) => {
        if (!mounted) return;
        const email = normalizeEmail(session?.user.email);
        authDebug("allowlist input", { userEmail: email, ownerEmail: normalizeEmail(appConfig.ownerEmail), currentRoute: currentRoute() });
        setState(session ? { status: "authenticated", session, email, error: "" } : { status: "unauthenticated", session: null, email: "", error: "" });
      })
      .catch((error: Error) => {
        if (!mounted) return;
        const invalid = error.message === "invalid_link";
        setState({ status: invalid ? "invalid_link" : "unauthenticated", session: null, email: "", error: invalid ? "This sign-in link expired or could not be verified. Request a new link." : error.message });
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session) => {
      authDebug("auth event", { event, hasSession: Boolean(session), userEmail: session?.user.email, currentRoute: currentRoute() });
      if (!mounted) return;
      if (["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"].includes(event) && session) {
        clearStaleAuthErrors();
        setState({ status: "authenticated", session, email: normalizeEmail(session.user.email), error: "" });
      }
      if (event === "SIGNED_OUT") {
        setState({ status: "unauthenticated", session: null, email: "", error: "" });
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export function isPrivateBetaError(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("private beta") || lower.includes("allowed_user_not_found") || lower.includes("allowed_user_not_active") || lower.includes("access required");
}

export function isInvalidLinkError(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("expired") || lower.includes("invalid link") || lower.includes("otp_expired") || lower.includes("jwt_verification_failed");
}
