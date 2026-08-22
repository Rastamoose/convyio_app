import { randomUUID } from "node:crypto";
import {
  ACTION_CAPABILITY,
  isBoardEnvelope,
  isProjectAction,
  mergeLiveItems,
  type ActionResultEvent,
  type AgentProjectAccess,
  type AgentResourceAccessRequest,
  type AgentResourceManifest,
  type BoardItem,
  type BoardPlan,
  type ChatMessage,
  type ContextNote,
  type ProjectAccessRequest,
  type ServerEvent,
  type ThreadEvent,
  type ToolmanAction,
  type WorkCapability,
  type PromptEnvelope,
  type ProtectedResourceKind,
  type WorkspaceSnapshot,
} from "@workspace/shared";
import { renderPromptEnvelope } from "@workspace/shared";
import type { AgentSocket } from "./socket";

/** Must exceed the server's approval timeout so an approved run still lands. */
const APPROVAL_WAIT_MS = 11 * 60 * 1000;

/**
 * The agent's view of the canonical board plus its channels to the server:
 * board lifecycle over the HTTP API (authenticated with the session token
 * from the welcome frame), world actions over the websocket toolman. The
 * agent has no other write path; every mutating action is judged server-side.
 */
export class BoardClient {
  private items = new Map<string, BoardItem>();
  private projects: AgentProjectAccess[] = [];
  private manifest: AgentResourceManifest | null = null;
  private envelope: PromptEnvelope | null = null;
  private token: string | null = null;
  private apiUrl: string | null = null;
  private actionWaiters = new Map<string, (result: ActionResultEvent) => void>();
  private resourceAccessWaiters = new Map<string, (granted: boolean) => void>();
  private resourceAccessHistory = new Map<string, "granted" | "denied">();
  private agentId: string | null = null;
  private lastRequestId: string | null = null;
  private onManifestUpdatedCallback: (() => void) | null = null;
  private onRunSuspended: ((reason: string) => void) | null = null;
  private onRunResumed: (() => void) | null = null;

  constructor(private socket: AgentSocket) {
    socket.onEvent((event) => {
      if (this.token && this.apiUrl && manifestUpdateEvent(event)) {
        void this.refreshManifest();
      }
      if (isBoardEnvelope(event)) {
        if (event.item.deletedAt) this.items.delete(event.item.id);
        else this.items.set(event.item.id, event.item);
        return;
      }
      if (event.type === "action_result") {
        const waiter = this.actionWaiters.get(event.requestId);
        if (waiter) {
          this.actionWaiters.delete(event.requestId);
          waiter(event);
        }
      }
      if (event.type === "thread_event") {
        resolveResourceAccessWaiter(event.event, this.agentId, this.resourceAccessWaiters, this.resourceAccessHistory);
      }
    });
  }

  setAgentId(agentId: string): void {
    this.agentId = agentId;
  }

  setRunHooks(
    onRunSuspended: ((reason: string) => void) | null,
    onRunResumed: (() => void) | null,
  ): void {
    this.onRunSuspended = onRunSuspended;
    this.onRunResumed = onRunResumed;
  }

  /**
   * Adopt the session from a welcome frame and load the board snapshot.
   * Returns false when the load failed: the cache then serves stale (possibly
   * empty) data, which is acceptable because live board envelopes and the
   * next (re)join heal it — but callers must not run restart-recovery sweeps
   * against it.
   */
  async join(token: string, apiUrl: string): Promise<boolean> {
    this.token = token;
    this.apiUrl = apiUrl;
    try {
      const snapshot = (await this.api("GET", "/api/workspace/snapshot")) as WorkspaceSnapshot;
      const merged = mergeLiveItems(snapshot.items, [...this.items.values()]);
      this.items.clear();
      for (const item of merged) this.items.set(item.id, item);
      await this.refreshProjectAccess();
      try {
        await this.refreshManifest();
      } catch (err) {
        console.warn("[agent] manifest refresh failed:", err instanceof Error ? err.message : err);
      }
      await this.refreshEnvelope();
      return true;
    } catch (err) {
      console.warn("[agent] board refresh failed:", err);
      return false;
    }
  }

