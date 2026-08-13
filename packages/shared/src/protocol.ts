import { z } from "zod";
import type { ChatMessage, Participant, TraceChunk } from "./participant";
import type { AuthzDenyCode, BoardEventEnvelope } from "./board";
import type { AgentInvite } from "./agent";
import type { AgentConversation, AgentWorkAssignment, InteractionRequest } from "./agentWork";
import type { ChannelInfo, ThreadEvent } from "./thread";

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

const requestIdsSchema = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, "request ids must be unique");

export const workClaimEventSchema = z.object({
  type: z.literal("work_claim"),
  requestIds: requestIdsSchema,
});

export const workCompleteEventSchema = z.object({
  type: z.literal("work_complete"),
  requestIds: requestIdsSchema,
  outcome: z.enum(["completed", "cancelled"]),
});

const boundedJsonPrimitiveSchema = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

function boundedJsonValueSchema(depth = 0): z.ZodTypeAny {
  if (depth >= 4) return boundedJsonPrimitiveSchema;
  const child = z.lazy(() => boundedJsonValueSchema(depth + 1));
  return z.union([
    boundedJsonPrimitiveSchema,
    z.array(child).max(50),
    z.record(z.string().min(1).max(128), child).superRefine((value, context) => {
      if (Object.keys(value).length > 50) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON objects may have at most 50 keys" });
      }
    }),
  ]);
}

const boundedPayloadSchema = z
  .record(z.string().min(1).max(128), boundedJsonValueSchema())
  .superRefine((value, context) => {
    if (Object.keys(value).length > 50) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "payloads may have at most 50 keys" });
    }
    if (JSON.stringify(value).length > 16_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "payload exceeds 16000 bytes" });
    }
  });

export const normalizedUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    cacheReadTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    cacheWriteTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    thoughtTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    toolTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    costUsd: z.number().nonnegative().max(1_000_000).optional(),
  })
  .refine((usage) => Object.values(usage).some((value) => value !== undefined), {
    message: "usage must contain at least one value",
  });

export const agentActivityKindSchema = z.enum([
  "agent.output.delta",
  "agent.thought.delta",
  "agent.plan.updated",
  "agent.tool.started",
  "agent.tool.progress",
  "agent.tool.completed",
  "agent.tool.failed",
  "agent.usage.reported",
  "agent.provider.session",
]);

const activityItemSchema = z.object({
  clientEventId: z.string().min(1).max(128),
  kind: agentActivityKindSchema,
  channelId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128).nullable(),
  runId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128).optional(),
  parentId: z.string().min(1).max(128).optional(),
  payload: boundedPayloadSchema,
});

export const activityBatchEventSchema = z.object({
  type: z.literal("activity_batch"),
  events: z
    .array(activityItemSchema)
    .min(1)
    .max(50)
    .refine((events) => new Set(events.map((event) => event.clientEventId)).size === events.length, {
      message: "activity client event ids must be unique",
    }),
});

export const agentRunFinishEventSchema = z.object({
  type: z.literal("agent_run_finish"),
  runId: z.string().min(1).max(128),
  channelId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128).nullable(),
  requestIds: z
    .array(z.string().min(1).max(128))
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "request ids must be unique"),
  outcome: z.enum(["completed", "cancelled", "failed"]),
  finalContent: z.string().max(4_000),
  error: z.string().max(2_000).optional(),
  usage: normalizedUsageSchema.optional(),
});

export const conversationSessionSetEventSchema = z.object({
  type: z.literal("conversation_session_set"),
  conversationId: z.string().min(1).max(128),
  providerSessionId: z.string().min(1).max(4_096).nullable(),
  permissionMode: z.enum(["default", "plan", "acceptEdits"]),
  clientEventId: z.string().min(1).max(128).optional(),
});

/** A human picks how much of the board grant runs without asking. */
export const conversationModeSetEventSchema = z.object({
  type: z.literal("conversation_mode_set"),
  agentId: z.string().min(1).max(128),
  /** Channel name; the server resolves it to the stable channel id. */
  channel: z.string().min(1).max(64),
  mode: z.enum(["default", "plan", "acceptEdits"]),
});

export const RUNNER_PROTOCOL_VERSION = 1;

const runnerOptionBase = {
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  category: z.enum(["model", "model_config", "thought_level", "mode"]),
};

const runnerSelectOptionSchema = z.object({
  ...runnerOptionBase,
  kind: z.literal("select"),
  value: z.string().max(200).optional(),
  choices: z
    .array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(100) }))
    .min(1)
    .max(50),
});

const runnerBooleanOptionSchema = z.object({
  ...runnerOptionBase,
  kind: z.literal("boolean"),
  value: z.boolean(),
});

export const runnerConfigOptionSchema = z.discriminatedUnion("kind", [
  runnerSelectOptionSchema,
  runnerBooleanOptionSchema,
]);

export const runnerHelloEventSchema = z.object({
  type: z.literal("runner_hello"),
  protocolVersion: z.number().int().min(1).max(1000),
  harness: z.object({
    id: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
  }),
  options: z
    .array(runnerConfigOptionSchema)
    .max(32)
    .refine((options) => new Set(options.map((option) => option.id)).size === options.length, {
      message: "runner option ids must be unique",
    }),
});

