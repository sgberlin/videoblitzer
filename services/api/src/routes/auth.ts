import { Router } from "express";
import { z } from "zod";
import { resolveAccess } from "../middleware/auth";
import { verifyBearerToken } from "../supabase";

export const authRouter = Router();

authRouter.post("/check-allowed", async (req, res) => {
  const parsed = z.object({ email: z.string().email().optional() }).safeParse(req.body);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const { user: authUser } = await verifyBearerToken(token);
  const email = authUser?.email ?? (parsed.success ? parsed.data.email : undefined);
  if (!authUser?.id || !email) return res.status(401).json({ allowed: false, error: "Valid Supabase session required" });
  const access = await resolveAccess(authUser.id, email);
  return res.json(access);
});
