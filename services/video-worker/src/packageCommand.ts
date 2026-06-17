import { spawn } from "node:child_process";

export type CommandProgress = {
  percent: number;
  seconds: number;
};

type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  progressDurationSeconds?: number;
  onProgress?: (progress: CommandProgress) => void | Promise<void>;
};

function progressSeconds(record: Record<string, string>) {
  const raw = record.out_time_us ?? record.out_time_ms;
  const micros = raw ? Number(raw) : NaN;
  if (Number.isFinite(micros) && micros > 0) return micros / 1_000_000;
  const time = record.out_time;
  if (!time) return 0;
  const [hours = "0", minutes = "0", seconds = "0"] = time.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function parseProgressChunk(input: string, state: { buffer: string; record: Record<string, string> }, options: RunCommandOptions) {
  if (!options.onProgress || !options.progressDurationSeconds || options.progressDurationSeconds <= 0) return;
  state.buffer += input;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? "";
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    state.record[key] = value;
    if (key === "progress") {
      const seconds = progressSeconds(state.record);
      const percent = value === "end"
        ? 100
        : Math.min(99, Math.max(0, Math.round((seconds / options.progressDurationSeconds) * 100)));
      void Promise.resolve(options.onProgress({ percent, seconds })).catch(() => undefined);
      state.record = {};
    }
  }
}

export function runCommand(command: string, args: string[], options: RunCommandOptions = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const progressState = { buffer: "", record: {} as Record<string, string> };
    const timeout = options.timeoutMs ? setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s.`));
    }, options.timeoutMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      parseProgressChunk(text, progressState, options);
    });
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
