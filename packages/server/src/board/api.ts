import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Actor, AgentProvider, ItemStatus } from "@workspace/shared";
import { ApiError, type BoardService } from "./BoardService";
import type { Sessions } from "./sessions";
import type { AgentInvites } from "../auth/AgentInvites";
import type { Auth } from "../auth/Auth";
import { MAX_ATTACHMENT_BYTES, type Attachments } from "../chat/Attachments";
import type { Channels } from "../chat/Channels";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, type MessageStore } from "../chat/MessageStore";
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
const channelPatchBodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

// Bounds only; the real username rules (and their error codes) live in Auth.
const usernameBodySchema = z.object({ username: z.string().max(200) });

const createAgentBodySchema = z.object({
  name: z.string().min(1).max(32),
  provider: z.enum(["claude", "codex"] as const),
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

/** Present iff Google and/or email sign-in is configured. */
export interface AuthGate {
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
  auth: Auth;
}

export function createApiHandler(
  db: WorkspaceDb,
  service: BoardService,
  sessions: Sessions,
  messages: MessageStore,
  channels: Channels,
  attachments: Attachments,
  corsOrigin: string,
  authGate: AuthGate | null = null,
  agentInvites: AgentInvites | null = null,
  onRevokeAgent: ((actorId: string) => void) | null = null,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;

    const allowedOrigin = resolveCorsOrigin(req, corsOrigin);
    if (!allowedOrigin) {
      if (req.method === "OPTIONS") {
        // Preflight for a disallowed origin: 204 with no ACAO — the browser
        // rejects it and never sends the real request.
        res.writeHead(204).end();
      } else {
        // A real request from a disallowed origin must fail LOUDLY. A silent
        // 204 here once counted as res.ok in clients and made a swallowed
        // username claim look successful (the prod Google-onboarding bounce).
        json(res, 403, { error: "ORIGIN_FORBIDDEN", message: "cross-origin requests from this origin are not allowed" });
      }
      return true;
    }
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
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
        await routeAuth(req, res, parts, url, authGate);
      } else if (parts[1] === "uploads" && parts.length === 4 && (method === "GET" || method === "HEAD")) {
        await serveUpload(res, attachments, parts[2], method === "HEAD");
      } else {
        const actor = await authenticate(req, db, sessions);
        await route(req, res, parts, url, actor, service, db, messages, channels, attachments, agentInvites, onRevokeAgent);
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
  messages: MessageStore,
  channels: Channels,
  attachments: Attachments,
  agentInvites: AgentInvites | null,
  onRevokeAgent: ((actorId: string) => void) | null,
): Promise<void> {
  const method = req.method ?? "GET";

  // GET /api/actors — the member roster, for owner assignment and display.
  if (parts[1] === "actors" && parts.length === 2 && method === "GET") {
    return json(res, 200, { actors: await db.listActors() });
  }

  // GET /api/agents — user-created agents that are still invited.
  if (parts[1] === "agents" && parts.length === 2 && method === "GET") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    return json(res, 200, { agents: await agentInvites.list() });
  }

  // POST /api/agents — create a new user-created agent invite (humans only).
  if (parts[1] === "agents" && parts.length === 2 && method === "POST") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can add agents");
    const body = createAgentBodySchema.parse(await readBody(req));
    const { invite, token } = await agentInvites.create(body.name, body.provider, actor);
    return json(res, 201, { ...invite, token });
  }

  // DELETE /api/agents/:id — revoke an agent invite (humans only).
  if (parts[1] === "agents" && parts.length === 3 && method === "DELETE") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can remove agents");
    const revoked = await agentInvites.revoke(parts[2]);
    if (!revoked) throw new ApiError(404, "NOT_FOUND", "no such agent invite");
    if (onRevokeAgent) onRevokeAgent(revoked.actorId);
    return json(res, 200, { ok: true });
  }

  // POST /api/channels — any signed-in human can add a channel.
  if (parts[1] === "channels" && parts.length === 2 && method === "POST") {
    const body = channelBodySchema.parse(await readBody(req));
    return json(res, 201, { channel: { name: await channels.create(actor, body.name) } });
  }

  // PATCH /api/channels/:name — rename and/or archive/pin, one field per call.
  if (parts[1] === "channels" && parts.length === 3 && method === "PATCH") {
    const name = decodeURIComponent(parts[2]);
    const body = channelPatchBodySchema.parse(await readBody(req));
    let current = name;
    if (body.name !== undefined) current = await channels.rename(actor, current, body.name);
    if (body.archived !== undefined) await channels.setArchived(actor, current, body.archived);
    if (body.pinned !== undefined) await channels.setPinned(actor, current, body.pinned);
    return json(res, 200, { channel: { name: current } });
  }

  // DELETE /api/channels/:name — also drops its message history.
  if (parts[1] === "channels" && parts.length === 3 && method === "DELETE") {
    const name = decodeURIComponent(parts[2]);
    await messages.clear(name);
    await channels.remove(actor, name);
    return json(res, 200, { ok: true });
  }

  // GET /api/messages?channel=&before=&limit= — an older page of chat
  // history than what the welcome frame's per-channel cap carried.
  if (parts[1] === "messages" && parts.length === 2 && method === "GET") {
    const channel = url.searchParams.get("channel");
    if (!channel) throw new ApiError(400, "BAD_CHANNEL", "channel is required");
    // Number(null) is 0, not NaN, so a missing `before` must be checked
    // before the numeric coercion or it would silently pass as "before 0".
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw === null ? NaN : Number(beforeRaw);
    if (!Number.isFinite(before)) {
      throw new ApiError(400, "BAD_BEFORE", "before must be a numeric timestamp");
    }
    return json(res, 200, { messages: await messages.olderPage(channel, before, historyLimit(url)) });
  }

  // POST /api/uploads — raw binary body; metadata rides in headers because
  // multipart would mean a whole parser for no extra capability.
  if (parts[1] === "uploads" && parts.length === 2 && method === "POST") {
    const bytes = await readRawBody(req, MAX_ATTACHMENT_BYTES);
    return json(res, 201, { attachment: await attachments.save(actor, uploadMeta(req), bytes) });
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
    const items = await service.list(actor.serverId, {
      status: (status as ItemStatus) ?? undefined,
      includeDeleted: url.searchParams.get("include_deleted") === "true",
    });
    return json(res, 200, { items });
  }

  // POST /api/board/items
  if (parts.length === 3 && method === "POST") {
    const body = createBodySchema.parse(await readBody(req));
    const item = await service.create(actor, body);
    return json(res, 201, { item });
  }

  const id = parts[3];
  if (!id) throw new ApiError(404, "NOT_FOUND", "no such route");

  // PATCH / DELETE /api/board/items/:id
  if (parts.length === 4) {
    if (method === "PATCH") {
      const body = patchBodySchema.parse(await readBody(req));
      return json(res, 200, { item: await service.edit(actor, id, body) });
    }
    if (method === "DELETE") {
      return json(res, 200, { item: await service.softDelete(actor, id) });
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`);
  }

  // GET /api/board/items/:id/events — the item's audit trail.
  if (parts.length === 5 && parts[4] === "events" && method === "GET") {
    return json(res, 200, { events: await service.events(actor.serverId, id) });
  }

  // POST /api/board/items/:id/<action>
  if (parts.length === 5 && method === "POST") {
    switch (parts[4]) {
      case "approve":
        return json(res, 200, { item: await service.approve(actor, id) });
      case "deny": {
        const body = denyBodySchema.parse(await readBody(req));
        return json(res, 200, { item: await service.deny(actor, id, body.reason) });
      }
      case "start":
        return json(res, 200, { item: await service.start(actor, id) });
      case "complete":
        return json(res, 200, { item: await service.complete(actor, id) });
      case "block": {
        const body = blockBodySchema.parse(await readBody(req));
        return json(res, 200, { item: await service.block(actor, id, body.reason) });
      }
      case "unblock":
        return json(res, 200, { item: await service.unblock(actor, id) });
      case "reopen":
        return json(res, 200, { item: await service.reopen(actor, id) });
    }
  }

  throw new ApiError(404, "NOT_FOUND", "no such route");
}

/**
 * /api/auth/*: the pre-token surface. `config` tells clients which modes the
 * server runs in. `session`/`username` both take the Supabase access token
 * as a Bearer header — there is no other credential left on the server side,
 * Supabase Auth issued it already — and re-verify it against Supabase on
 * every call, same as the WS join gate (joinPolicy.ts) does.
 */
async function routeAuth(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[], // ["api", "auth", ...]
  url: URL,
  authGate: AuthGate | null,
): Promise<void> {
  const method = req.method ?? "GET";
  if (parts.length !== 3) throw new ApiError(404, "NOT_FOUND", "no such route");

  if (parts[2] === "config" && method === "GET") {
    return json(res, 200, {
      googleAuthEnabled: authGate?.googleAuthEnabled ?? false,
      emailAuthEnabled: authGate?.emailAuthEnabled ?? false,
    });
  }
  if (!authGate) {
    throw new ApiError(409, "AUTH_DISABLED", "this server runs in guest mode");
  }

  // GET /api/auth/username-available?name= — unauthenticated on purpose:
  // usernames are public display names and the signup form probes them
  // before a session exists. Always 200; the verdict is in the body.
  if (parts[2] === "username-available" && method === "GET") {
    const name = url.searchParams.get("name") ?? "";
    // Same bound as usernameBodySchema: absurd lengths are just "invalid",
    // never a 4xx, so the form's probe loop stays a single code path.
    if (name.length > 200) return json(res, 200, { available: false, reason: "INVALID" });
    return json(res, 200, await authGate.auth.usernameAvailable(name));
  }

  if (parts[2] === "session" && method === "GET") {
    const jwt = bearerToken(req);
    if (!jwt) throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
    return json(res, 200, await authGate.auth.session(jwt));
  }
  if (parts[2] === "username" && method === "POST") {
    const jwt = bearerToken(req);
    if (!jwt) throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
    const body = usernameBodySchema.parse(await readBody(req));
    return json(res, 200, await authGate.auth.claimUsername(jwt, body.username));
  }
  throw new ApiError(404, "NOT_FOUND", "no such route");
}

async function authenticate(req: IncomingMessage, db: WorkspaceDb, sessions: Sessions): Promise<Actor> {
  const token = bearerToken(req);
  const actorId = token ? sessions.resolve(token) : null;
  const actor = actorId ? await db.getActor(actorId) : null;
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
  return actor;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/** GET/HEAD /api/uploads/:id/:name — the :name segment is URL aesthetics only. */
async function serveUpload(
  res: ServerResponse,
  attachments: Attachments,
  id: string,
  headOnly: boolean,
): Promise<void> {
  const found = await attachments.get(id);
  if (!found) throw new ApiError(404, "NOT_FOUND", "no such upload");
  const { attachment, blob } = found;
  res.writeHead(200, {
    "Content-Type": attachment.mime,
    "Content-Length": attachment.size,
    "Content-Disposition": `inline; filename="${attachment.name}"`,
    // The bytes at an id never change, so clients may cache forever.
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (headOnly) return void res.end();
  // blob.stream() is a web ReadableStream; Readable.fromWeb bridges it to
  // the Node stream `res` needs to be piped into.
  const stream = Readable.fromWeb(blob.stream() as Parameters<typeof Readable.fromWeb>[0]);
  // Headers are already sent; a missing/unreadable object can only abort.
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

/** Clamp ?limit= to [1, MAX_HISTORY_LIMIT]; missing or non-numeric falls
 *  back to the default rather than rejecting outright. */
function historyLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const n = raw === null ? DEFAULT_HISTORY_LIMIT : Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(n, MAX_HISTORY_LIMIT);
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

/**
 * Resolve the Access-Control-Allow-Origin header per request, or null for a
 * disallowed cross-origin caller. Ordering matters, learned the hard way:
 * browsers attach an Origin header to POST/PATCH/DELETE even on SAME-origin
 * requests, so same-origin must be recognized first (by comparing against
 * the request's own Host) — classifying those as cross-origin once silently
 * broke every browser POST in production. After that: no Origin header means
 * CORS is not in play (same-origin GET, curl, server-to-server); an explicit
 * CORS_ORIGIN allows exactly that origin; the "localhost-dev" default
 * mirrors any localhost/private-LAN origin so the Vite dev server works
 * regardless of which port it landed on.
 */
function resolveCorsOrigin(req: IncomingMessage, corsOrigin: string): string | null {
  if (corsOrigin === "*") return "*"; // explicit wildcard: allow everyone
  const origin = req.headers.origin;
  if (!origin) return corsOrigin === "localhost-dev" ? "http://localhost:5173" : corsOrigin;
  try {
    const parsed = new URL(origin);
    if (parsed.host === req.headers.host) return origin; // same-origin
    if (corsOrigin !== "localhost-dev") return origin === corsOrigin ? origin : null;
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.startsWith("192.168.") || host.startsWith("10.")) {
      return origin;
    }
  } catch { /* malformed Origin header — treat as disallowed */ }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
