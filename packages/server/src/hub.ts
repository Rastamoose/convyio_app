import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  clientEventSchema,
  type ActionRequestEvent,
  type BoardEventEnvelope,
  type ChatMessage,
  type ClientEvent,
  type Participant,
  type RunEndEvent,
  type ServerEvent,
  type StatusUpdateEvent,
  type SummaryEvent,
  type TraceChunk,
} from "@workspace/shared";
import type { Channels } from "./chat/Channels";
import type { MessageStore } from "./chat/MessageStore";
import type { Roster } from "./roster";
import type { Sessions } from "./board/sessions";
import type { Toolman } from "./board/Toolman";

interface Connection {
  socket: WebSocket;
  participant: Participant | null;
}

export interface HubOptions {
  apiUrl: string;
  serverId: string;
  demoChannels: string[];
}

/**
 * The dumb shell. Routes typed events between participants, persists chat
 * through the message store, and forwards agent actions to the toolman. It
 * has no notion of AI — humans and agents are both just participants on
 * identical websocket connections.
 */
export class Hub {
  private wss: WebSocketServer;
  private connections = new Set<Connection>();
  /** In-memory trace buffers keyed by runId. Dropped once summarized. */
  private traceBuffers = new Map<string, TraceChunk[]>();
  /** Optional hook fired for every message posted to the channel. */
  onMessagePosted: ((message: ChatMessage) => void) | null = null;
  /** Optional hook fired when a client requests the scripted demo. */
  onDemoStart: ((channel: string) => void) | null = null;
  /** Optional hook fired for every board event fanned out to clients. */
  onBoardEvent: ((envelope: BoardEventEnvelope) => void) | null = null;

  constructor(
    server: HttpServer,
    private roster: Roster,
    private messages: MessageStore,
    private channels: Channels,
    private sessions: Sessions,
    private toolman: Toolman,
    private options: HubOptions,
  ) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  broadcastBoardEvent(envelope: BoardEventEnvelope): void {
    this.broadcast(envelope);
    this.onBoardEvent?.(envelope);
  }

  broadcastChannelCreated(name: string): void {
    this.broadcast({ type: "channel_created", channel: name });
  }

  /** The single message-posting path: persist, broadcast, notify observers. */
  postMessage(
    author: Participant,
    content: string,
    channel: string,
    extras: { trace?: TraceChunk[]; runId?: string } = {},
  ): void {
    const message: ChatMessage = {
      id: randomUUID(),
      authorId: author.id,
      authorName: author.name,
      authorKind: author.kind,
      content,
      timestamp: Date.now(),
      channel,
      ...extras,
    };
    this.messages.append(message);
    this.broadcast({ type: "message", message });
    this.onMessagePosted?.(message);
  }

  /** Clear one channel's messages (or all) and tell clients. */
  clearChannel(channel?: string): void {
    this.messages.clear(channel);
    this.broadcast(channel ? { type: "clear", channel } : { type: "clear" });
  }

  broadcastPresence(): void {
    this.broadcast({ type: "presence_sync", participants: this.roster.list() });
  }

  private onConnection(socket: WebSocket): void {
    const conn: Connection = { socket, participant: null };
    this.connections.add(conn);

    socket.on("message", async (raw) => {
      let event: ClientEvent;
      try {
        event = clientEventSchema.parse(JSON.parse(raw.toString()));
      } catch (err) {
        console.warn("[hub] malformed event:", err instanceof Error ? err.message : err);
        this.send(conn, { type: "error", error: "malformed event" });
        return;
      }
      await this.dispatch(conn, event);
    });

    socket.on("close", () => this.onDisconnect(conn));
  }

  private onDisconnect(conn: Connection): void {
    this.connections.delete(conn);
    if (!conn.participant) return;
    const { id, kind } = conn.participant;
    const stillConnected = [...this.connections].some((c) => c.participant?.id === id);
    if (kind === "human") {
      // Humans exist only while a tab is open: last connection gone means
      // logged out, and their API tokens die with the session.
      if (!stillConnected) {
        this.roster.removeHuman(id);
        this.sessions.revokeFor(id);
      }
    } else {
      if (conn.participant.runState === "working") {
        conn.participant.runState = "dead";
      }
      this.roster.setOnline(id, stillConnected);
    }
    this.broadcastPresence();
  }

