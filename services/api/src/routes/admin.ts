import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireOwner } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireOwner);

adminRouter.get("/users", async (_req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ users: [] });
  const { data } = await supabase.from("allowed_users").select("*").order("invited_at", { ascending: false });
  return res.json({ users: data ?? [] });
});

adminRouter.post("/users", async (req, res) => {
  const body = z.object({ email: z.string().email(), role: z.enum(["owner", "admin", "member"]).default("member"), planKey: z.string().default("starter_weekly"), isUnlimited: z.boolean().default(false) }).parse(req.body);
  const supabase = createServiceClient();
  if (supabase) await supabase.from("allowed_users").upsert({ email: body.email.trim().toLowerCase(), role: body.role, plan_key: body.planKey, is_unlimited: body.isUnlimited, status: "active" });
  return res.status(201).json({ ok: true });
});

adminRouter.delete("/users/:email", async (req, res) => {
  const supabase = createServiceClient();
  if (supabase) await supabase.from("allowed_users").delete().eq("email", req.params.email.toLowerCase());
  return res.json({ ok: true });
});

adminRouter.get("/jobs", (_req, res) => res.json({ jobs: [] }));
adminRouter.get("/storage", (_req, res) => res.json({ bucket: "videoblitzer-videos", usageBytes: null }));
adminRouter.get("/logs", (_req, res) => res.json({ logs: [] }));
