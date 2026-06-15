import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackageZip } from "../src/bundleStage";
import type { PackageManifest } from "../src/packageTypes";

const workdir = await mkdtemp(path.join(tmpdir(), "videoblitzer-package-smoke-"));

try {
  const masterPath = path.join(workdir, "normalized-master.mp4");
  const exportsDir = path.join(workdir, "exports");
  const exportPath = path.join(exportsDir, "youtube_16_9_1080p.mp4");
  const zipPath = path.join(workdir, "package.zip");

  await mkdir(exportsDir, { recursive: true });
  await writeFile(masterPath, Buffer.from("synthetic normalized master"));
  await writeFile(exportPath, Buffer.from("synthetic export"));

  const manifest: PackageManifest = {
    packageJobId: "00000000-0000-0000-0000-000000000001",
    projectId: "00000000-0000-0000-0000-000000000002",
    videoId: "00000000-0000-0000-0000-000000000003",
    sourceObjectKey: "uploads/raw/test/source.mp4",
    generatedAt: new Date().toISOString(),
    analysis: { durationSeconds: 12 },
    normalizedMaster: {
      objectKey: "packages/masters/test/normalized-master.mp4",
      fileName: "normalized-master.mp4",
    },
    clipPlan: [{ id: "auto-1", startSeconds: 0, endSeconds: 12, label: "Auto moment 1" }],
    exports: [{
      presetId: "youtube_16_9_1080p",
      label: "YouTube 16:9 1080p",
      objectKey: "packages/exports/test/youtube_16_9_1080p.mp4",
      fileName: "youtube_16_9_1080p.mp4",
      width: 1920,
      height: 1080,
      target: "YouTube",
    }],
    socialPackage: { packageSummary: "Smoke package" },
  };

  await createPackageZip({
    outputPath: zipPath,
    manifest,
    clipPlanPath: path.join(workdir, "clip_plan.json"),
    manifestPath: path.join(workdir, "manifest.json"),
    normalizedMasterPath: masterPath,
    exports: [{ ...manifest.exports[0]!, filePath: exportPath }],
  });

  const artifact = await stat(zipPath);
  if (artifact.size <= 0) throw new Error("Package smoke artifact is empty.");
  console.log(`Package artifact smoke passed: ${zipPath} (${artifact.size} bytes)`);
} finally {
  await rm(workdir, { recursive: true, force: true });
}
