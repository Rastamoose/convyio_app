import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type {
  Actor,
  AgentInvite,
  AgentProvider,
  EcosystemImpact,
  ItemStatus,
  ProjectAction,
  WorkCapability,
  WorkspaceInviteMaxAgeSeconds,
  WorkspaceInviteMaxUses,
  WorkspaceSnapshot,
  ContextKind,
  ContextScope,
} from "@workspace/shared";
import {
  DEFAULT_WORKSPACE_INVITE_OPTIONS,
  MAX_FILE_BYTES,
  WORK_CAPABILITIES,
  WORKSPACE_INVITE_MAX_AGE_SECONDS,
  WORKSPACE_INVITE_MAX_USES,
} from "@workspace/shared";
import { ApiError, type BoardService } from "./BoardService";
import type { PlanService } from "./PlanService";
import type { Sessions } from "./sessions";
import type { AgentInvites } from "../auth/AgentInvites";
import type { Auth } from "../auth/Auth";
import { secretsEqual } from "../auth/joinPolicy";
import { MAX_ATTACHMENT_BYTES, type Attachments } from "../chat/Attachments";
import type { Channels } from "../chat/Channels";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, type MessageStore } from "../chat/MessageStore";
import {
  DEFAULT_THREAD_EVENT_LIMIT,
  MAX_THREAD_EVENT_LIMIT,
  type ThreadEventStore,
} from "../chat/ThreadEventStore";
import type { WorkspaceDb } from "../db";
import type { AccountStore } from "../auth/AccountStore";
import type { WorkspaceAccess } from "../auth/WorkspaceAccess";
import type { WorkspaceRegistry } from "../WorkspaceRegistry";
import { RateLimiter } from "../auth/RateLimiter";
import type { WorkspaceRuntime } from "../WorkspaceRuntime";
import { NOODLE_AGENT } from "../managedAgents";
import { requestOrigin, websocketUrl } from "../requestOrigin";
import type { RunnerRuntime } from "../RunnerRuntime";
import type { WorkspaceSnapshotBuilder } from "../context/WorkspaceSnapshot";
import type { PromptEnvelopeBuilder } from "../context/PromptEnvelope";
import type { ContextNotes } from "../context/ContextNotes";
import type { ContextStore } from "../context/ContextStore";
import type { ResourceAccessStore } from "../context/ResourceAccessStore";
import type { ResourceManifestBuilder } from "../context/ResourceManifest";
import type { GitHub } from "../projects/GitHub";
import type { GitRepositories } from "../projects/GitRepositories";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ToolmanNodes } from "../projects/ToolmanNodes";
import type { ToolmanGateway } from "../projects/ToolmanGateway";
import type { ToolExecutionStore } from "../projects/ToolExecutionStore";

const scopePathsSchema = z.array(z.string().min(1).max(500)).max(50);
const capabilitiesSchema = z.array(z.enum(WORK_CAPABILITIES as [WorkCapability, ...WorkCapability[]])).max(3);

const createBodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  why: z.string().max(1000).optional(),
  effect: z.string().max(1000).optional(),
  scopePaths: scopePathsSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
  planId: z.string().min(1).max(128).optional(),
  projectId: z.string().min(1).max(128).nullable().optional(),
  owner: z.string().min(1).max(128).optional(),
  channel: z.string().min(1).max(64).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(500)).max(40).optional(),
  impactMap: z
    .object({
      protocol: z.enum(["affected", "na"]),
      server: z.enum(["affected", "na"]),
      client: z.enum(["affected", "na"]),
      agent: z.enum(["affected", "na"]),
      database: z.enum(["affected", "na"]),
      security: z.enum(["affected", "na"]),
      deploy: z.enum(["affected", "na"]),
      tests: z.enum(["affected", "na"]),
      demos: z.enum(["affected", "na"]),
      docs: z.enum(["affected", "na"]),
      notes: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  // I2: any supplied status is ignored; parsed here only so it is dropped.
  status: z.unknown().optional(),
});
const approveBodySchema = z.object({ owner: z.string().min(1).max(128).optional() });
const completeBodySchema = z.object({ evidence: z.string().min(1).max(4000).optional() });

const channelBodySchema = z.object({
  name: z.string().min(1).max(64),
  sectionId: z.string().min(1).max(64).nullable().optional(),
});
const channelPatchBodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  sectionId: z.string().min(1).max(64).nullable().optional(),
});
const channelSectionBodySchema = z.object({ name: z.string().min(1).max(64) });

// Bounds only; the real username rules (and their error codes) live in Auth.
const usernameBodySchema = z.object({ username: z.string().max(200) });
const workspaceBodySchema = z.object({ name: z.string().max(200) });
const accessRequestBodySchema = z.object({ message: z.string().max(500).optional() });
const accessDecisionBodySchema = z.object({ decision: z.enum(["approved", "denied"] as const) });
const memberRoleBodySchema = z.object({ role: z.enum(["owner", "member"] as const) });
const workspaceInviteBodySchema = z.object({
  maxAgeSeconds: z.custom<WorkspaceInviteMaxAgeSeconds>(
    (value) => WORKSPACE_INVITE_MAX_AGE_SECONDS.includes(value as WorkspaceInviteMaxAgeSeconds),
  ).default(DEFAULT_WORKSPACE_INVITE_OPTIONS.maxAgeSeconds),
  maxUses: z.custom<WorkspaceInviteMaxUses>(
    (value) => WORKSPACE_INVITE_MAX_USES.includes(value as WorkspaceInviteMaxUses),
  ).default(DEFAULT_WORKSPACE_INVITE_OPTIONS.maxUses),
});

const agentAccessSchema = z.object({
  mode: z.enum(["workspace", "creator", "selected"] as const),
  selectedActorIds: z.array(z.string().min(1).max(100)).max(100).default([]),
});
const createAgentBodySchema = z.object({
  name: z.string().min(1).max(32),
  provider: z.enum(["claude", "codex"] as const),
  instructions: z.string().max(20000).default(""),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  access: agentAccessSchema.default({ mode: "workspace", selectedActorIds: [] }),
});
const patchAgentBodySchema = z
  .object({
    instructions: z.string().max(20000).optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    access: agentAccessSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "at least one profile field is required" });
const pairingExchangeBodySchema = z.object({ pairingCode: z.string().min(1).max(256) });
const toolmanPairingBodySchema = z.object({ name: z.string().min(1).max(80) });
const toolmanMountBodySchema = z.object({
  mountKey: z.string().min(1).max(128),
  projectName: z.string().min(1).max(80),
  kind: z.enum(["git", "directory"]),
  remoteUrl: z.string().max(500).nullable().optional(),
  defaultBranch: z.string().max(200).nullable().optional(),
  headRevision: z.string().max(200).nullable().optional(),
  branch: z.string().max(200).nullable().optional(),
  cleanliness: z.enum(["clean", "dirty", "unknown"]).optional(),
});
const projectAccessBodySchema = z.object({ reason: z.string().min(1).max(1000) });
const protectedResourceKindSchema = z.enum(["channel", "git_project", "local_project", "workspace_file"]);
const resourceAccessBodySchema = z.object({
  resourceKind: protectedResourceKindSchema,
  resourceId: z.string().min(1).max(200),
  reason: z.string().min(1).max(1000),
  originChannelId: z.string().min(1).max(200).nullable().optional(),
});
const resourceAccessResolveBodySchema = z.object({ decision: z.enum(["approved", "denied"] as const) });
const contextNoteBodySchema = z.object({
  scope: z.enum(["workspace", "agent"] as const),
  agentId: z.string().min(1).max(200).nullable().optional(),
  body: z.string().min(1).max(4000),
});
const projectAssignBodySchema = z.object({
  agentId: z.string().min(1).max(128),
  mountId: z.string().min(1).max(128).nullable().optional(),
});
const projectAccessResolveBodySchema = z.object({
  decision: z.enum(["approved", "denied"]),
  mountId: z.string().min(1).max(128).nullable().optional(),
});
const folderAccessModeBodySchema = z.object({
  accessMode: z.enum(["ask", "always", "deny"]),
});
const projectFileBodySchema = z.object({
  mountId: z.string().min(1).max(128),
  path: z.string().min(1).max(1000),
  content: z.string().max(MAX_FILE_BYTES).optional(),
});
const gitRepositoryBodySchema = z.object({
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(401),
});
const gitSyncBodySchema = z.object({ operation: z.enum(["fetch", "pull", "push"]) });
const gitBranchBodySchema = z.object({
  name: z.string().min(1).max(200),
  startPoint: z.string().min(1).max(200).optional(),
});
const gitPullBodySchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(20_000).default(""),
  head: z.string().min(1).max(200),
  base: z.string().min(1).max(200),
});
const gitIssueBodySchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(20_000).default(""),
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

