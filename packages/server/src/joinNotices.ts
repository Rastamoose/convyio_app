import { memberJoinedNotice, type ChatMessage, type ParticipantKind } from "@workspace/shared";
import type { Sql } from "./db";
import { MessageStore } from "./chat/MessageStore";
import { ThreadEventStore } from "./chat/ThreadEventStore";
import { WorkspaceDb } from "./db";

export async function appendJoinNotice(
  sql: Sql,
  workspace: { id: string; name: string },
  member: { id: string; displayName: string; kind: ParticipantKind },
  at: number,
): Promise<ChatMessage | null> {
  const [channel] = await sql<{ id: string }[]>`
    SELECT id FROM channels
    WHERE workspace_id = ${workspace.id} AND name = 'general'
    LIMIT 1
  `;
  if (!channel) return null;
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM messages
    WHERE workspace_id = ${workspace.id}
      AND author_kind = 'system'
      AND id = ${`member-joined:${workspace.id}:${member.id}`}
  `;
  if (existing) return null;

  const message: ChatMessage = {
    id: `member-joined:${workspace.id}:${member.id}`,
    authorId: member.id,
    authorName: member.displayName,
    authorKind: "system",
    content: memberJoinedNotice(member.displayName, member.kind),
    timestamp: at,
    channelId: channel.id,
    channel: "general",
    mentions: [],
  };
  const db = WorkspaceDb.scoped(sql, workspace);
  await new MessageStore(db, new ThreadEventStore(db)).appendInTransaction(sql, message);
  return message;
}


