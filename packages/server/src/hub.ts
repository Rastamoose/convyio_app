import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ACTION_CAPABILITY,
  clientEventSchema,
  type ActionRequestEvent,
  type ActivityBatchEvent,
  type AgentInvite,
  type AgentProvider,
  type AgentRunFinishEvent,
  type Attachment,
  type BoardEventEnvelope,
  type PlanEventEnvelope,
  type ChannelInfo,
  type ChatMessage,
  type ClientEvent,
  type ConversationModeSetEvent,
  type ConversationSessionSetEvent,
  type InteractionResolveEvent,
  type JoinEvent,
  type MessageDeleteEvent,
  type MessageEditEvent,
  type MessageReactEvent,
  type Participant,
  type PinEvent,
  type RunnerHelloEvent,
  type RunnerStatusEvent,
  type RunEndEvent,
  type ServerEvent,
  type StatusUpdateEvent,
  type SummaryEvent,
  type TraceChunk,
  type WorkClaimEvent,
  type WorkCompleteEvent,
  type WorkspaceInfo,
} from "@workspace/shared";
import { ApiError } from "./board/BoardService";
import type { InteractionStore } from "./chat/InteractionStore";
import { RunRequestAccessError, type AgentWorkStore } from "./chat/AgentWorkStore";
import type { Attachments } from "./chat/Attachments";
import type { Channels } from "./chat/Channels";
import { DEFAULT_HISTORY_LIMIT, type MessageStore } from "./chat/MessageStore";
import type { Roster } from "./roster";
import type { Sessions } from "./board/sessions";
import type { Toolman, ToolmanResult } from "./board/Toolman";
import { requestOrigin } from "./requestOrigin";
import type { RunnerRuntime } from "./RunnerRuntime";
import type { ContextCursorStore } from "./context/ContextCursorStore";
import type { ThreadEventStore } from "./chat/ThreadEventStore";

interface Connection {
  socket: WebSocket;
  participant: Participant | null;
  agentProfile: AgentInvite | null;
  /** Where this client can reach the HTTP API — the origin it connected to. */
  apiUrl: string;
  /** Serializes incoming socket messages so a single connection's handlers
   *  never interleave — this preserves server-side ordering for tests and
   *  clients that send rapid, causally-related frames. */
  queue: Promise<void>;
}

/** Verdict from the join gate: whether a join stands, and as what stored identity. */
export type JoinDecision =
  | { ok: true; name: string; actorId?: string; profile?: AgentInvite }
  | { ok: false };

export interface HubOptions {
  workspace: WorkspaceInfo;
  demoChannels: string[];
  /**
   * The join gate. It exists so the Hub never knows how identities are
   * proven (Google session vs shared agent secret) — it only learns whether
   * a join stands and as what name. The running server always sets this
   * (refusing every join when no sign-in method is configured); absent is
   * only a convenience for tests that build a Hub directly and trust joins
   * to self-declare a name.
   */
  authorizeJoin?: (join: JoinEvent) => Promise<JoinDecision>;
  authorizeAgentWork?: (agentId: string, authorId: string) => Promise<boolean>;
  /** Sequenced workspace projection used to stamp welcome.snapshotSeq. */
  threadEvents?: ThreadEventStore;
  contextCursors?: ContextCursorStore;
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
  onDemoStart: ((channel: string, actorId: string) => void) | null = null;
  /** Optional hook fired for every board event fanned out to clients. */
  onBoardEvent: ((envelope: BoardEventEnvelope) => void) | null = null;

  /** Runs paused on a human decision, keyed by interaction request id. */
  private pendingApprovals = new Map<string, (verdict: "approved" | "denied" | "expired") => void>();

  constructor(
    server: HttpServer,
    private roster: Roster,
    private messages: MessageStore,
    private agentWork: AgentWorkStore,
    private channels: Channels,
    private attachments: Attachments,
    private sessions: Sessions,
    private toolman: Toolman,
    private interactions: InteractionStore,
    private runnerRuntime: RunnerRuntime,
    private options: HubOptions,
  ) {
    this.wss = new WebSocketServer({ server });
    // ws re-emits the http server's 'error' on itself. Without a listener here
    // that re-emit is an unhandled 'error' event, which kills the process
    // before the http server's own handler can decide what to do — so a
    // recoverable EADDRINUSE during a dev restart became a hard crash.
    // Ownership of the verdict stays with whoever created the http server.
    this.wss.on("error", (err: NodeJS.ErrnoException) => {
      // Listen failures belong to whoever owns the http server; it reports and
      // decides. Anything else is genuinely the websocket layer's to report.
      if (err.code !== "EADDRINUSE") console.warn("[hub] websocket server error:", err.message);
    });
    this.wss.on("connection", (socket, request) => this.onConnection(socket, request));
  }

