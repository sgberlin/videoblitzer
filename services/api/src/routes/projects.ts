import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

projectsRouter.post("/", async (req, res) => {
  const body = z.object({ title: z.string().min(2), homeTeam: z.string().optional(), awayTeam: z.string().optional() }).parse(req.body);
  const supabase = createServiceClient();
  const project = { id: crypto.randomUUID(), owner_id: req.user!.id, title: body.title, home_team: body.homeTeam, away_team: body.awayTeam, status: "draft" };
  if (supabase) await supabase.from("projects").insert(project);
  return res.status(201).json({ project });
});

projectsRouter.get("/", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ projects: [] });
  const { data, error } = await supabase.from("projects").select("*").eq("owner_id", req.user!.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ projects: data });
});

projectsRouter.get("/:id", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ project: null });
  const { data, error } = await supabase.from("projects").select("*").eq("id", req.params.id).eq("owner_id", req.user!.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Project not found" });
  return res.json({ project: data });
});

projectsRouter.patch("/:id", async (req, res) => {
  const body = z.object({ title: z.string().min(2).optional(), status: z.string().optional() }).parse(req.body);
  const supabase = createServiceClient();
  if (supabase) await supabase.from("projects").update(body).eq("id", req.params.id).eq("owner_id", req.user!.id);
  return res.json({ ok: true });
});
