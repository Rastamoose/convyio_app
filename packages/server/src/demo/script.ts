import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Demo scripts are data, not code: one JSON file per channel under
 * assets/demo/scripts, validated here at load so a malformed script fails at
 * boot instead of mid-playback.
 */

const stepSchema = z.object({
  author: z.string().min(1),
  /** Message text; "{agent}" is replaced with the online agent's name. */
  say: z.string().min(1),
  await: z.enum(["agent_reply", "approve_proposal", "accept_plan"]).optional(),
});

const scriptSchema = z
  .object({
    channel: z.string().min(1).max(64),
    personas: z.array(z.string().min(1)).min(1),
    /** Fixture tree under assets/demo/seed to copy into the workspace. */
    seedDir: z.string().min(1).optional(),
    steps: z.array(stepSchema).min(1),
  })
  .refine(
    (script) => script.steps.every((s) => script.personas.includes(s.author)),
    { message: "every step author must be listed in personas" },
  );

export type DemoStep = z.infer<typeof stepSchema>;
export type DemoScript = z.infer<typeof scriptSchema>;

/** Load and validate every script in the directory, keyed by channel. */
export async function loadDemoScripts(scriptsDir: string): Promise<Map<string, DemoScript>> {
  const scripts = new Map<string, DemoScript>();
  const entries = await fs.readdir(scriptsDir);
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const file = path.join(scriptsDir, entry);
    const script = scriptSchema.parse(JSON.parse(await fs.readFile(file, "utf-8")));
    if (scripts.has(script.channel)) {
      throw new Error(`duplicate demo script for channel ${script.channel} (${entry})`);
    }
    scripts.set(script.channel, script);
  }
  return scripts;
}
