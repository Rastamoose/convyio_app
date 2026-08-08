import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  clientEventSchema,
  type ActionRequestEvent,
  type Attachment,
  type BoardEventEnvelope,
  type ChatMessage,
  type ClientEvent,
  type JoinEvent,
  type MessageDeleteEvent,
  type MessageEditEvent,
  type MessageReactEvent,
  type Participant,
  type PinEvent,
  type RunEndEvent,
  type ServerEvent,
  type StatusUpdateEvent,
  type SummaryEvent,
  type TraceChunk,
} from "@workspace/shared";
import { ApiError } from "./board/BoardService";
import type { Attachments } from "./chat/Attachments";
import type { Channels } from "./chat/Channels";
import { DEFAULT_HISTORY_LIMIT, type MessageStore } from "./chat/MessageStore";
import type { Roster } from "./roster";
import type { Sessions } from "./board/sessions";
import type { Toolman } from "./board/Toolman";

interface Connection {
  socket: WebSocket;
  participant: Participant | null;
  /** Where this client can reach the HTTP API — the origin it connected to. */
  apiUrl: string;
}

/** Verdict from the join gate: whether a join stands, and as what name. */
export type JoinDecision = { ok: true; name: string } | { ok: false };

export interface HubOptions {
  serverId: string;
  demoChannels: string[];
  /**
   * The join gate. It exists so the Hub never knows how identities are
   * proven (Google session vs shared agent secret) — it only learns whether
   * a join stands and as what name. The running server always sets this
   * (refusing every join when no sign-in method is configured); absent is
   * only a convenience for tests that build a Hub directly and trust joins
   * to self-declare a name.
   */
  authorizeJoin?: (join: JoinEvent) => JoinDecision;
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
    private attachments: Attachments,
    private sessions: Sessions,
    private toolman: Toolman,
    private options: HubOptions,
  ) {
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (socket, request) => this.onConnection(socket, request));
  }

  broadcastBoardEvent(envelope: BoardEventEnvelope): void {
    this.broadcast(envelope);
    this.onBoardEvent?.(envelope);
  }

  broadcastChannelCreated(name: string): void {
    this.broadcast({ type: "channel_created", channel: name });
  }

  broadcastChannelRenamed(oldName: string, newName: string): void {
    this.broadcast({ type: "channel_renamed", oldName, newName });
  }

  broadcastChannelArchived(name: string, archived: boolean): void {
    this.broadcast({ type: "channel_archived", channel: name, archived });
  }

  broadcastChannelPinned(name: string, pinned: boolean): void {
    this.broadcast({ type: "channel_pinned", channel: name, pinned });
  }

  broadcastChannelDeleted(name: string): void {
    this.broadcast({ type: "channel_deleted", channel: name });
  }

  /**
   * The single message-posting path: persist, broadcast, notify observers.
   * extras.id lets a caller pre-allocate the message id — needed to bind
   * attachments to the message before it is posted.
   */
  postMessage(
    author: Participant,
    content: string,
    channel: string,
    extras: {
      id?: string;
      trace?: TraceChunk[];
      runId?: string;
      attachments?: Attachment[];
      replyToId?: string;
      /** Echoed top-level on the resulting broadcast; never part of the message. */
      nonce?: string;
    } = {},
  ): void {
    const { id = randomUUID(), nonce, ...rest } = extras;
    const message: ChatMessage = {
      id,
      authorId: author.id,
      authorName: author.name,
      authorKind: author.kind,
      content,
      timestamp: Date.now(),
      channel,
      ...rest,
    };
    this.messages.append(message);
    this.broadcast(
      nonce === undefined ? { type: "message", message } : { type: "message", message, nonce },
    );
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

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const conn: Connection = { socket, participant: null, apiUrl: apiUrlFor(request) };
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
      this.handleJoin(conn, event);
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
        // Replies point at real messages only; clients resolve them from history.
        if (event.replyToId && !this.messages.get(event.replyToId)) {
          this.send(conn, { type: "error", error: `unknown message: ${event.replyToId}` });
          break;
        }
        // The message id is allocated before posting so uploads can be bound
        // to it; a failed bind drops the whole message.
        const messageId = randomUUID();
        let attachments: Attachment[] | undefined;
        if (event.attachmentIds?.length) {
          try {
            attachments = this.attachments.bind(messageId, event.attachmentIds, participant.id);
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            this.send(conn, { type: "error", error: err.message });
            break;
          }
        }
        this.postMessage(participant, event.content, channel, {
          id: messageId,
          attachments,
          replyToId: event.replyToId,
          nonce: event.nonce,
        });
        break;
      }
      case "demo_start":
        this.onDemoStart?.(event.channel);
        break;
      case "clear":
        this.clearChannel();
        break;
      case "pin":
        this.handlePin(conn, event);
        break;
      case "message_edit":
        this.handleMessageEdit(conn, event);
        break;
      case "message_delete":
        this.handleMessageDelete(conn, event);
        break;
      case "message_react":
        this.handleMessageReact(conn, event);
        break;
      case "typing":
        // Ephemeral relay: nothing persists, and the sender knows they type.
        this.broadcastExcept(conn, {
          type: "typing",
          actorId: participant.id,
          name: participant.name,
          channel: event.channel,
          timestamp: Date.now(),
        });
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

  private handleJoin(conn: Connection, join: JoinEvent): void {
    // In guest mode the schema guarantees a name (joins carry name or
    // authToken; a token-only join can stand only where a gate resolves it).
    const decision: JoinDecision = this.options.authorizeJoin
      ? this.options.authorizeJoin(join)
      : join.name !== undefined
        ? { ok: true, name: join.name }
        : { ok: false };
    if (!decision.ok) {
      this.send(conn, { type: "error", error: "unauthenticated" });
      conn.socket.close();
      return;
    }
    const { kind } = join;
    const participant = this.roster.join(kind, decision.name);

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

    // Bounded per channel (not "last N overall"): clients filter history by
    // channel client-side, so a flat cap would leave quiet channels empty.
    // Older messages page in via GET /api/messages.
    this.send(conn, {
      type: "welcome",
      self: participant,
      history: this.messages.recentByChannel(this.channels.list(), DEFAULT_HISTORY_LIMIT),
      participants: this.roster.list(),
      channels: this.channels.list(),
      archivedChannels: this.channels.listArchived(),
      pinnedChannels: this.channels.pinned(),
      demoChannels: this.options.demoChannels,
      token: this.sessions.issue(participant.id),
      apiUrl: conn.apiUrl,
    });
    this.broadcastPresence();
  }

  /** Pinning is a human act: agents mutate the world only through the toolman. */
  private handlePin(conn: Connection, event: PinEvent): void {
    const participant = conn.participant!;
    if (participant.kind !== "human") {
      this.send(conn, { type: "error", error: "human-only event" });
      return;
    }
    const message = this.messages.setPinned(
      event.messageId,
      event.pinned ? participant.name : null,
    );
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    this.broadcast({ type: "message_updated", message });
  }

  /** Resolve a message the connection's participant authored, or send the
   *  refusal. Identity comes from the connection, never the frame. */
  private authoredMessage(conn: Connection, messageId: string): ChatMessage | null {
    const message = this.messages.get(messageId);
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${messageId}` });
      return null;
    }
    if (message.authorId !== conn.participant!.id) {
      this.send(conn, { type: "error", error: "not the message author" });
      return null;
    }
    return message;
  }

  private handleMessageEdit(conn: Connection, event: MessageEditEvent): void {
    if (!this.authoredMessage(conn, event.messageId)) return;
    const message = this.messages.edit(event.messageId, event.content)!;
    this.broadcast({ type: "message_updated", message });
  }

  private handleMessageDelete(conn: Connection, event: MessageDeleteEvent): void {
    const message = this.authoredMessage(conn, event.messageId);
    if (!message) return;
    this.messages.delete(event.messageId);
    this.broadcast({
      type: "message_deleted",
      messageId: event.messageId,
      channel: message.channel ?? "general",
    });
  }

  /** Reactions are idempotent; only an actual change is worth a broadcast. */
  private handleMessageReact(conn: Connection, event: MessageReactEvent): void {
    const participant = conn.participant!;
    if (!this.messages.get(event.messageId)) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    let changed: boolean;
    if (event.op === "add") {
      const outcome = this.messages.addReaction(event.messageId, event.emoji, {
        id: participant.id,
        name: participant.name,
      });
      if (outcome === "capped") {
        this.send(conn, { type: "error", error: "reaction limit reached" });
        return;
      }
      changed = outcome === "added";
    } else {
      changed = this.messages.removeReaction(event.messageId, event.emoji, participant.id);
    }
    if (!changed) return;
    this.broadcast({ type: "message_updated", message: this.messages.get(event.messageId)! });
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

  /** Broadcast to every connection but the sender's (typing must not echo). */
  private broadcastExcept(sender: Connection, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const conn of this.connections) {
      if (conn !== sender && conn.socket.readyState === WebSocket.OPEN) {
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

/**
 * The HTTP API lives at whatever origin the client reached us through, so
 * derive it from the upgrade request rather than baking a URL in at boot —
 * a boot-time value breaks behind any real domain or reverse proxy. A TLS
 * proxy announces itself via X-Forwarded-Proto (first value wins: proxies
 * append); anything else is plain http.
 */
function apiUrlFor(request: IncomingMessage): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  const scheme = forwardedProto === "https" ? "https" : "http";
  // Host is mandatory since HTTP/1.1; the fallback covers ancient clients.
  const host = request.headers.host ?? `localhost:${request.socket.localPort}`;
  return `${scheme}://${host}`;
}
