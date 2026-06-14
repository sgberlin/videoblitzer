const { execFileSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const removeArch = context.appOutDir.endsWith("mac-arm64") ? "x64" : "arm64";
  for (const packageName of ["ffmpeg-static", "ffprobe-static"]) {
    rmSync(path.join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules", packageName, "bin", "darwin", removeArch), { recursive: true, force: true });
  }
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Delete :ElectronAsarIntegrity", plistPath], { stdio: "ignore" });
  } catch {
    // Older electron-builder output may not include this key.
  }
};
