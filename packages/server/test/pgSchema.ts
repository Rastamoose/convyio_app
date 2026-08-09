import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { WorkspaceDb } from "../src/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../supabase/migrations");

/**
 * Creates a throwaway Postgres schema, applies every migration file into
 * it, and returns a WorkspaceDb scoped to it — the Postgres analogue of
 * SQLite's `:memory:` database. Each test suite gets total isolation from
 * every other suite and from `public`, and `drop()` leaves nothing behind.
 */
export async function createTestDb(): Promise<{ db: WorkspaceDb; drop: () => Promise<void> }> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set — tests need a real Postgres connection");
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;

  const bootstrap = postgres(url, { max: 1 });
  await bootstrap.unsafe(`CREATE SCHEMA "${schema}"`);
  await bootstrap.end();

  const migrator = postgres(url, { connection: { search_path: schema }, max: 1 });
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await migrator.unsafe(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8"));
  }
  await migrator.end();

  const db = await WorkspaceDb.create(url, schema);

  return {
    db,
    drop: async () => {
      await db.close();
      const cleanup = postgres(url, { max: 1 });
      await cleanup.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await cleanup.end();
    },
  };
}
