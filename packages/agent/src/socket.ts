import { WebSocket } from "ws";
import type { ClientEvent, ServerEvent } from "@workspace/shared";

type Listener = (event: ServerEvent) => void;

export class AgentSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private joinName: string | null = null;
  private url: string;
  private retryMs = 500;
  private closed = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(name: string): void {
    this.joinName = name;
    this.open();
  }

  private open(): void {
    this.socket = new WebSocket(this.url);

    this.socket.on("open", () => {
      this.retryMs = 500;
      if (this.joinName) {
        this.sendRaw({ type: "join", name: this.joinName, kind: "agent" });
      }
    });

    this.socket.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        for (const l of this.listeners) l(event);
      } catch {
        // ignore malformed frames
      }
    });

    this.socket.on("close", () => {
      if (this.closed) return;
      setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    });

    this.socket.on("error", (err) => {
      console.warn("[agent ws] error:", err.message);
    });
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
