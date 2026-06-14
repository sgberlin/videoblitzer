import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const startupLogPath = path.join(os.homedir(), "Library", "Logs", "VideoBlitzer", "recorder.log");

function logBootstrap(message: string, details?: Record<string, unknown>) {
  try {
    mkdirSync(path.dirname(startupLogPath), { recursive: true });
    appendFileSync(startupLogPath, `${new Date().toISOString()} ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`);
  } catch {
    // Keep bootstrap logging best-effort.
  }
}

logBootstrap("bootstrap loaded", { cwd: process.cwd(), argv: process.argv });

try {
  require("./main.js");
  logBootstrap("main required from bootstrap");
} catch (error) {
  logBootstrap("main require failed", { message: error instanceof Error ? error.stack ?? error.message : String(error) });
  throw error;
}
