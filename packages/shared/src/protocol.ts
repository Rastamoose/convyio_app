import { z } from "zod";
import type { ChatMessage, Participant, TraceChunk } from "./participant";
import type { AuthzDenyCode, BoardEventEnvelope } from "./board";

/**
 * Wire protocol. Every frame is JSON with a discriminating `type` field.
 * Clients (human UIs and agent processes alike) ignore types they do not
 * understand, so new capabilities are additive and non-breaking.
 */

// ---------------------------------------------------------------------------
// Inbound: client -> server (validated with zod at the boundary)
// ---------------------------------------------------------------------------

const joinEventShape = z.object({
  type: z.literal("join"),
  name: z.string().min(1).max(32).optional(),
  kind: z.enum(["human", "agent"]).default("human"),
  /**
   * Credential for auth-enabled servers: a human's persistent session token
   * or the agent's shared secret. The server derives human identity from it
   * and ignores any client-supplied name (I1). Guest/dev mode omits it.
   */
  authToken: z.string().optional(),
});

/** Without an authToken the join must self-declare a name (guest/dev mode). */
const joinHasIdentity = (event: { name?: string; authToken?: string }) =>
  event.name !== undefined || event.authToken !== undefined;

export const joinEventSchema = joinEventShape.refine(joinHasIdentity, {
  message: "join needs a name or an authToken",
});

const messageEventShape = z.object({
  type: z.literal("message"),
  content: z.string().max(4000),
  channel: z.string().max(64).optional(),
  /** Ids of prior POST /api/uploads uploads to bind to this message. */
  attachmentIds: z.array(z.string()).max(10).optional(),
  /** Id of an existing message this one replies to; clients resolve it locally. */
  replyToId: z.string().optional(),
  /** Client-chosen token echoed on the resulting broadcast (optimistic UI); never persisted. */
  nonce: z.string().max(64).optional(),
});

/** A message must carry text or at least one attachment; fully empty is invalid. */
const messageHasSubstance = (event: { content: string; attachmentIds?: string[] }) =>
  event.content.trim().length > 0 || (event.attachmentIds?.length ?? 0) > 0;

export const messageEventSchema = messageEventShape.refine(messageHasSubstance, {
  message: "message needs content or attachments",
});

export const statusSetEventSchema = z.object({
  type: z.literal("status_set"),
  status: z.string().max(128),
});

export const statusUpdateEventSchema = z.object({
  type: z.literal("status_update"),
  status: z.string().max(128),
  runState: z.enum(["idle", "working", "blocked", "done", "dead"]),
  /** Board item id the agent is working off; null clears it. */
  taskId: z.string().nullable().optional(),
});

export const traceStartEventSchema = z.object({
  type: z.literal("trace_start"),
  runId: z.string(),
});

export const traceChunkEventSchema = z.object({
  type: z.literal("trace_chunk"),
  runId: z.string(),
  chunk: z.object({
    kind: z.enum(["thought", "text"]),
    content: z.string(),
  }),
});

export const summaryEventSchema = z.object({
  type: z.literal("summary"),
  runId: z.string(),
  content: z.string(),
  channel: z.string().max(64).optional(),
});

export const clearEventSchema = z.object({
  type: z.literal("clear"),
});

export const interruptEventSchema = z.object({
  type: z.literal("interrupt"),
  target: z.string().min(1).max(32),
  content: z.string().min(1).max(4000),
});

export const demoStartEventSchema = z.object({
  type: z.literal("demo_start"),
  channel: z.string().max(64).default("demo"),
});

export const runEndEventSchema = z.object({
  type: z.literal("run_end"),
  runId: z.string(),
  reason: z.enum(["completed", "aborted"]).default("completed"),
});

export const pinEventSchema = z.object({
  type: z.literal("pin"),
  messageId: z.string(),
  pinned: z.boolean(),
});

export const messageEditEventSchema = z.object({
  type: z.literal("message_edit"),
  messageId: z.string(),
  content: z.string().min(1).max(4000),
});

export const messageDeleteEventSchema = z.object({
  type: z.literal("message_delete"),
  messageId: z.string(),
});

export const messageReactEventSchema = z.object({
  type: z.literal("message_react"),
  messageId: z.string(),
  emoji: z.string().min(1).max(32),
  op: z.enum(["add", "remove"]),
});

/** Ephemeral typing signal: relayed to everyone else, never persisted. */
export const typingEventSchema = z.object({
  type: z.literal("typing"),
  channel: z.string().max(64),
});

// --- Toolman events ----------------------------------------------------------

/** Agent asks the toolman to perform an action on its behalf. */
export const actionRequestEventSchema = z.object({
  type: z.literal("action_request"),
  requestId: z.string(),
  /** Board item ref backing this action; required for mutating actions. */
  boardItemRef: z.string().nullable().optional(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("read_file"), path: z.string() }),
    z.object({ kind: z.literal("list_files"), path: z.string().optional() }),
    z.object({ kind: z.literal("write_file"), path: z.string(), content: z.string() }),
    z.object({ kind: z.literal("append_file"), path: z.string(), content: z.string() }),
  ]),
});

