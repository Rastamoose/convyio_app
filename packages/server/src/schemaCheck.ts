import fs from "node:fs";
import path from "node:path";
import type { Sql } from "./db";

/**
 * Tables and columns the running code needs. A migration that adds one adds a
 * line here in the same change.
 *
 * This exists because a database a few migrations behind does not fail
 * honestly: the server starts, then individual features throw at the moment
 * they are used, and in the browser that surfaces as an endless "Connecting…"
 * with nothing to read. Checking at boot turns a confusing runtime failure
 * into one accurate line before anything serves.
 */
const REQUIRED: readonly { table: string; column?: string }[] = [
  { table: "actors" },
  { table: "workspaces" },
  { table: "workspace_members" },
  { table: "channels" },
  { table: "messages", column: "channel_id" },
  { table: "message_reactions" },
  { table: "attachments" },
  { table: "board_items", column: "scope_paths" },
  { table: "board_items", column: "capabilities" },
  { table: "board_events" },
  { table: "agent_invites" },
  { table: "thread_events" },
  { table: "agent_conversations" },
  { table: "agent_run_requests" },
  { table: "interaction_requests" },
  { table: "board_plans" },
  { table: "board_items", column: "plan_id" },
  { table: "board_items", column: "acceptance_criteria" },
  { table: "board_items", column: "verification_evidence" },
  { table: "context_entries" },
  { table: "context_cursors" },
];

export class SchemaOutOfDateError extends Error {}

/**
 * Throws if the database is missing anything the code requires. The message
 * names what is missing and how to fix it, because "relation does not exist"
 * three layers down a stack trace does not.
 */
export async function assertSchemaCurrent(sql: Sql, migrationsDir: string): Promise<void> {
  const present = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
  `;
  const tables = new Set(present.map((row) => row.table_name));
  const columns = new Set(present.map((row) => `${row.table_name}.${row.column_name}`));

  const missing = REQUIRED.filter(({ table, column }) =>
    column ? !columns.has(`${table}.${column}`) : !tables.has(table),
  ).map(({ table, column }) => (column ? `${table}.${column}` : table));

  if (missing.length === 0) return;

  const available = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];
  const latest = available.at(-1);
  throw new SchemaOutOfDateError(
    `database schema is behind the code — missing: ${missing.join(", ")}.\n` +
      `Apply the migrations in ${path.relative(process.cwd(), migrationsDir)}` +
      (latest ? ` (latest is ${latest})` : "") +
      `:\n  npx supabase db push\n` +
      `If this is a local database you can rebuild, npm run db:wipe also works.`,
  );
}
