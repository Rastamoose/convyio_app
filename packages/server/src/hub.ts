import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  ACTION_CAPABILITY,
  clientEventSchema,
  isReadOnlyToolmanAction,
  type ActionRequestEvent,
  type ActivityBatchEvent,
  type Actor,
  type AgentInvite,
  type AgentProvider,
  type AgentResourceAccessRequest,
  type AgentRunFinishEvent,
  type Attachment,
  type BoardEventEnvelope,
  type PlanEventEnvelope,
  type ChannelInfo,
  type ChannelSection,
  type ChatMessage,
  type ClientEvent,
  type ConversationModeSetEvent,
  type ConversationSessionSetEvent,
  type DemoControlEvent,
  type DemoProgressEvent,
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
  type ThreadEvent,
  type ToolExecution,
  type TraceChunk,
  type TraceResumedEvent,
  type TraceSuspendedEvent,
  type WorkClaimEvent,
  type WorkCompleteEvent,
  type WorkspaceInfo,
} from "@workspace/shared";
import { ApiError } from "./board/BoardService";
import { RateLimiter } from "./auth/RateLimiter";
import type { InteractionStore } from "./chat/InteractionStore";
import { RunRequestAccessError, type AgentWorkStore } from "./chat/AgentWorkStore";
import type { Attachments } from "./chat/Attachments";
import type { Channels } from "./chat/Channels";
import { DEFAULT_HISTORY_LIMIT, type MessageStore } from "./chat/MessageStore";
import type { Roster } from "./roster";
import type { Sessions } from "./board/sessions";
import type { BoardService } from "./board/BoardService";
import type { ProjectAction } from "@workspace/shared";
import type { Toolman, ToolmanResult } from "./board/Toolman";
import type { GitRepositories } from "./projects/GitRepositories";
import type { ProjectStore } from "./projects/ProjectStore";
import type { ToolmanGateway } from "./projects/ToolmanGateway";
import type { ToolExecutionStore } from "./projects/ToolExecutionStore";
import { folderConsent } from "./projects/folderConsent";
import { requestOrigin } from "./requestOrigin";
import type { RunnerRuntime } from "./RunnerRuntime";
import type { ContextCursorStore } from "./context/ContextCursorStore";
import type { ResourceAccessStore } from "./context/ResourceAccessStore";
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
  /** Answered the last heartbeat ping; false for two rounds means dead. */
  alive: boolean;
}

/**
 * Ping interval. Under the 60s idle timeout every proxy in front of us uses:
 * without traffic the connection is cut silently and clients reconnect-loop.
 * It is also how presence learns the truth — a process that was killed or lost
 * its network never sends a close frame, so without a heartbeat its
 * participant stays green until the OS gives up on the TCP socket (minutes, or
 * never). Missing two rounds terminates the socket, which runs the ordinary
 * disconnect path and turns the dot grey.
 */
const HEARTBEAT_MS = 30_000;
const MAX_CONTEXT_READ_CHARS = 12_000;

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
  /** Overrides HEARTBEAT_MS. Only tests set it, so presence-on-death is
   *  observable without waiting out a real 30s round. */
  heartbeatMs?: number;
  /** Sequenced workspace projection used to stamp welcome.snapshotSeq. */
  threadEvents?: ThreadEventStore;
  contextCursors?: ContextCursorStore;
  resourceAccess?: ResourceAccessStore;
  projects?: ProjectStore;
  gitRepositories?: GitRepositories;
  toolmanGateway?: ToolmanGateway;
  executions?: ToolExecutionStore;
  board?: BoardService;
}

interface AgentOccupancy {
  kind: "working" | "waiting";
  /** Where the agent is stuck — origin thread, not the resource it wants. */
  location: string;
  reason: string;
  /** What the pending approval is for, when that is distinct from location. */
  target?: string;
}

/**
 * The dumb shell. Routes typed events between participants, persists chat
 * through the message store, and forwards agent actions to the toolman. It
 * has no notion of AI — humans and agents are both just participants on
 * identical websocket connections.
 */
export class Hub {
  private wss: WebSocketServer;
  private heartbeat: NodeJS.Timeout;
  private connections = new Set<Connection>();
  /** In-memory trace buffers keyed by runId. Dropped once summarized. */
  private traceBuffers = new Map<string, TraceChunk[]>();
  /** Optional hook fired for every message posted to the channel. */
  onMessagePosted: ((message: ChatMessage) => void) | null = null;
  /** Optional hook fired when a client requests the scripted demo. */
  onDemoStart: ((channel: string, mode: "walkthrough" | "live" | undefined, actorId: string) => void) | null = null;
  /** Optional hook fired for demo playback controls. */
  onDemoControl: ((channel: string, action: string, actorId: string) => void) | null = null;
  /** Optional hook fired for every board event fanned out to clients. */
  onBoardEvent: ((envelope: BoardEventEnvelope) => void) | null = null;
  /** Optional hook fired for every plan event fanned out to clients. */
  onPlanEvent: ((envelope: PlanEventEnvelope) => void) | null = null;

