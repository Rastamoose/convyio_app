import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { WorkspaceSummary } from "@workspace/shared";
import { AccountStore } from "../src/auth/AccountStore";
import { Auth } from "../src/auth/Auth";
import { WorkspaceAccess } from "../src/auth/WorkspaceAccess";
import { Sessions } from "../src/board/sessions";
import { createApiHandler } from "../src/board/api";
import { WorkspaceRegistry } from "../src/WorkspaceRegistry";
import { createTestDb } from "./pgSchema";
import { fakeSupabase } from "./helpers";

interface JoinedClient {
  ws: WebSocket;
  welcome: any;
  events: any[];
}

describe("multi-workspace runtime", () => {
  let close: () => Promise<void>;
  let baseUrl: string;
  let workspaceA: WorkspaceSummary;
  let workspaceB: WorkspaceSummary;
  let ownerToken: string;
  let memberToken: string;
  let sessions: Sessions;

  before(async () => {
    const { db, drop } = await createTestDb();
    const users = {
      "owner-jwt": { id: "workspace-owner", email: "owner@example.com" },
      "member-jwt": { id: "workspace-member", email: "member@example.com" },
    };
    const accounts = new AccountStore(db.sql);
    const auth = new Auth(accounts, fakeSupabase(users));
    const access = new WorkspaceAccess(db.sql, accounts);
    await auth.claimUsername("owner-jwt", "runtime-owner");
    await auth.claimUsername("member-jwt", "runtime-member");
    const owner = await auth.identity("owner-jwt");
    const member = await auth.identity("member-jwt");
    workspaceA = await access.createWorkspace(owner, "Runtime A");
    workspaceB = await access.createWorkspace(member, "Runtime B");
    const requested = await access.requestAccess(member, workspaceA.publicCode, "let me in");
    await access.resolveRequest(workspaceA.id, requested.id, owner.id, "approved");
    sessions = new Sessions();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "convyio-multi-workspace-"));
    const registry = new WorkspaceRegistry(
      db,
      sessions,
      auth,
      null,
      fakeSupabase(users),
      dataDir,
      db.workspaceId,
      new Map(),
      "/tmp/convyio-no-demo",
    );
    const defaultRuntime = await registry.require(db.workspaceId);
    const handler = createApiHandler({
      db: defaultRuntime.db,
      service: defaultRuntime.board,
      sessions,
      messages: defaultRuntime.messages,
      threadEvents: defaultRuntime.threadEvents,
      channels: defaultRuntime.channels,
      attachments: defaultRuntime.attachments,
      corsOrigin: "*",
      authGate: { googleAuthEnabled: true, emailAuthEnabled: true, auth },
      agentInvites: defaultRuntime.agentInvites,
      runnerRuntime: defaultRuntime.runnerRuntime,
      snapshot: defaultRuntime.snapshot,
      plans: defaultRuntime.plans,
      envelope: defaultRuntime.envelope,
      projects: defaultRuntime.projects,
      toolmanNodes: defaultRuntime.toolmanNodes,
      executions: defaultRuntime.executions,
      accounts,
      workspaceAccess: access,
      workspaceRegistry: registry,
    });
    const server = http.createServer((req, res) => void handler(req, res));
    registry.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;
    ownerToken = "owner-jwt";
    memberToken = "member-jwt";
    close = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await registry.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      await drop();
    };
  });

  after(async () => close());

  test("account sessions list every membership without choosing one implicitly", async () => {
    const response = await fetch(`${baseUrl}/api/account`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string; workspaces: WorkspaceSummary[] };
    assert.equal(body.status, "ok");
    assert.deepEqual(new Set(body.workspaces.map((workspace) => workspace.id)), new Set([workspaceA.id, workspaceB.id]));
  });

  test("workspace rooms isolate history, presence, broadcasts, and HTTP sessions", async () => {
    const a = await join(baseUrl, workspaceA.id, ownerToken);
    const b = await join(baseUrl, workspaceB.id, memberToken);
    try {
      a.ws.send(JSON.stringify({ type: "message", content: "only in A", channel: "general" }));
      await waitFor(a.events, (event) => event.type === "message" && event.message.content === "only in A");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(b.events.some((event) => event.type === "message" && event.message.content === "only in A"), false);
      assert.equal(b.welcome.history.some((message: { content: string }) => message.content === "only in A"), false);

      const before = Date.now() + 1;
      const aHistory = await fetch(`${baseUrl}/api/messages?channel=general&before=${before}`, {
        headers: { Authorization: `Bearer ${a.welcome.token}` },
      });
      const bHistory = await fetch(`${baseUrl}/api/messages?channel=general&before=${before}`, {
        headers: { Authorization: `Bearer ${b.welcome.token}` },
      });
      const aBody = await aHistory.json() as { messages: Array<{ content: string }> };
      const bBody = await bHistory.json() as { messages: Array<{ content: string }> };
      assert.equal(aBody.messages.some((message) => message.content === "only in A"), true);
      assert.equal(bBody.messages.some((message) => message.content === "only in A"), false);
      assert.notEqual(sessions.resolve(a.welcome.token)?.workspaceId, sessions.resolve(b.welcome.token)?.workspaceId);
    } finally {
      a.ws.terminate();
      b.ws.terminate();
    }
  });
});

async function join(baseUrl: string, workspaceId: string, token: string): Promise<JoinedClient> {
  const url = new URL(baseUrl);
  const ws = new WebSocket(`ws://${url.host}/ws/${encodeURIComponent(workspaceId)}`);
  const events: any[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("workspace join timed out")), 5000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      events.push(event);
      if (event.type === "welcome") {
        clearTimeout(timeout);
        resolve({ ws, welcome: event, events });
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", kind: "human", authToken: token })));
  });
}

async function waitFor(events: any[], predicate: (event: any) => boolean): Promise<void> {
  const started = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - started > 5000) throw new Error("event timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
