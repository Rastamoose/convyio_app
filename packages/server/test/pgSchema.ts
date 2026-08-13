import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { WorkspaceDb, type Sql } from "../src/db";

// Mirrors WorkspaceDb.create's bigint parsing so COUNT(*), seq, and
// epoch columns come back as numbers in tests instead of strings.
const bigintType = {
  to: 20,
  from: [20],
  serialize: (x: number) => String(x),
  parse: (x: string) => Number(x),
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");

/**
 * Creates a throwaway Postgres schema, applies every migration file into
 * it, and returns a WorkspaceDb scoped to it — the Postgres analogue of
 * SQLite's `:memory:` database. Each test suite gets total isolation from
 * every other suite and from `public`, and `drop()` leaves nothing behind.
 *
 * To avoid saturating the Supabase session pooler, a single postgres.js
 * client handles schema creation, migrations, and the WorkspaceDb; only
 * the final DROP SCHEMA uses a fresh throwaway client.
 */
export async function createTestDb(options?: {
  beforeMigration: string;
  seed: (sql: Sql) => Promise<void>;
}): Promise<{ db: WorkspaceDb; drop: () => Promise<void> }> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set — tests need a real Postgres connection");
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;

  const sql = postgres(url, {
    connection: { search_path: schema },
    max: 1,
    types: { bigint: bigintType },
  });
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (file === options?.beforeMigration) await options.seed(sql);
    await sql.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"));
  }

  const db = await WorkspaceDb.adopt(sql);

  return {
    db,
    drop: async () => {
      await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