export const runnerStatusEventSchema = z.object({
  type: z.literal("runner_status"),
  configRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  health: z.enum([
    "checking",
    "ready",
    "degraded",
    "auth_required",
    "misconfigured",
    "incompatible",
  ]),
  effectiveModel: z.string().min(1).max(200).optional(),
  diagnosticCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
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
    z.object({ kind: z.literal("run_shell"), command: z.string().min(1).max(4000) }),
    z.object({
      kind: z.literal("search_files"),
      query: z.string().min(1).max(500),
      path: z.string().max(500).optional(),
    }),
  ]),
  /** Conversation the action belongs to; selects the permission mode. */
  conversationId: z.string().max(128).nullable().optional(),
});

/** A human answers a pending permission request from any surface. */
export const interactionResolveEventSchema = z.object({
  type: z.literal("interaction_resolve"),
  requestId: z.string().max(128),
  decision: z.enum(["approve", "deny"]),
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
    workClaimEventSchema,
    workCompleteEventSchema,
    activityBatchEventSchema,
    agentRunFinishEventSchema,
    conversationSessionSetEventSchema,
    runnerHelloEventSchema,
    runnerStatusEventSchema,
    pinEventSchema,
    messageEditEventSchema,
    messageDeleteEventSchema,
    messageReactEventSchema,
    typingEventSchema,
    actionRequestEventSchema,
    interactionResolveEventSchema,
    conversationModeSetEventSchema,
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
export type WorkClaimEvent = z.infer<typeof workClaimEventSchema>;
export type WorkCompleteEvent = z.infer<typeof workCompleteEventSchema>;
export type AgentActivityKind = z.infer<typeof agentActivityKindSchema>;
export type AgentActivityItem = z.infer<typeof activityItemSchema>;
export type ActivityBatchEvent = z.infer<typeof activityBatchEventSchema>;
export type AgentRunFinishEvent = z.infer<typeof agentRunFinishEventSchema>;
export type ConversationSessionSetEvent = z.infer<typeof conversationSessionSetEventSchema>;
export type RunnerConfigOption = z.infer<typeof runnerConfigOptionSchema>;
export type RunnerHelloEvent = z.infer<typeof runnerHelloEventSchema>;
export type RunnerStatusEvent = z.infer<typeof runnerStatusEventSchema>;
export type RunnerHealth = RunnerStatusEvent["health"];
export type PinEvent = z.infer<typeof pinEventSchema>;
export type MessageEditEvent = z.infer<typeof messageEditEventSchema>;
export type MessageDeleteEvent = z.infer<typeof messageDeleteEventSchema>;
export type MessageReactEvent = z.infer<typeof messageReactEventSchema>;
export type TypingEvent = z.infer<typeof typingEventSchema>;
export type ActionRequestEvent = z.infer<typeof actionRequestEventSchema>;
export type InteractionResolveEvent = z.infer<typeof interactionResolveEventSchema>;
export type ConversationModeSetEvent = z.infer<typeof conversationModeSetEventSchema>;
export type ClientEvent = z.infer<typeof clientEventSchema>;

// ---------------------------------------------------------------------------
// Outbound: server -> clients
// ---------------------------------------------------------------------------

/** Identity of the workspace this server hosts. */
export interface WorkspaceInfo {
  id: string;
  name: string;
}

export interface WelcomeEvent {
  type: "welcome";
  workspace: WorkspaceInfo;
  self: Participant;
  history: ChatMessage[];
  participants: Participant[];
  /** Channels this server exposes, in display order. */
  channels: string[];
  /** Stable identities for the active channel names above. */
  channelInfos: ChannelInfo[];
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
  agentConfig?: AgentInvite;
}

export interface AgentConfigEvent {
  type: "agent_config";
  profile: AgentInvite;
}

export interface AgentRuntimeSummary {
  connected: boolean;
  health: RunnerHealth;
  configRevision: number;
  protocolVersion?: number;
  harness?: { id: string; version: string };
  effectiveModel?: string;
  diagnosticCode?: string;
  options: RunnerConfigOption[];
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

/**
 * Broadcast when a run pauses on a human decision, and again when it resolves.
 * One id, every surface: the inline capsule, the approval queue and the
 * activity panel all render this record rather than minting their own.
 */
export interface InteractionRequestEvent {
  type: "interaction_request";
  request: InteractionRequest;
}

export interface InteractionResolvedEvent {
  type: "interaction_resolved";
  request: InteractionRequest;
}

export interface WorkAvailableEvent {
  type: "work_available";
  requestIds: string[];
}

export interface WorkAssignedEvent {
  type: "work_assigned";
  assignments: AgentWorkAssignment[];
}

export interface ThreadEventBroadcast {
  type: "thread_event";
  event: ThreadEvent;
}

export interface ConversationUpdatedBroadcast {
  type: "conversation_updated";
  conversation: AgentConversation;
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
  channelInfo: ChannelInfo;
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
  | AgentConfigEvent
  | WorkAvailableEvent
  | InteractionRequestEvent
  | InteractionResolvedEvent
  | WorkAssignedEvent
  | ThreadEventBroadcast
  | ConversationUpdatedBroadcast
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
