import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";
import { emptyImpactMap, type Actor, type AgentInvite, type BoardEventEnvelope, type BoardItem, type EcosystemImpact } from "@workspace/shared";
import type { WorkspaceDb } from "../src/db";
import { Attachments } from "../src/chat/Attachments";
import { AgentWorkStore } from "../src/chat/AgentWorkStore";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { InteractionStore } from "../src/chat/InteractionStore";
import { Roster } from "../src/roster";
import { Auth } from "../src/auth/Auth";
import { AccountStore } from "../src/auth/AccountStore";
import { AgentInvites } from "../src/auth/AgentInvites";
import { WorkspaceAccess } from "../src/auth/WorkspaceAccess";
import { createJoinGate } from "../src/auth/joinPolicy";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { Toolman } from "../src/board/Toolman";
import { createApiHandler, type AuthGate } from "../src/board/api";
import { Hub } from "../src/hub";
import { RunnerRuntime } from "../src/RunnerRuntime";
import { createTestDb } from "./pgSchema";
import { ContextNotes } from "../src/context/ContextNotes";
import { ContextStore } from "../src/context/ContextStore";
import { WorkspaceSnapshotBuilder } from "../src/context/WorkspaceSnapshot";
import { PromptEnvelopeBuilder } from "../src/context/PromptEnvelope";
import { ResourceAccessStore } from "../src/context/ResourceAccessStore";
import { ResourceManifestBuilder } from "../src/context/ResourceManifest";
import { PlanService } from "../src/board/PlanService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/** A user record for fakeSupabase; user_metadata mirrors the real Supabase
 *  shape (data.user.user_metadata) so Auth's desired_username auto-claim is
 *  testable offline. */
export interface FakeSupabaseUser {
  id: string;
  email: string | null;
  user_metadata?: { desired_username?: string };
}

/** A fake Supabase admin client: getUser(jwt) resolves via a fixed lookup
 *  table the test controls, so ws-level auth tests never touch the network.
 *  An unknown token gets a 401-status error (matching the real AuthApiError,
 *  which Auth.verify treats as a definitive rejection); mapping a token to
 *  "unavailable" simulates a Supabase outage/rate limit (status 503). The
 *  table is read per call, so tests can mutate it mid-flight. */
export function fakeSupabase(
  users: Record<string, FakeSupabaseUser | "unavailable">,
): SupabaseClient {
  return {
    auth: {
      getUser: async (jwt: string) => {
        const user = users[jwt];
        if (user === "unavailable") {
          return { data: { user: null }, error: Object.assign(new Error("service down"), { status: 503 }) };
        }
        return user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: Object.assign(new Error("invalid"), { status: 401 }) };
      },
    },
  } as unknown as SupabaseClient;
}

/** The real Supabase admin client (service-role key), for Attachments —
 *  Storage has no useful in-memory fake, so tests exercise the real bucket. */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY are not set");
  return createClient(url, key);
}

export interface Env {
  db: WorkspaceDb;
  service: BoardService;
  sessions: Sessions;
  channels: Channels;
  messages: MessageStore;
  agentWork: AgentWorkStore;
  threadEvents: ThreadEventStore;
  attachments: Attachments;
  notes: ContextNotes;
  resourceAccess: ResourceAccessStore;
  resourceManifest: ResourceManifestBuilder;
  runnerRuntime: RunnerRuntime;
  baseUrl: string;
  envelopes: BoardEventEnvelope[];
  actor(kind: "human" | "agent", name: string): Promise<{ actor: Actor; token: string }>;
  api(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    raw?: string,
  ): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/** An isolated Postgres schema + board + HTTP API on an ephemeral port, shared by every suite. */
export async function createEnv(options: {
  hostedAgentToken?: string | null;
  onCreateAgent?: (invite: AgentInvite, apiKey: string) => void;
  validateOpenAiKey?: (apiKey: string) => Promise<boolean>;
} = {}): Promise<Env> {
  const { db, drop } = await createTestDb();
  const threadEvents = new ThreadEventStore(db);
  const channels = new Channels(db);
  await channels.seed([{ name: "general", isDemo: false }]);
  const plans = new PlanService(db, threadEvents, channels);
  const service = new BoardService(db, threadEvents, plans, channels);
  const sessions = new Sessions();
  const envelopes: BoardEventEnvelope[] = [];
  service.onEvent = (e) => envelopes.push(e);
  const attachments = new Attachments(db, supabaseAdmin());
  const messages = new MessageStore(db, threadEvents);
  const agentWork = new AgentWorkStore(db, threadEvents, messages);
  const agentInvites = new AgentInvites(db);
  const resourceAccess = new ResourceAccessStore(
    db,
    threadEvents,
    (agentId, humanId) => agentInvites.allowsAuthor(agentId, humanId),
  );
  const resourceManifest = new ResourceManifestBuilder(db, resourceAccess);
  const runnerRuntime = new RunnerRuntime();
  const context = new ContextStore(db, threadEvents);
  const notes = new ContextNotes(db, threadEvents);
  const snapshot = new WorkspaceSnapshotBuilder(db, service, plans, context);
  const envelope = new PromptEnvelopeBuilder(
    snapshot,
    { id: db.workspaceId, name: db.workspaceName },
    resourceAccess,
    notes,
  );
  const handler = createApiHandler({
    db,
    service,
    sessions,
    messages,
    threadEvents,
    channels,
    attachments,
    corsOrigin: "*",
    hostedAgentToken: options.hostedAgentToken ?? null,
    agentInvites,
    runnerRuntime,
    onCreateAgent: options.onCreateAgent ?? null,
    validateOpenAiKey: options.validateOpenAiKey,
    snapshot,
    plans,
    envelope,
    context,
    notes,
    resourceAccess,
    resourceManifest,
  });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://localhost:${port}`;
  return {
    db,
    service,
    sessions,
    channels,
    messages,
    agentWork,
    threadEvents,
    attachments,
    notes,
    resourceAccess,
    resourceManifest,
    runnerRuntime,
    baseUrl,
    envelopes,
    async actor(kind, name) {
      const actor = await db.upsertActor(kind, name);
      return { actor, token: sessions.issue(actor.id) };
    },
    async api(method, urlPath, token, body, raw) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await drop();
    },
  };
}

