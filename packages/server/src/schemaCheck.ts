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
  { table: "actors", column: "managed_agent" },
  { table: "workspaces" },
  { table: "workspaces", column: "public_code" },
  { table: "workspaces", column: "created_by" },
  { table: "workspaces", column: "updated_at" },
  { table: "workspace_members" },
  { table: "workspace_members", column: "role" },
  { table: "channels" },
  { table: "channels", column: "workspace_id" },
  { table: "messages", column: "channel_id" },
  { table: "messages", column: "workspace_id" },
  { table: "message_reactions" },
  { table: "message_reactions", column: "workspace_id" },
  { table: "attachments" },
  { table: "attachments", column: "workspace_id" },
  { table: "attachments", column: "storage_key" },
  { table: "workspace_invites" },
  { table: "workspace_invites", column: "workspace_id" },
  { table: "workspace_invites", column: "token_hash" },
  { table: "workspace_invites", column: "created_by" },
  { table: "workspace_invites", column: "created_at" },
  { table: "workspace_invites", column: "expires_at" },
  { table: "workspace_invites", column: "uses" },
  { table: "workspace_invites", column: "max_uses" },
  { table: "workspace_invites", column: "revoked_at" },
  { table: "workspace_access_requests" },
  { table: "workspace_access_requests", column: "workspace_id" },
  { table: "workspace_access_requests", column: "requester_id" },
  { table: "workspace_access_requests", column: "message" },
  { table: "workspace_access_requests", column: "status" },
  { table: "workspace_access_requests", column: "created_at" },
  { table: "workspace_access_requests", column: "resolved_by" },
  { table: "workspace_access_requests", column: "resolved_at" },
  { table: "board_items", column: "scope_paths" },
  { table: "board_items", column: "capabilities" },
  { table: "board_events" },
  { table: "agent_invites" },
  { table: "thread_events" },
  { table: "agent_conversations" },
  { table: "agent_run_requests" },
  { table: "interaction_requests" },
  { table: "board_plans" },
  { table: "board_plans", column: "clarifications" },
  { table: "ref_counters", column: "plan_n" },
  { table: "board_items", column: "plan_id" },
  { table: "board_items", column: "acceptance_criteria" },
  { table: "board_items", column: "verification_evidence" },
  { table: "board_items", column: "impact_map" },
  { table: "context_entries" },
  { table: "context_cursors" },
  { table: "projects" },
  { table: "projects", column: "access_mode" },
  { table: "git_connections", column: "token_ciphertext" },
  { table: "git_connections", column: "provider_user_id" },
  { table: "git_connections", column: "refresh_token_ciphertext" },
  { table: "git_connections", column: "token_expires_at" },
  { table: "git_repositories", column: "project_id" },
  { table: "git_repositories", column: "workspace_id" },
  { table: "git_repositories", column: "connection_id" },
  { table: "git_repositories", column: "clone_url" },
  { table: "git_repositories", column: "unlinked_at" },
  { table: "git_branch_channels", column: "channel_id" },
  { table: "interaction_requests", column: "target_actor_id" },
  { table: "toolman_nodes" },
  { table: "toolman_pairings" },
  { table: "project_mounts" },
  { table: "project_assignments" },
  { table: "board_items", column: "project_id" },
  { table: "project_access_requests" },
  { table: "tool_executions" },
  { table: "tool_retention_policies" },
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
