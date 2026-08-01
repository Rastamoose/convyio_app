import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const AGENT_NAME = process.env.AGENT_NAME ?? "noodle";
export const WS_URL = process.env.WS_URL ?? "ws://localhost:3001";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
export const CHARTER_PATH = process.env.CHARTER_PATH ?? path.resolve(__dirname, "../charter.md");
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data", "agents", AGENT_NAME);
