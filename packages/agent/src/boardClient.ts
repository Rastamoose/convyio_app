import { randomUUID } from "node:crypto";
import {
  isBoardEnvelope,
  type ActionResultEvent,
  type BoardItem,
  type ToolmanAction,
} from "@workspace/shared";
import type { AgentSocket } from "./socket";

/**
 * The agent's view of the canonical board plus its channels to the server:
 * board lifecycle over the HTTP API (authenticated with the session token
 * from the welcome frame), world actions over the websocket toolman. The
 * agent has no other write path; every mutating action is judged server-side.
 */
export class BoardClient {
  /** Fired after each full refresh so callers can recompute derived state. */
  onRefreshed: (() => void) | null = null;

  private items = new Map<string, BoardItem>();
  private token: string | null = null;
  private apiUrl: string | null = null;
  private actionWaiters = new Map<string, (result: ActionResultEvent) => void>();

  constructor(private socket: AgentSocket) {
    socket.onEvent((event) => {
      if (event.type === "welcome") {
        this.token = event.token;
        this.apiUrl = event.apiUrl;
        void this.refresh();
        return;
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
    });
  }

  async refresh(): Promise<void> {
    try {
      const { items } = (await this.api("GET", "/api/board/items?include_deleted=true")) as {
        items: BoardItem[];
      };
      this.items.clear();
      for (const item of items) {
        if (!item.deletedAt) this.items.set(item.id, item);
      }
      this.onRefreshed?.();
    } catch (err) {
      console.warn("[agent] board refresh failed:", err);
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

  async propose(fields: { title: string; why: string; effect: string }): Promise<BoardItem> {
    const { item } = (await this.api("POST", "/api/board/items", fields)) as { item: BoardItem };
    this.items.set(item.id, item);
    return item;
  }

  async start(ref: string): Promise<BoardItem> {
    return this.transition(ref, "start");
  }

  async complete(ref: string): Promise<BoardItem> {
    return this.transition(ref, "complete");
  }

  async block(ref: string, reason: string): Promise<BoardItem> {
    return this.transition(ref, "block", { reason });
  }

  async unblock(ref: string): Promise<BoardItem> {
    return this.transition(ref, "unblock");
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

  requestAction(action: ToolmanAction, boardItemRef: string | null): Promise<ActionResultEvent> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.actionWaiters.delete(requestId);
        reject(new Error("toolman request timed out"));
      }, 15_000);
      this.actionWaiters.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.socket.send({ type: "action_request", requestId, boardItemRef, action });
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
        return `${i.ref} [${i.status}] ${i.title}${proposal}`;
      })
      .join("\n");
  }
}
