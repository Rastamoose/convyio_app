import type { ChatMessage, ParticipantKind } from "./participant";

export function memberJoinedNotice(name: string, _kind?: ParticipantKind): string {
  return `${name} joined the workspace`;
}

export function joinNoticeMemberKind(
  message: Pick<ChatMessage, "id" | "content" | "authorId">,
  participants: Array<{ id: string; kind: ParticipantKind }> = [],
): ParticipantKind {
  if (message.content.endsWith(" joined as an agent")) return "agent";
  if (message.id.includes(":managed-agent:")) return "agent";
  return participants.some((participant) => participant.id === message.authorId && participant.kind === "agent")
    ? "agent"
    : "human";
}

export function isJoinNotice(message: Pick<ChatMessage, "id" | "authorKind">): boolean {
  return message.authorKind === "system" && message.id.startsWith("member-joined:");
}
