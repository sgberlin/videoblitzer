import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { jobRateLimit } from "../middleware/rateLimit";

export const jobsRouter = Router();
jobsRouter.use(requireAuth, jobRateLimit);

jobsRouter.post("/analyze", (req, res) => {
  const body = z.object({ projectId: z.string().uuid() }).parse(req.body);
  return res.status(202).json({ job: { id: crypto.randomUUID(), projectId: body.projectId, type: "analyze", status: "queued", progress: 0 } });
});

jobsRouter.post("/export", (req, res) => {
  const body = z.object({ projectId: z.string().uuid(), presetId: z.string(), cropMode: z.string() }).parse(req.body);
  return res.status(202).json({ job: { id: crypto.randomUUID(), ...body, type: "export", status: "queued", progress: 0 } });
});

jobsRouter.get("/:id", (req, res) => res.json({ job: { id: req.params.id, status: "queued", progress: 0 } }));
jobsRouter.post("/:id/retry", (req, res) => res.json({ job: { id: req.params.id, status: "queued", attempts: 1 } }));
