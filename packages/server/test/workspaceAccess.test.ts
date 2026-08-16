import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { AccountStore, type AccountIdentity } from "../src/auth/AccountStore";
import { WorkspaceAccess } from "../src/auth/WorkspaceAccess";
import { ApiError } from "../src/board/BoardService";
import { createTestDb } from "./pgSchema";

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

  test("single-use invites are revocable and idempotent only for their consumer", async () => {
    const workspace = await access.createWorkspace(owner, "Invite Test");
    const invited = await accounts.createHuman("invite-consumer", "invite-consumer", null);
    const other = await accounts.createHuman("invite-other", "invite-other", null);
    const created = await access.createInvite(workspace.id, owner.id);
    assert.equal((await access.previewInvite(created.token))?.workspace.id, workspace.id);
    const accepted = await access.acceptInvite(invited, created.token);
    assert.equal(accepted.role, "member");
    assert.deepEqual(await access.acceptInvite(invited, created.token), accepted);
    await assert.rejects(
      access.acceptInvite(other, created.token),
      (error) => error instanceof ApiError && error.code === "INVITE_UNAVAILABLE",
    );

    const revoked = await access.createInvite(workspace.id, owner.id);
    assert.equal(await access.revokeInvite(workspace.id, revoked.invite.id, owner.id), true);
    assert.equal(await access.previewInvite(revoked.token), null);
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
