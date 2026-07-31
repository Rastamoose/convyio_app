import type { ClientEvent, ServerEvent } from "@workspace/shared";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";

type Listener = (event: ServerEvent) => void;

/**
 * Thin websocket wrapper: JSON encode/decode, auto-reconnect with backoff,
 * re-join on reconnect. UI code only ever sees typed ServerEvents.
 */
export class WorkspaceSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
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
      try {
        const event = JSON.parse(e.data) as ServerEvent;
        for (const l of this.listeners) l(event);
      } catch {
        // ignore malformed frames
      }
    };

    this.socket.onclose = () => {
      if (this.closed) return;
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

  close(): void {
    this.closed = true;
    this.socket?.close();
  }
}
