import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AccountStore, type AccountIdentity } from "../src/auth/AccountStore";
import { WorkspaceAccess } from "../src/auth/WorkspaceAccess";
import { ApiError } from "../src/board/BoardService";
import { noodleWelcomeMessages } from "../src/managedAgents";
import { createTestDb } from "./pgSchema";

const REUSABLE_INVITES_MIGRATION = "20260816210000_reusable_workspace_invites.sql";
const MANAGED_NOODLE_MIGRATION = "20260818120000_managed_noodle.sql";

describe("workspace access lifecycle", () => {
  let drop: () => Promise<void>;
  let accounts: AccountStore;
  let access: WorkspaceAccess;
  let owner: AccountIdentity;
  let requester: AccountIdentity;

  before(async () => {
    const testDb = await createTestDb();
    drop = testDb.drop;
    accounts = new AccountStore(testDb.db.sql);
    access = new WorkspaceAccess(testDb.db.sql, accounts);
    owner = await accounts.createHuman("access-owner", "access-owner", "owner@example.com");
    requester = await accounts.createHuman("access-requester", "access-requester", "requester@example.com");
  });

  after(async () => drop());

  test("new workspaces atomically include noodle and his welcome messages", async () => {
    const workspace = await access.createWorkspace(owner, "Noodle Welcome");
    const [noodle] = await accounts.sql<{
      id: string;
      display_name: string;
      managed_agent: string;
      role: string;
    }[]>`
      SELECT a.id, a.display_name, a.managed_agent, m.role
      FROM workspace_members m
      JOIN actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${workspace.id} AND a.managed_agent = 'noodle'
    `;
    assert.ok(noodle);
    assert.equal(noodle.display_name, "noodle");
    assert.equal(noodle.role, "member");

    const messages = await accounts.sql<{ content: string; author_id: string; author_kind: string }[]>`
      SELECT content, author_id, author_kind FROM messages
      WHERE workspace_id = ${workspace.id}
      ORDER BY created_at, seq
    `;
    assert.deepEqual(messages.map((message) => message.content), [
      `${owner.displayName} joined the workspace`,
      "noodle joined the workspace",
      ...noodleWelcomeMessages(owner.displayName),
    ]);
    assert.equal(messages[0].author_kind, "system");
    assert.equal(messages[1].author_kind, "system");
    assert.ok(messages.slice(2).every((message) => message.author_id === noodle.id));

    const [{ count }] = await accounts.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM thread_events
      WHERE workspace_id = ${workspace.id} AND kind = 'message.created' AND actor_id = ${noodle.id}
    `;
    assert.equal(count, 4);
  });

  test("workspace codes create idempotent pending requests that only owners resolve", async () => {
    const workspace = await access.createWorkspace(owner, "Access Test");
    const first = await access.requestAccess(requester, workspace.publicCode.toLowerCase(), "first");
    const second = await access.requestAccess(requester, workspace.publicCode, "updated");
    assert.equal(second.id, first.id);
    assert.equal(second.message, "updated");
    await assert.rejects(
      access.resolveRequest(workspace.id, first.id, requester.id, "approved"),
      (error) => error instanceof ApiError && error.code === "OWNER_ONLY",
    );
    const approved = await access.resolveRequest(workspace.id, first.id, owner.id, "approved");
    assert.equal(approved.status, "approved");
    assert.equal(await accounts.role(workspace.id, requester.id), "member");
    assert.deepEqual(await access.resolveRequest(workspace.id, first.id, owner.id, "approved"), approved);
  });

  test("reusable invites add multiple members and remain revocable", async () => {
    const workspace = await access.createWorkspace(owner, "Invite Test");
    const invited = await accounts.createHuman("invite-consumer", "invite-consumer", null);
    const other = await accounts.createHuman("invite-other", "invite-other", null);
    const created = await access.createInvite(workspace.id, owner.id);
    assert.equal((await access.previewInvite(created.token))?.workspace.id, workspace.id);
    const accepted = await access.acceptInvite(invited, created.token);
    assert.equal(accepted.role, "member");
    assert.deepEqual(await access.acceptInvite(invited, created.token), accepted);
    assert.equal((await access.acceptInvite(other, created.token)).role, "member");
    const [invite] = await access.listInvites(workspace.id, owner.id);
    assert.equal(invite.uses, 2);
    assert.equal(invite.maxUses, 0);
    assert.equal(await access.revokeInvite(workspace.id, created.invite.id, owner.id), true);
    assert.equal(await access.previewInvite(created.token), null);
    assert.equal(await access.revokeInvite(workspace.id, "missing", owner.id), false);
  });

  test("invite use limits stop new memberships without charging retries", async () => {
    const workspace = await access.createWorkspace(owner, "Limited Invite Test");
    const invited = await accounts.createHuman("limited-consumer", "limited-consumer", null);
    const other = await accounts.createHuman("limited-other", "limited-other", null);
    const created = await access.createInvite(workspace.id, owner.id, { maxAgeSeconds: 1_800, maxUses: 1 });
    const accepted = await access.acceptInvite(invited, created.token);
    assert.deepEqual(await access.acceptInvite(invited, created.token), accepted);
    assert.equal(await access.previewInvite(created.token), null);
    await assert.rejects(
      access.acceptInvite(other, created.token),
      (error) => error instanceof ApiError && error.code === "INVITE_UNAVAILABLE",
    );
    const [invite] = await access.listInvites(workspace.id, owner.id);
    assert.equal(invite.uses, 1);
    assert.equal(invite.maxUses, 1);
  });

  test("the reusable-invite migration preserves legacy link availability", async () => {
    const migrated = await createTestDb({
      beforeMigration: REUSABLE_INVITES_MIGRATION,
      seed: async (sql) => {
        await sql`
          INSERT INTO actors (id, kind, display_name)
          VALUES ('legacy-inviter', 'human', 'legacy-inviter')
        `;
        await sql`
          INSERT INTO workspaces (id, name, public_code, created_by, created_at, updated_at)
          VALUES ('legacy-workspace', 'Legacy', 'CV-LEGACY01', 'legacy-inviter', 1000, 1000)
        `;
        await sql`
          INSERT INTO workspace_invites (
            id, workspace_id, token_hash, created_by, created_at, expires_at,
            consumed_by, consumed_at, revoked_at
          ) VALUES
            ('legacy-unused', 'legacy-workspace', 'legacy-unused-hash', 'legacy-inviter', 1000, 5000, NULL, NULL, NULL),
            ('legacy-used', 'legacy-workspace', 'legacy-used-hash', 'legacy-inviter', 1000, 5000, 'legacy-inviter', 2000, NULL)
        `;
      },
    });
    try {
      const invites = await migrated.db.sql<{ id: string; uses: number; max_uses: number }[]>`
        SELECT id, uses, max_uses FROM workspace_invites ORDER BY id
      `;
      assert.deepEqual([...invites], [
        { id: "legacy-unused", uses: 0, max_uses: 0 },
        { id: "legacy-used", uses: 1, max_uses: 1 },
      ]);
      const legacyColumns = await migrated.db.sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'workspace_invites'
          AND column_name IN ('consumed_by', 'consumed_at')
      `;
      assert.equal(legacyColumns.length, 0);
    } finally {
      await migrated.drop();
    }
  });

  test("the managed-noodle migration appends noodle and messages to existing workspaces", async () => {
    const migrated = await createTestDb({
      beforeMigration: MANAGED_NOODLE_MIGRATION,
      seed: async (sql) => {
        await sql`
          INSERT INTO actors (id, kind, display_name)
          VALUES ('legacy-noodle-owner', 'human', 'legacy-noodle-owner')
        `;
        await sql`
          INSERT INTO workspaces (id, name, public_code, created_by, created_at, updated_at)
          VALUES ('legacy-noodle-workspace', 'Legacy Noodle', 'CV-NOODLE01', 'legacy-noodle-owner', 1000, 1000)
        `;
        await sql`
          INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
          VALUES ('legacy-noodle-workspace', 'legacy-noodle-owner', 'owner', 1000)
        `;
        await sql`
          INSERT INTO channels (id, workspace_id, name, created_by, is_demo, created_at)
          VALUES ('legacy-noodle-general', 'legacy-noodle-workspace', 'general', 'legacy-noodle-owner', false, 1000)
        `;
      },
    });
    try {
      const [noodle] = await migrated.db.sql<{ id: string; role: string }[]>`
        SELECT a.id, m.role
        FROM workspace_members m
        JOIN actors a ON a.id = m.actor_id
        WHERE m.workspace_id = 'legacy-noodle-workspace' AND a.managed_agent = 'noodle'
      `;
      assert.ok(noodle);
      assert.equal(noodle.role, "member");
      const messages = await migrated.db.sql<{ content: string }[]>`
        SELECT content FROM messages
        WHERE workspace_id = 'legacy-noodle-workspace'
        ORDER BY created_at, seq
      `;
      assert.deepEqual(messages.map((message) => message.content), noodleWelcomeMessages("legacy-noodle-owner"));
    } finally {
      await migrated.drop();
    }
  });

  test("owners can remove and restore noodle without repeating welcome messages", async () => {
    const workspace = await access.createWorkspace(owner, "Noodle Restore");
    const [noodle] = await accounts.sql<{ id: string }[]>`
      SELECT a.id FROM workspace_members m
      JOIN actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${workspace.id} AND a.managed_agent = 'noodle'
    `;
    await access.removeMember(workspace.id, noodle.id, owner.id);
    assert.equal(await accounts.role(workspace.id, noodle.id), null);
    await access.restoreNoodle(workspace.id, owner.id);
    assert.equal(await accounts.role(workspace.id, noodle.id), "member");
    const [{ count }] = await accounts.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM messages
      WHERE workspace_id = ${workspace.id} AND author_id = ${noodle.id}
    `;
    assert.equal(count, 4);
  });

  test("last-owner protection survives self-service leave and demotion", async () => {
    const workspace = await access.createWorkspace(owner, "Owner Test");
    await assert.rejects(
      access.removeMember(workspace.id, owner.id, owner.id),
      (error) => error instanceof ApiError && error.code === "LAST_OWNER",
    );
    await assert.rejects(
      access.setRole(workspace.id, owner.id, "member", owner.id),
      (error) => error instanceof ApiError && error.code === "LAST_OWNER",
    );
    const request = await access.requestAccess(requester, workspace.publicCode);
    await access.resolveRequest(workspace.id, request.id, owner.id, "approved");
    await access.setRole(workspace.id, requester.id, "owner", owner.id);
    await access.removeMember(workspace.id, owner.id, owner.id);
    assert.equal(await accounts.role(workspace.id, owner.id), null);
    assert.equal(await accounts.role(workspace.id, requester.id), "owner");
  });
});
