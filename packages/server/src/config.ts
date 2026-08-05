import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, "../../../data"),
  /** Single allowed browser origin for the HTTP API (the Vite dev client). */
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  /** Google OAuth client id. Set = Google sign-in required; null = guest mode. */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  /** Shared secret the agent joins with when auth is enabled. */
  agentToken: process.env.AGENT_TOKEN ?? null,
};
