import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dotenv.config() with no path defaults to CWD, but npm workspaces run this
// with cwd = packages/server, not the repo root where .env lives. Point at
// it explicitly so `npm run dev` picks up the root .env (Docker Compose
// doesn't need this — it injects .env as real container env vars already).
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — set it in the root .env`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** Sandbox root for the agent's native file/bash tools (Toolman) only —
   *  unrelated to persistence, which now lives entirely in Supabase. */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, "../../../data"),
  /** Single allowed browser origin for the HTTP API (the Vite dev client). */
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  supabaseUrl: required("SUPABASE_URL"),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  supabaseDbUrl: required("SUPABASE_DB_URL"),
  /** Google sign-in itself is configured in the Supabase dashboard, not
   *  here; this only gates whether the client shows the Google button. */
  googleAuthEnabled: process.env.GOOGLE_AUTH_ENABLED === "1",
  /** Email/password sign-in. Neither this nor googleAuthEnabled set = guest mode. */
  emailAuthEnabled: process.env.EMAIL_AUTH === "1",
  /** Shared secret the agent joins with when auth is enabled. */
  agentToken: process.env.AGENT_TOKEN ?? null,
  /** Built client to serve as the single origin; absent = API only (dev). */
  clientDist: process.env.CLIENT_DIST ?? path.resolve(__dirname, "../../client/dist"),
};
