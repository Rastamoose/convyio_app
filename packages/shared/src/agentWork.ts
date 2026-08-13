import type { ChatMessage } from "./participant";

export type PermissionMode = "default" | "plan" | "acceptEdits";
export type RunRequestStatus = "queued" | "claimed" | "completed" | "cancelled";

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

export interface AgentWorkAssignment {
  request: AgentRunRequest;
  conversation: AgentConversation;
  trigger: ChatMessage;
}
