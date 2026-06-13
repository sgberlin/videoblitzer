import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireOwner } from "../middleware/auth";
import { createServiceClient } from "../supabase";
import { readR2Usage } from "../lib/r2";

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

adminRouter.get("/credits", async (_req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ balances: [], transactions: [] });
  const [balances, transactions] = await Promise.all([
    supabase.from("credit_balances").select("user_id,balance,is_unlimited,updated_at").order("updated_at", { ascending: false }).limit(100),
    supabase.from("credit_transactions").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  const error = balances.error ?? transactions.error;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ balances: balances.data ?? [], transactions: transactions.data ?? [] });
});

adminRouter.post("/credits", async (req, res) => {
  const body = z.object({ userId: z.string().uuid(), amount: z.number().int(), action: z.string().default("admin_adjustment"), metadata: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data: current, error: balanceError } = await supabase.from("credit_balances").select("balance,is_unlimited").eq("user_id", body.userId).maybeSingle();
  if (balanceError) return res.status(500).json({ error: balanceError.message });
  const nextBalance = Math.max(0, (current?.balance ?? 0) + body.amount);
  const { error: upsertError } = await supabase.from("credit_balances").upsert({ user_id: body.userId, balance: nextBalance, is_unlimited: Boolean(current?.is_unlimited), updated_at: new Date().toISOString() });
  if (upsertError) return res.status(500).json({ error: upsertError.message });
  await supabase.from("credit_transactions").insert({ user_id: body.userId, action: body.action, amount: body.amount, balance_after: nextBalance, metadata: body.metadata ?? {} });
  return res.json({ ok: true, balance: nextBalance });
});

adminRouter.get("/jobs", async (_req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ jobs: [] });
  const [jobs, exportJobs] = await Promise.all([
    supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("export_jobs").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  const error = jobs.error ?? exportJobs.error;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ jobs: jobs.data ?? [], exportJobs: exportJobs.data ?? [] });
});

adminRouter.post("/jobs/:id/retry", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.status(503).json({ error: "Supabase service role is required." });
  const { data, error } = await supabase.from("jobs").update({ status: "queued", progress: 0, error: null, attempts: 1, updated_at: new Date().toISOString() }).eq("id", req.params.id).select("*").maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from("export_jobs").update({ status: "queued", error_message: null }).eq("id", req.params.id);
  return res.json({ job: data });
});

adminRouter.get("/storage", async (_req, res) => {
  const metadata = await readR2Usage();
  return res.json({ metadata });
});

adminRouter.get("/imports", async (_req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ imports: [] });
  const { data, error } = await supabase.from("import_audits").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ imports: data ?? [] });
});

adminRouter.get("/logs", async (_req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ logs: [] });
  const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ logs: data ?? [] });
});