  private async dispatch(conn: Connection, event: ClientEvent): Promise<void> {
    if (event.type === "join") {
      this.handleJoin(conn, event.name, event.kind);
      return;
    }
    const participant = conn.participant;
    if (!participant) {
      this.send(conn, { type: "error", error: "join first" });
      return;
    }
    switch (event.type) {
      case "message": {
        const channel = event.channel ?? "general";
        if (!this.channels.exists(channel)) {
          this.send(conn, { type: "error", error: `unknown channel: ${channel}` });
          break;
        }
        this.postMessage(participant, event.content, channel);
        break;
      }
      case "demo_start":
        this.onDemoStart?.(event.channel);
        break;
      case "clear":
        this.clearChannel();
        break;
      case "interrupt":
        this.handleInterrupt(conn, event.target, event.content);
        break;
      case "status_set":
        participant.status = event.status;
        this.broadcastPresence();
        break;
      case "status_update":
        this.agentOnly(conn, () => this.handleStatusUpdate(participant, event));
        break;
      case "trace_start":
        this.agentOnly(conn, () => this.handleTraceStart(participant, event.runId));
        break;
      case "trace_chunk":
        this.agentOnly(conn, () => this.handleTraceChunk(event.runId, event.chunk));
        break;
      case "summary":
        this.agentOnly(conn, () => this.handleSummary(participant, event));
        break;
      case "run_end":
        this.agentOnly(conn, () => this.handleRunEnd(event));
        break;
      case "action_request":
        await this.handleActionRequest(conn, event);
        break;
    }
  }

  private handleJoin(conn: Connection, name: string, kind: Participant["kind"]): void {
    const participant = this.roster.join(kind, name);

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
    conn.participant = participant;

    this.send(conn, {
      type: "welcome",
      self: participant,
      history: this.messages.list(),
      participants: this.roster.list(),
      channels: this.channels.list(),
      demoChannels: this.options.demoChannels,
      token: this.sessions.issue(participant.id),
      apiUrl: this.options.apiUrl,
    });
    this.broadcastPresence();
  }

  private handleInterrupt(conn: Connection, target: string, content: string): void {
    const participant = conn.participant!;
    const targetParticipant = this.roster.get("agent", target);
    if (!targetParticipant) {
      this.send(conn, { type: "error", error: `unknown agent: ${target}` });
      return;
    }

    this.postMessage(participant, `/interrupt @${target} ${content}`, "general");
    const targetConn = [...this.connections].find(
      (c) => c.participant?.id === targetParticipant.id,
    );
    if (targetConn) {
      this.send(targetConn, {
        type: "interrupt",
        authorName: participant.name,
        content,
      });
    }
  }

  /**
   * Toolman gateway: the only write path agents have to the world.
   * Authorization against the board happens inside the toolman so the gate
   * cannot be bypassed by a differently-worded request.
   */
  private async handleActionRequest(conn: Connection, event: ActionRequestEvent): Promise<void> {
    const p = conn.participant!;
    if (p.kind !== "agent") {
      return this.send(conn, { type: "error", error: "agent-only event" });
    }
    // The roster joined this participant from a persistent actor, so the
    // identity handed to the toolman is the server's, never the client's.
    const actor = {
      id: p.id,
      kind: p.kind,
      displayName: p.name,
      serverId: this.options.serverId,
    };
    const result = await this.toolman.execute(actor, event.action, event.boardItemRef ?? null);
    this.send(conn, { type: "action_result", requestId: event.requestId, ...result });
  }

  private handleStatusUpdate(participant: Participant, event: StatusUpdateEvent): void {
    participant.status = event.status;
    participant.runState = event.runState;
    if (event.taskId !== undefined) {
      const next = event.taskId ?? undefined;
      if (next !== participant.currentTaskId) {
        participant.currentTaskId = next;
        participant.taskStartedAt = next ? Date.now() : undefined;
      }
    }
    this.broadcastPresence();
  }

  private handleTraceStart(participant: Participant, runId: string): void {
    this.traceBuffers.set(runId, []);
    this.broadcast({
      type: "trace_start",
      runId,
      agentId: participant.id,
      agentName: participant.name,
      timestamp: Date.now(),
    });
  }

  private handleTraceChunk(runId: string, chunk: TraceChunk): void {
    this.traceBuffers.get(runId)?.push(chunk);
    this.broadcast({ type: "trace_chunk", runId, chunk });
  }

  private handleSummary(participant: Participant, event: SummaryEvent): void {
    const trace = this.traceBuffers.get(event.runId) ?? [];
    this.traceBuffers.delete(event.runId);
    this.postMessage(participant, event.content, event.channel ?? "general", {
      trace: trace.length > 0 ? trace : undefined,
      runId: event.runId,
    });
  }

  private handleRunEnd(event: RunEndEvent): void {
    this.traceBuffers.delete(event.runId);
    this.broadcast({ type: "run_end", runId: event.runId, reason: event.reason });
  }

  private agentOnly(conn: Connection, handle: () => void): void {
    if (conn.participant?.kind !== "agent") {
      this.send(conn, { type: "error", error: "agent-only event" });
      return;
    }
    handle();
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
