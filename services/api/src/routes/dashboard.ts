import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { readR2Usage } from "../lib/r2";
import { createServiceClient } from "../supabase";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get("/", async (req, res) => {
  const supabase = createServiceClient();
  const profile = {
    id: req.user!.id,
    email: req.user!.email,
    role: req.user!.role,
    planKey: req.user!.planKey,
    isUnlimited: req.user!.isUnlimited,
    isOwner: req.user!.role === "owner",
  };
  const emptyDashboard = async () => ({
    projects: [],
    uploads: [],
    recordings: [],
    message: "No projects yet",
    profile,
    creditBalance: req.user!.isUnlimited ? "Unlimited" : 0,
    recentProjects: [],
    pendingJobs: [],
    failedJobs: [],
    usageEvents: [],
    storage: await readR2Usage(),
  });

  if (!supabase) {
    console.info("[dashboard] response", { statusCode: 200, mode: "empty_no_supabase_service", userEmail: req.user!.email });
    return res.json(await emptyDashboard());
  }

  const [projects, pendingJobs, failedJobs, usageEvents, balance, storage] = await Promise.all([
    supabase.from("projects").select("id,title,status,created_at,updated_at,home_team,away_team").eq("owner_id", req.user!.id).order("updated_at", { ascending: false }).limit(6),
    supabase.from("jobs").select("id,project_id,type,status,progress,created_at,updated_at").eq("user_id", req.user!.id).in("status", ["queued", "processing"]).order("created_at", { ascending: false }).limit(8),
    supabase.from("jobs").select("id,project_id,type,status,error,created_at,updated_at").eq("user_id", req.user!.id).eq("status", "failed").order("updated_at", { ascending: false }).limit(8),
    supabase.from("usage_events").select("id,event_name,project_id,metadata,created_at").eq("user_id", req.user!.id).order("created_at", { ascending: false }).limit(8),
    supabase.from("credit_balances").select("balance,is_unlimited,updated_at").eq("user_id", req.user!.id).maybeSingle(),
    readR2Usage(),
  ]);

  const error = projects.error ?? pendingJobs.error ?? failedJobs.error ?? usageEvents.error ?? balance.error;
  if (error) {
    console.warn("[dashboard] data query failed, returning empty dashboard", { statusCode: 200, errorCode: error.code ?? "dashboard_query_failed", userEmail: req.user!.email });
    return res.json(await emptyDashboard());
  }

  console.info("[dashboard] response", { statusCode: 200, mode: "loaded", userEmail: req.user!.email });
  return res.json({
    projects: projects.data ?? [],
    uploads: [],
    recordings: [],
    message: (projects.data ?? []).length ? "Dashboard loaded" : "No projects yet",
    profile,
    creditBalance: req.user!.isUnlimited || balance.data?.is_unlimited ? "Unlimited" : balance.data?.balance ?? 0,
    recentProjects: projects.data ?? [],
    pendingJobs: pendingJobs.data ?? [],
    failedJobs: failedJobs.data ?? [],
    usageEvents: usageEvents.data ?? [],
    storage,
  });
});