  list(): BoardItem[] {
    return [...this.items.values()];
  }

  /** Resolve a uuid or ref like "task-3" to an item. */
  resolve(ref: string): BoardItem | undefined {
    return this.list().find((i) => i.id === ref || i.ref === ref);
  }

  myProposedItems(myId: string): BoardItem[] {
    return this.list().filter((i) => i.status === "proposed" && i.createdBy === myId);
  }

  listProjectAccess(): AgentProjectAccess[] {
    return this.projects;
  }

  async refreshProjectAccess(): Promise<AgentProjectAccess[]> {
    const body = (await this.api("GET", "/api/agent-project-access")) as { projects: AgentProjectAccess[] };
    this.projects = body.projects;
    return this.projects;
  }

  async requestProjectAccess(projectId: string, reason: string): Promise<{ request: ProjectAccessRequest; projects: AgentProjectAccess[] }> {
    const body = (await this.api("POST", `/api/projects/${projectId}/access-requests`, { reason })) as {
      request: ProjectAccessRequest;
    };
    return { request: body.request, projects: await this.refreshProjectAccess() };
  }

  /**
   * Block until a resource or project access grant is resolved.
   * Keeps a run alive while waiting for a human approval decision.
   */
  waitForResourceAccess(key: string, timeoutMs = APPROVAL_WAIT_MS): Promise<boolean> {
    const prior = this.resourceAccessHistory.get(key);
    if (prior) {
      this.resourceAccessHistory.delete(key);
      return Promise.resolve(prior === "granted");
    }
    this.onRunSuspended?.(`awaiting access grant for ${key}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resourceAccessWaiters.delete(key);
        this.onRunResumed?.();
        resolve(false);
      }, timeoutMs);
      this.resourceAccessWaiters.set(key, (granted) => {
        clearTimeout(timer);
        this.resourceAccessWaiters.delete(key);
        this.onRunResumed?.();
        resolve(granted);
      });
    });
  }

  resourceManifest(): AgentResourceManifest | null {
    return this.manifest;
  }

  pendingResourceAccess(): Array<{ kind: string; name: string }> {
    return this.manifest?.resources.filter((r) => r.access === "pending").map((r) => ({ kind: r.kind, name: r.name })) ?? [];
  }

  onManifestUpdated(callback: () => void): void {
    this.onManifestUpdatedCallback = callback;
  }

  async refreshManifest(): Promise<AgentResourceManifest> {
    const body = (await this.api("GET", "/api/agent-context/manifest")) as { manifest: AgentResourceManifest };
    this.manifest = body.manifest;
    this.onManifestUpdatedCallback?.();
    return this.manifest;
  }

  async requestResourceAccess(input: {
    resourceKind: ProtectedResourceKind;
    resourceId: string;
    reason: string;
    originChannelId?: string | null;
  }): Promise<AgentResourceAccessRequest> {
    const body = (await this.api("POST", "/api/agent-context/access-requests", input)) as {
      request: AgentResourceAccessRequest;
    };
    await this.refreshManifest();
    return body.request;
  }

  async readChannel(channelId: string, before?: number): Promise<ChatMessage[]> {
    const query = before === undefined ? "" : `?before=${encodeURIComponent(String(before))}`;
    const body = (await this.api("GET", `/api/agent-context/channels/${channelId}/messages${query}`)) as {
      messages: ChatMessage[];
    };
    return body.messages;
  }

  async searchChannel(channelId: string, query: string): Promise<ChatMessage[]> {
    const body = (await this.api(
      "GET",
      `/api/agent-context/channels/${channelId}/search?q=${encodeURIComponent(query)}`,
    )) as { messages: ChatMessage[] };
    return body.messages;
  }

  async listContextNotes(): Promise<ContextNote[]> {
    const body = (await this.api("GET", "/api/context/notes")) as { notes: ContextNote[] };
    return body.notes;
  }

  async saveContextNote(body: string): Promise<ContextNote> {
    const response = (await this.api("POST", "/api/context/notes", { scope: "agent", body })) as {
      note: ContextNote;
    };
    return response.note;
  }

  // -------------------------------------------------------------------------
  // Board lifecycle (HTTP)
  // -------------------------------------------------------------------------

  async refreshEnvelope(): Promise<PromptEnvelope | null> {
    try {
      const body = (await this.api("GET", "/api/workspace/prompt-envelope")) as { envelope: PromptEnvelope };
      this.envelope = body.envelope;
      return this.envelope;
    } catch {
      return this.envelope;
    }
  }

  async proposePlan(fields: {
    title: string;
    objective: string;
    outline: string[];
    clarifications: string[];
    constraints?: string[];
    assumedOwnerId?: string;
    assumedProjectId?: string;
    channel?: string;
  }): Promise<BoardPlan> {
    const { plan } = (await this.api("POST", "/api/board/plans", fields)) as { plan: BoardPlan };
    return plan;
  }

  async propose(fields: {
    title: string;
    why: string;
    effect: string;
    scopePaths: string[];
    capabilities?: WorkCapability[];
    planId: string;
    owner?: string;
    acceptanceCriteria?: string[];
    projectId?: string;
  }): Promise<BoardItem> {
    const { item } = (await this.api("POST", "/api/board/items", fields)) as { item: BoardItem };
    this.items.set(item.id, item);
    return item;
  }

  async start(ref: string): Promise<BoardItem> {
    return this.transition(ref, "start");
  }

  async complete(ref: string, evidence?: string): Promise<BoardItem> {
    return this.transition(ref, "complete", evidence ? { evidence } : undefined);
  }

  async block(ref: string, reason: string): Promise<BoardItem> {
    return this.transition(ref, "block", { reason });
  }

  private async transition(ref: string, action: string, body?: unknown): Promise<BoardItem> {
    const target = this.resolve(ref);
    const { item } = (await this.api(
      "POST",
      `/api/board/items/${target?.id ?? ref}/${action}`,
      body,
    )) as { item: BoardItem };
    this.items.set(item.id, item);
    return item;
  }

  /**
   * Fetch an uploaded attachment's bytes, base64-encoded for the model. The
   * url is server-relative (e.g. "/api/uploads/<id>/<name>"); no bearer
   * header on purpose — the unguessable id in the url is the capability.
   */
  async fetchAttachment(url: string): Promise<{ mime: string; data: string }> {
    if (!this.apiUrl) throw new Error("not joined yet");
    const res = await fetch(`${this.apiUrl}${url}`);
    if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);
    return {
      mime: res.headers.get("content-type") ?? "application/octet-stream",
      data: Buffer.from(await res.arrayBuffer()).toString("base64"),
    };
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.token || !this.apiUrl) throw new Error("not joined yet");
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await res.json()) as { error?: string; message?: string };
    if (!res.ok) {
      throw new Error(`${payload.error ?? res.status}: ${payload.message ?? "request failed"}`);
    }
    return payload;
  }

  // -------------------------------------------------------------------------
  // Toolman (websocket)
  // -------------------------------------------------------------------------

  requestAction(
    action: ToolmanAction,
    boardItemRef: string | null,
    conversationId: string | null = null,
  ): Promise<ActionResultEvent> {
    // Project actions all pass through the server's folder-consent gate
    // (gateFolderAccess), which can prompt the owner even for reads under
    // "ask" policy — not just the mutating kinds ACTION_CAPABILITY lists.
    const needsApproval = Boolean(ACTION_CAPABILITY[action.kind]) || isProjectAction(action);
    if (needsApproval) this.onRunSuspended?.(`awaiting approval for ${action.kind}`);
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      this.lastRequestId = requestId;
      // A mutation may pause on a human decision, so the wait outlasts the
      // server's own approval timeout rather than abandoning an approved run.
      const timeout = needsApproval ? APPROVAL_WAIT_MS : 15_000;
      const timer = setTimeout(() => {
        this.actionWaiters.delete(requestId);
        if (needsApproval) this.onRunResumed?.();
        reject(new Error("toolman request timed out"));
      }, timeout);
      this.actionWaiters.set(requestId, (result) => {
        clearTimeout(timer);
        this.actionWaiters.delete(requestId);
        if (needsApproval) this.onRunResumed?.();
        resolve(result);
      });
      this.socket.send({ type: "action_request", requestId, boardItemRef, action, conversationId });
    });
  }

  cancelLastAction(): void {
    if (!this.lastRequestId) return;
    this.socket.send({ type: "action_cancel", requestId: this.lastRequestId });
  }

  /** Compact workspace summary for the model's context window. */
  summary(channelId?: string): string {
    const envelope = channelId && this.envelope ? scopeEnvelope(this.envelope, channelId) : this.envelope;
    const context = envelope ? renderPromptEnvelope(envelope) : "(workspace context unavailable)";
    const projects = this.projects.length === 0
      ? "(no shared projects)"
      : this.projects
          .map(({ project, assignment, request }) => {
            const access = assignment
              ? `assigned:${assignment.status}`
              : request
                ? "access-request:pending"
                : "not-assigned";
            return `${project.id} [${access}] ${project.name} (${project.kind}) — owner: ${project.createdByName ?? project.createdBy} — folder-policy: ${project.accessMode}`;
          })
          .join("\n");
    const resources = this.manifest?.resources
      .map((resource) => `${resource.kind}:${resource.id} [${resource.access}] ${resource.name}`)
      .join("\n") ?? "(resource manifest unavailable)";
    return `${context}\n\nResource manifest (discovery only; access does not load contents):\n${resources}\n\nShared projects (use project_* tools, not native filesystem tools):\n${projects}`;
  }
}

function scopeEnvelope(envelope: PromptEnvelope, channelId: string): PromptEnvelope {
  const context = envelope.context.filter(
    (entry) => entry.scope === "workspace" || (entry.scope === "channel" && entry.subjectId === channelId),
  );
  return { ...envelope, context };
}

/** Returns true when the event indicates the workspace resource manifest may have changed. */
function manifestUpdateEvent(event: ServerEvent): boolean {
  if (event.type === "thread_event") {
    const kind = event.event.kind;
    return kind.startsWith("resource.access.") || kind.startsWith("project.");
  }
  return (
    event.type === "channel_created" ||
    event.type === "channel_renamed" ||
    event.type === "channel_archived" ||
    event.type === "channel_deleted" ||
    event.type === "channel_moved" ||
    event.type === "channel_section_created" ||
    event.type === "channel_pinned" ||
    event.type === "project_sync" ||
    event.type === "project_updated" ||
    event.type === "project_assignment" ||
    event.type === "project_access"
  );
}

function resourceAccessKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function resolveResourceAccessWaiter(
  event: ThreadEvent,
  agentId: string | null,
  waiters: Map<string, (granted: boolean) => void>,
  history: Map<string, "granted" | "denied">,
): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  if (payload.agentId && agentId && payload.agentId !== agentId) return;

  const resolve = (key: string, granted: boolean) => {
    const waiter = waiters.get(key);
    if (waiter) {
      waiters.delete(key);
      waiter(granted);
    } else {
      history.set(key, granted ? "granted" : "denied");
    }
  };

  if (event.kind === "resource.access.granted") {
    const kind = String(payload.resourceKind ?? "");
    const id = String(payload.resourceId ?? "");
    if (kind && id) resolve(resourceAccessKey(kind, id), true);
  } else if (event.kind === "resource.access.denied") {
    const kind = String(payload.resourceKind ?? "");
    const id = String(payload.resourceId ?? "");
    if (kind && id) resolve(resourceAccessKey(kind, id), false);
  } else if (event.kind === "project.access.resolved") {
    const projectId = String(payload.projectId ?? "");
    if (projectId) resolve(resourceAccessKey("project", projectId), payload.decision === "approved");
  } else if (event.kind === "project.assignment.granted") {
    const projectId = String(payload.projectId ?? "");
    if (projectId) resolve(resourceAccessKey("project", projectId), true);
  }
}
