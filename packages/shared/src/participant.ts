export type ParticipantKind = "human" | "agent";

export type RunState = "idle" | "working" | "blocked" | "done" | "dead";

export interface Participant {
  id: string;
  name: string;
  kind: ParticipantKind;
  status: string;
  runState: RunState;
  online: boolean;
  /** Board item id the agent is currently working off (agents only). */
  currentTaskId?: string;
  /** When the agent picked up the current task (server-stamped). */
  taskStartedAt?: number;
}

export interface TraceChunk {
  kind: "thought" | "text";
  content: string;
}

/** An uploaded file bound to a chat message. */
export interface Attachment {
  id: string;
  /** Original filename, sanitized server-side. */
  name: string;
  mime: string;
  /** Bytes. */
  size: number;
  /** Image pixel dimensions, client-probed; present only for image/* uploads. */
  width?: number;
  height?: number;
  /** Server-relative path, e.g. "/api/uploads/<id>/<name>"; clients prefix their apiUrl. */
  url: string;
}

/** One emoji's reactions on a message: who reacted, in reaction order. */
export interface MessageReaction {
  emoji: string;
  actors: { id: string; name: string }[];
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: ParticipantKind;
  content: string;
  timestamp: number;
  /** Stable identity of the channel that owns this message. */
  channelId?: string;
  /** Server-derived actor ids genuinely @mentioned by this message. */
  mentions?: string[];
  /** Channel name retained for display and phase-one compatibility. */
  channel?: string;
  /** Optional trace of agent reasoning that produced this message. */
  trace?: TraceChunk[];
  /** Optional run id linking the message to a live/finished agent run. */
  runId?: string;
  /** Files uploaded via POST /api/uploads and bound to this message on send. */
  attachments?: Attachment[];
  /** Set while the message is pinned in its channel. */
  pinnedAt?: number;
  /** Display name of the human who pinned it. */
  pinnedBy?: string;
  /** When the author last edited the content. */
  editedAt?: number;
  /** Id of the message this one replies to; clients resolve it from history. */
  replyToId?: string;
  /** Emoji reactions, grouped per emoji in first-reaction order. */
  reactions?: MessageReaction[];
}
