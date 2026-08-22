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
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const privateKeyInput = process.env.GITHUB_APP_PRIVATE_KEY;
  const callbackUri = process.env.GITHUB_REDIRECT_URI ?? null;
  if (!appId && !slug && !clientId && !clientSecret && !privateKeyInput && !callbackUri) return null;
  if (!appId || !slug || !clientId || !clientSecret || !privateKeyInput) {
    throw new Error("GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and GITHUB_APP_PRIVATE_KEY must be set together");
  }
  if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be numeric");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) throw new Error("GITHUB_APP_SLUG is invalid");
  const privateKey = privateKeyInput.replaceAll("\\n", "\n");
  if (!privateKey.includes("-----BEGIN RSA PRIVATE KEY-----") && !privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be a PEM private key");
  }
  if (callbackUri) {
    const parsed = new URL(callbackUri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("GITHUB_REDIRECT_URI must be an absolute http(s) URL");
  }
  return { appId, slug, clientId, clientSecret, privateKey, callbackUri };
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
  /** Symmetric key (32 bytes, base64) for encrypting pasted API keys at
   *  rest. Optional — only needed by workspaces that use hosted API-key
   *  agents; secretBox throws clearly if used without it. */
  agentSecretKey: process.env.AGENT_SECRET_KEY ?? null,
  github: githubConfig(),
  /** Built client to serve as the single origin; absent = API only (dev). */
  clientDist: process.env.CLIENT_DIST ?? path.resolve(__dirname, "../../client/dist"),
};
