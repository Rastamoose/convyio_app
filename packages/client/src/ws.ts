import type { ClientEvent, ServerEvent } from "@workspace/shared";
import { wsUrl } from "./lib/serverUrl";

type Listener = (event: ServerEvent) => void;

/** How to join: a session token (auth mode) or a self-declared guest name. */
export interface JoinCredentials {
  workspaceId: string;
  name?: string;
  authToken?: string;
}

/**
 * WorkspaceSocket exists so UI code never handles raw WebSocket frames or
 * reconnection: it JSON encodes/decodes, auto-reconnects with backoff, and
 * re-joins after a drop. Consumers see only typed ServerEvents via `onEvent`
 * plus a disconnect signal via `onDisconnect`.
 */
export class WorkspaceSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private disconnectListeners = new Set<() => void>();
  private credentials: JoinCredentials | null = null;
  private retryMs = 500;
  private closed = false;
  private retryTimer: number | undefined;

  connect(credentials: JoinCredentials): void {
    this.credentials = credentials;
    this.open();
  }

  private open(): void {
    if (!this.credentials) return;
    this.socket = new WebSocket(wsUrl(this.credentials.workspaceId));

    this.socket.onopen = () => {
      this.retryMs = 500;
      const { name, authToken } = this.credentials ?? {};
      // With a token the server decides who we are; a name would be ignored.
      if (authToken) {
        this.sendRaw({ type: "join", kind: "human", authToken });
      } else if (name) {
        this.sendRaw({ type: "join", name, kind: "human" });
      }
    };

    this.socket.onmessage = (e) => {
      // A malformed frame is a server bug, not a client failure: log it and
      // keep the connection alive rather than tearing down the session.
      try {
        const event = JSON.parse(e.data) as ServerEvent;
        // A rejected credential is fatal: reconnecting with the same dead
        // token could only loop, so stop retrying and let the app re-login.
        if (event.type === "error" && event.error === "unauthenticated") {
          this.closed = true;
        }
        for (const l of this.listeners) l(event);
      } catch (err) {
        console.warn("[ws] ignoring malformed frame", err, e.data);
      }
    };

    this.socket.onclose = () => {
      if (this.closed) return;
      for (const l of this.disconnectListeners) l();
      // Re-check `closed` when the timer fires, not only when it is set:
      // close() during the wait must not be undone by a pending reconnect.
      // Otherwise React's dev double-mount leaves a zombie socket behind.
      this.retryTimer = window.setTimeout(() => {
        if (this.closed) return;
        this.open();
      }, this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  send(event: ClientEvent): void {
    this.sendRaw(event);
  }

  private sendRaw(event: ClientEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires when the connection drops (before each reconnect attempt). */
  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}