  broadcastBoardEvent(envelope: BoardEventEnvelope): void {
    this.broadcast(envelope);
    this.onBoardEvent?.(envelope);
  }

  broadcastPlanEvent(envelope: PlanEventEnvelope): void {
    this.broadcast(envelope);
  }

  broadcastChannelCreated(channel: ChannelInfo): void {
    this.broadcast({ type: "channel_created", channel: channel.name, channelInfo: channel });
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
  async postMessage(
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
  ): Promise<void> {
    const { id = randomUUID(), nonce, ...rest } = extras;
    const channelInfo = await this.channels.get(channel);
    if (!channelInfo) throw new Error(`unknown channel: ${channel}`);
    const mentionCandidates = deriveMentionedAgents(author, content, this.roster.list());
    const mentionedAgents = this.options.authorizeAgentWork
      ? (
          await Promise.all(
            mentionCandidates.map(async (agent) => ({
              agent,
              allowed: await this.options.authorizeAgentWork!(agent.id, author.id),
            })),
          )
        )
          .filter(({ allowed }) => allowed)
          .map(({ agent }) => agent)
      : mentionCandidates;
    const message: ChatMessage = {
      id,
      authorId: author.id,
      authorName: author.name,
      authorKind: author.kind,
      content,
      timestamp: Date.now(),
      channelId: channelInfo.id,
      mentions: mentionedAgents.map((agent) => agent.id),
      channel: channelInfo.name,
      ...rest,
    };
    const requests = await this.messages.appendAtomically(message, (sql) =>
      this.agentWork.queue(sql, message, message.mentions ?? []),
    );
    this.broadcast(
      nonce === undefined ? { type: "message", message } : { type: "message", message, nonce },
    );
    for (const agent of mentionedAgents) {
      this.notifyWork(
        agent.id,
        requests.filter((request) => request.agentId === agent.id).map((request) => request.id),
      );
    }
    this.onMessagePosted?.(message);
  }

  /** Clear one channel's messages (or all) and tell clients. */
  async clearChannel(actorId: string, channelName?: string): Promise<void> {
    const channel = channelName ? await this.channels.get(channelName) : undefined;
    if (channelName && !channel) throw new Error(`unknown channel: ${channelName}`);
    await this.messages.clear(actorId, channel ?? undefined);
    this.broadcast(channel ? { type: "clear", channel: channel.name } : { type: "clear" });
  }

  broadcastPresence(): void {
    this.broadcast({ type: "presence_sync", participants: this.roster.list() });
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const conn: Connection = {
      socket,
      participant: null,
      agentProfile: null,
      apiUrl: requestOrigin(request),
      queue: Promise.resolve(),
    };
    this.connections.add(conn);

    socket.on("message", (raw) => {
      let event: ClientEvent;
      try {
        event = clientEventSchema.parse(JSON.parse(raw.toString()));
      } catch (err) {
        console.warn("[hub] malformed event:", err instanceof Error ? err.message : err);
        this.send(conn, { type: "error", error: "malformed event" });
        return;
      }
      conn.queue = conn.queue
        .then(() => this.dispatch(conn, event))
        .catch((err) => console.warn("[hub] message handler error:", err instanceof Error ? err.message : err));
    });

    socket.on("close", () => this.onDisconnect(conn));
  }

  private onDisconnect(conn: Connection): void {
    this.connections.delete(conn);
    if (!conn.participant) return;
    const { id, kind } = conn.participant;
    const stillConnected = [...this.connections].some((c) => c.participant?.id === id);
    if (kind === "human") {
      // A logged-off human stays in the roster as offline (like agents);
      // only their API tokens die with the last connection.
      if (!stillConnected) {
        this.sessions.revokeFor(id);
      }
    } else {
      if (conn.participant.runState === "working") conn.participant.runState = "dead";
      if (!stillConnected) this.runnerRuntime.clear(id);
    }
    this.roster.setOnline(id, stillConnected);
    this.broadcastPresence();
  }

  private async dispatch(conn: Connection, event: ClientEvent): Promise<void> {
    if (event.type === "join") {
      await this.handleJoin(conn, event);
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
        if (!(await this.channels.exists(channel))) {
          this.send(conn, { type: "error", error: `unknown channel: ${channel}` });
          break;
        }
        // Replies point at real messages only; clients resolve them from history.
        if (event.replyToId && !(await this.messages.get(event.replyToId))) {
          this.send(conn, { type: "error", error: `unknown message: ${event.replyToId}` });
          break;
        }
        // The message id is allocated before posting so uploads can be bound
        // to it; a failed bind drops the whole message.
        const messageId = randomUUID();
        let attachments: Attachment[] | undefined;
        if (event.attachmentIds?.length) {
          try {
            attachments = await this.attachments.bind(messageId, event.attachmentIds, participant.id);
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            this.send(conn, { type: "error", error: err.message });
            break;
          }
        }
        await this.postMessage(participant, event.content, channel, {
          id: messageId,
          attachments,
          replyToId: event.replyToId,
          nonce: event.nonce,
        });
        break;
      }
      case "demo_start":
        this.onDemoStart?.(event.channel, participant.id);
        break;
      case "clear":
        await this.clearChannel(participant.id);
        break;
      case "pin":
        await this.handlePin(conn, event);
        break;
      case "message_edit":
        await this.handleMessageEdit(conn, event);
        break;
      case "message_delete":
        await this.handleMessageDelete(conn, event);
        break;
      case "message_react":
        await this.handleMessageReact(conn, event);
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
        await this.handleInterrupt(conn, event.target, event.content);
        break;
      case "status_set":
        participant.status = event.status;
        this.broadcastPresence();
        break;
      case "status_update":
        await this.agentOnly(conn, () => this.handleStatusUpdate(participant, event));
        break;
      case "trace_start":
        await this.agentOnly(conn, () => this.handleTraceStart(participant, event.runId));
        break;
      case "trace_chunk":
        await this.agentOnly(conn, () => this.handleTraceChunk(event.runId, event.chunk));
        break;
      case "summary":
        await this.agentOnly(conn, () => this.handleSummary(participant, event));
        break;
      case "run_end":
        await this.agentOnly(conn, () => this.handleRunEnd(event));
        break;
      case "work_claim":
        await this.agentOnly(conn, () => this.handleWorkClaim(conn, event));
        break;
      case "work_complete":
        await this.agentOnly(conn, () => this.handleWorkComplete(conn, event));
        break;
      case "activity_batch":
        await this.agentOnly(conn, () => this.handleActivityBatch(conn, event));
        break;
      case "agent_run_finish":
        await this.agentOnly(conn, () => this.handleAgentRunFinish(conn, event));
        break;
      case "conversation_session_set":
        await this.agentOnly(conn, () => this.handleConversationSessionSet(conn, event));
        break;
      case "runner_hello":
        await this.agentOnly(conn, () => this.handleRunnerHello(conn, event));
        break;
      case "runner_status":
        await this.agentOnly(conn, () => this.handleRunnerStatus(conn, event));
        break;
      case "action_request":
        await this.handleActionRequest(conn, event);
        break;
      case "interaction_resolve":
        await this.handleInteractionResolve(conn.participant!, event);
        break;
      case "conversation_mode_set":
        await this.handleConversationModeSet(conn.participant!, event);
        break;
    }
  }