  /** Runs paused on a human decision, keyed by interaction request id. */
  private pendingApprovals = new Map<string, (verdict: "approved" | "denied" | "expired") => void>();
  private rateLimiter = new RateLimiter();
  /** Folder-owner approvals for the rest of a conversation, keyed by agent:folder:conversation. */
  private folderLeases = new Map<string, string>();

  private channelNameCache = new Map<string, string | null>();

  constructor(
    server: HttpServer | null,
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
    // noServer: ToolmanGateway also upgrades this HTTP server on /toolman.
    // Two WebSocketServers both attached via `{ server }` both get every
    // upgrade; the first that doesn't match its path abortHandshake(400)s
    // the rest — which is why the client/agent join on `/` saw empty data.
    this.wss = new WebSocketServer({ noServer: true });
    if (server) {
      server.on("upgrade", (req, socket, head) => {
        const pathname = (req.url ?? "/").split("?")[0];
        if (pathname === "/toolman") return;
        this.handleUpgrade(req, socket, head);
      });
    }
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
    // unref: a heartbeat must not be the reason the process stays alive.
    this.heartbeat = setInterval(() => this.pingAll(), options.heartbeatMs ?? HEARTBEAT_MS).unref();
  }

  private pingAll(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request);
    });
  }

  broadcastBoardEvent(envelope: BoardEventEnvelope): void {
    void this.broadcastBoardEnvelope(envelope);
    this.onBoardEvent?.(envelope);
    if (envelope.type === "item.approved") {
      void this.dispatchApprovedTicket(envelope).catch((err) => {
        console.warn("[hub] ticket dispatch failed:", err instanceof Error ? err.message : err);
      });
    }
  }

  private async dispatchApprovedTicket(envelope: BoardEventEnvelope): Promise<void> {
    const item = envelope.item;
    if (!item.owner) return;
    const owner = this.roster.list().find((participant) => participant.id === item.owner);
    if (!owner || owner.kind !== "agent") return;
    const channel = await this.channels.resolve(item.originChannelId);
    if (!channel) return;

    const occupancy = await this.checkAgentOccupancy(owner.id, channel.id);
    if (occupancy) {
      const reply = this.buildOccupancyReply(owner, occupancy, channel, Date.now());
      await this.messages.append(reply);
      await this.broadcastMessage({ type: "message", message: reply });
      this.onMessagePosted?.(reply);
      return;
    }

    const queued = await this.agentWork.queueApprovedTicket({
      actor: { id: envelope.actor.id, displayName: envelope.actor.display_name },
      owner: { id: owner.id, displayName: owner.name, kind: owner.kind },
      item: { id: item.id, ref: item.ref, title: item.title },
      channelId: channel.id,
      channelName: channel.name,
    });
    if (!queued) return;
    this.broadcast({ type: "message", message: queued.message });
    this.notifyWork(owner.id, [queued.request.id]);
  }

  broadcastPlanEvent(envelope: PlanEventEnvelope): void {
    void this.broadcastPlanEnvelope(envelope);
    this.onPlanEvent?.(envelope);
  }

  broadcastThreadEvent(event: ThreadEvent): void {
    void this.broadcastThreadEventScoped(event);
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

  broadcastChannelSectionCreated(section: ChannelSection): void {
    this.broadcast({ type: "channel_section_created", section });
  }

  broadcastChannelMoved(name: string, sectionId: string | null): void {
    this.broadcast({ type: "channel_moved", channel: name, sectionId });
  }

  broadcastDemoProgress(event: DemoProgressEvent): void {
    this.broadcast(event);
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

    // Determine which agents can accept work right now. An agent that is
    // already working in another channel or waiting for any human approval is
    // globally unavailable; the user gets a deterministic templated reply
    // instead of being silently mixed into an ongoing run.
    const allowedAgents: Participant[] = [];
    const occupiedAgents: { agent: Participant; occupancy: AgentOccupancy }[] = [];
    for (const agent of mentionedAgents) {
      const occupancy = await this.checkAgentOccupancy(agent.id, channelInfo.id);
      if (occupancy) {
        occupiedAgents.push({ agent, occupancy });
        continue;
      }
      if (this.options.resourceAccess) {
        const hasAccess = await this.options.resourceAccess.has(agent.id, "channel", channelInfo.id);
        if (!hasAccess) {
          await this.options.resourceAccess.requestIfNeeded(this.toActor(agent), {
            resourceKind: "channel",
            resourceId: channelInfo.id,
            reason: `Mentioned in #${channelInfo.name}`,
            originChannelId: channelInfo.id,
          });
          occupiedAgents.push({
            agent,
            occupancy: {
              kind: "waiting",
              location: "this channel",
              target: `#${channelInfo.name}`,
              reason: `waiting for access approval to #${channelInfo.name}`,
            },
          });
          continue;
        }
      }
      allowedAgents.push(agent);
    }

    const message: ChatMessage = {
      id,
      authorId: author.id,
      authorName: author.name,
      authorKind: author.kind,
      content,
      timestamp: Date.now(),
      channelId: channelInfo.id,
      mentions: allowedAgents.map((agent) => agent.id),
      channel: channelInfo.name,
      ...rest,
    };
    const { requests, replies } = await this.messages.appendAtomically(message, async (sql) => {
      const queued = await this.agentWork.queue(sql, message, message.mentions ?? []);
      const replyMessages: ChatMessage[] = [];
      for (let index = 0; index < occupiedAgents.length; index++) {
        const { agent, occupancy } = occupiedAgents[index];
        const reply = this.buildOccupancyReply(agent, occupancy, channelInfo, message.timestamp + 1 + index);
        await this.messages.appendInTransaction(sql, reply, { clientEventId: `occupancy-reply:${reply.id}` });
        replyMessages.push(reply);
      }
      return { requests: queued, replies: replyMessages };
    });
    await this.broadcastMessage(
      nonce === undefined ? { type: "message", message } : { type: "message", message, nonce },
    );
    for (const reply of replies) {
      await this.broadcastMessage({ type: "message", message: reply });
      this.onMessagePosted?.(reply);
    }
    for (const agent of allowedAgents) {
      this.notifyWork(
        agent.id,
        requests.filter((request) => request.agentId === agent.id).map((request) => request.id),
      );
    }
    this.onMessagePosted?.(message);
  }

  /**
   * Describes why an agent cannot start a new run right now.
   * `location` is the human-readable place the agent is stuck.
   */
  private async checkAgentOccupancy(agentId: string, currentChannelId: string): Promise<AgentOccupancy | null> {
    const workspaceId = this.options.workspace.id;

    // Waiting on a human approval blocks every channel, even the one the
    // approval was raised in.
    const interactions = await this.interactions.pendingForAgent(workspaceId, agentId);
    if (interactions.length > 0) {
      const interaction = interactions[0];
      const channelName = await this.lookupChannelName(interaction.channelId);
      return {
        kind: "waiting",
        location: this.formatChannelLocation(currentChannelId, interaction.channelId, channelName),
        reason: `waiting for approval to ${interaction.capability}`,
      };
    }

    if (this.options.resourceAccess) {
      const resourceRequests = (await this.options.resourceAccess.requestsForAgent(agentId)).filter(
        (request) => request.status === "pending",
      );
      const request = this.chooseOccupyingResourceRequest(resourceRequests, currentChannelId);
      if (request) {
        const originName = await this.lookupChannelName(request.originChannelId);
        const target = this.formatAccessTarget(request);
        return {
          kind: "waiting",
          location: this.formatChannelLocation(currentChannelId, request.originChannelId, originName),
          target,
          reason: `waiting for access approval to ${target}`,
        };
      }
    }

    if (this.options.board) {
      const proposedItems = (await this.options.board.list(workspaceId, { status: "proposed" })).filter(
        (item) => item.createdBy === agentId && item.status === "proposed",
      );
      if (proposedItems.length > 0) {
        const item = proposedItems[0];
        const channelName = item.originChannelName ?? (await this.lookupChannelName(item.originChannelId ?? null));
        return {
          kind: "waiting",
          location: this.formatChannelLocation(currentChannelId, item.originChannelId ?? currentChannelId, channelName),
          reason: `waiting for approval of ${item.ref} (${item.title})`,
        };
      }
    }

    // A claimed run in a different channel means the agent is currently
    // responding there. A claimed run in the same channel is fine: the new
    // message will queue and run after the current one finishes.
    const activeRuns = await this.agentWork.listActive(agentId);
    if (activeRuns.length > 0) {
      const run = activeRuns[0];
      if (run.channelId !== currentChannelId) {
        const channelName = await this.lookupChannelName(run.channelId);
        return {
          kind: "working",
          location: this.formatChannelLocation(currentChannelId, run.channelId, channelName),
          reason: `already responding`,
        };
      }
    }

    return null;
  }

  private formatChannelLocation(currentChannelId: string, channelId: string | null, channelName: string): string {
    if (channelId && channelId === currentChannelId) return "this channel";
    return channelName === "workspace" ? "workspace" : `#${channelName}`;
  }

  /**
   * Pending access occupies the agent globally. Prefer a request for a
   * different resource than the current channel so a later foreign request
   * is not hidden behind a first-mention grant for this room.
   */
  private chooseOccupyingResourceRequest(
    requests: AgentResourceAccessRequest[],
    currentChannelId: string,
  ): AgentResourceAccessRequest | null {
    if (requests.length === 0) return null;
    const foreign = requests.filter(
      (request) => request.resourceKind !== "channel" || request.resourceId !== currentChannelId,
    );
    const pool = foreign.length > 0 ? foreign : requests;
    return pool[pool.length - 1] ?? null;
  }

  private formatAccessTarget(request: AgentResourceAccessRequest): string {
    const name = request.resourceName ?? request.resourceId;
    if (request.resourceKind === "channel") return `#${name}`;
    if (request.resourceKind === "git_project") return `Git project ${name}`;
    if (request.resourceKind === "local_project") return `local project ${name}`;
    return `workspace file ${name}`;
  }

  private toActor(participant: Participant): Actor {
    return {
      id: participant.id,
      workspaceId: this.options.workspace.id,
      kind: participant.kind === "agent" ? "agent" : "human",
      displayName: participant.name,
    };
  }

  private buildOccupancyReply(
    agent: Participant,
    occupancy: AgentOccupancy,
    channelInfo: ChannelInfo,
    timestamp: number,
  ): ChatMessage {
    const content =
      occupancy.kind === "waiting" && occupancy.target
        ? `${agent.name} is waiting for a decision in ${occupancy.location} to access ${occupancy.target}. Resolve that approval first, then continue here.`
        : occupancy.kind === "waiting"
          ? `${agent.name} is waiting for a decision in ${occupancy.location} (${occupancy.reason}). Resolve that approval first, then continue here.`
          : `${agent.name} is currently occupied in ${occupancy.location} (${occupancy.reason}). Wait for it to finish there, or continue the conversation in that channel.`;
    return {
      id: randomUUID(),
      authorId: agent.id,
      authorName: agent.name,
      authorKind: "agent",
      content,
      timestamp,
      channelId: channelInfo.id,
      channel: channelInfo.name,
      mentions: [],
    };
  }

  private async lookupChannelName(channelId: string | null): Promise<string> {
    if (!channelId) return "workspace";
    const cached = this.channelNameCache.get(channelId);
    if (cached !== undefined) return cached ?? "unknown";
    const channel = await this.channels.getById(channelId);
    const name = channel?.name ?? "unknown";
    this.channelNameCache.set(channelId, channel ? name : null);
    return name;
  }

  /** Clear one channel's messages (or all) and tell clients. */
  async clearChannel(actorId: string, channelName?: string, work = false): Promise<void> {
    const channel = channelName ? await this.channels.get(channelName) : undefined;
    if (channelName && !channel) throw new Error(`unknown channel: ${channelName}`);
    await this.messages.clear(actorId, channel ?? undefined);
    this.broadcast(channel ? { type: "clear", channel: channel.name, ...(work ? { work: true } : {}) } : { type: "clear" });
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
      alive: true,
    };
    this.connections.add(conn);
    socket.on("pong", () => {
      conn.alive = true;
    });

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
        this.sessions.revokeFor(
          id,
          this.options.authorizeJoin ? this.options.workspace.id : undefined,
        );
        this.revokeFolderLeasesFor(id);
        void this.expireOwnerApprovals(id);
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
        if (!this.rateLimiter.take(`${participant.id}:message`, 60, 10_000)) {
          this.send(conn, { type: "error", error: "message rate limit exceeded" });
          break;
        }
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
        this.onDemoStart?.(event.channel, event.mode, participant.id);
        break;
      case "demo_control":
        this.onDemoControl?.(event.channel, event.action, participant.id);
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
      case "agent_activate":
        this.handleAgentActivate(conn, event.target, event.active);
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
      case "trace_suspended":
        await this.agentOnly(conn, () => this.handleTraceSuspended(participant, event));
        break;
      case "trace_resumed":
        await this.agentOnly(conn, () => this.handleTraceResumed(participant, event));
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
      case "action_cancel":
        this.options.toolmanGateway?.cancel(event.requestId);
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
    const [rawHistory, archivedChannels, pinnedChannels, channelSections, snapshotSeq, contextCursor] = await Promise.all([
      this.messages.recentByChannel(channelList, DEFAULT_HISTORY_LIMIT),
      this.channels.listArchived(),
      this.channels.pinned(),
      this.channels.listSections(),
      this.options.threadEvents
        ? this.options.threadEvents.latestSeq(this.options.workspace.id)
        : Promise.resolve(0),
      this.options.contextCursors
        ? this.options.contextCursors.get(participant.id)
        : Promise.resolve(null),
    ]);
    const history = kind === "agent" && this.options.resourceAccess
      ? await this.authorizedHistory(participant.id, rawHistory)
      : rawHistory;
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
      channelSections,
      demoChannels: this.options.demoChannels,
      token: this.sessions.issue(
        participant.id,
        this.options.authorizeJoin ? this.options.workspace.id : null,
      ),
      apiUrl: conn.apiUrl,
      snapshotSeq,
      ...(contextCursor ? { contextCursor } : {}),
      agentConfig: conn.agentProfile ?? undefined,
    });
    // A runner that was awake before it dropped comes back awake, so a crash
    // restart or a machine re-login is invisible instead of looking like death.
    if (kind === "agent" && this.runnerRuntime.isActivated(participant.id)) {
      this.send(conn, { type: "agent_activation", active: true });
    }
    if (this.options.executions) {
      const recent = await this.options.executions.listRecent();
      for (const execution of recent) {
        const allowed =
          participant.kind === "human" ||
          participant.id === execution.agentId ||
          !this.options.resourceAccess ||
          (execution.channelId !== null && await this.options.resourceAccess.has(participant.id, "channel", execution.channelId));
        if (allowed) this.send(conn, { type: "tool_execution", execution });
      }
    }
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

  /**
   * Wake or sleep a paired runner's local harness. Starting a harness runs
   * code with filesystem access on the creator's own machine, so this is
   * deliberately narrower than /interrupt: only the human who created the
   * agent may flip it, and the check reads createdBy off the target's own
   * connection rather than anything the caller supplied.
   */
  private handleAgentActivate(conn: Connection, target: string, active: boolean): void {
    const participant = conn.participant!;
    const targetConn = [...this.connections].find((c) => c.participant?.id === target);
    // No live connection means the machine is off or the runner was never
    // started — there is nothing to wake, and no createdBy to authorize against.
    if (!targetConn?.agentProfile) {
      this.send(conn, { type: "error", error: "agent is offline" });
      return;
    }
    if (participant.kind !== "human" || targetConn.agentProfile.createdBy !== participant.id) {
      this.send(conn, { type: "error", error: "only the agent's creator can activate it" });
      return;
    }
    this.runnerRuntime.setActivated(target, active);
    this.send(targetConn, { type: "agent_activation", active });
    this.broadcastPresence();
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
        await this.broadcastThreadEventScoped(threadEvent);
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
        await this.broadcastMessage({ type: "message", message: result.message });
        this.onMessagePosted?.(result.message);
      }
      for (const threadEvent of result.events) {
        await this.broadcastThreadEventScoped(threadEvent);
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
      if (updated.event) await this.broadcastThreadEventScoped(updated.event);
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
      return this.sendToParticipant(p.id, {
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
      return this.sendToParticipant(p.id, {
        type: "action_result",
        requestId: event.requestId,
        ok: false,
        code: authz.code,
        error: authz.message,
      });
    }
    if (isProjectAction(event.action)) {
      const folderGate = await this.gateFolderAccess(actor, event, event.action);
      if (folderGate.result) {
        return this.sendToParticipant(p.id, { type: "action_result", requestId: event.requestId, ...folderGate.result });
      }
      if (!folderGate.ownerPromptApproved) {
        const gate = await this.gateByMode(actor, event, mode, capability);
        if (gate) {
          return this.sendToParticipant(p.id, { type: "action_result", requestId: event.requestId, ...gate });
        }
      }
    } else {
      const gate = await this.gateByMode(actor, event, mode, capability);
      if (gate) {
        return this.sendToParticipant(p.id, { type: "action_result", requestId: event.requestId, ...gate });
      }
    }
    const result = isProjectAction(event.action)
      ? await this.executeProjectAction(actor, event.action, event.boardItemRef ?? null, conversationId, event.requestId)
      : await this.toolman.execute(actor, event.action, event.boardItemRef ?? null, { chatGrant });
    if (isReadOnlyToolmanAction(event.action.kind) && result.ok && (result.output?.length ?? 0) > MAX_CONTEXT_READ_CHARS) {
      return this.sendToParticipant(p.id, {
        type: "action_result",
        requestId: event.requestId,
        ok: false,
        error: "CONTEXT_BUDGET_EXCEEDED: narrow the search or read a smaller resource",
      });
    }
    this.sendToParticipant(p.id, { type: "action_result", requestId: event.requestId, ...result });
  }

  /**
   * Local-folder consent. Conversation permission modes never widen this:
   * deny refuses, always is durable consent, and ask requires the owner online.
   */
  private async gateFolderAccess(
    actor: { id: string; workspaceId: string },
    event: ActionRequestEvent,
    action: ProjectAction,
  ): Promise<{ result: ToolmanResult | null; ownerPromptApproved: boolean }> {
    if (!this.options.projects) {
      return {
        result: { ok: false, code: "CHECKOUT_UNAVAILABLE", error: "project actions require a paired Toolman node" },
        ownerPromptApproved: false,
      };
    }
    const project = await this.options.projects.find(action.projectId);
    if (!project || project.archivedAt) {
      return {
        result: { ok: false, code: "PROJECT_REQUIRED", error: "no such folder" },
        ownerPromptApproved: false,
      };
    }
    const assignment = await this.options.projects.assignment(action.projectId, actor.id);
    if (!assignment) {
      return {
        result: { ok: false, code: "PROJECT_UNASSIGNED", error: "you are not assigned to this project" },
        ownerPromptApproved: false,
      };
    }
    if (assignment.status !== "ready" && assignment.status !== "pending") {
      return {
        result: { ok: false, code: "CHECKOUT_UNAVAILABLE", error: assignment.lastError ?? "the assigned checkout is not ready" },
        ownerPromptApproved: false,
      };
    }
    const decision = folderConsent(project, this.isHumanOnline(project.createdBy));
    if ("allow" in decision) {
      return {
        result: decision.allow ? null : { ok: false, code: decision.code, error: decision.message },
        ownerPromptApproved: false,
      };
    }
    const leaseKey = folderLeaseKey(actor.id, action.projectId, event.conversationId ?? null);
    if (this.folderLeases.get(leaseKey) === project.createdBy) {
      return { result: null, ownerPromptApproved: true };
    }
    const capability = ACTION_CAPABILITY[action.kind] ?? "folder_read";
    const gate = await this.awaitApproval(actor, event, capability, event.conversationId ?? null, project.createdBy);
    if (gate) return { result: gate, ownerPromptApproved: false };
    this.folderLeases.set(leaseKey, project.createdBy);
    return { result: null, ownerPromptApproved: true };
  }

  private isHumanOnline(actorId: string): boolean {
    return this.roster.list().some((participant) => participant.id === actorId && participant.kind === "human" && participant.online);
  }

  private revokeFolderLeasesFor(ownerId: string): void {
    for (const [key, owner] of this.folderLeases) {
      if (owner === ownerId) this.folderLeases.delete(key);
    }
  }

  private async expireOwnerApprovals(ownerId: string): Promise<void> {
    const expired = await this.interactions.expireForTarget(this.options.workspace.id, ownerId);
    for (const request of expired) {
      this.pendingApprovals.get(request.id)?.("expired");
      this.broadcast({ type: "interaction_resolved", request });
    }
  }

  private async executeProjectAction(
    actor: import("@workspace/shared").Actor,
    action: ProjectAction,
    boardItemRef: string | null,
    conversationId: string | null,
    requestId?: string,
  ): Promise<ToolmanResult> {
    if (!this.options.projects) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE", error: "project actions are not available" };
    }
    const assignment = await this.options.projects.assignment(action.projectId, actor.id);
    if (!assignment) {
      return { ok: false, code: "PROJECT_UNASSIGNED", error: "you are not assigned to this project" };
    }
    if (assignment.status !== "ready" && assignment.status !== "pending") {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE", error: assignment.lastError ?? "the assigned checkout is not ready" };
    }
    const managed = Boolean(this.options.gitRepositories && await this.options.gitRepositories.isManaged(action.projectId));
    const mount = assignment.mountId && this.options.toolmanGateway
      ? await this.options.toolmanGateway.findMount(assignment.mountId)
      : null;
    if (!managed && (!assignment.mountId || !mount || !this.options.toolmanGateway)) {
      return { ok: false, code: "CHECKOUT_UNAVAILABLE", error: "the assigned project mount is gone" };
    }
    let started: { execution: import("@workspace/shared").ToolExecution; event?: import("@workspace/shared").ThreadEvent } | null = null;
    if (this.options.executions) {
      try {
        started = await this.options.executions.start({
          agentId: actor.id,
          projectId: action.projectId,
          mountId: assignment.mountId,
          nodeId: mount?.nodeId ?? null,
          boardItemRef,
          conversationId,
          action,
        });
        await this.broadcastToolExecution(started.execution);
        if (started.event) await this.broadcastThreadEventScoped(started.event);
      } catch (err) {
        console.warn("[hub] could not persist tool execution:", err instanceof Error ? err.message : err);
      }
    }
    const result = managed
      ? await this.options.gitRepositories!.execute(actor, action)
      : await this.options.toolmanGateway!.execute(assignment, action, requestId);
    if (started && this.options.executions) {
      try {
        const finished = await this.options.executions.finish(started.execution.id, {
          ok: result.ok,
          output: result.output,
          error: result.error,
        });
        await this.broadcastToolExecution(finished.execution);
        await this.broadcastThreadEventScoped(finished.event);
      } catch (err) {
        console.warn("[hub] could not finish tool execution:", err instanceof Error ? err.message : err);
      }
    }
    return { ...result, executionId: started?.execution.id };
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
    targetActorId?: string | null,
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
        targetActorId,
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
    const pending = await this.interactions.findPending(this.options.workspace.id, event.requestId);
    if (pending?.targetActorId && pending.targetActorId !== participant.id) return;
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
    this.broadcastHumans({
      type: "trace_start",
      runId,
      agentId: participant.id,
      agentName: participant.name,
      timestamp: Date.now(),
    });
  }

  private handleTraceChunk(runId: string, chunk: TraceChunk): void {
    this.traceBuffers.get(runId)?.push(chunk);
    this.broadcastHumans({ type: "trace_chunk", runId, chunk });
  }

  private handleTraceSuspended(participant: Participant, event: TraceSuspendedEvent): void {
    this.broadcastHumans({
      type: "trace_suspended",
      runId: event.runId,
      agentId: participant.id,
      agentName: participant.name,
      reason: event.reason,
      timestamp: Date.now(),
    });
  }

  private handleTraceResumed(participant: Participant, event: TraceResumedEvent): void {
    this.broadcastHumans({
      type: "trace_resumed",
      runId: event.runId,
      agentId: participant.id,
      agentName: participant.name,
      timestamp: Date.now(),
    });
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
    this.broadcastHumans({ type: "run_end", runId: event.runId, reason: event.reason });
  }

  private async agentOnly(conn: Connection, handle: () => void | Promise<void>): Promise<void> {
    if (conn.participant?.kind !== "agent") {
      this.send(conn, { type: "error", error: "agent-only event" });
      return;
    }
    await handle();
  }

  private async authorizedHistory(agentId: string, history: ChatMessage[]): Promise<ChatMessage[]> {
    const channelIds = [...new Set(history.flatMap((message) => message.channelId ?? []))];
    const accessible = new Set(
      (
        await Promise.all(
          channelIds.map(async (channelId) =>
            (await this.options.resourceAccess!.has(agentId, "channel", channelId)) ? channelId : null,
          ),
        )
      ).filter((channelId): channelId is string => channelId !== null),
    );
    return history.filter((message) => message.channelId !== undefined && accessible.has(message.channelId));
  }

  private async broadcastThreadEventScoped(event: ThreadEvent): Promise<void> {
    const payload = JSON.stringify({ type: "thread_event", event });
    const isGlobal =
      event.channelId === null ||
      event.kind.startsWith("resource.access.") ||
      event.kind.startsWith("note.");
    for (const conn of this.connections) {
      if (conn.socket.readyState !== WebSocket.OPEN || !conn.participant) continue;
      const allowed =
        conn.participant.kind === "human" ||
        conn.participant.id === event.actorId ||
        isGlobal ||
        !this.options.resourceAccess ||
        (event.channelId !== null && await this.options.resourceAccess.has(conn.participant.id, "channel", event.channelId));
      if (allowed) conn.socket.send(payload);
    }
  }

  private async broadcastToolExecution(execution: ToolExecution): Promise<void> {
    const payload = JSON.stringify({ type: "tool_execution", execution });
    for (const conn of this.connections) {
      if (conn.socket.readyState !== WebSocket.OPEN || !conn.participant) continue;
      const allowed =
        conn.participant.kind === "human" ||
        conn.participant.id === execution.agentId ||
        !this.options.resourceAccess ||
        (execution.channelId !== null && await this.options.resourceAccess.has(conn.participant.id, "channel", execution.channelId));
      if (allowed) conn.socket.send(payload);
    }
  }

  private async broadcastBoardEnvelope(envelope: BoardEventEnvelope): Promise<void> {
    const globallyPublished = ["approved", "in_progress", "blocked", "done"].includes(envelope.item.status);
    const payload = JSON.stringify(envelope);
    for (const conn of this.connections) {
      if (conn.socket.readyState !== WebSocket.OPEN || !conn.participant) continue;
      const allowed =
        conn.participant.kind === "human" ||
        conn.participant.id === envelope.actor.id ||
        globallyPublished ||
        !this.options.resourceAccess ||
        (envelope.item.originChannelId !== null &&
          envelope.item.originChannelId !== undefined &&
          await this.options.resourceAccess.has(conn.participant.id, "channel", envelope.item.originChannelId));
      if (allowed) conn.socket.send(payload);
    }
  }

  private async broadcastPlanEnvelope(envelope: PlanEventEnvelope): Promise<void> {
    const payload = JSON.stringify(envelope);
    for (const conn of this.connections) {
      if (conn.socket.readyState !== WebSocket.OPEN || !conn.participant) continue;
      const allowed =
        conn.participant.kind === "human" ||
        conn.participant.id === envelope.actor.id ||
        !this.options.resourceAccess ||
        (envelope.plan.originChannelId !== null &&
          envelope.plan.originChannelId !== undefined &&
          await this.options.resourceAccess.has(conn.participant.id, "channel", envelope.plan.originChannelId));
      if (allowed) conn.socket.send(payload);
    }
  }

  private async broadcastMessage(event: Extract<ServerEvent, { type: "message" }>): Promise<void> {
    const payload = JSON.stringify(event);
    for (const conn of this.connections) {
      if (conn.socket.readyState !== WebSocket.OPEN || !conn.participant) continue;
      const allowed =
        conn.participant.kind === "human" ||
        conn.participant.id === event.message.authorId ||
        !this.options.resourceAccess ||
        (event.message.channelId !== undefined &&
          await this.options.resourceAccess.has(conn.participant.id, "channel", event.message.channelId));
      if (allowed) conn.socket.send(payload);
    }
  }

  private broadcastHumans(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const conn of this.connections) {
      if (conn.participant?.kind === "human" && conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(payload);
      }
    }
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

  /** Send to every connection currently belonging to a participant.
   *  Used for action_result frames because the agent may reconnect while
   *  a mutation is paused on human approval. */
  private sendToParticipant(participantId: string, event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const conn of this.connections) {
      if (conn.participant?.id === participantId && conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(payload);
      }
    }
  }

  private notifyWork(agentId: string, requestIds: string[]): void {
    if (requestIds.length === 0 || !this.runnerRuntime.isAvailable(agentId)) return;
    for (const conn of this.connections) {
      if (conn.participant?.id === agentId) this.sendWorkAvailable(conn, requestIds);
    }
  }

  private async sendPendingWork(conn: Connection): Promise<void> {
    const agentId = conn.participant!.id;
    let pending = await this.agentWork.listPending(agentId);
    // Never dispatch work in a different channel while the agent is already
    // in a run. Same-channel work is queued and processed after the current
    // run finishes; cross-channel work waits until the agent is free.
    const active = await this.agentWork.listActive(agentId);
    if (active.length > 0) {
      const activeChannelId = active[0].channelId;
      pending = pending.filter((request) => request.channelId === activeChannelId);
    }
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
    this.runnerRuntime.forget(actorId);
    this.sessions.revokeFor(
      actorId,
      this.options.authorizeJoin ? this.options.workspace.id : undefined,
    );
    this.broadcastPresence();
  }

  async addOfflineMember(actorId: string): Promise<void> {
    await this.roster.addOffline(actorId);
    this.broadcastPresence();
    const notice = await this.messages.get(`member-joined:${this.options.workspace.id}:${actorId}`);
    if (notice) this.broadcast({ type: "message", message: notice });
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
    this.sessions.revokeFor(
      actorId,
      this.options.authorizeJoin ? this.options.workspace.id : undefined,
    );
    this.broadcastPresence();
  }

  /** Close the WebSocket server and sever every active connection. */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
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

function isProjectAction(action: ActionRequestEvent["action"]): action is ProjectAction {
  return action.kind.startsWith("project_");
}

function folderLeaseKey(agentId: string, projectId: string, conversationId: string | null): string {
  return `${agentId}:${projectId}:${conversationId ?? "-"}`;
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
