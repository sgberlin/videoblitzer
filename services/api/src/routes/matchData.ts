import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createServiceClient } from "../supabase";

export const matchDataRouter = Router();
matchDataRouter.use(requireAuth);

matchDataRouter.post("/confirm", async (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), data: z.record(z.string(), z.unknown()) }).parse(req.body);
  const supabase = createServiceClient();
  if (supabase) await supabase.from("match_data").upsert({ project_id: body.projectId, user_id: req.user!.id, data: body.data, confirmed: true });
  return res.json({ ok: true, confirmed: true });
});

matchDataRouter.get("/:projectId", async (req, res) => {
  const supabase = createServiceClient();
  if (!supabase) return res.json({ data: null });
  const { data } = await supabase.from("match_data").select("*").eq("project_id", req.params.projectId).eq("user_id", req.user!.id).maybeSingle();
  return res.json({ data });
});