/** Collaborators the HTTP surface needs. Optional fields stay unset in tests that do not exercise that route. */
export interface ApiServices {
  db: WorkspaceDb;
  service: BoardService;
  sessions: Sessions;
  messages: MessageStore;
  threadEvents: ThreadEventStore;
  channels: Channels;
  attachments: Attachments;
  corsOrigin: string;
  authGate?: AuthGate | null;
  hostedAgentToken?: string | null;
  agentInvites?: AgentInvites | null;
  runnerRuntime?: RunnerRuntime | null;
  onUpdateAgent?: ((profile: AgentInvite) => void) | null;
  onRevokeAgent?: ((actorId: string) => void) | null;
  onRemoveMember?: ((actorId: string) => void) | null;
  onAddMember?: ((actorId: string) => void) | null;
  snapshot?: WorkspaceSnapshotBuilder | null;
  plans?: PlanService | null;
  envelope?: PromptEnvelopeBuilder | null;
  context?: ContextStore | null;
  notes?: ContextNotes | null;
  resourceAccess?: ResourceAccessStore | null;
  resourceManifest?: ResourceManifestBuilder | null;
  github?: GitHub | null;
  gitRepositories?: GitRepositories | null;
  projects?: ProjectStore | null;
  toolmanNodes?: ToolmanNodes | null;
  toolmanGateway?: ToolmanGateway | null;
  executions?: ToolExecutionStore | null;
  accounts?: AccountStore | null;
  workspaceAccess?: WorkspaceAccess | null;
  workspaceRegistry?: WorkspaceRegistry | null;
}