export function ticketImpact(): EcosystemImpact {
  const map = emptyImpactMap();
  map.server = "affected";
  map.notes.server = "Existing ticket authorization path";
  return map;
}

/** A valid agent proposal body; scope covers everything tests write. */
export const PROPOSAL = {
  title: "Migrate auth",
  why: "sessions are safer",
  effect: "auth uses sessions",
  scopePaths: ["out.md", "deep/"],
  acceptanceCriteria: ["Auth still works"],
  impactMap: ticketImpact(),
};

export async function acceptedPlan(
  env: Pick<Env, "api">,
  humanToken: string,
  title = "Test plan",
): Promise<string> {
  const created = await env.api("POST", "/api/board/plans", humanToken, {
    title,
    objective: "Hold one live ticket for tests",
    outline: ["Accept", "Create next ticket"],
    clarifications: ["Test fixture: this is megaplan work"],
    impactMap: ticketImpact(),
  });
  const accepted = await env.api("POST", `/api/board/plans/${created.body.plan.id}/accept`, humanToken);
  return accepted.body.plan.id as string;
}

export async function proposeTicket(
  env: Pick<Env, "service">,
  actor: Actor,
  planId: string,
  extras: Partial<typeof PROPOSAL> & { owner?: string; title?: string } = {},
): Promise<BoardItem> {
  return env.service.create(actor, { ...PROPOSAL, planId, ...extras });
}

export interface WsClient {
  ws: WebSocket;
  token: string;
  welcome: any;
  /** Resolves with the first seen event matching pred, past or future. */
  next(pred: (event: any) => boolean, ms?: number): Promise<any>;
}

/** A join attempt's outcome: exactly one of welcome/refusal, never both. */
export interface JoinOutcome {
  welcome: any | null;
  error: string | null;
  closed: boolean;
  client: WsClient | null;
}

export interface WsEnv {
  db: WorkspaceDb;
  service: BoardService;
  sessions: Sessions;
  messages: MessageStore;
  agentWork: AgentWorkStore;
  threadEvents: ThreadEventStore;
  channels: Channels;
  attachments: Attachments;
  notes: ContextNotes;
  resourceAccess: ResourceAccessStore;
  resourceManifest: ResourceManifestBuilder;
  runnerRuntime: RunnerRuntime;
  plans: PlanService;
  hub: Hub;
  agentInvites: AgentInvites;
  toolman: Toolman;
  roster: Roster;
  workspaceDir: string;
  /** Set when the env was created with auth enabled. */
  auth: Auth | null;
  baseUrl: string;
  /** `autoPong: false` makes the client ignore heartbeat pings, so the hub
   *  sees it as a process that died without closing its socket. */
  connect(name: string, kind: "human" | "agent", options?: { autoPong?: boolean }): Promise<WsClient>;
  /** Send an arbitrary join frame; resolves on welcome or on socket close. */
  join(frame: Record<string, unknown>): Promise<JoinOutcome>;
  /** Terminate all connected sockets without closing the server. */
  closeClients(): void;
  /** Truncate workspace data and clear in-memory state so the next test
   *  can reuse this env without leaking from the previous one. */
  reset(): Promise<void>;
  /** Test-only durable channel grant so mention-driven work can start. */
  grantChannel(agentId: string, grantedById: string, channelName?: string): Promise<void>;
  close(): Promise<void>;
}

