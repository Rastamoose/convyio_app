export interface ChannelInfo {
  id: string;
  name: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thoughtTokens?: number;
  toolTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type ThreadEventKind =
  | "message.created"
  | "message.edited"
  | "message.deleted"
  | "message.pinned"
  | "message.unpinned"
  | "message.reaction_added"
  | "message.reaction_removed"
  | "message.channel_cleared"
  | "message.all_cleared"
  | "item.created"
  | "item.proposed"
  | "item.approved"
  | "item.denied"
  | "item.started"
  | "item.blocked"
  | "item.unblocked"
  | "item.completed"
  | "item.edited"
  | "item.deleted"
  | "item.reopened"
  | "conversation.created"
  | "conversation.mode_changed"
  | "agent.run.requested"
  | "agent.run.claimed"
  | "agent.run.requeued"
  | "agent.run.started"
  | "agent.run.completed"
  | "agent.run.failed"
  | "agent.run.cancelled"
  | "agent.activity.started"
  | "agent.activity.progress"
  | "agent.activity.completed"
  | "agent.activity.failed"
  | "agent.thought.started"
  | "agent.thought.delta"
  | "agent.thought.completed"
  | "agent.tool.started"
  | "agent.tool.progress"
  | "agent.tool.completed"
  | "agent.tool.failed"
  | "agent.plan.updated"
  | "agent.usage.reported"
  | "agent.provider.session"
  | "agent.output.started"
  | "agent.output.delta"
  | "agent.output.completed"
  | "interaction.requested"
  | "interaction.resolved"
  | "plan.created"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.completed"
  | "plan.cancelled"
  | "plan.edited"
  | "context.created"
  | "context.superseded"
  | "context.cursor.acknowledged"
  | "project.created"
  | "project.updated"
  | "project.archived"
  | "project.assignment.granted"
  | "project.assignment.revoked"
  | "project.access.requested"
  | "project.access.resolved"
  | "project.access_mode.updated"
  | "git.repository.linked"
  | "git.repository.unlinked"
  | "git.repository.synced"
  | "git.branch.created"
  | "git.branch.deleted"
  | "git.push.completed"
  | "git.commit.created"
  | "git.pull.created"
  | "git.pull.approved"
  | "git.pull.merged"
  | "git.issue.created"
  | "toolman.node.paired"
  | "toolman.node.revoked"
  | "toolman.mount.registered"
  | "toolman.mount.updated"
  | "toolman.checkout.updated"
  | "tool.execution.requested"
  | "tool.execution.awaiting_approval"
  | "tool.execution.started"
  | "tool.execution.completed"
  | "tool.execution.failed"
  | "tool.execution.denied"
  | "tool.execution.cancelled"
  | "tool.artifact.expired";

export type ThreadEventPayload = JsonObject;

export interface ThreadEvent {
  id: string;
  seq: number;
  workspaceId: string;
  channelId: string | null;
  actorId: string;
  kind: ThreadEventKind;
  conversationId: string | null;
  runId: string | null;
  subjectId: string | null;
  parentId: string | null;
  clientEventId: string | null;
  payload: ThreadEventPayload;
  createdAt: number;
}