export const clientEventSchema = z
  .discriminatedUnion("type", [
    // zod v3 discriminated unions only accept plain objects, so the join and
    // message shapes go in and their refinements are re-applied just below.
    joinEventShape,
    messageEventShape,
    clearEventSchema,
    statusSetEventSchema,
    statusUpdateEventSchema,
    traceStartEventSchema,
    traceChunkEventSchema,
    summaryEventSchema,
    interruptEventSchema,
    demoStartEventSchema,
    runEndEventSchema,
    pinEventSchema,
    messageEditEventSchema,
    messageDeleteEventSchema,
    messageReactEventSchema,
    typingEventSchema,
    actionRequestEventSchema,
  ])
  .refine((event) => event.type !== "message" || messageHasSubstance(event), {
    message: "message needs content or attachments",
  })
  .refine((event) => event.type !== "join" || joinHasIdentity(event), {
    message: "join needs a name or an authToken",
  });

export type JoinEvent = z.infer<typeof joinEventSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type StatusSetEvent = z.infer<typeof statusSetEventSchema>;
export type StatusUpdateEvent = z.infer<typeof statusUpdateEventSchema>;
export type TraceStartEvent = z.infer<typeof traceStartEventSchema>;
export type TraceChunkEvent = z.infer<typeof traceChunkEventSchema>;
export type SummaryEvent = z.infer<typeof summaryEventSchema>;
export type ClearEvent = z.infer<typeof clearEventSchema>;
export type InterruptEvent = z.infer<typeof interruptEventSchema>;
export type DemoStartEvent = z.infer<typeof demoStartEventSchema>;
export type RunEndEvent = z.infer<typeof runEndEventSchema>;
export type PinEvent = z.infer<typeof pinEventSchema>;
export type MessageEditEvent = z.infer<typeof messageEditEventSchema>;
export type MessageDeleteEvent = z.infer<typeof messageDeleteEventSchema>;
export type MessageReactEvent = z.infer<typeof messageReactEventSchema>;
export type TypingEvent = z.infer<typeof typingEventSchema>;
export type ActionRequestEvent = z.infer<typeof actionRequestEventSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;

// ---------------------------------------------------------------------------
// Outbound: server -> clients
// ---------------------------------------------------------------------------

export interface WelcomeEvent {
  type: "welcome";
  self: Participant;
  history: ChatMessage[];
  participants: Participant[];
  /** Channels this server exposes, in display order. */
  channels: string[];
  /** Archived channels, hidden from the main list until unarchived. */
  archivedChannels: string[];
  /** Subset of `channels` currently pinned to the top of the list. */
  pinnedChannels: string[];
  /** Channels that play a scripted demo when demo_start names them. */
  demoChannels: string[];
  /** Bearer token for the HTTP API, bound to this actor identity. */
  token: string;
  /** Base URL of the HTTP API (same host/port as the websocket). */
  apiUrl: string;
}

/** Toolman verdict, sent only to the requesting agent. */
export interface ActionResultEvent {
  type: "action_result";
  requestId: string;
  ok: boolean;
  /** Set when the toolman denied authorization for the action. */
  code?: AuthzDenyCode;
  error?: string;
  output?: string;
}

export interface MessageBroadcast {
  type: "message";
  message: ChatMessage;
  /** Echo of the sender's nonce, present only on the broadcast that send triggered. */
  nonce?: string;
}

/** An existing message changed in place (pins, edits, reactions). */
export interface MessageUpdatedBroadcast {
  type: "message_updated";
  message: ChatMessage;
}

/** A message was hard-deleted; clients drop it from their history. */
export interface MessageDeletedBroadcast {
  type: "message_deleted";
  messageId: string;
  channel: string;
}

/** Someone is composing in a channel; ephemeral, never echoed to the sender. */
export interface TypingBroadcast {
  type: "typing";
  actorId: string;
  name: string;
  channel: string;
  timestamp: number;
}

export interface PresenceSyncEvent {
  type: "presence_sync";
  participants: Participant[];
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export interface TraceStartBroadcast {
  type: "trace_start";
  runId: string;
  agentId: string;
  agentName: string;
  timestamp: number;
}

export interface TraceChunkBroadcast {
  type: "trace_chunk";
  runId: string;
  chunk: TraceChunk;
}

export interface ClearBroadcast {
  type: "clear";
  /** When set, only messages in this channel were cleared. */
  channel?: string;
}

/** A new chat channel exists; clients append it to their channel list. */
export interface ChannelCreatedEvent {
  type: "channel_created";
  channel: string;
}

export interface ChannelRenamedEvent {
  type: "channel_renamed";
  oldName: string;
  newName: string;
}

/** Archived channels drop out of the active list until unarchived. */
export interface ChannelArchivedEvent {
  type: "channel_archived";
  channel: string;
  archived: boolean;
}

export interface ChannelPinnedEvent {
  type: "channel_pinned";
  channel: string;
  pinned: boolean;
}

export interface ChannelDeletedEvent {
  type: "channel_deleted";
  channel: string;
}

export interface InterruptBroadcast {
  type: "interrupt";
  authorName: string;
  content: string;
}

export interface RunEndBroadcast {
  type: "run_end";
  runId: string;
  reason: "completed" | "aborted";
}

export type ServerEvent =
  | WelcomeEvent
  | MessageBroadcast
  | MessageUpdatedBroadcast
  | MessageDeletedBroadcast
  | TypingBroadcast
  | PresenceSyncEvent
  | ErrorEvent
  | TraceStartBroadcast
  | TraceChunkBroadcast
  | ClearBroadcast
  | ChannelCreatedEvent
  | ChannelRenamedEvent
  | ChannelArchivedEvent
  | ChannelPinnedEvent
  | ChannelDeletedEvent
  | InterruptBroadcast
  | RunEndBroadcast
  | ActionResultEvent
  | BoardEventEnvelope;
