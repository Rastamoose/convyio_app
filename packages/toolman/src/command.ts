import { spawn } from "node:child_process";
import { LIVE_OUTPUT_PREVIEW_BYTES, MAX_COMMAND_OUTPUT_BYTES } from "@workspace/shared";

export const COMMAND_TIMEOUT_MS = 120_000;

export interface CommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface RunningCommand {
  promise: Promise<CommandResult>;
  cancel(): void;
}

export function runCommand(
  cwd: string,
  command: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    onChunk?: (chunk: string) => void;
    extraEnv?: Record<string, string | undefined>;
  } = {},
): RunningCommand {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_COMMAND_OUTPUT_BYTES;
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    env: sanitizedEnv(options.extraEnv),
    detached: true,
  });
  let cancelled = false;
  let timedOut = false;
  let truncated = false;
  let collected = "";
  let collectedBytes = 0;

  const append = (chunk: Buffer) => {
    if (truncated) return;
    const next = chunk.toString("utf8");
    const nextBytes = Buffer.byteLength(next);
    if (collectedBytes + nextBytes > maxBytes) {
      const remaining = Math.max(0, maxBytes - collectedBytes);
      collected += next.slice(0, remaining);
      collectedBytes += remaining;
      truncated = true;
      options.onChunk?.(next.slice(0, Math.min(remaining, LIVE_OUTPUT_PREVIEW_BYTES)));
      return;
    }
    collected += next;
    collectedBytes += nextBytes;
    options.onChunk?.(next.slice(0, LIVE_OUTPUT_PREVIEW_BYTES));
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const promise = new Promise<CommandResult>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut || cancelled ? null : code,
        output: collected,
        truncated,
        timedOut,
        cancelled,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        output: collected || error.message,
        truncated,
        timedOut,
        cancelled,
      });
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      killTree(child.pid);
    },
  };
}

function sanitizedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "USER", "LOGNAME", "SHELL"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && !/TOKEN|SECRET|PASSWORD|KEY/i.test(key)) env[key] = value;
  }
  return env;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