export function createApiHandler(services: ApiServices) {
  const {
    db,
    service,
    sessions,
    messages,
    threadEvents,
    channels,
    attachments,
    corsOrigin,
    authGate = null,
    hostedAgentToken = null,
    agentInvites = null,
    runnerRuntime = null,
    onUpdateAgent = null,
    onRevokeAgent = null,
    onRemoveMember = null,
    onAddMember = null,
    snapshot = null,
    plans = null,
    envelope = null,
    context = null,
    notes = null,
    resourceAccess = null,
    resourceManifest = null,
    github = null,
    gitRepositories = null,
    projects = null,
    toolmanNodes = null,
    toolmanGateway = null,
    executions = null,
    accounts = null,
    workspaceAccess = null,
    workspaceRegistry = null,
  } = services;
  const rateLimiter = new RateLimiter();
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
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
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
      enforceRateLimit(req, parts, method, rateLimiter);
      // Fetching an upload is deliberately unauthenticated: the unguessable
      // UUID in the path is the capability (the Discord-CDN model), and <img>
      // tags cannot send Authorization headers. Everything else stays gated.
      if (parts[1] === "health" && parts.length === 2 && method === "GET") {
        // Liveness for deploy platforms and container healthchecks; no auth.
        json(res, 200, { ok: true });
      } else if (
        parts[1] === "hosted-agent" &&
        parts[2] === "workspaces" &&
        parts.length === 3 &&
        method === "GET"
      ) {
        const token = bearerToken(req);
        if (!token || !hostedAgentToken || !secretsEqual(token, hostedAgentToken)) {
          throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        }
        const apiUrl = requestOrigin(req);
        const workspaces = await db.listManagedAgentWorkspaces(NOODLE_AGENT);
        json(res, 200, {
          workspaces: workspaces.map((workspace) => ({
            ...workspace,
            wsUrl: workspaceSocketUrl(apiUrl, workspace.id),
          })),
        });
      } else if (parts[1] === "auth") {
        // Login endpoints are how a token is obtained, so they cannot demand one.
        await routeAuth(req, res, parts, url, authGate);
      } else if (
        parts[1] === "git" &&
        parts[2] === "github" &&
        parts[3] === "callback" &&
        parts.length === 4 &&
        method === "GET"
      ) {
        if (!github) throw new ApiError(501, "GITHUB_UNAVAILABLE", "GitHub integration is not configured");
        const code = url.searchParams.get("code");
        const installationId = url.searchParams.get("installation_id");
        const state = url.searchParams.get("state");
        if (!state) throw new ApiError(400, "GITHUB_AUTH_FAILED", "GitHub did not return installation state");
        const pending = await github.pending(state);
        if (!pending) throw new ApiError(400, "OAUTH_STATE_INVALID", "GitHub connection expired or was already used; start again");
        // Carry the real reason back to the UI. A bare `?git=error` renders as
        // "connection was not completed", which is indistinguishable from
        // nothing happening — it hid a permanent 409 for days.
        const errorRedirect = (reason: string) => {
          const target = new URL(`/w/${encodeURIComponent(pending.workspaceId)}`, pending.returnOrigin);
          target.searchParams.set("git", "error");
          target.searchParams.set("gitReason", reason);
          return target.toString();
        };
        // installation_id only arrives when the visit created a new
        // installation; on every reconnect GitHub sends code + state alone and
        // complete() resolves the installation from the user's own token.
        if (!code && installationId) {
          // Setup-URL style callback (OAuth-during-installation off): the
          // installation exists but is unverified, so go get a code.
          res.writeHead(302, { Location: await github.reauthorize(state), "Cache-Control": "no-store" }).end();
        } else if (!code) {
          await github.cancel(state);
          res.writeHead(302, {
            Location: errorRedirect(url.searchParams.get("error_description") ?? "GitHub did not authorize the connection"),
            "Cache-Control": "no-store",
          }).end();
        } else {
          try {
            const completed = await github.complete(code, installationId, state);
            res.writeHead(302, {
              Location: completed.kind === "install"
                ? completed.url
                : new URL(`/w/${encodeURIComponent(completed.workspaceId)}?git=connected`, completed.returnOrigin).toString(),
              "Cache-Control": "no-store",
            }).end();
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            console.error(`[api] GitHub connect failed (${error.code}):`, error.message);
            res.writeHead(302, { Location: errorRedirect(error.message), "Cache-Control": "no-store" }).end();
          }
        }
      } else if (
        parts[1] === "account" ||
        parts[1] === "workspaces" ||
        parts[1] === "invites"
      ) {
        await routeAccount(req, res, parts, authGate, workspaceAccess, workspaceRegistry);
      } else if (
        parts[1] === "uploads" &&
        (parts.length === 4 || parts.length === 5) &&
        (method === "GET" || method === "HEAD")
      ) {
        const runtime = parts.length === 5 && workspaceRegistry
          ? await workspaceRegistry.get(parts[2])
          : null;
        if (parts.length === 5 && workspaceRegistry && !runtime) {
          throw new ApiError(404, "NOT_FOUND", "no such upload");
        }
        if (parts.length === 5 && !workspaceRegistry && parts[2] !== db.workspaceId) {
          throw new ApiError(404, "NOT_FOUND", "no such upload");
        }
        const uploadStore = runtime?.attachments ?? attachments;
        const uploadId = parts.length === 5 ? parts[3] : parts[2];
        await serveUpload(res, uploadStore, uploadId, method === "HEAD");
      } else if (
        parts[1] === "agent-pairings" &&
        parts[2] === "exchange" &&
        parts.length === 3 &&
        method === "POST"
      ) {
        const body = pairingExchangeBodySchema.parse(await readBody(req));
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForAgentPairing(body.pairingCode)
          : null;
        const invites = runtime?.agentInvites ?? agentInvites;
        const workspaceDb = runtime?.db ?? db;
        if (!invites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
        const exchanged = await invites.exchangePairing(body.pairingCode);
        if (!exchanged) throw new ApiError(401, "INVALID_PAIRING", "pairing code is invalid or expired");
        const apiUrl = requestOrigin(req);
        json(res, 200, {
          installation: exchanged.installation,
          installationToken: exchanged.installationToken,
          agent: exchanged.invite,
          workspace: { id: workspaceDb.workspaceId, name: workspaceDb.workspaceName },
          apiUrl,
          wsUrl: workspaceSocketUrl(apiUrl, workspaceDb.workspaceId),
        });
      } else if (
        parts[1] === "agent-installations" &&
        parts.length === 2 &&
        method === "DELETE"
      ) {
        // The installation token is the only credential the machine has.
        // Session-auth would let any human delete any runner; this only
        // forgets the credential that presented itself.
        const token = bearerToken(req);
        if (!token) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForAgentInstallation(token)
          : null;
        const invites = runtime?.agentInvites ?? agentInvites;
        if (!invites || !(await invites.revokeInstallation(token))) {
          throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        }
        json(res, 200, { ok: true });
      } else if (
        parts[1] === "toolman" &&
        parts[2] === "pairings" &&
        parts[3] === "exchange" &&
        parts.length === 4 &&
        method === "POST"
      ) {
        const body = pairingExchangeBodySchema.parse(await readBody(req));
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForToolmanPairing(body.pairingCode)
          : null;
        const nodes = runtime?.toolmanNodes ?? toolmanNodes;
        const workspaceDb = runtime?.db ?? db;
        if (!nodes) throw new ApiError(501, "NOT_IMPLEMENTED", "Toolman nodes are not available");
        const exchanged = await nodes.exchangePairing(body.pairingCode);
        if (!exchanged) throw new ApiError(401, "INVALID_PAIRING", "pairing code is invalid or expired");
        (runtime?.toolmanGateway ?? toolmanGateway)?.disconnect(exchanged.node.id);
        const apiUrl = requestOrigin(req);
        json(res, 200, {
          node: exchanged.node,
          installation: exchanged.installation,
          installationToken: exchanged.installationToken,
          workspace: { id: workspaceDb.workspaceId, name: workspaceDb.workspaceName },
          apiUrl,
          wsUrl: toolmanSocketUrl(apiUrl, workspaceDb.workspaceId),
        });
      } else if (
        parts[1] === "toolman" &&
        parts[2] === "installation" &&
        parts.length === 3 &&
        method === "GET"
      ) {
        const token = bearerToken(req);
        if (!token) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForToolmanInstallation(token)
          : null;
        const nodes = runtime?.toolmanNodes ?? toolmanNodes;
        const gateway = runtime?.toolmanGateway ?? toolmanGateway;
        const resolved = nodes ? await nodes.resolveInstallation(token) : null;
        if (!resolved) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        json(res, 200, {
          node: {
            ...resolved.node,
            health: gateway?.isOnline(resolved.node.id) ? "ready" : "offline",
          },
          mounts: (await nodes!.mountsForNode(resolved.node.id)).map((mount) => ({
            mountKey: mount.mountKey,
            projectId: mount.projectId,
          })),
        });
      } else if (
        parts[1] === "toolman" &&
        parts[2] === "installation" &&
        parts.length === 3 &&
        method === "DELETE"
      ) {
        const token = bearerToken(req);
        if (!token) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForToolmanInstallation(token)
          : null;
        const nodes = runtime?.toolmanNodes ?? toolmanNodes;
        const nodeId = nodes ? await nodes.revokeInstallation(token) : null;
        if (!nodeId) {
          throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        }
        (runtime?.toolmanGateway ?? toolmanGateway)?.disconnect(nodeId);
        json(res, 200, { ok: true });
      } else if (
        parts[1] === "toolman" &&
        parts[2] === "mounts" &&
        parts.length === 3 &&
        method === "POST"
      ) {
        const token = bearerToken(req);
        if (!token) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForToolmanInstallation(token)
          : null;
        const nodes = runtime?.toolmanNodes ?? toolmanNodes;
        if (!nodes) throw new ApiError(501, "NOT_IMPLEMENTED", "Toolman nodes are not available");
        const resolved = await nodes.resolveInstallation(token);
        if (!resolved) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        const body = toolmanMountBodySchema.parse(await readBody(req));
        json(res, 200, await nodes.registerMount(resolved.node.id, body));
      } else if (
        parts[1] === "toolman" &&
        parts[2] === "mounts" &&
        parts.length === 4 &&
        method === "DELETE"
      ) {
        const token = bearerToken(req);
        if (!token) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        const runtime = workspaceRegistry
          ? await workspaceRegistry.workspaceForToolmanInstallation(token)
          : null;
        const nodes = runtime?.toolmanNodes ?? toolmanNodes;
        const resolved = nodes ? await nodes.resolveInstallation(token) : null;
        if (!nodes || !resolved) throw new ApiError(401, "UNAUTHENTICATED", "missing or invalid token");
        json(res, 200, await nodes.removeMountFromNode(resolved.node.id, decodedPathPart(parts[3])));
      } else {
        const authenticated = await authenticate(req, db, sessions, workspaceRegistry);
        const scoped = authenticated.runtime
          ? runtimeRouteServices(authenticated.runtime, accounts, workspaceAccess, github)
          : {
              db,
              service,
              messages,
              threadEvents,
              channels,
              attachments,
              agentInvites,
              runnerRuntime,
              onUpdateAgent,
              onRevokeAgent,
              onRemoveMember,
              onAddMember,
              snapshot,
              plans,
              envelope,
              context,
              notes,
              resourceAccess,
              resourceManifest,
              github,
              gitRepositories,
              projects,
              toolmanNodes,
              toolmanGateway,
              executions,
              accounts,
              workspaceAccess,
            };
        await route(req, res, parts, url, authenticated.actor, scoped);
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

interface RouteServices {
  db: WorkspaceDb;
  service: BoardService;
  messages: MessageStore;
  threadEvents: ThreadEventStore;
  channels: Channels;
  attachments: Attachments;
  agentInvites: AgentInvites | null;
  runnerRuntime: RunnerRuntime | null;
  onUpdateAgent: ((profile: AgentInvite) => void) | null;
  onRevokeAgent: ((actorId: string) => void) | null;
  onRemoveMember: ((actorId: string) => void) | null;
  onAddMember: ((actorId: string) => void) | null;
  snapshot: WorkspaceSnapshotBuilder | null;
  plans: PlanService | null;
  envelope: PromptEnvelopeBuilder | null;
  context: ContextStore | null;
  notes: ContextNotes | null;
  resourceAccess: ResourceAccessStore | null;
  resourceManifest: ResourceManifestBuilder | null;
  github: GitHub | null;
  gitRepositories: GitRepositories | null;
  projects: ProjectStore | null;
  toolmanNodes: ToolmanNodes | null;
  toolmanGateway: ToolmanGateway | null;
  executions: ToolExecutionStore | null;
  accounts: AccountStore | null;
  workspaceAccess: WorkspaceAccess | null;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[], // ["api", "board", "items", ...]
  url: URL,
  actor: Actor,
  services: RouteServices,
): Promise<void> {
  const {
    db,
    service,
    messages,
    threadEvents,
    channels,
    attachments,
    agentInvites,
    runnerRuntime,
    onUpdateAgent,
    onRevokeAgent,
    onRemoveMember,
    onAddMember,
    snapshot,
    plans,
    envelope,
    context,
    notes,
    resourceAccess,
    resourceManifest,
    github,
    gitRepositories,
    projects,
    toolmanNodes,
    toolmanGateway,
    executions,
    accounts,
    workspaceAccess,
  } = services;
  const method = req.method ?? "GET";

  if (parts[1] === "workspace" && parts[2] === "members") {
    if (!accounts || !workspaceAccess) {
      throw new ApiError(501, "NOT_IMPLEMENTED", "workspace membership is not available");
    }
    if (parts.length === 3 && method === "GET") {
      return json(res, 200, { members: await accounts.listMembers(actor.workspaceId) });
    }
    const targetId = parts[3];
    if (!targetId) throw new ApiError(404, "NOT_FOUND", "no such member route");
    if (parts.length === 4 && method === "PATCH") {
      const body = memberRoleBodySchema.parse(await readBody(req));
      await workspaceAccess.setRole(actor.workspaceId, targetId, body.role, actor.id);
      return json(res, 200, { ok: true });
    }
    if (parts.length === 4 && method === "DELETE") {
      await workspaceAccess.removeMember(actor.workspaceId, targetId, actor.id);
      onRemoveMember?.(targetId);
      return json(res, 200, { ok: true });
    }
  }

  if (parts[1] === "workspace" && parts[2] === "noodle" && parts.length === 3) {
    if (!workspaceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "workspace membership is not available");
    if (method === "POST") {
      const restored = await workspaceAccess.restoreNoodle(actor.workspaceId, actor.id);
      onAddMember?.(restored.actorId);
      return json(res, 200, { actorId: restored.actorId, enabled: true });
    }
  }

  if (parts[1] === "workspace" && parts[2] === "access-requests") {
    if (!workspaceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "workspace access is not available");
    if (parts.length === 3 && method === "GET") {
      return json(res, 200, { requests: await workspaceAccess.listRequests(actor.workspaceId, actor.id) });
    }
    if (parts.length === 5 && parts[4] === "resolve" && method === "POST") {
      const body = accessDecisionBodySchema.parse(await readBody(req));
      const request = await workspaceAccess.resolveRequest(actor.workspaceId, parts[3], actor.id, body.decision);
      if (body.decision === "approved") onAddMember?.(request.requesterId);
      return json(res, 200, { request });
    }
  }

  if (parts[1] === "workspace" && parts[2] === "invites") {
    if (!workspaceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "workspace invites are not available");
    if (parts.length === 3 && method === "GET") {
      return json(res, 200, { invites: await workspaceAccess.listInvites(actor.workspaceId, actor.id) });
    }
    if (parts.length === 3 && method === "POST") {
      const body = workspaceInviteBodySchema.parse(await readBody(req));
      return json(res, 201, await workspaceAccess.createInvite(actor.workspaceId, actor.id, body));
    }
    if (parts.length === 4 && method === "DELETE") {
      const revoked = await workspaceAccess.revokeInvite(actor.workspaceId, parts[3], actor.id);
      if (!revoked) throw new ApiError(404, "INVITE_NOT_FOUND", "no active invite with that id");
      return json(res, 200, { ok: true });
    }
  }

  // GET /api/actors — the member roster, for owner assignment and display.
  if (parts[1] === "actors" && parts.length === 2 && method === "GET") {
    return json(res, 200, { actors: await db.listMembers() });
  }

  // DELETE /api/actors/:id — remove a human from the workspace (humans
  // only; a human cannot remove themselves). Agent removal has its own
  // flow (DELETE /api/agents/:id) because it also revokes an invite token.
  if (parts[1] === "actors" && parts.length === 3 && method === "DELETE") {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can remove members");
    const targetId = parts[2];
    const target = await db.getActor(targetId);
    if (!target || (target.kind !== "human" && target.managedAgent !== "noodle")) {
      throw new ApiError(404, "NOT_FOUND", "no such removable member");
    }
    if (workspaceAccess) {
      await workspaceAccess.removeMember(actor.workspaceId, targetId, actor.id);
    } else {
      if (targetId === actor.id) throw new ApiError(400, "CANNOT_REMOVE_SELF", "you cannot remove yourself");
      const removed = await db.removeMember(targetId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "not a workspace member");
    }
    onRemoveMember?.(targetId);
    return json(res, 200, { ok: true });
  }

  // GET /api/agents — user-created agents that are still invited.
  if (parts[1] === "agents" && parts.length === 2 && method === "GET") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    const agents = await agentInvites.list();
    return json(res, 200, {
      agents: agents.map((agent) => ({
        ...agent,
        runtime: runnerRuntime?.summary(agent.actorId, agent.configRevision) ?? {
          connected: false,
          health: "checking",
          configRevision: agent.configRevision,
          options: [],
        },
      })),
    });
  }

  // POST /api/agents — create a new user-created agent invite (humans only).
  if (parts[1] === "agents" && parts.length === 2 && method === "POST") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can add agents");
    const body = createAgentBodySchema.parse(await readBody(req));
    const { invite, token } = await agentInvites.create(body.name, body.provider, actor, {
      instructions: body.instructions,
      requestedModel: body.model,
      access: body.access,
    });
    const pairing = await agentInvites.createPairing(invite.id, actor);
    if (!pairing) throw new Error("new agent invite could not issue a pairing");
    return json(res, 201, { ...invite, token, ...pairing });
  }

  // PATCH /api/agents/:id — update profile configuration (humans only).
  if (parts[1] === "agents" && parts.length === 3 && method === "PATCH") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can configure agents");
    const body = patchAgentBodySchema.parse(await readBody(req));
    const updated = await agentInvites.update(parts[2], {
      instructions: body.instructions,
      requestedModel: body.model,
      access: body.access,
    });
    if (!updated) throw new ApiError(404, "NOT_FOUND", "no such agent invite");
    onUpdateAgent?.(updated);
    return json(res, 200, updated);
  }

  // POST /api/agents/:id/pairings — replace any unused pairing (humans only).
  if (parts[1] === "agents" && parts[3] === "pairings" && parts.length === 4 && method === "POST") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can pair agents");
    const pairing = await agentInvites.createPairing(parts[2], actor);
    if (!pairing) throw new ApiError(404, "NOT_FOUND", "no such agent invite");
    return json(res, 201, pairing);
  }

  // DELETE /api/agents/:id — revoke an agent invite (humans only). This
  // also drops the agent's workspace membership: an agent has no identity
  // outside the workspace that created it, so removal must fully retire
  // the name for reuse, not just the token (see findActorByName).
  if (parts[1] === "agents" && parts.length === 3 && method === "DELETE") {
    if (!agentInvites) throw new ApiError(501, "NOT_IMPLEMENTED", "agent invites are not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can remove agents");
    const revoked = await agentInvites.revoke(parts[2]);
    if (!revoked) throw new ApiError(404, "NOT_FOUND", "no such agent invite");
    await db.removeMember(revoked.actorId);
    if (onRevokeAgent) onRevokeAgent(revoked.actorId);
    return json(res, 200, { ok: true });
  }

  // POST /api/channels — any signed-in human can add a channel.
  if (parts[1] === "channels" && parts.length === 2 && method === "POST") {
    const body = channelBodySchema.parse(await readBody(req));
    const channel = await channels.create(actor, body.name, body.sectionId ?? null);
    return json(res, 201, { channel: { name: channel.name } });
  }

  // POST /api/channel-sections — create a shared sidebar section.
  if (parts[1] === "channel-sections" && parts.length === 2 && method === "POST") {
    const body = channelSectionBodySchema.parse(await readBody(req));
    const section = await channels.createSection(actor, body.name);
    return json(res, 201, { section });
  }

  // PATCH /api/channels/:name — rename and/or archive/pin/move, one field per call.
  if (parts[1] === "channels" && parts.length === 3 && method === "PATCH") {
    const name = decodeURIComponent(parts[2]);
    const body = channelPatchBodySchema.parse(await readBody(req));
    let current = name;
    if (body.name !== undefined) current = await channels.rename(actor, current, body.name);
    if (body.archived !== undefined) await channels.setArchived(actor, current, body.archived);
    if (body.pinned !== undefined) await channels.setPinned(actor, current, body.pinned);
    if (body.sectionId !== undefined) await channels.move(actor, current, body.sectionId);
    return json(res, 200, { channel: { name: current } });
  }

  // DELETE /api/channels/:name — also drops its message history.
  if (parts[1] === "channels" && parts.length === 3 && method === "DELETE") {
    const name = decodeURIComponent(parts[2]);
    if (actor.kind !== "human") {
      throw new ApiError(403, "FORBIDDEN", "only humans can manage channels");
    }
    const channel = await channels.get(name);
    if (!channel) throw new ApiError(404, "NOT_FOUND", `no such channel: ${name}`);
    if (name === "general") {
      throw new ApiError(400, "CHANNEL_FIXED", "the general channel cannot be changed");
    }
    await messages.clear(actor.id, channel);
    await channels.remove(actor, name);
    return json(res, 200, { ok: true });
  }

  const impactMapSchema = z.object({
    protocol: z.enum(["affected", "na"]),
    server: z.enum(["affected", "na"]),
    client: z.enum(["affected", "na"]),
    agent: z.enum(["affected", "na"]),
    database: z.enum(["affected", "na"]),
    security: z.enum(["affected", "na"]),
    deploy: z.enum(["affected", "na"]),
    tests: z.enum(["affected", "na"]),
    demos: z.enum(["affected", "na"]),
    docs: z.enum(["affected", "na"]),
    notes: z.record(z.string(), z.string()).default({}),
  });
  const planBodySchema = z.object({
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4000),
    outline: z.array(z.string().min(1).max(500)).min(1).max(40),
    impactMap: impactMapSchema.optional(),
    constraints: z.array(z.string().min(1).max(500)).max(40).optional(),
    decisions: z.array(z.string().min(1).max(500)).max(40).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).max(40).optional(),
    clarifications: z.array(z.string().min(1).max(1000)).max(20).optional(),
    channel: z.string().min(1).max(64).optional(),
    assumedOwnerId: z.string().min(1).max(128).optional(),
    assumedProjectId: z.string().min(1).max(128).optional(),
  });
  const planDecisionSchema = z.object({ decision: z.string().min(1).max(1000) });
  const planConstraintSchema = z.object({ constraint: z.string().min(1).max(500) });
  const contextBodySchema = z.object({
    kind: z.enum(["decision", "constraint", "fact", "blocker", "handoff", "summary"]),
    scope: z.enum(["workspace", "plan", "ticket", "channel"]),
    subjectId: z.string().min(1).max(128).optional(),
    body: z.string().min(1).max(2000),
  });

  if (parts[1] === "board" && parts[2] === "plans") {
    if (!plans) throw new ApiError(501, "NOT_IMPLEMENTED", "plans are not available");
    if (parts.length === 3 && method === "GET") {
      if (actor.kind === "agent" && snapshot) {
        return json(res, 200, { plans: (await snapshot.buildFor(actor, resourceAccess)).plans });
      }
      return json(res, 200, { plans: await plans.list(actor.workspaceId) });
    }
    if (parts.length === 3 && method === "POST") {
      const body = planBodySchema.parse(await readBody(req));
      return json(res, 201, { plan: await plans.create(actor, { ...body, impactMap: body.impactMap as EcosystemImpact | undefined }) });
    }
    const id = parts[3];
    if (!id) throw new ApiError(404, "NOT_FOUND", "no such route");
    if (parts.length === 4 && method === "GET") {
      const plan = actor.kind === "agent" && snapshot
        ? (await snapshot.buildFor(actor, resourceAccess)).plans.find((candidate) => candidate.id === id || candidate.ref === id)
        : await plans.find(actor.workspaceId, id);
      if (!plan) throw new ApiError(404, "PLAN_NOT_FOUND", `no plan ${id}`);
      return json(res, 200, { plan });
    }
    if (parts.length === 5 && method === "POST") {
      switch (parts[4]) {
        case "accept":
          return json(res, 200, { plan: await plans.accept(actor, id) });
        case "complete":
          return json(res, 200, { plan: await plans.complete(actor, id) });
        case "cancel":
          return json(res, 200, { plan: await plans.cancel(actor, id) });
        case "decisions": {
          const body = planDecisionSchema.parse(await readBody(req));
          return json(res, 200, { plan: await plans.appendDecision(actor, id, body.decision) });
        }
        case "constraints": {
          const body = planConstraintSchema.parse(await readBody(req));
          const plan = await plans.appendConstraint(actor, id, body.constraint);
          if (context) {
            await context.create({
              actorId: actor.id,
              kind: "constraint",
              scope: "plan",
              subjectId: plan.id,
              body: body.constraint,
              channelId: plan.originChannelId ?? null,
            });
          }
          return json(res, 200, { plan });
        }
        default:
          throw new ApiError(404, "NOT_FOUND", "no such route");
      }
    }
    throw new ApiError(404, "NOT_FOUND", "no such route");
  }

  if (parts[1] === "context" && parts.length === 2) {
    if (!context) throw new ApiError(501, "NOT_IMPLEMENTED", "context is not available");
    if (method === "GET") {
      if (actor.kind === "agent" && snapshot) {
        return json(res, 200, { context: (await snapshot.buildFor(actor, resourceAccess)).context });
      }
      return json(res, 200, { context: await context.listActive() });
    }
    if (method === "POST") {
      const body = contextBodySchema.parse(await readBody(req));
      return json(res, 201, {
        entry: await context.create({
          actorId: actor.id,
          kind: body.kind as ContextKind,
          scope: body.scope as ContextScope,
          subjectId: body.subjectId,
          body: body.body,
        }),
      });
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`);
  }

  if (parts[1] === "context" && parts[2] === "notes" && parts.length === 3) {
    if (!notes) throw new ApiError(501, "NOT_IMPLEMENTED", "context notes are not available");
    if (method === "GET") return json(res, 200, { notes: await notes.listFor(actor) });
    if (method === "POST") {
      const body = contextNoteBodySchema.parse(await readBody(req));
      return json(res, 201, { note: await notes.create(actor, body) });
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", `${method} not allowed`);
  }

  if (parts[1] === "agent-context" && parts[2] === "manifest" && parts.length === 3 && method === "GET") {
    if (!resourceManifest) throw new ApiError(501, "NOT_IMPLEMENTED", "resource manifest is not available");
    if (actor.kind !== "agent") throw new ApiError(403, "AGENT_ONLY", "resource manifests are agent-scoped");
    return json(res, 200, { manifest: await resourceManifest.build(actor) });
  }

  if (parts[1] === "agent-context" && parts[2] === "channels" && parts.length === 5 && method === "GET") {
    if (!resourceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "resource access is not available");
    if (actor.kind !== "agent") throw new ApiError(403, "AGENT_ONLY", "agent context is agent-scoped");
    const channel = await channels.getById(parts[3]);
    if (!channel) throw new ApiError(404, "NOT_FOUND", "no such channel");
    if (!(await resourceAccess.has(actor.id, "channel", channel.id))) {
      throw new ApiError(403, "RESOURCE_ACCESS_REQUIRED", "channel access is required");
    }
    if (parts[4] === "messages") {
      const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(before)) throw new ApiError(400, "BAD_BEFORE", "before must be numeric");
      return json(res, 200, { messages: await messages.olderPage(channel.name, before, Math.min(historyLimit(url), 20)) });
    }
    if (parts[4] === "search") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query || query.length > 200) throw new ApiError(400, "BAD_QUERY", "q must be 1-200 characters");
      return json(res, 200, { messages: await messages.search(channel.id, query, Math.min(historyLimit(url), 20)) });
    }
  }

  if (parts[1] === "agent-context" && parts[2] === "access-requests") {
    if (!resourceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "resource access is not available");
    if (parts.length === 3 && method === "POST") {
      const body = resourceAccessBodySchema.parse(await readBody(req));
      return json(res, 201, { request: await resourceAccess.request(actor, body) });
    }
    if (parts.length === 5 && parts[4] === "resolve" && method === "POST") {
      const body = resourceAccessResolveBodySchema.parse(await readBody(req));
      return json(res, 200, { request: await resourceAccess.resolve(actor, parts[3], body.decision) });
    }
  }

  if (parts[1] === "resource-access-requests" && parts.length === 2 && method === "GET") {
    if (!resourceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "resource access is not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can inspect resource access requests");
    return json(res, 200, { requests: await resourceAccess.pendingRequests() });
  }

  if (parts[1] === "agents" && parts[3] === "resource-access" && parts.length === 4 && method === "GET") {
    if (!resourceAccess || !resourceManifest) throw new ApiError(501, "NOT_IMPLEMENTED", "resource access is not available");
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can inspect agent access");
    const target = await db.getActor(parts[2]);
    if (!target || target.kind !== "agent") throw new ApiError(404, "NOT_FOUND", "no such agent");
    return json(res, 200, {
      manifest: await resourceManifest.build(target),
      grants: await resourceAccess.grantsForAgent(target.id),
      requests: await resourceAccess.requestsForAgent(target.id),
    });
  }

  if (parts[1] === "agents" && parts[3] === "resource-grants" && parts.length === 5 && method === "DELETE") {
    if (!resourceAccess) throw new ApiError(501, "NOT_IMPLEMENTED", "resource access is not available");
    const grants = await resourceAccess.grantsForAgent(parts[2]);
    if (!grants.some((grant) => grant.id === parts[4])) throw new ApiError(404, "NOT_FOUND", "no such agent grant");
    return json(res, 200, { grant: await resourceAccess.revoke(actor, parts[4]) });
  }

  // GET /api/workspace/snapshot — cursor-bearing board + context projection.
  if (parts[1] === "workspace" && parts[2] === "snapshot" && parts.length === 3 && method === "GET") {
    if (!snapshot) throw new ApiError(501, "NOT_IMPLEMENTED", "workspace snapshot is not available");
    const body: WorkspaceSnapshot = await snapshot.buildFor(actor, resourceAccess);
    return json(res, 200, body);
  }

  // GET /api/workspace/prompt-envelope — typed policy + board context for a run.
  if (parts[1] === "workspace" && parts[2] === "prompt-envelope" && parts.length === 3 && method === "GET") {
    if (!envelope) throw new ApiError(501, "NOT_IMPLEMENTED", "prompt envelope is not available");
    return json(res, 200, { envelope: await envelope.build(actor) });
  }

  // GET /api/thread/events?channel_id=&before_seq=&limit= — canonical
  // channel activity, newest page returned in ascending sequence order.
  if (parts[1] === "thread" && parts[2] === "events" && parts.length === 3 && method === "GET") {
    const channelId = url.searchParams.get("channel_id");
    if (!channelId) throw new ApiError(400, "BAD_CHANNEL_ID", "channel_id is required");
    if (actor.kind === "agent" && resourceAccess && !(await resourceAccess.has(actor.id, "channel", channelId))) {
      throw new ApiError(403, "RESOURCE_ACCESS_REQUIRED", "channel access is required");
    }
    const beforeSeq = optionalPositiveInt(url, "before_seq", "BAD_BEFORE_SEQ");
    return json(res, 200, {
      events: await threadEvents.list({
        workspaceId: actor.workspaceId,
        channelId,
        beforeSeq,
        limit: threadEventLimit(url),
      }),
    });
  }

  // GET /api/messages?channel=&before=&limit= — an older page of chat
  // history than what the welcome frame's per-channel cap carried.
  if (parts[1] === "messages" && parts.length === 2 && method === "GET") {
    const channel = url.searchParams.get("channel");
    if (!channel) throw new ApiError(400, "BAD_CHANNEL", "channel is required");
    const channelInfo = await channels.get(channel);
    if (!channelInfo) throw new ApiError(404, "NOT_FOUND", "no such channel");
    if (actor.kind === "agent" && resourceAccess && !(await resourceAccess.has(actor.id, "channel", channelInfo.id))) {
      throw new ApiError(403, "RESOURCE_ACCESS_REQUIRED", "channel access is required");
    }
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

  if (parts[1] === "git") {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "agents access repositories through Toolman");
    if (!github) throw new ApiError(501, "GITHUB_UNAVAILABLE", "GitHub integration is not configured");
    if (parts[2] === "account" && parts.length === 3 && method === "GET") {
      return json(res, 200, { available: github.available, account: await github.account(actor.id) });
    }
    if (parts[2] === "account" && parts.length === 3 && method === "DELETE") {
      await github.disconnect(actor);
      return json(res, 200, { ok: true });
    }
    if (parts[2] === "github" && parts[3] === "authorize" && parts.length === 4 && method === "POST") {
      return json(res, 200, { url: await github.authorize(actor, actor.workspaceId, requestOrigin(req), browserReturnOrigin(req)) });
    }
    if (parts[2] === "available-repositories" && parts.length === 3 && method === "GET") {
      return json(res, 200, { repositories: await github.repositories(actor.id) });
    }
    if (parts[2] === "repositories") {
      if (!gitRepositories) throw new ApiError(501, "NOT_IMPLEMENTED", "Git repositories are not available");
      if (parts.length === 3 && method === "GET") {
        return json(res, 200, { repositories: await gitRepositories.list() });
      }
      if (parts.length === 3 && method === "POST") {
        const body = gitRepositoryBodySchema.parse(await readBody(req));
        return json(res, 201, { repository: await gitRepositories.link(actor, body.fullName) });
      }
      const projectId = parts[3];
      if (!projectId) throw new ApiError(404, "NOT_FOUND", "no such Git route");
      if (parts.length === 4 && method === "GET") {
        const repository = await gitRepositories.find(projectId);
        if (!repository) throw new ApiError(404, "NOT_FOUND", "no such linked repository");
        return json(res, 200, { repository });
      }
      if (parts.length === 4 && method === "DELETE") {
        await gitRepositories.unlink(actor, projectId);
        return json(res, 200, { ok: true });
      }
      if (parts[4] === "retry" && parts.length === 5 && method === "POST") {
        return json(res, 200, { repository: await gitRepositories.retry(actor, projectId) });
      }
      if (parts[4] === "sync" && parts.length === 5 && method === "POST") {
        const body = gitSyncBodySchema.parse(await readBody(req));
        return json(res, 200, { repository: await gitRepositories.sync(actor, projectId, body.operation) });
      }
      if (parts[4] === "branches" && parts.length === 5 && method === "GET") {
        return json(res, 200, { branches: await gitRepositories.branches(projectId) });
      }
      if (parts[4] === "branches" && parts.length === 5 && method === "POST") {
        const body = gitBranchBodySchema.parse(await readBody(req));
        return json(res, 201, { repository: await gitRepositories.createBranch(actor, projectId, body.name, body.startPoint) });
      }
      if (parts[4] === "branches" && parts.length === 6 && method === "DELETE") {
        return json(res, 200, { repository: await gitRepositories.deleteBranch(actor, projectId, decodedPathPart(parts[5])) });
      }
      if (parts[4] === "commits" && parts.length === 5 && method === "GET") {
        return json(res, 200, { commits: await gitRepositories.commits(projectId, url.searchParams.get("ref") ?? undefined) });
      }
      if (parts[4] === "tree" && parts.length === 5 && method === "GET") {
        return json(res, 200, {
          entries: await gitRepositories.tree(
            projectId,
            url.searchParams.get("ref") ?? undefined,
            url.searchParams.get("path") ?? undefined,
            gitSource(url.searchParams.get("source")),
          ),
        });
      }
      if (parts[4] === "file" && parts.length === 5 && method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) throw new ApiError(400, "BAD_PATH", "path is required");
        return json(res, 200, {
          content: await gitRepositories.file(
            projectId,
            filePath,
            url.searchParams.get("ref") ?? undefined,
            gitSource(url.searchParams.get("source")),
          ),
        });
      }
      if (parts[4] === "pulls" && parts.length === 5 && method === "GET") {
        const state = gitListState(url.searchParams.get("state"));
        return json(res, 200, { pulls: await gitRepositories.pulls(projectId, state) });
      }
      if (parts[4] === "pulls" && parts.length === 5 && method === "POST") {
        const body = gitPullBodySchema.parse(await readBody(req));
        return json(res, 201, { pull: await gitRepositories.createPull(actor, projectId, body) });
      }
      if (parts[4] === "pulls" && parts.length === 7 && method === "GET") {
        const number = gitNumber(parts[5]);
        if (parts[6] === "files") return json(res, 200, { files: await gitRepositories.pullFiles(projectId, number) });
        if (parts[6] === "checks") return json(res, 200, { checks: await gitRepositories.pullChecks(projectId, number) });
      }
      if (parts[4] === "pulls" && parts.length === 7 && method === "POST") {
        const number = gitNumber(parts[5]);
        if (parts[6] === "approve") {
          await gitRepositories.approvePull(actor, projectId, number);
          return json(res, 200, { ok: true });
        }
        if (parts[6] === "merge") {
          await gitRepositories.mergePull(actor, projectId, number);
          return json(res, 200, { ok: true });
        }
      }
      if (parts[4] === "issues" && parts.length === 5 && method === "GET") {
        const state = gitListState(url.searchParams.get("state"));
        return json(res, 200, { issues: await gitRepositories.issues(projectId, state) });
      }
      if (parts[4] === "issues" && parts.length === 5 && method === "POST") {
        const body = gitIssueBodySchema.parse(await readBody(req));
        return json(res, 201, { issue: await gitRepositories.createIssue(actor, projectId, body.title, body.body) });
      }
      throw new ApiError(404, "NOT_FOUND", "no such Git route");
    }
    throw new ApiError(404, "NOT_FOUND", "no such Git route");
  }

  if (parts[1] === "projects") {
    if (!projects) throw new ApiError(501, "NOT_IMPLEMENTED", "projects are not available");
    if (parts.length === 2 && method === "GET") {
      return json(res, 200, { projects: await projects.list() });
    }
    if (parts.length === 3 && method === "GET") {
      const project = await projects.find(parts[2]);
      if (!project) throw new ApiError(404, "NOT_FOUND", "no such project");
      return json(res, 200, {
        project,
        assignments: await projects.listAssignments(project.id),
        mounts: toolmanNodes ? await toolmanNodes.mountsForProject(project.id) : [],
      });
    }
    if (parts.length === 4 && parts[3] === "files" && method === "GET") {
      const mountId = requiredSearchParam(url, "mountId");
      const filePath = url.searchParams.get("path") ?? ".";
      const output = await executeOwnedProjectAction(
        actor,
        parts[2],
        mountId,
        { kind: "project_list_files", projectId: parts[2], path: filePath },
        projects,
        toolmanNodes,
        toolmanGateway,
      );
      return json(res, 200, { entries: output === "(empty)" ? [] : output.split("\n") });
    }
    if (parts.length === 4 && parts[3] === "file" && method === "GET") {
      const mountId = requiredSearchParam(url, "mountId");
      const filePath = requiredSearchParam(url, "path");
      const output = await executeOwnedProjectAction(
        actor,
        parts[2],
        mountId,
        { kind: "project_read_file", projectId: parts[2], path: filePath },
        projects,
        toolmanNodes,
        toolmanGateway,
      );
      return json(res, 200, { content: output });
    }
    if (parts.length === 4 && parts[3] === "file" && (method === "PUT" || method === "DELETE")) {
      const body = projectFileBodySchema.parse(await readBody(req));
      if (method === "PUT" && body.content === undefined) {
        throw new ApiError(400, "CONTENT_REQUIRED", "content is required");
      }
      const action: ProjectAction = method === "PUT"
        ? { kind: "project_write_file", projectId: parts[2], path: body.path, content: body.content! }
        : { kind: "project_delete_file", projectId: parts[2], path: body.path };
      const output = await executeOwnedProjectAction(
        actor,
        parts[2],
        body.mountId,
        action,
        projects,
        toolmanNodes,
        toolmanGateway,
      );
      return json(res, 200, { ok: true, output });
    }
    if (parts.length === 5 && parts[3] === "mounts" && method === "DELETE") {
      if (!toolmanNodes) throw new ApiError(501, "NOT_IMPLEMENTED", "Toolman nodes are not available");
      return json(res, 200, await toolmanNodes.removeMount(actor, parts[2], parts[4]));
    }
    if (parts.length === 3 && method === "DELETE") {
      return json(res, 200, { project: await projects.archive(actor, parts[2]) });
    }
    if (parts.length === 4 && parts[3] === "access-mode" && method === "POST") {
      const body = folderAccessModeBodySchema.parse(await readBody(req));
      return json(res, 200, { project: await projects.setAccessMode(actor, parts[2], body.accessMode) });
    }
    if (parts.length === 4 && parts[3] === "assignments" && method === "POST") {
      const body = projectAssignBodySchema.parse(await readBody(req));
      return json(res, 201, {
        assignment: await projects.assign(actor, { projectId: parts[2], ...body }),
      });
    }
    if (parts.length === 5 && parts[3] === "assignments" && method === "DELETE") {
      await projects.revoke(actor, parts[2], parts[4]);
      return json(res, 200, { ok: true });
    }
    if (parts.length === 4 && parts[3] === "access-requests" && method === "POST") {
      const body = projectAccessBodySchema.parse(await readBody(req));
      return json(res, 201, { request: await projects.requestAccess(actor, parts[2], body.reason) });
    }
    throw new ApiError(404, "NOT_FOUND", "no such route");
  }

  if (parts[1] === "tool-executions" && parts.length === 2 && method === "GET") {
    if (!executions) throw new ApiError(501, "NOT_IMPLEMENTED", "executions are not available");
    return json(res, 200, { executions: await executions.listRecent() });
  }
  if (
    parts[1] === "tool-executions" &&
    parts[3] === "artifact" &&
    parts.length === 5 &&
    method === "GET"
  ) {
    if (!executions) throw new ApiError(501, "NOT_IMPLEMENTED", "executions are not available");
    if (parts[4] !== "input" && parts[4] !== "output") {
      throw new ApiError(404, "NOT_FOUND", "no such artifact");
    }
    const found = await executions.readArtifact(parts[2], parts[4]);
    if (!found) throw new ApiError(404, "NOT_FOUND", "artifact expired or missing");
    res.writeHead(200, {
      "Content-Type": found.contentType,
      "Content-Length": found.bytes.length,
      "Cache-Control": "private, max-age=60",
    });
    res.end(found.bytes);
    return;
  }

  if (parts[1] === "agent-project-access" && parts.length === 2 && method === "GET") {
    if (!projects) throw new ApiError(501, "NOT_IMPLEMENTED", "projects are not available");
    return json(res, 200, { projects: await projects.agentAccess(actor) });
  }

  if (parts[1] === "project-access-requests") {
    if (!projects) throw new ApiError(501, "NOT_IMPLEMENTED", "projects are not available");
    if (parts.length === 2 && method === "GET") {
      return json(res, 200, { requests: await projects.pendingAccess(actor) });
    }
    if (parts.length === 4 && parts[3] === "resolve" && method === "POST") {
      const body = projectAccessResolveBodySchema.parse(await readBody(req));
      return json(res, 200, {
        request: await projects.resolveAccess(actor, parts[2], body.decision, body.mountId),
      });
    }
    throw new ApiError(404, "NOT_FOUND", "no such route");
  }

  if (parts[1] === "toolman") {
    if (!toolmanNodes) throw new ApiError(501, "NOT_IMPLEMENTED", "Toolman nodes are not available");
    if (parts[2] === "nodes" && parts.length === 3 && method === "GET") {
      const nodes = await toolmanNodes.list();
      return json(res, 200, {
        nodes: nodes.map((node) => node.revokedAt
          ? node
          : { ...node, health: toolmanGateway?.isOnline(node.id) ? "ready" : "offline" }),
      });
    }
    if (parts[2] === "pairings" && parts.length === 3 && method === "POST") {
      const body = toolmanPairingBodySchema.parse(await readBody(req));
      return json(res, 201, await toolmanNodes.createPairing(actor, body.name));
    }
    if (parts[2] === "nodes" && parts.length === 5 && parts[4] === "revoke" && method === "POST") {
      const node = await toolmanNodes.revoke(actor, parts[3]);
      toolmanGateway?.disconnect(node.id);
      return json(res, 200, { node });
    }
    if (parts[2] === "nodes" && parts.length === 5 && parts[4] === "permanent" && method === "DELETE") {
      const node = await toolmanNodes.removeNode(actor, parts[3]);
      toolmanGateway?.disconnect(node.id);
      return json(res, 200, { node });
    }
    if (parts[2] === "nodes" && parts.length === 4 && method === "DELETE") {
      const node = await toolmanNodes.revoke(actor, parts[3]);
      toolmanGateway?.disconnect(node.id);
      return json(res, 200, { node });
    }
    throw new ApiError(404, "NOT_FOUND", "no such route");
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
    const items = actor.kind === "agent" && snapshot
      ? (await snapshot.buildFor(actor, resourceAccess)).items.filter((item) => !status || item.status === status)
      : await service.list(actor.workspaceId, {
          status: (status as ItemStatus) ?? undefined,
          includeDeleted: url.searchParams.get("include_deleted") === "true",
        });
    return json(res, 200, { items });
  }

  // POST /api/board/items
  if (parts.length === 3 && method === "POST") {
    const body = createBodySchema.parse(await readBody(req));
    const item = await service.create(actor, {
      ...body,
      impactMap: body.impactMap && typeof body.impactMap === "object" ? body.impactMap as import("@workspace/shared").EcosystemImpact : undefined,
    });
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
    return json(res, 200, { events: await service.events(actor.workspaceId, id) });
  }

  // POST /api/board/items/:id/<action>
  if (parts.length === 5 && method === "POST") {
    switch (parts[4]) {
      case "approve": {
        const body = approveBodySchema.parse(await readBody(req).catch(() => ({})));
        return json(res, 200, { item: await service.approve(actor, id, body.owner) });
      }
      case "deny": {
        const body = denyBodySchema.parse(await readBody(req));
        return json(res, 200, { item: await service.deny(actor, id, body.reason) });
      }
      case "start":
        return json(res, 200, { item: await service.start(actor, id) });
      case "complete": {
        const body = completeBodySchema.parse(await readBody(req).catch(() => ({})));
        return json(res, 200, { item: await service.complete(actor, id, body.evidence) });
      }
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

async function routeAccount(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  authGate: AuthGate | null,
  workspaceAccess: WorkspaceAccess | null,
  workspaceRegistry: WorkspaceRegistry | null,
): Promise<void> {
  if (!authGate || !workspaceAccess) {
    throw new ApiError(501, "NOT_IMPLEMENTED", "workspace accounts are not available");
  }
  const method = req.method ?? "GET";
  if (parts[1] === "invites" && parts.length === 3 && method === "GET") {
    const preview = await workspaceAccess.previewInvite(parts[2]);
    if (!preview) throw new ApiError(410, "INVITE_UNAVAILABLE", "this invite is invalid, expired, or no longer available");
    return json(res, 200, preview);
  }
  const jwt = bearerToken(req);
  if (!jwt) throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
  if (parts[1] === "account" && parts.length === 2 && method === "GET") {
    const account = await authGate.auth.session(jwt);
    const requests = account.status === "ok"
      ? await workspaceAccess.listRequestsForActor((await authGate.auth.identity(jwt)).id)
      : [];
    return json(res, 200, { ...account, accessRequests: requests });
  }
  if (parts[1] === "account" && parts[2] === "access-requests" && parts.length === 3 && method === "GET") {
    const actor = await authGate.auth.identity(jwt);
    return json(res, 200, { requests: await workspaceAccess.listRequestsForActor(actor.id) });
  }
  if (parts[1] === "workspaces" && parts.length === 2 && method === "POST") {
    const actor = await authGate.auth.identity(jwt);
    const body = workspaceBodySchema.parse(await readBody(req));
    return json(res, 201, { workspace: await workspaceAccess.createWorkspace(actor, body.name) });
  }
  if (parts[1] === "workspaces" && parts[2] === "lookup" && parts.length === 4 && method === "GET") {
    await authGate.auth.identity(jwt);
    const workspace = await workspaceAccess.lookup(parts[3]);
    if (!workspace) throw new ApiError(404, "WORKSPACE_NOT_FOUND", "no workspace has that code");
    return json(res, 200, { workspace });
  }
  if (parts[1] === "workspaces" && parts[3] === "access-requests" && parts.length === 4 && method === "POST") {
    const actor = await authGate.auth.identity(jwt);
    const body = accessRequestBodySchema.parse(await readBody(req));
    return json(res, 201, { request: await workspaceAccess.requestAccess(actor, parts[2], body.message) });
  }
  if (parts[1] === "invites" && parts[3] === "accept" && parts.length === 4 && method === "POST") {
    const actor = await authGate.auth.identity(jwt);
    const workspace = await workspaceAccess.acceptInvite(actor, parts[2]);
    await workspaceRegistry?.addOfflineMember(workspace.id, actor.id);
    return json(res, 200, { workspace });
  }
  throw new ApiError(404, "NOT_FOUND", "no such account route");
}

function runtimeRouteServices(
  runtime: WorkspaceRuntime,
  accounts: AccountStore | null,
  workspaceAccess: WorkspaceAccess | null,
  github: GitHub | null,
): RouteServices {
  return {
    db: runtime.db,
    service: runtime.board,
    messages: runtime.messages,
    threadEvents: runtime.threadEvents,
    channels: runtime.channels,
    attachments: runtime.attachments,
    agentInvites: runtime.agentInvites,
    runnerRuntime: runtime.runnerRuntime,
    onUpdateAgent: (profile) => runtime.updateAgent(profile),
    onRevokeAgent: (actorId) => runtime.hub.closeAgentConnection(actorId),
    onRemoveMember: (actorId) => {
      runtime.hub.closeAgentConnection(actorId);
      runtime.hub.closeHumanConnection(actorId);
    },
    onAddMember: (actorId) => void runtime.hub.addOfflineMember(actorId),
    snapshot: runtime.snapshot,
    plans: runtime.plans,
    envelope: runtime.envelope,
    context: runtime.context,
    notes: runtime.notes,
    resourceAccess: runtime.resourceAccess,
    resourceManifest: runtime.resourceManifest,
    github,
    gitRepositories: runtime.gitRepositories,
    projects: runtime.projects,
    toolmanNodes: runtime.toolmanNodes,
    toolmanGateway: runtime.toolmanGateway,
    executions: runtime.executions,
    accounts,
    workspaceAccess,
  };
}

async function authenticate(
  req: IncomingMessage,
  db: WorkspaceDb,
  sessions: Sessions,
  registry: WorkspaceRegistry | null,
): Promise<{ actor: Actor; runtime: WorkspaceRuntime | null }> {
  const token = bearerToken(req);
  const session = token ? sessions.resolve(token) : null;
  if (!session) throw new ApiError(401, "UNAUTHENTICATED", "workspace session expired; refresh the page and try again");
  if (registry) {
    if (!session.workspaceId) throw new ApiError(401, "UNAUTHENTICATED", "workspace session required");
    const runtime = await registry.get(session.workspaceId);
    const actor = runtime ? await runtime.db.getActor(session.actorId) : null;
    if (!runtime || !actor || !(await runtime.db.isMember(actor.id))) {
      throw new ApiError(401, "UNAUTHENTICATED", "workspace session expired; refresh the page and try again");
    }
    return { actor, runtime };
  }
  if (session.workspaceId && session.workspaceId !== db.workspaceId) {
    throw new ApiError(401, "UNAUTHENTICATED", "token belongs to another workspace");
  }
  const actor = await db.getActor(session.actorId);
  if (!actor || (session.workspaceId && !(await db.isMember(actor.id)))) {
    throw new ApiError(401, "UNAUTHENTICATED", "workspace session expired; refresh the page and try again");
  }
  return { actor, runtime: null };
}

async function executeOwnedProjectAction(
  actor: Actor,
  projectId: string,
  mountId: string,
  action: ProjectAction,
  projects: ProjectStore,
  nodes: ToolmanNodes | null,
  gateway: ToolmanGateway | null,
): Promise<string> {
  await projects.requireOwner(actor, projectId);
  if (!nodes || !gateway) throw new ApiError(503, "TOOLMAN_OFFLINE", "Toolman is not available");
  const mount = await nodes.findMountById(mountId);
  if (!mount || mount.projectId !== projectId) throw new ApiError(404, "NOT_FOUND", "no such project mount");
  const result = await gateway.executeMount(mountId, actor.id, `human:${actor.id}`, action);
  if (!result.ok) throw new ApiError(503, result.code ?? "TOOLMAN_FAILED", result.error ?? "Toolman action failed");
  return result.output ?? "";
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ApiError(400, "VALIDATION", `${name} is required`);
  return value;
}

function browserReturnOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (!origin) return requestOrigin(req);
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) return parsed.origin;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  throw new ApiError(400, "BAD_ORIGIN", "browser origin is invalid");
}

function workspaceSocketUrl(origin: string, workspaceId: string): string {
  return `${websocketUrl(origin)}/ws/${encodeURIComponent(workspaceId)}`;
}

function toolmanSocketUrl(origin: string, workspaceId: string): string {
  return `${websocketUrl(origin)}/toolman/${encodeURIComponent(workspaceId)}`;
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

function decodedPathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) throw new ApiError(400, "BAD_PATH", "URL path is malformed");
    throw error;
  }
}

function gitNumber(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new ApiError(400, "BAD_NUMBER", "pull request number is invalid");
  return number;
}

function gitSource(value: string | null): "remote" | "local" {
  if (value === null || value === "remote") return "remote";
  if (value === "local") return "local";
  throw new ApiError(400, "BAD_SOURCE", "source must be remote or local");
}

function gitListState(value: string | null): "open" | "closed" | "all" {
  if (value === null || value === "open") return "open";
  if (value === "closed" || value === "all") return value;
  throw new ApiError(400, "BAD_STATE", "state must be open, closed, or all");
}

/** Clamp ?limit= to [1, MAX_HISTORY_LIMIT]; missing or non-numeric falls
 *  back to the default rather than rejecting outright. */
function historyLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  const n = raw === null ? DEFAULT_HISTORY_LIMIT : Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(n, MAX_HISTORY_LIMIT);
}

function threadEventLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_THREAD_EVENT_LIMIT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ApiError(400, "BAD_LIMIT", "limit must be a positive integer");
  }
  return Math.min(limit, MAX_THREAD_EVENT_LIMIT);
}

function optionalPositiveInt(url: URL, name: string, code: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, code, `${name} must be a positive integer`);
  }
  return value;
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

function enforceRateLimit(
  req: IncomingMessage,
  parts: string[],
  method: string,
  limiter: RateLimiter,
): void {
  if (parts[1] === "health") return;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const address = forwarded || req.socket.remoteAddress || "unknown";
  if (!limiter.take(`${address}:all`, 600, 60_000)) {
    throw new ApiError(429, "RATE_LIMITED", "too many requests; try again shortly");
  }
  let key = `${parts[1]}:${method}`;
  let limit = 120;
  let windowMs = 60_000;
  if (parts[1] === "workspaces" && parts[2] === "lookup") limit = 30;
  if (parts[1] === "workspaces" && method === "POST") {
    key = parts[3] === "access-requests" ? "workspace-access-request" : "workspace-create";
    limit = parts[3] === "access-requests" ? 20 : 10;
    windowMs = 60 * 60_000;
  }
  if (parts[1] === "agent-pairings" || parts[1] === "agent-installations") limit = 20;
  if (parts[1] === "toolman" && (parts[2] === "pairings" || parts[2] === "installation")) limit = 20;
  if (parts[1] === "uploads" && method === "POST") limit = 30;
  if (parts[1] === "git" && method !== "GET") {
    key = "git-mutation";
    limit = 20;
  }
  if (!limiter.take(`${address}:${key}`, limit, windowMs)) {
    throw new ApiError(429, "RATE_LIMITED", "too many requests; try again shortly");
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
