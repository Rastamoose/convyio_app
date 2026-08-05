import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Actor, BoardEventEnvelope } from "@workspace/shared";
import { WorkspaceDb } from "../src/db";
import { Attachments } from "../src/chat/Attachments";
import { Channels } from "../src/chat/Channels";
import { BoardService } from "../src/board/BoardService";
import { Sessions } from "../src/board/sessions";
import { createApiHandler } from "../src/board/api";

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
