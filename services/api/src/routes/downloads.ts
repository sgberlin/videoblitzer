import { Router } from "express";
import { stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";

const artifacts: Record<string, { filename: string; label: string }> = {
  "mac-x64": { filename: "VideoBlitzer-Recorder-mac-x64.dmg", label: "macOS Intel DMG" },
  "mac-arm64": { filename: "VideoBlitzer-Recorder-mac-arm64.dmg", label: "macOS Apple Silicon DMG" },
  "windows-x64": { filename: "VideoBlitzer-Recorder-win-x64.exe", label: "Windows x64 installer" },
};

export const downloadsRouter = Router();

downloadsRouter.get("/recorders/:platform", async (req, res) => {
  const artifact = artifacts[req.params.platform];
  if (!artifact) {
    return res.status(400).json({ error: "Unknown recorder installer.", available: Object.keys(artifacts) });
  }

  const filePath = path.join(config.RECORDER_DOWNLOAD_DIR, artifact.filename);
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("Artifact path is not a file.");
    res.setHeader("Content-Type", artifact.filename.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/vnd.microsoft.portable-executable");
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.download(filePath, artifact.filename);
  } catch {
    return res.status(503).json({
      error: `${artifact.label} is not deployed to the API download directory yet.`,
      expectedPath: filePath,
      copyFromBuildArtifact: `apps/desktop-recorder/release/${artifact.filename}`,
    });
  }
});