  private async handleJoin(conn: Connection, join: JoinEvent): Promise<void> {
    // In guest mode the schema guarantees a name (joins carry name or
    // authToken; a token-only join can stand only where a gate resolves it).
    let decision: JoinDecision;
    try {
      decision = this.options.authorizeJoin
        ? await this.options.authorizeJoin(join)
        : join.name !== undefined
          ? { ok: true, name: join.name }
          : { ok: false };
    } catch (err) {
      // The gate could not reach its verifier (Supabase rate limit/outage) —
      // that says nothing about the credential. Close retryably: clients
      // treat only the "unauthenticated" verdict as fatal, so their normal
      // reconnect backoff covers this.
      console.warn("[hub] join gate unavailable:", err instanceof Error ? err.message : err);
      this.send(conn, { type: "error", error: "auth temporarily unavailable" });
      conn.socket.close();
      return;
    }
    if (!decision.ok) {
      this.send(conn, { type: "error", error: "unauthenticated" });
      conn.socket.close();
      return;
    }
    const { kind } = join;
    const participant = await this.roster.join(kind, decision.name, decision.actorId);

    // Agents are singletons: a new connection for the same agent identity
    // displaces any previous one so duplicates can never double-reply.
    if (kind === "agent") {
      for (const other of this.connections) {
        if (other !== conn && other.participant?.id === participant.id) {
          this.send(other, { type: "error", error: "displaced by newer agent connection" });
          other.participant = null;
          other.agentProfile = null;
          other.socket.close();
        }
      }
    }
    conn.participant = participant;
    conn.agentProfile = decision.profile ?? null;
    if (kind === "agent") {
      await this.agentWork.requeueClaimed(participant.id);
      if (conn.agentProfile) this.runnerRuntime.connect(conn.agentProfile);
    }

    // Bounded per channel (not "last N overall"): clients filter history by
    // channel client-side, so a flat cap would leave quiet channels empty.
    // Older messages page in via GET /api/messages.
    const channelInfos = await this.channels.listInfo();
    const channelList = channelInfos.map((channel) => channel.name);
    const [history, archivedChannels, pinnedChannels, snapshotSeq, contextCursor] = await Promise.all([
      this.messages.recentByChannel(channelList, DEFAULT_HISTORY_LIMIT),
      this.channels.listArchived(),
      this.channels.pinned(),
      this.options.threadEvents
        ? this.options.threadEvents.latestSeq(this.options.workspace.id)
        : Promise.resolve(0),
      this.options.contextCursors
        ? this.options.contextCursors.get(participant.id)
        : Promise.resolve(null),
    ]);
    this.send(conn, {
      type: "welcome",
      workspace: this.options.workspace,
      self: participant,
      history,
      participants: this.roster.list(),
      channels: channelList,
      channelInfos,
      archivedChannels,
      pinnedChannels,
      demoChannels: this.options.demoChannels,
      token: this.sessions.issue(participant.id),
      apiUrl: conn.apiUrl,
      snapshotSeq,
      ...(contextCursor ? { contextCursor } : {}),
      agentConfig: conn.agentProfile ?? undefined,
    });
    if (kind === "agent" && this.runnerRuntime.isAvailable(participant.id)) {
      await this.sendPendingWork(conn);
    }
    this.broadcastPresence();
  }

