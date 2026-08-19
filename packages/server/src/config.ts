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

function githubConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const encryption = process.env.GIT_CREDENTIAL_ENCRYPTION_KEY;
  const redirectUri = process.env.GITHUB_REDIRECT_URI ?? null;
  if (!clientId && !clientSecret && !encryption && !redirectUri) return null;
  if (!clientId || !clientSecret || !encryption) {
    throw new Error("GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and GIT_CREDENTIAL_ENCRYPTION_KEY must be set together");
  }
  const encryptionKey = /^[a-f\d]{64}$/i.test(encryption)
    ? Buffer.from(encryption, "hex")
    : Buffer.from(encryption, "base64url");
  if (encryptionKey.length !== 32) throw new Error("GIT_CREDENTIAL_ENCRYPTION_KEY must encode exactly 32 bytes");
  if (redirectUri) {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("GITHUB_REDIRECT_URI must be an absolute http(s) URL");
  }
  return { clientId, clientSecret, encryptionKey, redirectUri };
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  /** Root for workspace sandboxes and managed Git checkouts. Database records
   *  and uploads remain in Supabase. */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, "../../../data"),
  /** CORS origin for the HTTP API. In dev, the Vite client can end up on
   *   any localhost port (5173, 5174, …), so the default mirrors any
   *   localhost origin. Set CORS_ORIGIN explicitly for production (one
   *   origin) or to a specific port in dev if you need it locked. */
  corsOrigin: process.env.CORS_ORIGIN ?? "localhost-dev",
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
  github: githubConfig(),
  /** Built client to serve as the single origin; absent = API only (dev). */
  clientDist: process.env.CLIENT_DIST ?? path.resolve(__dirname, "../../client/dist"),
};
