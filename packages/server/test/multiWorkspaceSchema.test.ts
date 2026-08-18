import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTestDb } from "./pgSchema";

const MIGRATION = "20260816200000_multi_workspace_foundation.sql";

function hasPostgresCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === code
  );
}

describe("multi-workspace schema foundation", () => {
  test("a fresh schema scopes channel names and message relationships by workspace", async () => {
    const { db, drop } = await createTestDb();
    try {
      const [firstWorkspace] = await db.sql<
        { id: string; name: string; public_code: string; updated_at: number }[]
      >`SELECT id, name, public_code, updated_at FROM workspaces WHERE id = ${db.workspaceId}`;
      assert.match(firstWorkspace.public_code, /^CV-[0-9A-F]{10}$/);
      assert.ok(firstWorkspace.updated_at > 0);

      const secondWorkspaceId = "workspace-two";
      await db.sql`
        INSERT INTO workspaces (id, name, created_at)
        VALUES (${secondWorkspaceId}, ${firstWorkspace.name}, 2000)
      `;
      const [secondWorkspace] = await db.sql<{ public_code: string }[]>`
        SELECT public_code FROM workspaces WHERE id = ${secondWorkspaceId}
      `;
      assert.notEqual(secondWorkspace.public_code, firstWorkspace.public_code);

      await db.sql`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('schema-human', 'human', 'Schema Human')
      `;
      await db.sql`
        INSERT INTO workspace_members (workspace_id, actor_id, joined_at, role)
        VALUES (${db.workspaceId}, 'schema-human', 2000, 'owner')
      `;
      await db.sql`
        INSERT INTO channels (id, workspace_id, name, created_at)
        VALUES
          ('channel-one', ${db.workspaceId}, 'general', 2000),
          ('channel-two', ${secondWorkspaceId}, 'general', 2000)
      `;

      const [{ count }] = await db.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM channels WHERE lower(name) = 'general'
      `;
      assert.equal(count, 2);
      await assert.rejects(
        () => db.sql`
          INSERT INTO channels (id, workspace_id, name, created_at)
          VALUES ('channel-one-duplicate', ${db.workspaceId}, 'GENERAL', 2001)
        `,
        (error) => hasPostgresCode(error, "23505"),
      );

      await db.sql`
        INSERT INTO messages
          (id, workspace_id, author_id, author_name, author_kind, content,
           channel, channel_id, created_at)
        VALUES
          ('matching-message', ${secondWorkspaceId}, 'schema-human', 'Schema Human',
           'human', 'valid', 'general', 'channel-two', 2000)
      `;
      await assert.rejects(
        () => db.sql`
          INSERT INTO messages
            (id, workspace_id, author_id, author_name, author_kind, content,
             channel, channel_id, created_at)
          VALUES
            ('cross-workspace-message', ${secondWorkspaceId}, 'schema-human', 'Schema Human',
             'human', 'invalid', 'general', 'channel-one', 2001)
        `,
        (error) => hasPostgresCode(error, "23503"),
      );
    } finally {
      await drop();
    }
  });

  test("an existing single workspace is backfilled without losing chat data", async () => {
    const { db, drop } = await createTestDb({
      beforeMigration: MIGRATION,
      seed: async (sql) => {
        await sql`
          INSERT INTO workspaces (id, name, created_at)
          VALUES ('legacy-workspace', 'Legacy', 1000)
        `;
        await sql`
          INSERT INTO actors (id, kind, display_name, email)
          VALUES
            ('legacy-human', 'human', 'Legacy Human', 'legacy@example.com'),
            ('legacy-agent', 'agent', 'Legacy Agent', NULL)
        `;
        await sql`
          INSERT INTO workspace_members (workspace_id, actor_id, joined_at)
          VALUES
            ('legacy-workspace', 'legacy-human', 1000),
            ('legacy-workspace', 'legacy-agent', 1001)
        `;
        await sql`
          INSERT INTO channels (id, name, created_at)
          VALUES ('legacy-channel', 'general', 1000)
        `;
        await sql`
          INSERT INTO messages
            (id, author_id, author_name, author_kind, content, channel, channel_id, created_at)
          VALUES
            ('legacy-message', 'legacy-human', 'Legacy Human', 'human',
             'preserve me', 'general', 'legacy-channel', 1002)
        `;
        await sql`
          INSERT INTO message_reactions
            (message_id, emoji, actor_id, actor_name, created_at)
          VALUES ('legacy-message', 'thumbs-up', 'legacy-agent', 'Legacy Agent', 1003)
        `;
        await sql`
          INSERT INTO attachments
            (id, uploader_id, message_id, name, mime, size, created_at)
          VALUES
            ('legacy-attachment', 'legacy-human', 'legacy-message',
             'note.txt', 'text/plain', 11, 1004)
        `;
      },
    });

    try {
      const [workspace] = await db.sql<
        { public_code: string; created_by: string | null; updated_at: number }[]
      >`
        SELECT public_code, created_by, updated_at
        FROM workspaces WHERE id = 'legacy-workspace'
      `;
      assert.match(workspace.public_code, /^CV-[0-9A-F]{10}$/);
      assert.equal(workspace.created_by, null);
      assert.equal(workspace.updated_at, 1000);

      const members = await db.sql<{ actor_id: string; role: string }[]>`
        SELECT actor_id, role FROM workspace_members ORDER BY actor_id
      `;
      assert.deepEqual([...members], [
        { actor_id: "legacy-agent", role: "member" },
        { actor_id: "legacy-human", role: "owner" },
        { actor_id: "managed-agent:noodle:legacy-workspace", role: "member" },
      ]);

      const workspaceRows = await db.sql<{ relation: string; workspace_id: string }[]>`
        SELECT 'attachments' AS relation, workspace_id FROM attachments
        UNION ALL
        SELECT 'channels' AS relation, workspace_id FROM channels
        UNION ALL
        SELECT 'message_reactions' AS relation, workspace_id FROM message_reactions
        UNION ALL
        SELECT 'messages' AS relation, workspace_id FROM messages
        ORDER BY relation
      `;
      assert.deepEqual([...workspaceRows], [
        { relation: "attachments", workspace_id: "legacy-workspace" },
        { relation: "channels", workspace_id: "legacy-workspace" },
        { relation: "message_reactions", workspace_id: "legacy-workspace" },
        { relation: "messages", workspace_id: "legacy-workspace" },
        { relation: "messages", workspace_id: "legacy-workspace" },
        { relation: "messages", workspace_id: "legacy-workspace" },
        { relation: "messages", workspace_id: "legacy-workspace" },
      ]);
      const [attachment] = await db.sql<{ storage_key: string }[]>`
        SELECT storage_key FROM attachments WHERE id = 'legacy-attachment'
      `;
      assert.equal(attachment.storage_key, "legacy-attachment");
    } finally {
      await drop();
    }
  });
});