export interface WsAuthOptions {
  /** Fake Supabase getUser(jwt) lookup table — see fakeSupabase() above. */
  users: Record<string, FakeSupabaseUser | "unavailable">;
  agentToken?: string;
}

/** The full hub + HTTP stack on an ephemeral port, for websocket suites. */
/**
 * How long to wait for an expected frame. Generous on purpose: these tests
 * talk to a real remote Postgres, so a round trip is not a fixed cost, and a
 * frame arriving in 1.2s instead of 0.9s is not a bug. Tests that genuinely
 * assert latency pass their own bound. Node's 30s per-test timeout still
 * catches a real hang.
 */
const WS_WAIT_MS = 5000;

export async function createWsEnv(
  options: { auth?: WsAuthOptions; heartbeatMs?: number } = {},
): Promise<WsEnv> {
  const { db, drop } = await createTestDb();
  const threadEvents = new ThreadEventStore(db);
  const channels = new Channels(db);
  await channels.seed([{ name: "general", isDemo: false }]);
  const plans = new PlanService(db, threadEvents, channels);
  const service = new BoardService(db, threadEvents, plans, channels);
  const sessions = new Sessions();
  const accounts = new AccountStore(db.sql);
  const auth = options.auth
    ? new Auth(accounts, fakeSupabase(options.auth.users), new WorkspaceAccess(db.sql, accounts))
    : null;
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();
  const messages = new MessageStore(db, threadEvents);
  const agentWork = new AgentWorkStore(db, threadEvents, messages);
  const attachments = new Attachments(db, supabaseAdmin());
  const agentInvites = new AgentInvites(db);
  const resourceAccess = new ResourceAccessStore(
    db,
    threadEvents,
    (agentId, humanId) => agentInvites.allowsAuthor(agentId, humanId),
  );
  const resourceManifest = new ResourceManifestBuilder(db, resourceAccess);
  const notes = new ContextNotes(db, threadEvents);
  const runnerRuntime = new RunnerRuntime();
  // Auth-enabled envs expose /api/auth/* through the SAME Auth instance the
  // join gate uses (prod runs one instance for both HTTP and ws, and the
  // verify cache lives per instance).
  const authGate: AuthGate | null = auth ? { googleAuthEnabled: true, emailAuthEnabled: true, auth } : null;
  // "localhost-dev" (the server's real default) rather than "*", so suites
  // exercise the same same-origin/cross-origin classification prod runs.
  const handler = createApiHandler({
    db,
    service,
    sessions,
    messages,
    threadEvents,
    channels,
    attachments,
    corsOrigin: "localhost-dev",
    authGate,
    agentInvites,
    notes,
    resourceAccess,
    resourceManifest,
    runnerRuntime,
    onUpdateAgent: (profile) => hub.updateAgentConfig(profile),
    onRevokeAgent: (actorId) => hub.closeAgentConnection(actorId),
    onRemoveMember: (actorId) => hub.closeHumanConnection(actorId),
  });
  const server = http.createServer((req, res) => void handler(req, res));
  const roster = await Roster.create(db, agentInvites);
  const interactions = new InteractionStore(db, threadEvents);
  const hub = new Hub(
    server,
    roster,
    messages,
    agentWork,
    channels,
    attachments,
    sessions,
    toolman,
    interactions,
    runnerRuntime,
    {
      workspace: { id: db.workspaceId, name: db.workspaceName },
      demoChannels: [],
      authorizeJoin: auth
        ? createJoinGate(auth, db.workspaceId, options.auth?.agentToken ?? null, agentInvites, db)
        : undefined,
      authorizeAgentWork: (agentId, authorId) => agentInvites.allowsAuthor(agentId, authorId),
      threadEvents,
      resourceAccess,
      ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    },
  );
  service.onEvent = (e) => hub.broadcastBoardEvent(e);
  plans.onEvent = (e) => hub.broadcastPlanEvent(e);
  channels.onCreated = (channel) => hub.broadcastChannelCreated(channel);
  channels.onRenamed = (oldName, newName) => hub.broadcastChannelRenamed(oldName, newName);
  channels.onArchived = (name, archived) => hub.broadcastChannelArchived(name, archived);
  channels.onPinned = (name, pinned) => hub.broadcastChannelPinned(name, pinned);
  channels.onDeleted = (name) => hub.broadcastChannelDeleted(name);
  channels.onSectionCreated = (section) => hub.broadcastChannelSectionCreated(section);
  channels.onMoved = (name, sectionId) => hub.broadcastChannelMoved(name, sectionId);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const clients: WebSocket[] = [];
  const closeClients = () => {
    for (const ws of clients) ws.terminate();
    clients.length = 0;
  };

  return {
    db,
    service,
    sessions,
    messages,
    agentWork,
    threadEvents,
    channels,
    attachments,
    notes,
    resourceAccess,
    resourceManifest,
    runnerRuntime,
    plans,
    hub,
    agentInvites,
    toolman,
    roster,
    workspaceDir,
    auth,
    baseUrl: `http://localhost:${port}`,
    join(frame) {
      return new Promise<JoinOutcome>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        clients.push(ws);
        const seen: any[] = [];
        const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
        let error: string | null = null;
        let settled = false;
        ws.on("message", (raw) => {
          const ev = JSON.parse(raw.toString());
          seen.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(ev)) waiters.splice(i, 1)[0].resolve(ev);
          }
          if (ev.type === "error") error = ev.error;
          if (ev.type === "welcome" && !settled) {
            settled = true;
            const client: WsClient = {
              ws,
              token: ev.token,
              welcome: ev,
              next: (pred, ms = WS_WAIT_MS) =>
                new Promise((res, rej) => {
                  const already = seen.find(pred);
                  if (already) return res(already);
                  const timeout = setTimeout(() => rej(new Error("timeout")), ms);
                  waiters.push({
                    pred,
                    resolve: (event) => {
                      clearTimeout(timeout);
                      res(event);
                    },
                  });
                }),
            };
            resolve({ welcome: ev, error, closed: false, client });
          }
        });
        ws.on("close", () => {
          if (!settled) {
            settled = true;
            resolve({ welcome: null, error, closed: true, client: null });
          }
        });
        ws.on("open", () => ws.send(JSON.stringify(frame)));
      });
    },
    connect(name, kind, connectOptions) {
      return new Promise<WsClient>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`, {
          autoPong: connectOptions?.autoPong ?? true,
        });
        clients.push(ws);
        const seen: any[] = [];
        const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
        ws.on("message", (raw) => {
          const ev = JSON.parse(raw.toString());
          seen.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(ev)) waiters.splice(i, 1)[0].resolve(ev);
          }
          if (ev.type === "welcome") {
            resolve({
              ws,
              token: ev.token,
              welcome: ev,
              next: (pred, ms = WS_WAIT_MS) =>
                new Promise((res, rej) => {
                  const already = seen.find(pred);
                  if (already) return res(already);
                  const t = setTimeout(() => rej(new Error("timeout")), ms);
                  waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
                }),
            });
          }
        });
        ws.on("open", () => ws.send(JSON.stringify({ type: "join", name, kind })));
      });
    },
    closeClients,
    async grantChannel(agentId, grantedById, channelName = "general") {
      const channel = await channels.get(channelName);
      if (!channel) throw new Error(`unknown channel: ${channelName}`);
      if (await resourceAccess.has(agentId, "channel", channel.id)) return;
      await db.sql`
        INSERT INTO agent_resource_grants (
          id, workspace_id, agent_id, resource_kind, resource_id, capability,
          granted_by, reason, created_at, revoked_by, revoked_at
        ) VALUES (
          ${randomUUID()}, ${db.workspaceId}, ${agentId}, 'channel', ${channel.id},
          'content_read', ${grantedById}, 'test grant', ${Date.now()}, NULL, NULL
        )
      `;
    },
    async reset() {
      // A local function, not `this`: inside an object literal being returned
      // as a promise, `this` widens to include the PromiseLike form.
      closeClients();
      // Truncate all mutable tables, keep the workspaces row so
      // db.workspaceId stays valid.
      await db.sql`TRUNCATE TABLE workspaces, actors RESTART IDENTITY CASCADE`;
      const now = Date.now();
      const noodleId = `managed-agent:noodle:${db.workspaceId}`;
      await db.sql`
        INSERT INTO workspaces (id, name, public_code, created_at, updated_at)
        VALUES (${db.workspaceId}, ${db.workspaceName}, 'CV-TEST000001', ${now}, ${now})
      `;
      await db.sql`
        INSERT INTO actors (id, kind, display_name, managed_agent)
        VALUES (${noodleId}, 'agent', 'noodle', 'noodle')
      `;
      await db.sql`
        INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
        VALUES (${db.workspaceId}, ${noodleId}, 'member', ${now})
      `;
      await db.sql`
        INSERT INTO ref_counters (workspace_id, n) VALUES (${db.workspaceId}, 0)
        ON CONFLICT (workspace_id) DO UPDATE SET n = 0
      `;
      await channels.seed([{ name: "general", isDemo: false }]);
      sessions.clear();
      runnerRuntime.clearAll();
      roster.clear();
    },
    async close() {
      for (const ws of clients) ws.terminate();
      await hub.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      await drop();
    },
  };
}
