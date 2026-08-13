import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { assertSchemaCurrent, SchemaOutOfDateError } from "../src/schemaCheck";
import { createTestDb } from "./pgSchema";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

describe("schema check", () => {
  test("the migrations satisfy everything the code requires", async () => {
    // createTestDb applies every migration in order, so this fails the moment
    // the code needs something no migration creates.
    const { db, drop } = await createTestDb();
    try {
      await assertSchemaCurrent(db.sql, MIGRATIONS_DIR);
    } finally {
      await drop();
    }
  });

  test("a database behind the code is refused, naming what is missing", async () => {
    const { db, drop } = await createTestDb();
    try {
      // Stand in for a database that never ran the newest migration.
      await db.sql`DROP TABLE interaction_requests`;
      await assert.rejects(
        () => assertSchemaCurrent(db.sql, MIGRATIONS_DIR),
        (err: unknown) => {
          assert.ok(err instanceof SchemaOutOfDateError);
          assert.match(err.message, /interaction_requests/);
          // The message has to carry the fix, not just the symptom.
          assert.match(err.message, /supabase db push/);
          return true;
        },
      );
    } finally {
      await drop();
    }
  });
});
