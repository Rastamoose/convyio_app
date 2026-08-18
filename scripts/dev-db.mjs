// Local dev Postgres for networks that block outbound 5432 (see AGENTS.md:
// the Supabase pooler is unreachable from some locked-down networks). Starts
// an embedded Postgres 17 cluster under data/dev-db/ (gitignored, persistent)
// and applies supabase/migrations/*.sql — the same files `npx supabase db
// push` applies to the real database. Auth and Storage still use real
// Supabase over HTTPS; only the Postgres connection moves local.
//
// Usage: npm run dev:db (leave running), then point SUPABASE_DB_URL in .env
// at the URL it prints and run npm run dev as usual.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data/dev-db");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const PORT = 55432;
const USER = "postgres";
const PASSWORD = "postgres";
const URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/postgres`;

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
  console.log(`[dev-db] initialising a new Postgres cluster in ${path.relative(ROOT, DATA_DIR)}`);
  await pg.initialise();
}

await pg.start();
console.log(`[dev-db] postgres listening on localhost:${PORT}`);

// `_dev_migrations` is a local-only convenience — Supabase itself tracks
// applied files on the real database, so this table never exists there.
const sql = postgres(URL, { max: 1 });
await sql`
  CREATE TABLE IF NOT EXISTS _dev_migrations (
    file text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;
const applied = new Set((await sql`SELECT file FROM _dev_migrations`).map((row) => row.file));
const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) {
  if (applied.has(file)) continue;
  await sql.begin(async (tx) => {
    await tx.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"));
    await tx`INSERT INTO _dev_migrations (file) VALUES (${file})`;
  });
  console.log(`[dev-db] applied ${file}`);
}
if (files.every((f) => applied.has(f))) console.log("[dev-db] schema already current");

console.log(`\n[dev-db] set this in .env, then run npm run dev:\n\n  SUPABASE_DB_URL=${URL}\n`);
console.log("[dev-db] running until Ctrl+C");

await new Promise((resolve) => {
  process.on("SIGINT", resolve);
  process.on("SIGTERM", resolve);
});
await sql.end();
await pg.stop();
