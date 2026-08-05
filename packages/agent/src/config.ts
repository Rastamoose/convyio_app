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
/** No default on purpose: a missing key must fail loudly at startup (index.ts). */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "gemini-2.5-flash";
export const CHARTER_PATH = process.env.CHARTER_PATH ?? path.resolve(__dirname, "../charter.md");
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data", "agents", AGENT_NAME);
