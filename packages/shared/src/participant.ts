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

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: ParticipantKind;
  content: string;
  timestamp: number;
  /** Channel the message belongs to. Absent = "general" (pre-channel messages). */
  channel?: string;
  /** Optional trace of agent reasoning that produced this message. */
  trace?: TraceChunk[];
  /** Optional run id linking the message to a live/finished agent run. */
  runId?: string;
  /** Files uploaded via POST /api/uploads and bound to this message on send. */
  attachments?: Attachment[];
}
