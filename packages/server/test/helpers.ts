import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { Actor, BoardEventEnvelope } from "@workspace/shared";
import { WorkspaceDb } from "../src/db";
import { Attachments } from "../src/chat/Attachments";
import { Channels } from "../src/chat/Channels";
import { MessageStore } from "../src/chat/MessageStore";
import { Roster } from "../src/roster";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { Toolman } from "../src/board/Toolman";
import { createApiHandler } from "../src/board/api";
import { Hub } from "../src/hub";

export interface Env {
  db: WorkspaceDb;
  service: BoardService;
  sessions: Sessions;
  channels: Channels;
  attachments: Attachments;
  uploadsDir: string;
  baseUrl: string;
  envelopes: BoardEventEnvelope[];
  actor(kind: "human" | "agent", name: string): { actor: Actor; token: string };
  api(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    raw?: string,
  ): Promise<{ status: number; body: any }>;
  close(): void;
}

/** In-memory board + HTTP API on an ephemeral port, shared by every suite. */
export async function createEnv(): Promise<Env> {
  const db = new WorkspaceDb(":memory:");
  const service = new BoardService(db);
  const sessions = new Sessions();
  const channels = new Channels(db);
  channels.seed([{ name: "general", isDemo: false }]);
  const envelopes: BoardEventEnvelope[] = [];
  service.onEvent = (e) => envelopes.push(e);
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-test-"));
  const attachments = new Attachments(db, uploadsDir);
  const handler = createApiHandler(db, service, sessions, channels, attachments, "*");
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://localhost:${port}`;
  return {
    db,
    service,
    sessions,
    channels,
    attachments,
    uploadsDir,
    baseUrl,
    envelopes,
    actor(kind, name) {
      const actor = db.upsertActor(kind, name);
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
    close() {
      server.close();
      db.close();
      fs.rmSync(uploadsDir, { recursive: true, force: true });
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

export interface WsEnv {
  db: WorkspaceDb;
  messages: MessageStore;
  channels: Channels;
  attachments: Attachments;
  hub: Hub;
  uploadsDir: string;
  baseUrl: string;
  connect(name: string, kind: "human" | "agent"): Promise<WsClient>;
  close(): void;
}

/** The full hub + HTTP stack on an ephemeral port, for websocket suites. */
export async function createWsEnv(): Promise<WsEnv> {
  const db = new WorkspaceDb(":memory:");
  const service = new BoardService(db);
  const sessions = new Sessions();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();
  const channels = new Channels(db);
  channels.seed([{ name: "general", isDemo: false }]);
  const messages = new MessageStore(db);
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-test-"));
  const attachments = new Attachments(db, uploadsDir);
  const handler = createApiHandler(db, service, sessions, channels, attachments, "*");
  const server = http.createServer((req, res) => void handler(req, res));
  const hub = new Hub(server, new Roster(db), messages, channels, attachments, sessions, toolman, {
    apiUrl: "",
    serverId: db.serverId,
    demoChannels: [],
  });
  channels.onCreated = (name) => hub.broadcastChannelCreated(name);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const clients: WebSocket[] = [];

  return {
    db,
    messages,
    channels,
    attachments,
    hub,
    uploadsDir,
    baseUrl: `http://localhost:${port}`,
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
    close() {
      for (const ws of clients) ws.terminate();
      server.close();
      db.close();
      fs.rmSync(uploadsDir, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}
