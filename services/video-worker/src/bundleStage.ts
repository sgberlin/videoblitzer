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
  readmePath: string;
  normalizedMasterPath: string;
  exports: ExportArtifactWithPath[];
  assets: ExportArtifactWithPath[];
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
      archive.file(artifact.filePath, { name: `clips/landscape_16x9/${artifact.fileName}` });
    }
    for (const asset of input.assets) {
      const folder = typeof asset.metadata?.folder === "string" ? asset.metadata.folder : asset.assetType === "thumbnail" ? "thumbnails" : asset.assetType === "caption" ? "captions/srt" : asset.assetType === "metadata" ? "metadata" : "metadata";
      archive.file(asset.filePath, { name: `${folder}/${asset.fileName}` });
    }
    archive.file(input.clipPlanPath, { name: "clip_plan.json" });
    archive.file(input.manifestPath, { name: "manifest.json" });
    archive.file(input.readmePath, { name: "README.txt" });
    void archive.finalize();
  });
}

export async function bundleStage(input: {
  workdir: string;
  manifest: PackageManifest;
  normalizedMasterPath: string;
  exports: ExportArtifactWithPath[];
  assets: ExportArtifactWithPath[];
  readmeText: string;
}) {
  const zipPath = path.join(input.workdir, "package.zip");
  const readmePath = path.join(input.workdir, "README.txt");
  await writeFile(readmePath, input.readmeText, "utf8");
  await createPackageZip({
    outputPath: zipPath,
    manifest: input.manifest,
    clipPlanPath: path.join(input.workdir, "clip_plan.json"),
    manifestPath: path.join(input.workdir, "manifest.json"),
    readmePath,
    normalizedMasterPath: input.normalizedMasterPath,
    exports: input.exports,
    assets: input.assets,
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
