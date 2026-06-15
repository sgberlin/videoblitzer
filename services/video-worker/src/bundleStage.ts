import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { uploadFileToR2 } from "./packageStorage";
import type { ExportArtifact, PackageManifest } from "./packageTypes";

type ExportArtifactWithPath = ExportArtifact & { filePath: string };

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function createPackageZip(input: {
  outputPath: string;
  manifest: PackageManifest;
  clipPlanPath: string;
  manifestPath: string;
  normalizedMasterPath: string;
  exports: ExportArtifactWithPath[];
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeJson(input.clipPlanPath, input.manifest.clipPlan);
  await writeJson(input.manifestPath, input.manifest);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(input.outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(input.normalizedMasterPath, { name: `master/${input.manifest.normalizedMaster.fileName}` });
    for (const artifact of input.exports) {
      archive.file(artifact.filePath, { name: `exports/${artifact.fileName}` });
    }
    archive.file(input.clipPlanPath, { name: "clip_plan.json" });
    archive.file(input.manifestPath, { name: "manifest.json" });
    void archive.finalize();
  });
}

export async function bundleStage(input: {
  workdir: string;
  manifest: PackageManifest;
  normalizedMasterPath: string;
  exports: ExportArtifactWithPath[];
}) {
  const zipPath = path.join(input.workdir, "package.zip");
  await createPackageZip({
    outputPath: zipPath,
    manifest: input.manifest,
    clipPlanPath: path.join(input.workdir, "clip_plan.json"),
    manifestPath: path.join(input.workdir, "manifest.json"),
    normalizedMasterPath: input.normalizedMasterPath,
    exports: input.exports,
  });
  return { zipPath };
}

export async function uploadPackageZip(input: {
  zipPath: string;
  userId: string;
  projectId: string;
  packageJobId: string;
}) {
  const artifactObjectKey = `packages/${input.userId}/${input.projectId}/${input.packageJobId}.zip`;
  await uploadFileToR2(input.zipPath, artifactObjectKey, "application/zip");
  return artifactObjectKey;
}
