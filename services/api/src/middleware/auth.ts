import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { createServiceClient, verifyBearerToken } from "../supabase";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email?: string; role: string; isUnlimited: boolean; planKey: string };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const authUser = await verifyBearerToken(token);
  if (!authUser?.email) return res.status(401).json({ error: "Unauthorized" });

  const access = await resolveAccess(authUser.id, authUser.email);
  if (!access.allowed) return res.status(403).json({ error: "Private beta access required" });
  if (access.isSuspended) return res.status(403).json({ error: "Account suspended" });

  req.user = { id: authUser.id, email: authUser.email, role: access.role, isUnlimited: access.isUnlimited, planKey: access.planKey };
  return next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Owner access required" });
  return next();
}

export async function resolveAccess(userId: string, email: string) {
  const normalizedEmail = email.toLowerCase();
  if (normalizedEmail === config.OWNER_EMAIL.toLowerCase()) {
    return { allowed: true, isSuspended: false, role: "owner", planKey: "owner_unlimited", isUnlimited: true };
  }

  const supabase = createServiceClient();
  if (!supabase) {
    return { allowed: false, isSuspended: false, role: "member", planKey: "starter_weekly", isUnlimited: false };
  }

  const { data } = await supabase.from("allowed_users").select("role, plan_key, is_unlimited, is_suspended").eq("email", normalizedEmail).maybeSingle();
  if (!data) return { allowed: false, isSuspended: false, role: "member", planKey: "starter_weekly", isUnlimited: false };

  await supabase.from("profiles").upsert({ id: userId, email: normalizedEmail, role: data.role, plan_key: data.plan_key, is_unlimited: data.is_unlimited });
  await supabase.from("credit_balances").upsert({ user_id: userId, is_unlimited: data.is_unlimited });

  return { allowed: true, isSuspended: data.is_suspended, role: data.role, planKey: data.plan_key, isUnlimited: data.is_unlimited };
}
