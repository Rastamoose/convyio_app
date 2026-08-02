import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  clientEventSchema,
  type BoardEventEnvelope,
  type ChatMessage,
  type ClientEvent,
  type Participant,
  type ServerEvent,
  type TraceChunk,
} from "@workspace/shared";
import type { Storage } from "./storage/Storage";
import type { BoardDb } from "./board/db";
import type { Sessions } from "./board/api";
import type { Toolman } from "./board/Toolman";

interface Connection {
  socket: WebSocket;
  participant: Participant | null;
}

/**
 * The dumb shell. Routes typed events between participants and persists chat
 * history. It has no notion of AI — humans and agents are both just
 * participants on identical websocket connections.
 */
export class Hub {
  private wss: WebSocketServer;
  private connections = new Set<Connection>();
  /** Participants keyed by name so a rejoin reclaims the same identity. */
  private known = new Map<string, Participant>();
  /** In-memory trace buffers keyed by runId. Dropped once summarized. */
  private traceBuffers = new Map<string, TraceChunk[]>();
  /** Optional hook fired for every message posted to the channel. */
  onMessagePosted: ((message: ChatMessage) => void) | null = null;
  /** Optional hook fired when a client requests the scripted demo. */
  onDemoStart: ((channel: string) => void) | null = null;

  constructor(
    server: HttpServer,
    private storage: Storage,
    private db: BoardDb,
    private sessions: Sessions,
    private toolman: Toolman,
    private apiUrl: string,
  ) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  /** Fan a board event out to every connected client (§4). */
  broadcastBoardEvent(envelope: BoardEventEnvelope): void {
    this.broadcast(envelope);
  }

  private onConnection(socket: WebSocket): void {
    const conn: Connection = { socket, participant: null };
    this.connections.add(conn);

    socket.on("message", async (raw) => {
      let event: ClientEvent;
      try {
        event = clientEventSchema.parse(JSON.parse(raw.toString()));
      } catch {
        this.send(conn, { type: "error", error: "malformed event" });
        return;
      }
      await this.dispatch(conn, event);
    });

    socket.on("close", () => {
      this.connections.delete(conn);
      if (!conn.participant) return;
      const { id, kind } = conn.participant;
      if (kind === "human") {
        // Humans exist only while a tab is open: last connection gone => logged out.
        const stillConnected = [...this.connections].some(
          (c) => c.participant?.id === id,
        );
        if (!stillConnected) {
          for (const [key, p] of this.known) {
            if (p.id === id) this.known.delete(key);
          }
        }
      } else {
        if (conn.participant.runState === "working") {
          conn.participant.runState = "dead";
        }
        this.refreshPresence(id);
      }
      this.broadcastPresence();
    });
  }

  private async dispatch(conn: Connection, event: ClientEvent): Promise<void> {
    switch (event.type) {
      case "join":
        await this.handleJoin(conn, event.name, event.kind);
        break;
      case "message":
        await this.handleMessage(conn, event.content, event.channel);
        break;
      case "demo_start":
        this.onDemoStart?.(event.channel);
        break;
      case "clear":
        await this.handleClear(conn);
        break;
      case "interrupt":
        await this.handleInterrupt(conn, event.target, event.content);
        break;
      case "status_set":
        this.handleStatusSet(conn, event.status);
        break;
      case "status_update":
      case "trace_start":
      case "trace_chunk":
      case "summary":
      case "run_end":
        this.handleAgentEvent(conn, event);
        break;
      case "action_request":
        await this.handleActionRequest(conn, event);
        break;
    }
  }

