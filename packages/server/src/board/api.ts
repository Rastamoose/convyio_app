import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Actor, ItemStatus } from "@workspace/shared";
import { ApiError, type BoardService } from "./BoardService";
import type { Sessions } from "./sessions";
import type { Auth } from "../auth/Auth";
import { MAX_ATTACHMENT_BYTES, type Attachments } from "../chat/Attachments";
import type { Channels } from "../chat/Channels";
import type { WorkspaceDb } from "../db";

const scopePathsSchema = z.array(z.string().min(1).max(500)).max(50);

const createBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  why: z.string().max(1000).optional(),
  effect: z.string().max(1000).optional(),
  scopePaths: scopePathsSchema.optional(),
  // I2: any supplied status is ignored; parsed here only so it is dropped.
  status: z.unknown().optional(),
});

const channelBodySchema = z.object({ name: z.string().min(1).max(64) });

const googleLoginBodySchema = z.object({ credential: z.string().min(1) });
// Bounds only; the real username rules (and their error codes) live in Auth.
const usernameBodySchema = z.object({
  signupToken: z.string().min(1),
  username: z.string().max(200),
});

const denyBodySchema = z.object({ reason: z.string().max(1000).optional() });
const blockBodySchema = z.object({ reason: z.string().min(1).max(1000) });
const patchBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  owner: z.string().nullable().optional(),
  scopePaths: scopePathsSchema.nullable().optional(),
});

const statusValues: ItemStatus[] = ["proposed", "denied", "approved", "in_progress", "blocked", "done"];

/** Present iff Google sign-in is configured; the two halves never part ways. */
export interface GoogleSignIn {
  clientId: string;
  auth: Auth;
}

export function createApiHandler(
  db: WorkspaceDb,
  service: BoardService,
  sessions: Sessions,
  channels: Channels,
  attachments: Attachments,
  corsOrigin: string,
  googleSignIn: GoogleSignIn | null = null,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;

    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-File-Name, X-Image-Width, X-Image-Height",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return true;
    }

    try {
      const method = req.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
      // Fetching an upload is deliberately unauthenticated: the unguessable
      // UUID in the path is the capability (the Discord-CDN model), and <img>
      // tags cannot send Authorization headers. Everything else stays gated.
      if (parts[1] === "health" && parts.length === 2 && method === "GET") {
        // Liveness for deploy platforms and container healthchecks; no auth.
        json(res, 200, { ok: true });
      } else if (parts[1] === "auth") {
        // Login endpoints are how a token is obtained, so they cannot demand one.
        await routeAuth(req, res, parts, googleSignIn);
      } else if (parts[1] === "uploads" && parts.length === 4 && (method === "GET" || method === "HEAD")) {
        serveUpload(res, attachments, parts[2], method === "HEAD");
      } else {
        const actor = authenticate(req, db, sessions);
        await route(req, res, parts, url, actor, service, db, channels, attachments);
      }
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
  parts: string[], // ["api", "board", "items", ...]
  url: URL,
  actor: Actor,
  service: BoardService,
  db: WorkspaceDb,
  channels: Channels,
  attachments: Attachments,
): Promise<void> {
  const method = req.method ?? "GET";

  // GET /api/actors — the member roster, for owner assignment and display.
  if (parts[1] === "actors" && parts.length === 2 && method === "GET") {
    return json(res, 200, { actors: db.listActors() });
  }

  // POST /api/channels — any signed-in human can add a channel.
  if (parts[1] === "channels" && parts.length === 2 && method === "POST") {
    const body = channelBodySchema.parse(await readBody(req));
    return json(res, 201, { channel: { name: channels.create(actor, body.name) } });
  }

  // POST /api/uploads — raw binary body; metadata rides in headers because
  // multipart would mean a whole parser for no extra capability.
  if (parts[1] === "uploads" && parts.length === 2 && method === "POST") {
    const bytes = await readRawBody(req, MAX_ATTACHMENT_BYTES);
    return json(res, 201, { attachment: attachments.save(actor, uploadMeta(req), bytes) });
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

/**
 * /api/auth/*: the pre-token surface. `config` tells clients which mode the
 * server runs in; the POST routes only exist once Google sign-in is
 * configured, and answer 409 AUTH_DISABLED in guest mode.
 */
async function routeAuth(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[], // ["api", "auth", ...]
  googleSignIn: GoogleSignIn | null,
): Promise<void> {
  const method = req.method ?? "GET";
  if (parts.length !== 3) throw new ApiError(404, "NOT_FOUND", "no such route");

  if (parts[2] === "config" && method === "GET") {
    return json(res, 200, { googleClientId: googleSignIn?.clientId ?? null });
  }
  if (method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`);
  if (!googleSignIn) {
    throw new ApiError(409, "AUTH_DISABLED", "this server runs in guest mode");
  }

  switch (parts[2]) {
    case "google": {
      const body = googleLoginBodySchema.parse(await readBody(req));
      return json(res, 200, await googleSignIn.auth.loginWithGoogle(body.credential));
    }
    case "username": {
      const body = usernameBodySchema.parse(await readBody(req));
      return json(res, 200, googleSignIn.auth.completeSignup(body.signupToken, body.username));
    }
    case "logout": {
      googleSignIn.auth.revoke(bearerToken(req) ?? "");
      return void res.writeHead(204).end();
    }
  }
  throw new ApiError(404, "NOT_FOUND", "no such route");
}

function authenticate(req: IncomingMessage, db: WorkspaceDb, sessions: Sessions): Actor {
  const token = bearerToken(req);
  const actorId = token ? sessions.resolve(token) : null;
  const actor = actorId ? db.getActor(actorId) : null;
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
  return actor;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/** GET/HEAD /api/uploads/:id/:name — the :name segment is URL aesthetics only. */
function serveUpload(
  res: ServerResponse,
  attachments: Attachments,
  id: string,
  headOnly: boolean,
): void {
  const found = attachments.get(id);
  if (!found) throw new ApiError(404, "NOT_FOUND", "no such upload");
  const { attachment, filePath } = found;
  res.writeHead(200, {
    "Content-Type": attachment.mime,
    "Content-Length": attachment.size,
    "Content-Disposition": `inline; filename="${attachment.name}"`,
    // The bytes at an id never change, so clients may cache forever.
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (headOnly) return void res.end();
  const stream = fs.createReadStream(filePath);
  // Headers are already sent; a missing/unreadable file can only abort.
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Upload metadata rides in headers; the body is the file bytes verbatim. */
function uploadMeta(req: IncomingMessage): { name: string; mime: string; width?: number; height?: number } {
  const contentType = req.headers["content-type"]?.split(";")[0].trim();
  const encodedName = req.headers["x-file-name"];
  let name = "file";
  if (typeof encodedName === "string" && encodedName) {
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      throw new ApiError(400, "BAD_FILE_NAME", "x-file-name must be URI-encoded");
    }
  }
  return {
    name,
    mime: contentType || "application/octet-stream",
    width: intHeader(req, "x-image-width"),
    height: intHeader(req, "x-image-height"),
  };
}

function intHeader(req: IncomingMessage, header: string): number | undefined {
  const raw = req.headers[header];
  if (typeof raw !== "string") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Stream-read a request body, rejecting as soon as the cap is crossed. */
async function readRawBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new ApiError(413, "TOO_LARGE", "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const raw = (await readRawBody(req, 256 * 1024)).toString("utf-8");
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
