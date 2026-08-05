import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const createdDirs: string[] = [];
process.on("exit", () => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** Fresh throwaway data dir, removed when the test process exits. */
export async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-test-"));
  createdDirs.push(dir);
  return dir;
}

/**
 * Poll until `fn` yields a value. Persistence in this package is a queued
 * async write, so tests observe it at the boundary a restarted agent would
 * use (a fresh load from disk) instead of reaching into the queue.
 */
export async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
