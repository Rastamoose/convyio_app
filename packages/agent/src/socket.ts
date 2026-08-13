import { WebSocket } from "ws";
import type { ClientEvent, ServerEvent } from "@workspace/shared";

type Listener = (event: ServerEvent) => void;

export class AgentSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private joinName: string | null = null;
  private authToken: string | undefined;
  private url: string;
  private retryMs = 500;
  private closed = false;
  private retryTimer: NodeJS.Timeout | undefined;
  /** Connection failures so far; the first few are normal at dev startup. */
  private failures = 0;

  constructor(url: string) {
    this.url = url;
  }

  /** authToken is required by auth-enabled servers, ignored by guest mode. */
  connect(name: string, authToken?: string): void {
    this.joinName = name;
    this.authToken = authToken;
    this.open();
  }

  private open(): void {
    this.socket = new WebSocket(this.url);

    this.socket.on("open", () => {
      this.retryMs = 500;
      this.failures = 0;
      if (this.joinName) {
        this.sendRaw({
          type: "join",
          name: this.joinName,
          kind: "agent",
          authToken: this.authToken,
        });
      }
    });

    this.socket.on("message", (data) => {
      const raw = data.toString();
      let event: ServerEvent;
      try {
        event = JSON.parse(raw) as ServerEvent;
      } catch (err) {
        // JSON.stringify escapes control characters so the frame can't forge log lines.
        console.warn(
          "[agent ws] dropping malformed frame:",
          err instanceof Error ? err.message : err,
          JSON.stringify(raw.slice(0, 200)),
        );
        return;
      }
      for (const l of this.listeners) l(event);
    });

    this.socket.on("close", () => {
      if (this.closed) return;
      // Re-check `closed` when the timer fires, not only when it is set:
      // a close() during the wait must not be undone by a pending reconnect.
      this.retryTimer = setTimeout(() => {
        if (this.closed) return;
        this.open();
      }, this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    });

    this.socket.on("error", (err) => {
      // `npm run dev` starts the agent and the server together, so the first
      // attempts lose the race by design. Only say so once it stops looking
      // like a startup race and starts looking like the server being down.
      this.failures += 1;
      if (this.failures === 1 || this.failures % 10 === 0) {
        console.warn(
          `[agent ws] cannot reach ${this.url} (attempt ${this.failures}): ${err.message}` +
            (this.failures === 1 ? " — retrying, this is normal while the server boots" : ""),
        );
      }
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
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}
