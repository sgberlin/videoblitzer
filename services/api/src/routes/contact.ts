import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { contactRateLimit } from "../middleware/rateLimit";
import { createServiceClient } from "../supabase";

export const contactRouter = Router();

contactRouter.post("/", contactRateLimit, async (req, res) => {
  const body = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    message: z.string().min(10).max(5000),
    company: z.string().optional(),
    useCase: z.string().optional(),
    website_url: z.string().optional(),
    startedAt: z.number().optional(),
  }).parse(req.body);

  if (body.website_url) return res.status(400).json({ error: "Invalid submission" });
  if (body.startedAt && Date.now() - body.startedAt < 3000) return res.status(429).json({ error: "Please try again" });

  const ipHash = createHash("sha256").update(req.ip ?? "unknown").digest("hex");
  const supabase = createServiceClient();
  if (supabase) {
    await supabase.from("contact_messages").insert({ name: body.name, email: body.email, company: body.company, use_case: body.useCase, message: body.message, ip_hash: ipHash, user_agent: req.headers["user-agent"] });
  }
  return res.status(201).json({ ok: true });
});
