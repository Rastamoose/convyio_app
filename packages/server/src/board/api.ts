import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Actor, ItemStatus } from "@workspace/shared";
import { ApiError, type BoardService } from "./BoardService";
import type { BoardDb } from "./db";

/**
 * Session registry. Tokens are issued when a participant joins over the
 * websocket and map to a persistent actor identity. HTTP routes derive the
 * actor from the token only — never from the request body (I1).
 */
export class Sessions {
  private tokens = new Map<string, string>();

  issue(actorId: string): string {
    const token = randomUUID();
    this.tokens.set(token, actorId);
    return token;
  }

  resolve(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }
}

const createBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  why: z.string().max(1000).optional(),
  effect: z.string().max(1000).optional(),
  // I2: any supplied status is ignored; parsed here only so it is dropped.
  status: z.unknown().optional(),
});

const denyBodySchema = z.object({ reason: z.string().max(1000).optional() });
const blockBodySchema = z.object({ reason: z.string().min(1).max(1000) });
const patchBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  owner: z.string().nullable().optional(),
});

const statusValues: ItemStatus[] = ["proposed", "denied", "approved", "in_progress", "blocked", "done"];

export function createApiHandler(
  db: BoardDb,
  service: BoardService,
  sessions: Sessions,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return true;
    }

    try {
      const actor = authenticate(req, db, sessions);
      await route(req, res, url, actor, service, db);
    } catch (err) {
      if (err instanceof ApiError) {
        json(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof z.ZodError) {
        json(res, 400, { error: "VALIDATION", message: err.issues.map((i) => i.message).join("; ") });
      } else {
        console.error("[api] internal error:", err);
        json(res, 500, { error: "INTERNAL", message: "internal error" });
      }
    }
    return true;
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  actor: Actor,
  service: BoardService,
  db: BoardDb,
): Promise<void> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "board", "items", ...]

  // GET /api/actors — the member roster, for owner assignment and display.
  if (parts[1] === "actors" && parts.length === 2 && method === "GET") {
    return json(res, 200, { actors: db.listActors() });
  }

  if (parts[1] !== "board" || parts[2] !== "items") {
    throw new ApiError(404, "NOT_FOUND", "no such route");
  }

  // GET /api/board/items
  if (parts.length === 3 && method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !statusValues.includes(status as ItemStatus)) {
      throw new ApiError(400, "BAD_STATUS", `status must be one of ${statusValues.join(", ")}`);
    }
    const items = service.list(actor.serverId, {
      status: (status as ItemStatus) ?? undefined,
      includeDeleted: url.searchParams.get("include_deleted") === "true",
    });
    return json(res, 200, { items });
  }

  // POST /api/board/items
  if (parts.length === 3 && method === "POST") {
    const body = createBodySchema.parse(await readBody(req));
    const item = service.create(actor, body);
    return json(res, 201, { item });
  }

  const id = parts[3];
  if (!id) throw new ApiError(404, "NOT_FOUND", "no such route");

  // PATCH / DELETE /api/board/items/:id
  if (parts.length === 4) {
    if (method === "PATCH") {
      const body = patchBodySchema.parse(await readBody(req));
      return json(res, 200, { item: service.edit(actor, id, body) });
    }
    if (method === "DELETE") {
      return json(res, 200, { item: service.softDelete(actor, id) });
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`);
  }

  // GET /api/board/items/:id/events — the item's audit trail.
  if (parts.length === 5 && parts[4] === "events" && method === "GET") {
    return json(res, 200, { events: service.events(actor.serverId, id) });
  }

  // POST /api/board/items/:id/<action>
  if (parts.length === 5 && method === "POST") {
    switch (parts[4]) {
      case "approve":
        return json(res, 200, { item: service.approve(actor, id) });
      case "deny": {
        const body = denyBodySchema.parse(await readBody(req));
        return json(res, 200, { item: service.deny(actor, id, body.reason) });
      }
      case "start":
        return json(res, 200, { item: service.start(actor, id) });
      case "complete":
        return json(res, 200, { item: service.complete(actor, id) });
      case "block": {
        const body = blockBodySchema.parse(await readBody(req));
        return json(res, 200, { item: service.block(actor, id, body.reason) });
      }
      case "unblock":
        return json(res, 200, { item: service.unblock(actor, id) });
      case "reopen":
        return json(res, 200, { item: service.reopen(actor, id) });
    }
  }

  throw new ApiError(404, "NOT_FOUND", "no such route");
}

function authenticate(req: IncomingMessage, db: BoardDb, sessions: Sessions): Actor {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const actorId = token ? sessions.resolve(token) : null;
  const actor = actorId ? db.getActor(actorId) : null;
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
  return actor;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new ApiError(413, "TOO_LARGE", "body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "BAD_JSON", "malformed JSON body");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
