import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Demo scripts are data, not code: one JSON file per channel under
 * assets/demo/scripts, validated here at load so a malformed script fails at
 * boot instead of mid-playback.
 */

const stepSchema = z
  .object({
    kind: z.enum(["message", "gate", "action"]).default("message"),
    author: z.string().min(1).optional(),
    /** Message text; "{agent}" is replaced with the online agent's name. */
    say: z.string().min(1).optional(),
    await: z.enum(["agent_reply", "approve_proposal", "accept_plan"]).optional(),
    gate: z.enum(["continue", "accept_plan", "approve_ticket"]).optional(),
    prompt: z.string().min(1).max(240).optional(),
    action: z.enum(["propose_plan", "add_constraint", "correct_plan", "propose_ticket", "execute"]).optional(),
    actor: z.string().min(1).optional(),
    constraint: z.string().min(1).optional(),
  })
  .refine(
    (step) => {
      if (step.kind === "message") return step.author !== undefined && step.say !== undefined;
      if (step.kind === "gate") return step.gate !== undefined;
      if (step.kind === "action") return step.action !== undefined;
      return true;
    },
    { message: "step fields do not match kind" },
  );

const scriptSchema = z
  .object({
    channel: z.string().min(1).max(64),
    mode: z.enum(["live", "walkthrough"]).default("live"),
    personas: z.array(z.string().min(1)).min(1),
    agents: z.array(z.string().min(1)).default([]),
    /** Fixture tree under assets/demo/seed to copy into the workspace. */
    seedDir: z.string().min(1).optional(),
    steps: z.array(stepSchema).min(1),
  })
  .refine(
    (script) =>
      script.steps.every((s) =>
        s.kind !== "message" || script.personas.includes(s.author!) || script.agents.includes(s.author!),
      ),
    { message: "every message author must be listed in personas or agents" },
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
