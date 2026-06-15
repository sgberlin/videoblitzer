import { spawn } from "node:child_process";

export function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs ? setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`));
    }, options.timeoutMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
