import type { ClientEvent, ServerEvent } from "@workspace/shared";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";

type Listener = (event: ServerEvent) => void;

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
  private joinName: string | null = null;
  private retryMs = 500;
  private closed = false;

  connect(name: string): void {
    this.joinName = name;
    this.open();
  }

  private open(): void {
    this.socket = new WebSocket(WS_URL);

    this.socket.onopen = () => {
      this.retryMs = 500;
      if (this.joinName) {
        this.sendRaw({ type: "join", name: this.joinName, kind: "human" });
      }
    };

    this.socket.onmessage = (e) => {
      // A malformed frame is a server bug, not a client failure: log it and
      // keep the connection alive rather than tearing down the session.
      try {
        const event = JSON.parse(e.data) as ServerEvent;
        for (const l of this.listeners) l(event);
      } catch (err) {
        console.warn("[ws] ignoring malformed frame", err, e.data);
      }
    };

    this.socket.onclose = () => {
      if (this.closed) return;
      for (const l of this.disconnectListeners) l();
      setTimeout(() => this.open(), this.retryMs);
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
    this.socket?.close();
  }
}
