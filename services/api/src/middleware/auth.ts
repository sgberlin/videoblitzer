import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { createServiceClient, hasExpectedSupabaseProjectRef, hasSupabaseServiceKey, hasSupabaseUrl, supabaseProjectRef, verifyBearerToken } from "../supabase";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email?: string; role: string; isUnlimited: boolean; planKey: string };
    }
  }
}

interface AuthDiagnostics {
  hasAuthHeader: boolean;
  authHeaderStartsWithBearer: boolean;
  hasSupabaseUrl: boolean;
  hasSupabaseSecretKey: boolean;
  hasSupabaseServiceRoleKey: boolean;
  tokenVerified: boolean;
  decodedEmail: string | null;
  ownerEmail: string;
  allowlistPassed: boolean;
}

function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() ?? "";
}

function ownerEmail() {
  return normalizeEmail(config.OWNER_EMAIL || "gizlenweb@gmail.com");
}

function authDiagnostics(input: Partial<AuthDiagnostics> = {}): AuthDiagnostics {
  return {
    hasAuthHeader: false,
    authHeaderStartsWithBearer: false,
    hasSupabaseUrl: Boolean(config.SUPABASE_URL),
    hasSupabaseSecretKey: Boolean(config.SUPABASE_SECRET_KEY),
    hasSupabaseServiceRoleKey: Boolean(config.SUPABASE_SERVICE_ROLE_KEY),
    tokenVerified: false,
    decodedEmail: null,
    ownerEmail: ownerEmail(),
    allowlistPassed: false,
    ...input,
  };
}

function authError(status: number, code: string, diagnostics: AuthDiagnostics) {
  const body = { error: "Unauthorized", code, ...(config.DEBUG_AUTH ? { diagnostics } : {}) };
  return { status, body };
}

function authLog(message: string, details: Record<string, unknown>) {
  console.info(`[auth] ${message}`, details);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const hasAuthorizationHeader = Boolean(req.headers.authorization);
  const authHeaderStartsWithBearer = req.headers.authorization?.startsWith("Bearer ") ?? false;
  const token = authHeaderStartsWithBearer ? req.headers.authorization?.replace(/^Bearer\s+/i, "") : "";
  const projectRef = supabaseProjectRef();
  const baseDiagnostics = authDiagnostics({ hasAuthHeader: hasAuthorizationHeader, authHeaderStartsWithBearer });
  authLog("request received", { path: req.originalUrl, method: req.method, hasAuthorizationHeader, authHeaderStartsWithBearer, supabaseProjectRef: projectRef, expectedSupabaseProject: hasExpectedSupabaseProjectRef() });
  if (!hasAuthorizationHeader) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "missing_auth_header", hasAuthorizationHeader });
    return res.status(401).json(authError(401, "missing_auth_header", baseDiagnostics).body);
  }
  if (!authHeaderStartsWithBearer || !token) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "invalid_auth_header", hasAuthorizationHeader, authHeaderStartsWithBearer });
    return res.status(401).json(authError(401, "invalid_auth_header", baseDiagnostics).body);
  }
  if (!hasSupabaseUrl()) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "api_missing_supabase_url", hasAuthorizationHeader });
    return res.status(401).json(authError(401, "api_missing_supabase_url", baseDiagnostics).body);
  }
  if (!hasSupabaseServiceKey()) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "api_missing_supabase_service_key", hasAuthorizationHeader });
    return res.status(401).json(authError(401, "api_missing_supabase_service_key", baseDiagnostics).body);
  }
  if (!hasExpectedSupabaseProjectRef()) {
    authLog("request denied", { path: req.originalUrl, statusCode: 503, errorCode: "supabase_project_ref_mismatch", supabaseProjectRef: projectRef });
    return res.status(503).json(authError(503, "api_wrong_supabase_project", baseDiagnostics).body);
  }

  const { user: authUser, errorCode } = await verifyBearerToken(token);
  authLog("token verification result", { path: req.originalUrl, success: Boolean(authUser), errorCode, decodedUserEmail: authUser?.email ?? null });
  if (!authUser) return res.status(401).json(authError(401, errorCode ?? "token_verify_failed", baseDiagnostics).body);
  const normalizedEmail = normalizeEmail(authUser.email);
  if (!normalizedEmail) {
    authLog("request denied", { path: req.originalUrl, statusCode: 401, errorCode: "missing_authenticated_email", decodedUserEmail: authUser.email ?? null });
    return res.status(401).json(authError(401, "token_verify_failed", authDiagnostics({ ...baseDiagnostics, tokenVerified: true })).body);
  }

  const access = await resolveAccess(authUser.id, normalizedEmail);
  const resolvedDiagnostics = authDiagnostics({ ...baseDiagnostics, tokenVerified: true, decodedEmail: normalizedEmail, allowlistPassed: access.allowed });
  authLog("allowlist result", { path: req.originalUrl, allowed: access.allowed, decodedUserEmail: normalizedEmail, role: access.role, isUnlimited: access.isUnlimited, reason: access.reason, allowedUserFound: access.allowedUserFound });
  if (!access.allowed) return res.status(403).json(authError(403, "email_not_allowed", resolvedDiagnostics).body);

  req.user = { id: authUser.id, email: normalizedEmail, role: access.role, isUnlimited: access.isUnlimited, planKey: access.planKey };
  return next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Owner access required" });
  return next();
}

export async function resolveAccess(userId: string, email: string) {
  const normalizedEmail = normalizeEmail(email);

  const supabase = createServiceClient();
  if (!supabase) {
    return { allowed: false, role: "member", planKey: "starter_weekly", isUnlimited: false, reason: "api_missing_supabase_service_key", allowedUserFound: false };
  }

  const isOwnerEmail = normalizedEmail === ownerEmail();
  if (isOwnerEmail) {
    await supabase.from("allowed_users").upsert({ email: normalizedEmail, role: "owner", plan_key: "owner_unlimited", is_unlimited: true, status: "active" });
    await supabase.from("profiles").upsert({ id: userId, email: normalizedEmail, role: "owner", plan_key: "owner_unlimited", is_unlimited: true });
    await supabase.from("credit_balances").upsert({ user_id: userId, is_unlimited: true });
    return { allowed: true, role: "owner", planKey: "owner_unlimited", isUnlimited: true, reason: "owner_email_allowed", allowedUserFound: true };
  }

  const { data, error } = await supabase.from("allowed_users").select("email, role, plan_key, is_unlimited, status").eq("email", normalizedEmail).maybeSingle();
  if (error) {
    return { allowed: false, role: "member", planKey: "starter_weekly", isUnlimited: false, reason: "allowed_user_lookup_failed", allowedUserFound: false };
  }
  if (!data) return { allowed: false, role: "member", planKey: "starter_weekly", isUnlimited: false, reason: "allowed_user_not_found", allowedUserFound: false };

  const status = String(data.status ?? "").trim().toLowerCase();
  if (status !== "active") return { allowed: false, role: data.role ?? "member", planKey: data.plan_key ?? "starter_weekly", isUnlimited: false, reason: "allowed_user_not_active", allowedUserFound: true };

  const role = data.role;
  const planKey = data.plan_key;
  const isUnlimited = Boolean(data.is_unlimited);

  await supabase.from("profiles").upsert({ id: userId, email: normalizedEmail, role, plan_key: planKey, is_unlimited: isUnlimited });
  await supabase.from("credit_balances").upsert({ user_id: userId, is_unlimited: isUnlimited });

  return { allowed: true, role, planKey, isUnlimited, reason: "allowed_user_active", allowedUserFound: true };
}
