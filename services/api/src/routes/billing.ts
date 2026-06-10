import { Router } from "express";
import { requireAuth } from "../middleware/auth";

export const billingRouter = Router();

billingRouter.post("/stripe/webhook", (req, res) => res.json({ received: true, mode: "placeholder" }));
billingRouter.post("/billing/create-checkout", requireAuth, (req, res) => res.json({ url: null, mode: "private_beta_sales_disabled" }));
billingRouter.post("/billing/create-portal", requireAuth, (req, res) => res.json({ url: null, mode: "stripe_placeholder" }));
