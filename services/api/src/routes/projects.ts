import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

projectsRouter.post("/", async (req, res) => {
  const body = z.object({ title: z.string().min(2), homeTeam: z.string().optional(), awayTeam: z.string().optional(), source_type: z.string().optional(), sourceType: z.string().optional() }).parse(req.body);
  const supabase = createServiceClient();
  const sourceType = body.sourceType ?? body.source_type ?? "web_app";
  const project = { id: crypto.randomUUID(), owner_id: req.user!.id, user_id: req.user!.id, title: body.title, home_team: body.homeTeam, away_team: body.awayTeam, source_type: sourceType, status: "draft" };
  if (supabase) {
    const { error } = await supabase.from("projects").insert(project);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from("usage_events").insert({ user_id: req.user!.id, project_id: project.id, event_name: "project_created", metadata: { title: body.title, sourceType } });
  }
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
  if (!supabase) return res.json({ project: null, videos: [], jobs: [], exports: [], matchData: null, thumbnails: [], socialPackages: [] });
  const projectId = req.params.id;
  const [project, videos, jobs, exports, matchData, thumbnails, socialPackages, events] = await Promise.all([
    supabase.from("projects").select("*").eq("id", projectId).eq("owner_id", req.user!.id).maybeSingle(),
    supabase.from("videos").select("*").eq("project_id", projectId).eq("owner_id", req.user!.id).order("created_at", { ascending: false }),
    supabase.from("jobs").select("*").eq("project_id", projectId).eq("user_id", req.user!.id).order("created_at", { ascending: false }),
    supabase.from("exports").select("*").eq("project_id", projectId).eq("user_id", req.user!.id).order("created_at", { ascending: false }),
    supabase.from("match_data").select("*").eq("project_id", projectId).eq("user_id", req.user!.id).maybeSingle(),
    supabase.from("thumbnails").select("*").eq("project_id", projectId).eq("user_id", req.user!.id).order("created_at", { ascending: false }),
    supabase.from("social_packages").select("*").eq("project_id", projectId).eq("user_id", req.user!.id).order("created_at", { ascending: false }),
    supabase.from("match_events").select("*").eq("project_id", projectId).eq("user_id", req.user!.id).order("event_time", { ascending: true }),
  ]);
  if (project.error) return res.status(500).json({ error: project.error.message });
  if (!project.data) return res.status(404).json({ error: "Project not found" });
  const error = videos.error ?? jobs.error ?? exports.error ?? matchData.error ?? thumbnails.error ?? socialPackages.error ?? events.error;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ project: project.data, videos: videos.data ?? [], jobs: jobs.data ?? [], exports: exports.data ?? [], matchData: matchData.data, thumbnails: thumbnails.data ?? [], socialPackages: socialPackages.data ?? [], events: events.data ?? [] });
});

projectsRouter.patch("/:id", async (req, res) => {
  const body = z.object({ title: z.string().min(2).optional(), status: z.string().optional(), homeTeam: z.string().optional(), awayTeam: z.string().optional() }).parse(req.body);
  const update = { title: body.title, status: body.status, home_team: body.homeTeam, away_team: body.awayTeam, updated_at: new Date().toISOString() };
  const supabase = createServiceClient();
  if (supabase) {
    const { error } = await supabase.from("projects").update(update).eq("id", req.params.id).eq("owner_id", req.user!.id);
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.json({ ok: true });
});
