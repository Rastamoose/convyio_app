export type ParticipantKind = "human" | "agent";

export type RunState = "idle" | "working" | "done" | "dead";

export interface Participant {
  id: string;
  name: string;
  kind: ParticipantKind;
  status: string;
  runState: RunState;
  online: boolean;
}

export interface TraceChunk {
  kind: "thought" | "text";
  content: string;
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
}
