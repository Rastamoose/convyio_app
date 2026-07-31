import { z } from "zod";
import type { ChatMessage, Participant, TraceChunk } from "./participant";

/**
 * Wire protocol. Every frame is JSON with a discriminating `type` field.
 * Clients (human UIs and agent processes alike) ignore types they do not
 * understand, so new capabilities are additive and non-breaking.
 */

// ---------------------------------------------------------------------------
// Inbound: client -> server (validated with zod at the boundary)
// ---------------------------------------------------------------------------

export const joinEventSchema = z.object({
  type: z.literal("join"),
  name: z.string().min(1).max(32),
  kind: z.enum(["human", "agent"]).default("human"),
});

export const messageEventSchema = z.object({
  type: z.literal("message"),
  content: z.string().min(1).max(4000),
  channel: z.string().max(64).optional(),
});

export const statusSetEventSchema = z.object({
  type: z.literal("status_set"),
  status: z.string().max(128),
});

export const statusUpdateEventSchema = z.object({
  type: z.literal("status_update"),
  status: z.string().max(128),
  runState: z.enum(["idle", "working", "done", "dead"]),
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

export const clientEventSchema = z.discriminatedUnion("type", [
  joinEventSchema,
  messageEventSchema,
  clearEventSchema,
  statusSetEventSchema,
  statusUpdateEventSchema,
  traceStartEventSchema,
  traceChunkEventSchema,
  summaryEventSchema,
  interruptEventSchema,
  demoStartEventSchema,
  runEndEventSchema,
]);

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
export type ClientEvent = z.infer<typeof clientEventSchema>;

// ---------------------------------------------------------------------------
// Outbound: server -> clients
// ---------------------------------------------------------------------------

export interface WelcomeEvent {
  type: "welcome";
  self: Participant;
  history: ChatMessage[];
  participants: Participant[];
}

export interface MessageBroadcast {
  type: "message";
  message: ChatMessage;
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
  | PresenceSyncEvent
  | ErrorEvent
  | TraceStartBroadcast
  | TraceChunkBroadcast
  | ClearBroadcast
  | InterruptBroadcast
  | RunEndBroadcast;
