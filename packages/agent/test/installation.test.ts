import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { exchangePairing, listInstallationMetadata, saveInstallation } from "../src/installation";
import { tempDir } from "./helpers";

function exchangeBody(origin: string, token = "installation-secret") {
  return {
    installation: { id: "installation-1", agentId: "agent-1", createdAt: 1, lastUsedAt: null },
    installationToken: token,
    agent: {
      id: "agent-1",
      workspaceId: "workspace-1",
      actorId: "actor-1",
      name: "reader",
      provider: "claude",
      instructions: "Read carefully",
      requestedModel: null,
      access: { mode: "workspace", selectedActorIds: [] },
      configRevision: 1,
      createdBy: "human-1",
      createdAt: 1,
      updatedAt: 1,
      revokedAt: null,
    },
    workspace: { id: "workspace-1", name: "Test Space" },
    apiUrl: origin,
    wsUrl: origin.replace(/^http/, "ws"),
  };
}

describe("agent installation pairing", () => {
  test("exchanges once and atomically stores one durable credential with private modes", async () => {
    const workspace = await tempDir();
    const xdg = await tempDir();
    const code = "one-time-pairing-secret";
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify(exchangeBody("http://localhost:3001")), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const installation = await exchangePairing("http://localhost:3001", code, workspace, fetcher);
    const file = await saveInstallation(installation, { XDG_CONFIG_HOME: xdg });
    assert.deepEqual(requests, [{
      url: "http://localhost:3001/api/agent-pairings/exchange",
      body: JSON.stringify({ pairingCode: code }),
    }]);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const persisted = await fs.readFile(file, "utf8");
    assert.equal(persisted.includes(code), false);
    assert.equal(persisted.includes("installation-secret"), true);
    const status = await listInstallationMetadata({ XDG_CONFIG_HOME: xdg });
    assert.equal(JSON.stringify(status).includes("installation-secret"), false);
    assert.equal(JSON.stringify(status).includes(code), false);
  });

  test("rejects insecure remote origins, workspace failures, and returned origin changes", async () => {
    const workspace = await tempDir();
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(exchangeBody("https://other.example")), { status: 200 });
    await assert.rejects(exchangePairing("http://example.com", "code", workspace, fetcher), /HTTPS/);
    await assert.rejects(exchangePairing("https://example.com/path", "code", workspace, fetcher), /origin only/);
    await assert.rejects(exchangePairing("https://example.com", "code", path.join(workspace, "missing"), fetcher), /does not exist/);
    await assert.rejects(exchangePairing("https://example.com", "code", workspace, fetcher), /different origin/);
  });

  test("turns a consumed pairing response into an actionable error without echoing the code", async () => {
    const workspace = await tempDir();
    const code = "never-echo-this-code";
    const fetcher: typeof fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(exchangePairing("https://example.com", code, workspace, fetcher), (error: Error) => {
      assert.match(error.message, /invalid, expired, or already used/);
      assert.equal(error.message.includes(code), false);
      return true;
    });
  });
});