  private async handleJoin(
    conn: Connection,
    name: string,
    kind: Participant["kind"],
  ): Promise<void> {
    const key = `${kind}:${name.toLowerCase()}`;
    let participant = this.known.get(key);
    if (!participant) {
      // Participant identity is the persistent actor identity, so board
      // attribution and presence agree on ids.
      const actor = this.db.upsertActor(kind, name);
      participant = {
        id: actor.id,
        name,
        kind,
        status: "",
        runState: "idle",
        online: true,
      };
      this.known.set(key, participant);
    }

    // Agents are singletons: a new connection for the same agent identity
    // displaces any previous one so duplicates can never double-reply.
    if (kind === "agent") {
      for (const other of this.connections) {
        if (other !== conn && other.participant?.id === participant.id) {
          this.send(other, { type: "error", error: "displaced by newer agent connection" });
          other.socket.close();
        }
      }
    }

    participant.online = true;
    participant.runState = "idle";
    conn.participant = participant;

    this.send(conn, {
      type: "welcome",
      self: participant,
      history: await this.storage.loadMessages(),
      participants: this.participantList(),
      token: this.sessions.issue(participant.id),
      apiUrl: this.apiUrl,
    });
    this.broadcastPresence();
  }

  private async handleMessage(
    conn: Connection,
    content: string,
    channel?: string,
  ): Promise<void> {
    if (!conn.participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    await this.postMessage({
      id: randomUUID(),
      authorId: conn.participant.id,
      authorName: conn.participant.name,
      authorKind: conn.participant.kind,
      content,
      timestamp: Date.now(),
      channel: channel ?? "general",
    });
  }

  /** Persist + broadcast a message and notify observers. */
  private async postMessage(message: ChatMessage): Promise<void> {
    await this.storage.appendMessage(message);
    this.broadcast({ type: "message", message });
    this.onMessagePosted?.(message);
  }

  // -------------------------------------------------------------------------
  // Demo support: synthetic participants driven by the DemoRunner. They are
  // ordinary participants to everything downstream; only their input source
  // (a script instead of a socket) differs.
  // -------------------------------------------------------------------------

  /** Post a message authored by a synthetic human participant. */
  async postAsSynthetic(
    name: string,
    content: string,
    channel: string,
  ): Promise<void> {
    const key = `human:${name.toLowerCase()}`;
    let participant = this.known.get(key);
    if (!participant) {
      participant = {
        id: randomUUID(),
        name,
        kind: "human",
        status: "",
        runState: "idle",
        online: true,
      };
      this.known.set(key, participant);
      this.broadcastPresence();
    }
    await this.postMessage({
      id: randomUUID(),
      authorId: participant.id,
      authorName: participant.name,
      authorKind: "human",
      content,
      timestamp: Date.now(),
      channel,
    });
  }

  /** Clear a single channel's messages and tell clients. */
  async clearChannel(channel: string): Promise<void> {
    await this.storage.clearMessages(channel);
    this.broadcast({ type: "clear", channel });
  }

  /** Name of the first online agent, if any. */
  findOnlineAgentName(): string | null {
    for (const p of this.known.values()) {
      if (p.kind === "agent" && p.online) return p.name;
    }
    return null;
  }

  /** Remove synthetic participants once a demo run finishes. */
  removeSynthetic(names: string[]): void {
    for (const name of names) {
      this.known.delete(`human:${name.toLowerCase()}`);
    }
    this.broadcastPresence();
  }

  private async handleClear(conn: Connection): Promise<void> {
    if (!conn.participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    await this.storage.clearMessages();
    this.broadcast({ type: "clear" });
  }

  private async handleInterrupt(
    conn: Connection,
    target: string,
    content: string,
  ): Promise<void> {
    if (!conn.participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    const targetKey = `agent:${target.toLowerCase()}`;
    const targetParticipant = this.known.get(targetKey);
    if (!targetParticipant || targetParticipant.kind !== "agent") {
      this.send(conn, { type: "error", error: `unknown agent: ${target}` });
      return;
    }

    const message: ChatMessage = {
      id: randomUUID(),
      authorId: conn.participant.id,
      authorName: conn.participant.name,
      authorKind: conn.participant.kind,
      content: `/interrupt @${target} ${content}`,
      timestamp: Date.now(),
    };
    await this.storage.appendMessage(message);
    this.broadcast({ type: "message", message });

    const targetConn = [...this.connections].find(
      (c) => c.participant?.id === targetParticipant.id,
    );
    if (targetConn) {
      this.send(targetConn, {
        type: "interrupt",
        authorName: conn.participant.name,
        content,
      });
    }
  }

  private handleStatusSet(conn: Connection, status: string): void {
    if (!conn.participant) return;
    conn.participant.status = status;
    this.broadcastPresence();
  }

  /**
   * Toolman gateway. This is the only write path agents have to the world;
   * authorization against the board happens inside the toolman (§5).
   */
  private async handleActionRequest(
    conn: Connection,
    event: Extract<ClientEvent, { type: "action_request" }>,
  ): Promise<void> {
    const p = conn.participant;
    if (!p) return this.send(conn, { type: "error", error: "join first" });
    if (p.kind !== "agent") {
      return this.send(conn, { type: "error", error: "agent-only event" });
    }
    const actor = this.db.getActor(p.id);
    if (!actor) return this.send(conn, { type: "error", error: "unknown actor" });
    const result = await this.toolman.execute(actor, event.action, event.boardItemRef ?? null);
    console.log(
      `[toolman] ${p.name} ${event.action.kind}${"path" in event.action ? ` ${event.action.path ?? ""}` : ""} → ${
        result.ok ? "ok" : result.code ? `DENY ${result.code}` : `error: ${result.error}`
      }`,
    );
    this.send(conn, { type: "action_result", requestId: event.requestId, ...result });
  }

  private handleAgentEvent(
    conn: Connection,
    event:
      | {
          type: "status_update";
          status: string;
          runState: Participant["runState"];
          taskId?: string | null;
        }
      | { type: "trace_start"; runId: string }
      | { type: "trace_chunk"; runId: string; chunk: TraceChunk }
      | { type: "summary"; runId: string; content: string; channel?: string }
      | { type: "run_end"; runId: string; reason: "completed" | "aborted" },
  ): void {
    if (!conn.participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    if (conn.participant.kind !== "agent") {
      this.send(conn, { type: "error", error: "agent-only event" });
      return;
    }

    switch (event.type) {
      case "status_update": {
        conn.participant.status = event.status;
        conn.participant.runState = event.runState;
        if (event.taskId !== undefined) {
          const next = event.taskId ?? undefined;
          if (next !== conn.participant.currentTaskId) {
            conn.participant.currentTaskId = next;
            conn.participant.taskStartedAt = next ? Date.now() : undefined;
          }
        }
        this.broadcastPresence();
        break;
      }
      case "trace_start": {
        this.traceBuffers.set(event.runId, []);
        this.broadcast({
          type: "trace_start",
          runId: event.runId,
          agentId: conn.participant.id,
          agentName: conn.participant.name,
          timestamp: Date.now(),
        });
        break;
      }
      case "trace_chunk": {
        const buffer = this.traceBuffers.get(event.runId);
        if (buffer) buffer.push(event.chunk);
        this.broadcast({ type: "trace_chunk", runId: event.runId, chunk: event.chunk });
        break;
      }
      case "summary": {
        const trace = this.traceBuffers.get(event.runId) ?? [];
        this.traceBuffers.delete(event.runId);
        void this.postMessage({
          id: randomUUID(),
          authorId: conn.participant.id,
          authorName: conn.participant.name,
          authorKind: conn.participant.kind,
          content: event.content,
          timestamp: Date.now(),
          channel: event.channel ?? "general",
          trace: trace.length > 0 ? trace : undefined,
          runId: event.runId,
        });
        break;
      }
      case "run_end": {
        this.traceBuffers.delete(event.runId);
        this.broadcast({
          type: "run_end",
          runId: event.runId,
          reason: event.reason,
        });
        break;
      }
    }
  }

  /** Recompute a participant's online flag from live connections. */
  private refreshPresence(participantId: string): void {
    const stillConnected = [...this.connections].some(
      (c) => c.participant?.id === participantId,
    );
    for (const p of this.known.values()) {
      if (p.id === participantId) p.online = stillConnected;
    }
  }

  private participantList(): Participant[] {
    return [...this.known.values()];
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence_sync", participants: this.participantList() });
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const conn of this.connections) {
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(payload);
      }
    }
  }

  private send(conn: Connection, event: ServerEvent): void {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(JSON.stringify(event));
    }
  }
}
