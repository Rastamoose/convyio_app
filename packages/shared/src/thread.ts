export interface ChannelInfo {
  id: string;
  name: string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
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
  | "agent.output.started"
  | "agent.output.delta"
  | "agent.output.completed";

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
