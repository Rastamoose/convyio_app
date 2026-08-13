import type { ChatMessage } from "./participant";

export type PermissionMode = "default" | "plan" | "acceptEdits";
export type RunRequestStatus = "queued" | "claimed" | "completed" | "cancelled" | "failed";

export interface AgentConversation {
  id: string;
  workspaceId: string;
  agentId: string;
  channelId: string;
  providerSessionId: string | null;
  permissionMode: PermissionMode;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunRequest {
  id: string;
  workspaceId: string;
  channelId: string;
  agentId: string;
  messageId: string;
  conversationId: string;
  status: RunRequestStatus;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
}

/**
 * A paused run waiting on a human. One row, one id — the inline run capsule,
 * the approval queue and the activity panel all resolve the same record rather
 * than each minting their own copy of the question.
 */
export interface InteractionRequest {
  id: string;
  workspaceId: string;
  channelId: string;
  agentId: string;
  conversationId: string | null;
  /** Human-readable action summary, e.g. `write_file src/a.ts`. */
  summary: string;
  /** Capability the pending action consumes. */
  capability: string;
  boardItemRef: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  resolvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface AgentWorkAssignment {
  request: AgentRunRequest;
  conversation: AgentConversation;
  trigger: ChatMessage;
}
