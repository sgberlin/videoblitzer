import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { billingRouter } from "./routes/billing";
import { contactRouter } from "./routes/contact";
import { dashboardRouter } from "./routes/dashboard";
import { exportsRouter } from "./routes/exports";
import { generationRouter } from "./routes/generation";
import { jobsRouter } from "./routes/jobs";
import { matchIntelligenceRouter } from "./routes/matchIntelligence";
import { matchDataRouter } from "./routes/matchData";
import { projectsRouter } from "./routes/projects";
import { storageRouter } from "./routes/storage";
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
}));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "videoblitzer-api", product: config.APP_NAME }));
app.use("/auth", authRouter);
app.use("/dashboard", dashboardRouter);
app.use("/projects", projectsRouter);
app.use("/uploads", uploadsRouter);
app.use("/jobs", jobsRouter);
app.use("/exports", exportsRouter);
app.use("/match-intelligence", matchIntelligenceRouter);
app.use("/match-data", matchDataRouter);
app.use("/storage", storageRouter);
app.use(generationRouter);
app.use("/contact", contactRouter);
app.use(billingRouter);
app.use("/admin", adminRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Internal server error";
  res.status(400).json({ error: message });
});

app.listen(config.PORT, () => {
  console.log(`VideoBlitzer API listening on ${config.PORT}`);
});
