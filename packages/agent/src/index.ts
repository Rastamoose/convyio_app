import fs from "node:fs/promises";
import {
  AGENT_MODEL,
  AGENT_NAME,
  AGENT_PROVIDER,
  AGENT_TOKEN,
  CHARTER_PATH,
  CLAUDE_WORKDIR,
  DATA_DIR,
  GEMINI_API_KEY,
  WS_URL,
} from "./config";
import { HostedUsageLimiter } from "./hostedLimiter";
import { HostedSupervisor, httpUrlFromWs } from "./hostedSupervisor";
import { runAgent } from "./runtime";

async function main(): Promise<void> {
  if (AGENT_PROVIDER === "gemini" && !GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY. Set it in the environment and restart.");
  }
  if (AGENT_PROVIDER === "codex") throw new Error("Codex provider is not yet supported.");
  const charter = await loadCharter();
  if (AGENT_TOKEN) {
    const supervisor = new HostedSupervisor({
      apiUrl: httpUrlFromWs(WS_URL),
      token: AGENT_TOKEN,
      name: AGENT_NAME,
      provider: AGENT_PROVIDER,
      model: AGENT_MODEL,
      geminiApiKey: GEMINI_API_KEY,
      workspace: CLAUDE_WORKDIR,
      dataDir: DATA_DIR,
      charter,
      limiter: new HostedUsageLimiter(),
    });
    const shutdown = () => supervisor.close();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    supervisor.start();
    return;
  }
  await runAgent({
    mode: "legacy",
    name: AGENT_NAME,
    wsUrl: WS_URL,
    token: AGENT_TOKEN,
    provider: AGENT_PROVIDER,
    model: AGENT_MODEL,
    geminiApiKey: GEMINI_API_KEY,
    workspace: CLAUDE_WORKDIR,
    dataDir: DATA_DIR,
    charter,
  });
}

async function loadCharter(): Promise<string> {
  try {
    return await fs.readFile(CHARTER_PATH, "utf8");
  } catch (error) {
    console.warn("[agent] could not load charter, using default prompt:", error);
    return `You are ${AGENT_NAME}, a helpful workspace assistant. Respond only when directly addressed.`;
  }
}

main().catch((error) => {
  console.error("[agent] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