  /** Pinning is a human act: agents mutate the world only through the toolman. */
  private async handlePin(conn: Connection, event: PinEvent): Promise<void> {
    const participant = conn.participant!;
    if (participant.kind !== "human") {
      this.send(conn, { type: "error", error: "human-only event" });
      return;
    }
    const message = await this.messages.setPinned(
      event.messageId,
      { id: participant.id, name: participant.name },
      event.pinned,
    );
    if (!message) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    this.broadcast({ type: "message_updated", message });
  }

  /** Resolve a message the connection's participant authored, or send the
   *  refusal. Identity comes from the connection, never the frame. */
  private async authoredMessage(conn: Connection, messageId: string): Promise<ChatMessage | null> {
    const message = await this.messages.get(messageId);
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

  private async handleMessageEdit(conn: Connection, event: MessageEditEvent): Promise<void> {
    if (!(await this.authoredMessage(conn, event.messageId))) return;
    const message = (await this.messages.edit(
      event.messageId,
      event.content,
      conn.participant!.id,
    ))!;
    this.broadcast({ type: "message_updated", message });
  }

  private async handleMessageDelete(conn: Connection, event: MessageDeleteEvent): Promise<void> {
    const message = await this.authoredMessage(conn, event.messageId);
    if (!message) return;
    await this.messages.delete(event.messageId);
    this.broadcast({
      type: "message_deleted",
      messageId: event.messageId,
      channel: message.channel ?? "general",
    });
  }

  /** Reactions are idempotent; only an actual change is worth a broadcast. */
  private async handleMessageReact(conn: Connection, event: MessageReactEvent): Promise<void> {
    const participant = conn.participant!;
    if (!(await this.messages.get(event.messageId))) {
      this.send(conn, { type: "error", error: `unknown message: ${event.messageId}` });
      return;
    }
    let changed: boolean;
    if (event.op === "add") {
      const outcome = await this.messages.addReaction(event.messageId, event.emoji, {
        id: participant.id,
        name: participant.name,
      });
      if (outcome === "capped") {
        this.send(conn, { type: "error", error: "reaction limit reached" });
        return;
      }
      changed = outcome === "added";
    } else {
      changed = await this.messages.removeReaction(event.messageId, event.emoji, participant.id);
    }
    if (!changed) return;
    this.broadcast({ type: "message_updated", message: (await this.messages.get(event.messageId))! });
  }

  private async handleInterrupt(conn: Connection, target: string, content: string): Promise<void> {
    const participant = conn.participant!;
    const targetParticipant = this.roster.get("agent", target);
    if (!targetParticipant) {
      this.send(conn, { type: "error", error: `unknown agent: ${target}` });
      return;
    }

    await this.postMessage(participant, `/interrupt @${target} ${content}`, "general");
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

  private async handleWorkClaim(conn: Connection, event: WorkClaimEvent): Promise<void> {
    if (!this.runnerRuntime.isAvailable(conn.participant!.id)) {
      this.send(conn, { type: "error", error: "runner is not ready" });
      return;
    }
    try {
      const assignments = await this.agentWork.claim(conn.participant!.id, event.requestIds);
      this.send(conn, { type: "work_assigned", assignments });
    } catch (err) {
      if (!(err instanceof RunRequestAccessError)) throw err;
      this.send(conn, { type: "error", error: "work request unavailable" });
    }
  }

  private async handleWorkComplete(conn: Connection, event: WorkCompleteEvent): Promise<void> {
    try {
      await this.agentWork.finish(conn.participant!.id, event.requestIds, event.outcome);
    } catch (err) {
      if (!(err instanceof RunRequestAccessError)) throw err;
      this.send(conn, { type: "error", error: "work request unavailable" });
    }
  }

  private async handleActivityBatch(conn: Connection, event: ActivityBatchEvent): Promise<void> {
    try {
      const committed = await this.agentWork.appendActivity(conn.participant!.id, event);
      for (const threadEvent of committed) {
        this.broadcast({ type: "thread_event", event: threadEvent });
      }
    } catch (err) {
      if (!(err instanceof RunRequestAccessError)) throw err;
      this.send(conn, { type: "error", error: "agent activity unavailable" });
    }
  }

  private async handleAgentRunFinish(conn: Connection, event: AgentRunFinishEvent): Promise<void> {
    try {
      const trace = this.traceBuffers.get(event.runId) ?? [];
      const result = await this.agentWork.finishRun(conn.participant!.id, event, trace);
      this.traceBuffers.delete(event.runId);
      if (result.message) {
        this.broadcast({ type: "message", message: result.message });
        this.onMessagePosted?.(result.message);
      }
      for (const threadEvent of result.events) {
        this.broadcast({ type: "thread_event", event: threadEvent });
      }
      if (!result.message) {
        this.broadcast({
          type: "run_end",
          runId: event.runId,
          reason: event.outcome === "cancelled" ? "aborted" : "completed",
        });
      }
    } catch (err) {
      if (!(err instanceof RunRequestAccessError)) throw err;
      this.send(conn, { type: "error", error: "agent run unavailable" });
    }
  }

  private async handleConversationSessionSet(
    conn: Connection,
    event: ConversationSessionSetEvent,
  ): Promise<void> {
    try {
      const updated = await this.agentWork.setConversationSession(conn.participant!.id, event);
      if (updated.event) this.broadcast({ type: "thread_event", event: updated.event });
      this.send(conn, { type: "conversation_updated", conversation: updated.conversation });
    } catch (err) {
      if (!(err instanceof RunRequestAccessError)) throw err;
      this.send(conn, { type: "error", error: "conversation unavailable" });
    }
  }

  private handleRunnerHello(conn: Connection, event: RunnerHelloEvent): void {
    this.runnerRuntime.hello(conn.participant!.id, event);
  }

  private async handleRunnerStatus(conn: Connection, event: RunnerStatusEvent): Promise<void> {
    if (this.runnerRuntime.status(conn.participant!.id, event)) await this.sendPendingWork(conn);
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
      workspaceId: this.options.workspace.id,
    };
    const conversationId = event.conversationId ?? null;
    const mode = conversationId
      ? await this.agentWork.permissionMode(actor.id, conversationId)
      : "default";
    const capability = ACTION_CAPABILITY[event.action.kind];
    if (mode === "plan" && capability) {
      return this.send(conn, {
        type: "action_result",
        requestId: event.requestId,
        ok: false,
        code: "PLAN_MODE",
        error: "plan mode: propose the change and wait for the human to leave plan mode",
      });
    }
    const chatGrant = !event.boardItemRef && Boolean(capability);
    const authz = await this.toolman.authorize(
      actor,
      event.action,
      event.boardItemRef ?? null,
      { chatGrant },
    );
    if (!authz.allow) {
      return this.send(conn, {
        type: "action_result",
        requestId: event.requestId,
        ok: false,
        code: authz.code,
        error: authz.message,
      });
    }
    const gate = await this.gateByMode(actor, event, mode, capability);
    if (gate) {
      return this.send(conn, { type: "action_result", requestId: event.requestId, ...gate });
    }
    const result = await this.toolman.execute(
      actor,
      event.action,
      event.boardItemRef ?? null,
      { chatGrant },
    );
    this.send(conn, { type: "action_result", requestId: event.requestId, ...result });
  }

  /**
   * Layer 2 of the permission model. The board grant (layer 1, inside the
   * toolman) is the hard ceiling; the conversation's mode decides how much of
   * that ceiling runs without asking. Returns a denial to send back, or null to
   * proceed to the toolman.
   */
  private async gateByMode(
    actor: { id: string; workspaceId: string },
    event: ActionRequestEvent,
    mode: "default" | "plan" | "acceptEdits" | "approveAll" | "bypass",
    capability: string | undefined,
  ): Promise<ToolmanResult | null> {
    if (!capability) return null;
    if (mode === "bypass" || mode === "approveAll") return null;
    if (mode === "acceptEdits" && capability === "file_write") return null;
    return await this.awaitApproval(actor, event, capability, event.conversationId ?? null);
  }

  private async awaitApproval(
    actor: { id: string; workspaceId: string },
    event: ActionRequestEvent,
    capability: string,
    conversationId: string | null,
  ): Promise<ToolmanResult | null> {
    let request;
    try {
      request = await this.interactions.open({
        workspaceId: actor.workspaceId,
        channelId: await this.channelOf(conversationId),
        agentId: actor.id,
        conversationId,
        summary: describeAction(event.action),
        capability,
        boardItemRef: event.boardItemRef ?? null,
      });
    } catch (err) {
      // If the decision cannot be recorded it cannot be audited, so nothing
      // runs. Fail closed rather than executing an unlogged mutation.
      console.warn("[hub] approval could not be recorded:", err instanceof Error ? err.message : err);
      return {
        ok: false,
        code: "APPROVAL_UNAVAILABLE",
        error: "permission could not be recorded; the action was not run",
      };
    }
    this.broadcast({ type: "interaction_request", request });

    const decision = await new Promise<"approved" | "denied" | "expired">((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(request.id);
        void this.interactions.resolve(actor.workspaceId, request.id, "expired", null);
        resolve("expired");
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(request.id, (verdict) => {
        clearTimeout(timer);
        this.pendingApprovals.delete(request.id);
        resolve(verdict);
      });
    });

    if (decision === "approved") return null;
    return {
      ok: false,
      code: "APPROVAL_DENIED",
      error:
        decision === "expired"
          ? "nobody answered the permission request in time"
          : "a human declined this action",
    };
  }

  private async handleInteractionResolve(
    participant: Participant,
    event: InteractionResolveEvent,
  ): Promise<void> {
    // Approving is a human act: an agent must not clear its own prompt.
    if (participant.kind !== "human") return;
    const verdict = event.decision === "approve" ? "approved" : "denied";
    const request = await this.interactions.resolve(
      this.options.workspace.id,
      event.requestId,
      verdict,
      participant.id,
    );
    if (!request) return; // already resolved elsewhere; first verdict stands
    this.broadcast({ type: "interaction_resolved", request: { ...request, status: verdict } });
    this.pendingApprovals.get(event.requestId)?.(verdict);
  }

  /** Choosing the mode is a human act; an agent cannot loosen its own leash. */
  private async handleConversationModeSet(
    participant: Participant,
    event: ConversationModeSetEvent,
  ): Promise<void> {
    if (participant.kind !== "human") return;
    const channel = await this.channels.get(event.channel);
    if (!channel) return;
    const conversation = await this.agentWork.setPermissionMode(
      participant.id,
      event.agentId,
      channel.id,
      event.mode,
    );
    this.broadcast({ type: "conversation_updated", conversation });
  }

  private async channelOf(conversationId: string | null): Promise<string> {
    if (!conversationId) return "general";
    return (await this.agentWork.channelOfConversation(conversationId)) ?? "general";
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

  private async handleSummary(participant: Participant, event: SummaryEvent): Promise<void> {
    const trace = this.traceBuffers.get(event.runId) ?? [];
    this.traceBuffers.delete(event.runId);
    await this.postMessage(participant, event.content, event.channel ?? "general", {
      trace: trace.length > 0 ? trace : undefined,
      runId: event.runId,
    });
  }

  private handleRunEnd(event: RunEndEvent): void {
    this.traceBuffers.delete(event.runId);
    this.broadcast({ type: "run_end", runId: event.runId, reason: event.reason });
  }

  private async agentOnly(conn: Connection, handle: () => void | Promise<void>): Promise<void> {
    if (conn.participant?.kind !== "agent") {
      this.send(conn, { type: "error", error: "agent-only event" });
      return;
    }
    await handle();
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

  private notifyWork(agentId: string, requestIds: string[]): void {
    if (requestIds.length === 0 || !this.runnerRuntime.isAvailable(agentId)) return;
    for (const conn of this.connections) {
      if (conn.participant?.id === agentId) this.sendWorkAvailable(conn, requestIds);
    }
  }

  private async sendPendingWork(conn: Connection): Promise<void> {
    const pending = await this.agentWork.listPending(conn.participant!.id);
    this.sendWorkAvailable(conn, pending.map((request) => request.id));
  }

  private sendWorkAvailable(conn: Connection, requestIds: string[]): void {
    for (let index = 0; index < requestIds.length; index += 50) {
      this.send(conn, { type: "work_available", requestIds: requestIds.slice(index, index + 50) });
    }
  }

  updateAgentConfig(profile: AgentInvite): void {
    this.runnerRuntime.update(profile);
    for (const conn of this.connections) {
      if (conn.participant?.id !== profile.actorId || !conn.agentProfile) continue;
      conn.agentProfile = profile;
      this.send(conn, { type: "agent_config", profile });
    }
  }

  /** Disconnect a user-created agent and remove it from the live roster. */
  closeAgentConnection(actorId: string): void {
    for (const conn of this.connections) {
      if (conn.participant?.id === actorId) {
        this.send(conn, { type: "error", error: "agent removed" });
        conn.socket.close();
      }
    }
    this.roster.removeAgent(actorId);
    this.runnerRuntime.clear(actorId);
    this.sessions.revokeFor(actorId);
    this.broadcastPresence();
  }

  /** Disconnect a human whose workspace membership was just revoked and
   *  remove them from the live roster (their next join attempt is refused
   *  by Auth.resolveSession's membership check). */
  closeHumanConnection(actorId: string): void {
    for (const conn of this.connections) {
      if (conn.participant?.id === actorId) {
        this.send(conn, { type: "error", error: "removed from workspace" });
        conn.socket.close();
      }
    }
    this.roster.removeHuman(actorId);
    this.sessions.revokeFor(actorId);
    this.broadcastPresence();
  }

  /** Close the WebSocket server and sever every active connection. */
  async close(): Promise<void> {
    // Let in-flight message handlers finish before we yank the sockets, so
    // queued dispatches don't trip over a closed DB connection.
    await Promise.all([...this.connections].map((conn) => conn.queue.catch(() => {})));
    for (const conn of this.connections) conn.socket.terminate();
    this.connections.clear();
    this.runnerRuntime.clearAll();
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

/** How long a paused run waits for a human before failing closed. */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** One line a human can decide on without opening the activity panel. */
function describeAction(action: ActionRequestEvent["action"]): string {
  if ("command" in action) return `${action.kind}: ${action.command.slice(0, 200)}`;
  if ("from" in action) return `${action.kind} ${action.from} → ${action.to}`;
  if ("path" in action) return `${action.kind} ${action.path ?? "."}`;
  return action.kind;
}

function deriveMentionedAgents(
  author: Participant,
  content: string,
  participants: Participant[],
): Participant[] {
  if (
    author.kind !== "human" ||
    content.trimStart().toLowerCase().startsWith("/interrupt")
  ) {
    return [];
  }
  return participants.filter((participant) => {
    if (participant.kind !== "agent") return false;
    const escapedName = participant.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(
      `(?<![\\p{L}\\p{N}_])@${escapedName}(?![\\p{L}\\p{N}_-])`,
      "iu",
    );
    return mention.test(content);
  });
}
