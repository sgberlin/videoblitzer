import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { readR2Usage } from "../lib/r2";

export const storageRouter = Router();
storageRouter.use(requireAuth);

storageRouter.get("/usage", async (_req, res) => {
  const usage = await readR2Usage();
  return res.json({ usage });
});

storageRouter.get("/metadata", async (_req, res) => {
  const metadata = await readR2Usage();
  return res.json({ metadata });
});
