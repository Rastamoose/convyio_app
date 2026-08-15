import { randomUUID } from "node:crypto";
import {
  ACTION_CAPABILITY,
  isBoardEnvelope,
  mergeLiveItems,
  type ActionResultEvent,
  type BoardItem,
  type BoardPlan,
  type ToolmanAction,
  type WorkCapability,
  type WorkspaceSnapshot,
} from "@workspace/shared";
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
  private token: string | null = null;
  private apiUrl: string | null = null;
  private actionWaiters = new Map<string, (result: ActionResultEvent) => void>();

  constructor(private socket: AgentSocket) {
    socket.onEvent((event) => {
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
    });
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

  // -------------------------------------------------------------------------
  // Board lifecycle (HTTP)
  // -------------------------------------------------------------------------

  async proposePlan(fields: {
    title: string;
    objective: string;
    outline: string[];
    clarifications: string[];
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
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      // A mutation may pause on a human decision, so the wait outlasts the
      // server's own approval timeout rather than abandoning an approved run.
      const timeout = ACTION_CAPABILITY[action.kind] ? APPROVAL_WAIT_MS : 15_000;
      const timer = setTimeout(() => {
        this.actionWaiters.delete(requestId);
        reject(new Error("toolman request timed out"));
      }, timeout);
      this.actionWaiters.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.socket.send({ type: "action_request", requestId, boardItemRef, action, conversationId });
    });
  }

  /** Compact board summary for the model's context window. */
  summary(): string {
    const items = this.list();
    if (items.length === 0) return "(board is empty)";
    return items
      .map((i) => {
        const proposal =
          i.origin === "agent" ? ` — why: ${i.proposalWhy} — effect: ${i.proposalEffect}` : "";
        const scope = i.scopePaths ? ` — scope: ${i.scopePaths.join(", ")}` : "";
        const owner = i.ownerName ? ` — owner: ${i.ownerName}` : "";
        return `${i.ref} [${i.status}] ${i.title}${owner}${proposal}${scope}`;
      })
      .join("\n");
  }
}
