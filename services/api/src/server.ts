import express from "express";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import { config } from "./config";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { billingRouter } from "./routes/billing";
import { contactRouter } from "./routes/contact";
import { clipPlanningRouter } from "./routes/clipPlanning";
import { dashboardRouter } from "./routes/dashboard";
import { downloadsRouter } from "./routes/downloads";
import { exportsRouter } from "./routes/exports";
import { generationRouter } from "./routes/generation";
import { jobsRouter } from "./routes/jobs";
import { matchIntelligenceRouter } from "./routes/matchIntelligence";
import { matchDataRouter } from "./routes/matchData";
import { packagesRouter } from "./routes/packages";
import { projectsRouter } from "./routes/projects";
import { storageRouter } from "./routes/storage";
import { sourceImportRouter } from "./routes/sourceImport";
import { uploadsRouter } from "./routes/uploads";

const app = express();
app.use(helmet());
const allowedOrigins = new Set([config.APP_URL, "http://localhost:3000", "http://localhost:3001", "file://"]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by VideoBlitzer API CORS policy"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  return res.sendStatus(204);
});
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "videoblitzer-api", product: config.APP_NAME }));
app.use("/auth", authRouter);
app.use("/dashboard", dashboardRouter);
app.use("/downloads", downloadsRouter);
app.use("/projects", projectsRouter);
app.use("/uploads", uploadsRouter);
app.use("/jobs", jobsRouter);
app.use("/packages", packagesRouter);
app.use("/exports", exportsRouter);
app.use("/match-intelligence", matchIntelligenceRouter);
app.use("/match-data", matchDataRouter);
app.use("/storage", storageRouter);
app.use("/source-import", sourceImportRouter);
app.use("/clip-planning", clipPlanningRouter);
app.use(generationRouter);
app.use("/contact", contactRouter);
app.use(billingRouter);
app.use("/admin", adminRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal server error";
  if (error instanceof ZodError) return res.status(400).json({ error: "Validation failed", details: error.issues });
  const lower = message.toLowerCase();
  if (lower.includes("insufficient credits")) return res.status(402).json({ error: message, code: "insufficient_credits" });
  if (lower.includes("unauthorized") || lower.includes("auth")) return res.status(401).json({ error: message });
  if (lower.includes("owner access") || lower.includes("forbidden")) return res.status(403).json({ error: message });
  return res.status(500).json({ error: message });
});

app.listen(config.PORT, () => {
  console.info("[startup] env", {
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasSupabaseSecretKey: Boolean(process.env.SUPABASE_SECRET_KEY),
    hasSupabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    ownerEmail: process.env.OWNER_EMAIL || "gizlenweb@gmail.com",
  });
  console.log(`VideoBlitzer API listening on ${config.PORT}`);
});
