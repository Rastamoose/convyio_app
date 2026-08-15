import os from "node:os";
import path from "node:path";

export function configRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  return path.join(home, "convyio", "toolman");
}

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), ".local", "share");
  return path.join(home, "convyio", "toolman");
}

export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "unnamed";
}
