import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dotenv.config() with no path defaults to CWD, but npm workspaces run this
// script with cwd = packages/agent, not the repo root where .env lives. Point
// at it explicitly so `npm run dev` picks up the root .env either way.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const AGENT_NAME = process.env.AGENT_NAME ?? "noodle";
export const WS_URL = process.env.WS_URL ?? "ws://localhost:3001";
/** Join secret for auth-enabled servers; omitted on guest-mode servers. */
export const AGENT_TOKEN = process.env.AGENT_TOKEN;

/** Which LLM backend the agent runs against. */
export const AGENT_PROVIDER: "gemini" | "claude" =
  process.env.AGENT_PROVIDER === "claude" ? "claude" : "gemini";

/** No default on purpose: a missing key must fail loudly at startup (index.ts). Gemini provider only. */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const AGENT_MODEL =
  process.env.AGENT_MODEL ?? (AGENT_PROVIDER === "claude" ? "claude-sonnet-5" : "gemini-2.5-flash");

/**
 * cwd Claude Code's native tools (Bash, Write, Edit, ...) operate in.
 * Mirrors the server's Toolman sandbox root (packages/server/src/index.ts's
 * `path.join(config.dataDir, "workspace")`, server DATA_DIR defaulting to
 * `<repo root>/data`) — not this process's own DATA_DIR below (this agent's
 * private memory/pending-work store). Resolved against __dirname, not
 * process.cwd(), for the same reason CHARTER_PATH is: npm workspaces run
 * this script with cwd = packages/agent, not the repo root.
 */
export const CLAUDE_WORKDIR =
  process.env.CLAUDE_WORKDIR ?? path.resolve(__dirname, "../../../data/workspace");

export const CHARTER_PATH = process.env.CHARTER_PATH ?? path.resolve(__dirname, "../charter.md");
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data", "agents", AGENT_NAME);
