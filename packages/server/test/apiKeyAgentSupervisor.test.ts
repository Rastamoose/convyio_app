import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentInvite } from "@workspace/shared";
import { ApiKeyAgentSupervisor } from "../src/agents/ApiKeyAgentSupervisor";

function invite(overrides: Partial<AgentInvite> = {}): AgentInvite {
  return {
    id: "invite-1",
    workspaceId: "workspace-1",
    actorId: "actor-1",
    name: "openai-agent",
    provider: "openai",
    instructions: "",
    requestedModel: null,
    access: { mode: "workspace", selectedActorIds: [] },
    configRevision: 1,
    createdBy: "human-1",
    createdAt: 1,
    updatedAt: 1,
    revokedAt: null,
    ...overrides,
  };
}

function fakeAgentInvites(overrides: Partial<{
  mintInstallation: (id: string) => Promise<any>;
  listOpenAiWithKeys: () => Promise<any[]>;
}> = {}) {
  return {
    mintInstallation: overrides.mintInstallation ?? (async (id: string) => ({
      invite: invite({ id }),
      installation: { id: "installation-1", agentId: id, createdAt: 1, lastUsedAt: null },
      installationToken: "installation-token",
    })),
    listOpenAiWithKeys: overrides.listOpenAiWithKeys ?? (async () => []),
  } as any;
}

describe("ApiKeyAgentSupervisor", () => {
  test("start() mints an installation and calls runAgent in installation mode", async () => {
    const calls: any[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites(),
      { id: "workspace-1", name: "Test" },
      3001,
      async (config) => { calls.push(config); return { close() {} }; },
    );
    await supervisor.start(invite(), "sk-test");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "installation");
    assert.equal(calls[0].apiKey, "sk-test");
    assert.equal(calls[0].ownProcess, false);
    assert.equal(calls[0].installation.installationToken, "installation-token");
    assert.equal(calls[0].installation.wsUrl, "ws://127.0.0.1:3001/ws/workspace-1");
    assert.equal(calls[0].installation.apiUrl, "http://127.0.0.1:3001");
  });

  test("start() no-ops if the invite was revoked before minting completed", async () => {
    const calls: any[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites({ mintInstallation: async () => null }),
      { id: "workspace-1", name: "Test" },
      3001,
      async (config) => { calls.push(config); return { close() {} }; },
    );
    await supervisor.start(invite(), "sk-test");
    assert.equal(calls.length, 0);
  });

  test("stop() closes the connection and start() can be called again for the same actor", async () => {
    const closed: string[] = [];
    let opened = 0;
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites(),
      { id: "workspace-1", name: "Test" },
      3001,
      async () => { opened += 1; return { close: () => closed.push("closed") }; },
    );
    await supervisor.start(invite({ actorId: "actor-1" }), "sk-test");
    supervisor.stop("actor-1");
    assert.deepEqual(closed, ["closed"]);
    await supervisor.start(invite({ actorId: "actor-1" }), "sk-test");
    assert.equal(opened, 2);
  });

  test("stop() on an unknown actor is a no-op", () => {
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites(),
      { id: "workspace-1", name: "Test" },
      3001,
      async () => ({ close() {} }),
    );
    supervisor.stop("never-started");
  });

  test("syncAll() starts every stored openai invite, decrypting each key", async () => {
    const decrypted: string[] = [];
    const calls: any[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites({
        listOpenAiWithKeys: async () => [
          { invite: invite({ id: "a", actorId: "actor-a" }), apiKeyCiphertext: "cipher-a" },
          { invite: invite({ id: "b", actorId: "actor-b" }), apiKeyCiphertext: "cipher-b" },
        ],
      }),
      { id: "workspace-1", name: "Test" },
      3001,
      async (config) => { calls.push(config); return { close() {} }; },
      (ciphertext) => `plain-${ciphertext}`,
    );
    await supervisor.syncAll();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].apiKey, "plain-cipher-a");
    assert.equal(calls[1].apiKey, "plain-cipher-b");
  });

  test("closeAll() closes every running connection", async () => {
    const closed: string[] = [];
    const supervisor = new ApiKeyAgentSupervisor(
      fakeAgentInvites({
        listOpenAiWithKeys: async () => [
          { invite: invite({ id: "a", actorId: "actor-a" }), apiKeyCiphertext: "cipher-a" },
          { invite: invite({ id: "b", actorId: "actor-b" }), apiKeyCiphertext: "cipher-b" },
        ],
      }),
      { id: "workspace-1", name: "Test" },
      3001,
      async () => ({ close: () => closed.push("x") }),
      () => "plain",
    );
    await supervisor.syncAll();
    supervisor.closeAll();
    assert.deepEqual(closed, ["x", "x"]);
  });
});
