import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitShortSha() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

await mkdir("dist/renderer", { recursive: true });
await cp("src/renderer/index.html", "dist/renderer/index.html");
await cp("src/renderer/crop-overlay.html", "dist/renderer/crop-overlay.html");
await cp("src/renderer/styles.css", "dist/renderer/styles.css");
const rendererJsPath = "dist/renderer/renderer.js";
const rendererJs = await readFile(rendererJsPath, "utf8");
await writeFile(rendererJsPath, rendererJs.replace(/\nexport \{\};\s*$/, "\n"));
await writeFile("dist/renderer/build-info.js", `window.__VB_BUILD_INFO__ = ${JSON.stringify({
  version: process.env.npm_package_version ?? "0.1.0",
  commit: await gitShortSha(),
  builtAt: new Date().toISOString(),
  environment: process.env.NODE_ENV === "production" ? "packaged" : "dev",
})};\n`);
