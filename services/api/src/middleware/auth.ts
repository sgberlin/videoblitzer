import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { createServiceClient, hasExpectedSupabaseProjectRef, hasSupabaseAuthConfig, supabaseProjectRef, verifyBearerToken } from "../supabase";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email?: string; role: string; isUnlimited: boolean; planKey: string };
    }
  }
}

interface AuthDiagnostics {
  authenticated: boolean;
  email_present: boolean;
  normalized_email_present: boolean;
  allowed_user_found: boolean;
  allowed_user_status?: string;
  reason: string;
}

function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() ?? "";
}

function authError(status: number, message: string, diagnostics: AuthDiagnostics) {
  return { status, body: { error: message, ...diagnostics } };
}

function authLog(message: string, details: Record<string, unknown>) {
  console.info(`[auth] ${message}`, details);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hasAuthorizationHeader = Boolean(req.headers.authorization);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const projectRef = supabaseProjectRef();
  authLog("request received", { path: req.originalUrl, method: req.method, hasAuthorizationHeader, supabaseProjectRef: projectRef, expectedSupabaseProject: hasExpectedSupabaseProjectRef() });
  if (!token) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "missing_bearer_token", hasAuthorizationHeader });
    return res.status(401).json(authError(401, "Missing login token. Please sign in again.", { authenticated: false, email_present: false, normalized_email_present: false, allowed_user_found: false, reason: "missing_bearer_token" }).body);
  }
  if (!hasSupabaseAuthConfig()) {
    authLog("request denied", { path: req.originalUrl, statusCode: 503, errorCode: "missing_supabase_auth_config", hasAuthorizationHeader });
    return res.status(503).json(authError(503, "API Supabase auth is not configured. Check SUPABASE_URL and Supabase key env vars on the VPS.", { authenticated: false, email_present: false, normalized_email_present: false, allowed_user_found: false, reason: "missing_supabase_auth_config" }).body);
  }
  if (!hasExpectedSupabaseProjectRef()) {
    authLog("request denied", { path: req.originalUrl, statusCode: 503, errorCode: "supabase_project_ref_mismatch", supabaseProjectRef: projectRef });
    return res.status(503).json(authError(503, "API Supabase auth points at the wrong project. Check SUPABASE_URL on the VPS.", { authenticated: false, email_present: false, normalized_email_present: false, allowed_user_found: false, reason: "supabase_project_ref_mismatch" }).body);
  }

  const { user: authUser, errorCode } = await verifyBearerToken(token);
  authLog("token verification result", { path: req.originalUrl, success: Boolean(authUser), errorCode, decodedUserEmail: authUser?.email ?? null });
  if (!authUser) return res.status(401).json(authError(401, "Login session could not be verified. Please open the latest magic link or sign in again.", { authenticated: false, email_present: false, normalized_email_present: false, allowed_user_found: false, reason: errorCode ?? "jwt_verification_failed" }).body);
  const normalizedEmail = normalizeEmail(authUser.email);
  if (!normalizedEmail) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "missing_authenticated_email", decodedUserEmail: authUser.email ?? null });
    return res.status(401).json(authError(401, "Login session did not include an email address. Please sign in again.", { authenticated: true, email_present: Boolean(authUser.email), normalized_email_present: false, allowed_user_found: false, reason: "missing_authenticated_email" }).body);
  }

  const access = await resolveAccess(authUser.id, normalizedEmail);
  authLog("allowlist result", { path: req.originalUrl, allowed: access.allowed, decodedUserEmail: normalizedEmail, role: access.role, isUnlimited: access.isUnlimited, reason: access.diagnostics.reason, allowedUserFound: access.diagnostics.allowed_user_found });
  if (!access.allowed) return res.status(403).json(authError(403, "Private beta access required", access.diagnostics).body);

  req.user = { id: authUser.id, email: normalizedEmail, role: access.role, isUnlimited: access.isUnlimited, planKey: access.planKey };
  return next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Owner access required" });
  return next();
}

export async function resolveAccess(userId: string, email: string) {
  const normalizedEmail = normalizeEmail(email);
  const baseDiagnostics = {
    authenticated: true,
    email_present: Boolean(email),
    normalized_email_present: Boolean(normalizedEmail),
    allowed_user_found: false,
  };

  const supabase = createServiceClient();
  if (!supabase) {
    return { allowed: false, role: "member", planKey: "starter_weekly", isUnlimited: false, diagnostics: { ...baseDiagnostics, reason: "missing_supabase_service_config" } };
  }

  const isOwnerEmail = normalizedEmail === normalizeEmail(config.OWNER_EMAIL);
  const { data, error } = await supabase.from("allowed_users").select("email, role, plan_key, is_unlimited, status").eq("email", normalizedEmail).maybeSingle();
  if (error) {
    return { allowed: false, role: "member", planKey: "starter_weekly", isUnlimited: false, diagnostics: { ...baseDiagnostics, reason: "allowed_user_lookup_failed" } };
  }
  if (!data && isOwnerEmail) {
    await supabase.from("allowed_users").upsert({ email: normalizedEmail, role: "owner", plan_key: "owner_unlimited", is_unlimited: true, status: "active" });
    await supabase.from("profiles").upsert({ id: userId, email: normalizedEmail, role: "owner", plan_key: "owner_unlimited", is_unlimited: true });
    await supabase.from("credit_balances").upsert({ user_id: userId, is_unlimited: true });
    return { allowed: true, role: "owner", planKey: "owner_unlimited", isUnlimited: true, diagnostics: { ...baseDiagnostics, allowed_user_found: true, allowed_user_status: "active", reason: "owner_auto_allowed" } };
  }
  if (!data) return { allowed: false, role: "member", planKey: "starter_weekly", isUnlimited: false, diagnostics: { ...baseDiagnostics, reason: "allowed_user_not_found" } };

  const status = String(data.status ?? "").trim().toLowerCase();
  const rowDiagnostics = { ...baseDiagnostics, allowed_user_found: true, allowed_user_status: status || "missing" };
  if (status !== "active" && isOwnerEmail) {
    await supabase.from("allowed_users").upsert({ email: normalizedEmail, role: "owner", plan_key: "owner_unlimited", is_unlimited: true, status: "active" });
    await supabase.from("profiles").upsert({ id: userId, email: normalizedEmail, role: "owner", plan_key: "owner_unlimited", is_unlimited: true });
    await supabase.from("credit_balances").upsert({ user_id: userId, is_unlimited: true });
    return { allowed: true, role: "owner", planKey: "owner_unlimited", isUnlimited: true, diagnostics: { ...rowDiagnostics, allowed_user_status: "active", reason: "owner_reactivated" } };
  }
  if (status !== "active") return { allowed: false, role: data.role ?? "member", planKey: data.plan_key ?? "starter_weekly", isUnlimited: false, diagnostics: { ...rowDiagnostics, reason: "allowed_user_not_active" } };

  const role = isOwnerEmail ? "owner" : data.role;
  const planKey = isOwnerEmail ? "owner_unlimited" : data.plan_key;
  const isUnlimited = isOwnerEmail ? true : Boolean(data.is_unlimited);

  await supabase.from("profiles").upsert({ id: userId, email: normalizedEmail, role, plan_key: planKey, is_unlimited: isUnlimited });
  await supabase.from("credit_balances").upsert({ user_id: userId, is_unlimited: isUnlimited });

  return { allowed: true, role, planKey, isUnlimited, diagnostics: { ...rowDiagnostics, reason: "allowed" } };
}
