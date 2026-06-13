import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { readR2Usage } from "../lib/r2";

export const storageRouter = Router();
storageRouter.use(requireAuth);

storageRouter.get("/usage", async (req, res) => {
  const usage = await readR2Usage(req.user!.role === "owner" ? undefined : `uploads/raw/${req.user!.id}/`);
  return res.json({ usage });
});

storageRouter.get("/metadata", async (req, res) => {
  const metadata = await readR2Usage(req.user!.role === "owner" ? undefined : `uploads/raw/${req.user!.id}/`);
  return res.json({ metadata });
});
