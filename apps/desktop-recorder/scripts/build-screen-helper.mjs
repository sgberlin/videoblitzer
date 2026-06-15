import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

const outputDir = path.resolve("dist/native");
await mkdir(outputDir, { recursive: true });

if (process.platform !== "darwin") {
  console.log("Skipping ScreenCaptureKit helper build: native mac capture helper only builds on macOS.");
  process.exit(0);
}

await run("xcrun", [
  "swiftc",
  "-O",
  "-framework",
  "ScreenCaptureKit",
  "-framework",
  "AVFoundation",
  "-framework",
  "AppKit",
  "native/screencapturekit-helper/ScreenCaptureKitRecorder.swift",
  "-o",
  path.join(outputDir, "VideoBlitzerScreenCapture"),
]);
