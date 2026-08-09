import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";
import type { Actor, BoardEventEnvelope } from "@workspace/shared";
import type { WorkspaceDb } from "../src/db";
import { Attachments } from "../src/chat/Attachments";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { Roster } from "../src/roster";
import { Auth } from "../src/auth/Auth";
import { createJoinGate } from "../src/auth/joinPolicy";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { Toolman } from "../src/board/Toolman";
import { createApiHandler } from "../src/board/api";
import { Hub } from "../src/hub";
import { createTestDb } from "./pgSchema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/** A fake Supabase admin client: getUser(jwt) resolves via a fixed lookup
 *  table the test controls, so ws-level auth tests never touch the network. */
export function fakeSupabase(users: Record<string, { id: string; email: string | null }>): SupabaseClient {
  return {
    auth: {
      getUser: async (jwt: string) => {
        const user = users[jwt];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error("invalid") };
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
  attachments: Attachments;
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
export async function createEnv(): Promise<Env> {
  const { db, drop } = await createTestDb();
  const service = new BoardService(db);
  const sessions = new Sessions();
  const channels = new Channels(db);
  await channels.seed([{ name: "general", isDemo: false }]);
  const envelopes: BoardEventEnvelope[] = [];
  service.onEvent = (e) => envelopes.push(e);
  const attachments = new Attachments(db, supabaseAdmin());
  const messages = new MessageStore(db);
  const handler = createApiHandler(db, service, sessions, messages, channels, attachments, "*");
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
    attachments,
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
      server.close();
      await drop();
    },
  };
}

/** A valid agent proposal body; scope covers everything tests write. */
export const PROPOSAL = {
  title: "Migrate auth",
  why: "sessions are safer",
  effect: "auth uses sessions",
  scopePaths: ["out.md", "deep/"],
};

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
}

export interface WsEnv {
  db: WorkspaceDb;
  messages: MessageStore;
  channels: Channels;
  attachments: Attachments;
  hub: Hub;
  /** Set when the env was created with auth enabled. */
  auth: Auth | null;
  baseUrl: string;
  connect(name: string, kind: "human" | "agent"): Promise<WsClient>;
  /** Send an arbitrary join frame; resolves on welcome or on socket close. */
  join(frame: Record<string, unknown>): Promise<JoinOutcome>;
  close(): Promise<void>;
}

export interface WsAuthOptions {
  /** Fake Supabase getUser(jwt) lookup table — see fakeSupabase() above. */
  users: Record<string, { id: string; email: string | null }>;
  agentToken?: string;
}

/** The full hub + HTTP stack on an ephemeral port, for websocket suites. */
export async function createWsEnv(options: { auth?: WsAuthOptions } = {}): Promise<WsEnv> {
  const { db, drop } = await createTestDb();
  const service = new BoardService(db);
  const sessions = new Sessions();
  const auth = options.auth ? new Auth(db, fakeSupabase(options.auth.users)) : null;
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();
  const channels = new Channels(db);
  await channels.seed([{ name: "general", isDemo: false }]);
  const messages = new MessageStore(db);
  const attachments = new Attachments(db, supabaseAdmin());
  const handler = createApiHandler(db, service, sessions, messages, channels, attachments, "*");
  const server = http.createServer((req, res) => void handler(req, res));
  const roster = await Roster.create(db);
  const hub = new Hub(server, roster, messages, channels, attachments, sessions, toolman, {
    serverId: db.serverId,
    demoChannels: [],
    authorizeJoin: auth ? createJoinGate(auth, options.auth?.agentToken ?? null) : undefined,
  });
  channels.onCreated = (name) => hub.broadcastChannelCreated(name);
  channels.onRenamed = (oldName, newName) => hub.broadcastChannelRenamed(oldName, newName);
  channels.onArchived = (name, archived) => hub.broadcastChannelArchived(name, archived);
  channels.onPinned = (name, pinned) => hub.broadcastChannelPinned(name, pinned);
  channels.onDeleted = (name) => hub.broadcastChannelDeleted(name);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const clients: WebSocket[] = [];

  return {
    db,
    messages,
    channels,
    attachments,
    hub,
    auth,
    baseUrl: `http://localhost:${port}`,
    join(frame) {
      return new Promise<JoinOutcome>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        clients.push(ws);
        let error: string | null = null;
        let settled = false;
        ws.on("message", (raw) => {
          const ev = JSON.parse(raw.toString());
          if (ev.type === "error") error = ev.error;
          if (ev.type === "welcome" && !settled) {
            settled = true;
            resolve({ welcome: ev, error, closed: false });
          }
        });
        ws.on("close", () => {
          if (!settled) {
            settled = true;
            resolve({ welcome: null, error, closed: true });
          }
        });
        ws.on("open", () => ws.send(JSON.stringify(frame)));
      });
    },
    connect(name, kind) {
      return new Promise<WsClient>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
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
              next: (pred, ms = 1000) =>
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
    async close() {
      for (const ws of clients) ws.terminate();
      server.close();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      await drop();
    },
  };
}
