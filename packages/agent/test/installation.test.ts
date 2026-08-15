import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { clearInstallations, exchangePairing, listInstallationMetadata, loadInstallation, saveInstallation } from "../src/installation";
import { tempDir } from "./helpers";

function exchangeBody(
  origin: string,
  token = "installation-secret",
  overrides: { agentId?: string; name?: string; installationId?: string } = {},
) {
  const agentId = overrides.agentId ?? "agent-1";
  return {
    installation: { id: overrides.installationId ?? "installation-1", agentId, createdAt: 1, lastUsedAt: null },
    installationToken: token,
    agent: {
      id: agentId,
      workspaceId: "workspace-1",
      actorId: "actor-1",
      name: overrides.name ?? "reader",
      provider: "claude" as const,
      instructions: "Read carefully",
      requestedModel: null,
      access: { mode: "workspace" as const, selectedActorIds: [] },
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

async function pairNamed(
  workspace: string,
  xdg: string,
  fields: { agentId: string; name: string; installationId: string; token: string },
) {
  const installation = await exchangePairing(
    "http://localhost:3001",
    "code",
    workspace,
    async () =>
      new Response(
        JSON.stringify(exchangeBody("http://localhost:3001", fields.token, fields)),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  await saveInstallation(installation, { XDG_CONFIG_HOME: xdg });
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

  test("run accepts an agent name and lists names when the choice is missing or ambiguous", async () => {
    const workspace = await tempDir();
    const xdg = await tempDir();
    const env = { XDG_CONFIG_HOME: xdg };
    await pairNamed(workspace, xdg, { agentId: "id-reader", name: "reader", installationId: "inst-1", token: "tok-1" });
    await pairNamed(workspace, xdg, { agentId: "id-claude", name: "claude", installationId: "inst-2", token: "tok-2" });

    assert.equal((await loadInstallation("claude", env)).agent.id, "id-claude");
    assert.equal((await loadInstallation("CLAUDE", env)).agent.id, "id-claude");
    assert.equal((await loadInstallation("id-reader", env)).agent.id, "id-reader");

    await assert.rejects(loadInstallation(undefined, env), (error: Error) => {
      assert.match(error.message, /More than one paired agent\. Run one by name, or clear them with `convyio-agent unpair`:/);
      assert.match(error.message, /convyio-agent run reader/);
      assert.match(error.message, /convyio-agent run claude/);
      assert.equal(error.message.includes("id-reader"), false);
      return true;
    });
    await assert.rejects(loadInstallation("missing", env), (error: Error) => {
      assert.match(error.message, /No paired agent named "missing"/);
      assert.match(error.message, /reader/);
      assert.match(error.message, /claude/);
      return true;
    });
  });

  test("unpair clears every locally stored pairing", async () => {
    const workspace = await tempDir();
    const xdg = await tempDir();
    const env = { XDG_CONFIG_HOME: xdg };
    await pairNamed(workspace, xdg, { agentId: "id-reader", name: "reader", installationId: "inst-1", token: "tok-1" });
    await pairNamed(workspace, xdg, { agentId: "id-claude", name: "claude", installationId: "inst-2", token: "tok-2" });

    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const cleared = await clearInstallations(env, fetcher);
    assert.deepEqual(cleared.sort(), ["claude", "reader"]);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.method === "DELETE"));
    assert.ok(requests.every((request) => request.url === "http://localhost:3001/api/agent-installations"));
    assert.deepEqual(
      requests.map((request) => request.authorization).sort(),
      ["Bearer tok-1", "Bearer tok-2"],
    );
    assert.deepEqual(await listInstallationMetadata(env), []);
    assert.deepEqual(await clearInstallations(env, fetcher), []);
    await assert.rejects(loadInstallation("claude", env), /No paired agents found/);
  });

  test("unpair leaves the local file when the server refuses", async () => {
    const workspace = await tempDir();
    const xdg = await tempDir();
    const env = { XDG_CONFIG_HOME: xdg };
    await pairNamed(workspace, xdg, { agentId: "id-claude", name: "claude", installationId: "inst-2", token: "tok-2" });
    const fetcher: typeof fetch = async () => new Response("nope", { status: 500 });
    await assert.rejects(clearInstallations(env, fetcher), /Unpair server returned HTTP 500/);
    assert.equal((await listInstallationMetadata(env)).length, 1);
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
