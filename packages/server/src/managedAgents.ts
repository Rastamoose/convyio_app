import type { ChatMessage, ManagedAgent } from "@workspace/shared";
import type { Sql } from "./db";
import { WorkspaceDb } from "./db";
import { MessageStore } from "./chat/MessageStore";
import { ThreadEventStore } from "./chat/ThreadEventStore";
import { appendJoinNotice } from "./joinNotices";

export const NOODLE_AGENT: ManagedAgent = "noodle";
export const NOODLE_NAME = "noodle";

export function managedAgentActorId(workspaceId: string, managedAgent: ManagedAgent): string {
  return `managed-agent:${managedAgent}:${workspaceId}`;
}

export function noodleWelcomeMessages(ownerName: string): string[] {
  return [
    `Hey ${ownerName} — I’m noodle, the little face in the tab and your built-in Convyio guide. I’m hosted by Convyio and free to use, so there’s nothing to install or keep running.`,
    "This workspace is where people and agents figure things out together: chat here, shape work on the board, and approve what agents can actually change. You stay in charge.",
    "Try `@noodle` with a question or small task. I’m quick and handy, but honestly not as capable as your own local Claude or Codex. When you want more power, hit **Add agent** in the sidebar. Owners can remove me any time by right-clicking my name.",
  ];
}

export async function seedNoodle(
  sql: Sql,
  workspace: { id: string; name: string },
  ownerName: string,
  channelId: string,
  createdAt: number,
): Promise<void> {
  const actorId = managedAgentActorId(workspace.id, NOODLE_AGENT);
  await sql`
    INSERT INTO actors (id, kind, display_name, managed_agent)
    VALUES (${actorId}, 'agent', ${NOODLE_NAME}, ${NOODLE_AGENT})
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, actor_id, role, joined_at)
    VALUES (${workspace.id}, ${actorId}, 'member', ${createdAt})
  `;
  await appendJoinNotice(
    sql,
    workspace,
    { id: actorId, displayName: NOODLE_NAME, kind: "agent" },
    createdAt,
  );

  const db = WorkspaceDb.scoped(sql, workspace);
  const messages = new MessageStore(db, new ThreadEventStore(db));
  const contents = noodleWelcomeMessages(ownerName);
  for (const [index, content] of contents.entries()) {
    const message: ChatMessage = {
      id: `managed-welcome:${workspace.id}:${index + 1}`,
      authorId: actorId,
      authorName: NOODLE_NAME,
      authorKind: "agent",
      content,
      timestamp: createdAt + index + 1,
      channelId,
      channel: "general",
      mentions: [],
    };
    await messages.appendInTransaction(sql, message);
  }
}
