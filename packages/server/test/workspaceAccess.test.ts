import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AccountStore, type AccountIdentity } from "../src/auth/AccountStore";
import { WorkspaceAccess } from "../src/auth/WorkspaceAccess";
import { ApiError } from "../src/board/BoardService";
import { createTestDb } from "./pgSchema";

const REUSABLE_INVITES_MIGRATION = "20260816210000_reusable_workspace_invites.sql";

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
