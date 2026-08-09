import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Actor, AgentInvite, AgentProvider } from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { WorkspaceDb } from "../db";
import { USERNAME_PATTERN } from "./Auth";

const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface InviteRow {
  id: string;
  token_hash: string;
  actor_id: string;
  created_by: string;
  provider: string;
  created_at: number;
  revoked_at: number | null;
  name?: string;
}

function toInvite(row: InviteRow): AgentInvite {
  return {
    id: row.id,
    actorId: row.actor_id,
    name: row.name ?? "",
    provider: row.provider as AgentProvider,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * User-created agent invites. A human with a bound actor can create an invite
 * that names an agent and yields a single token. The token resolves to the
 * agent actor on websocket join, and it can be revoked to evict the agent.
 */
export class AgentInvites {
  constructor(private db: WorkspaceDb) {}

  async create(name: string, provider: AgentProvider, createdBy: Actor): Promise<{ invite: AgentInvite; token: string }> {
    const trimmed = name.trim();
    if (!USERNAME_PATTERN.test(trimmed)) {
      throw new ApiError(
        400,
        "BAD_NAME",
        "agent names are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    const human = await this.db.findActorByName("human", trimmed);
    if (human) {
      throw new ApiError(409, "NAME_TAKEN", `the name ${trimmed} is already in use`);
    }
    const existingAgent = await this.db.findActorByName("agent", trimmed);
    if (existingAgent) {
      throw new ApiError(409, "NAME_TAKEN", `the name ${trimmed} is already in use`);
    }

    const actor = await this.db.upsertActor("agent", trimmed);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const inviteId = randomUUID();
    const now = Date.now();

    await this.db.sql`
      INSERT INTO agent_invites (id, token_hash, actor_id, created_by, provider, created_at, revoked_at)
      VALUES (${inviteId}, ${hashToken(token)}, ${actor.id}, ${createdBy.id}, ${provider}, ${now}, NULL)
    `;

    const invite: AgentInvite = {
      id: inviteId,
      actorId: actor.id,
      name: actor.displayName,
      provider,
      createdBy: createdBy.id,
      createdAt: now,
      revokedAt: null,
    };
    return { invite, token };
  }

  async resolve(token: string): Promise<{ actor: Actor; invite: AgentInvite } | null> {
    const hash = hashToken(token);
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      WHERE i.token_hash = ${hash} AND i.revoked_at IS NULL
    `;
    if (!rows[0]) return null;
    const actor = await this.db.getActor(rows[0].actor_id);
    if (!actor) return null;
    return { actor, invite: toInvite(rows[0]) };
  }

  async list(): Promise<AgentInvite[]> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      WHERE a.server_id = ${this.db.serverId} AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC
    `;
    return rows.map(toInvite);
  }

  async revoke(id: string): Promise<AgentInvite | null> {
    const rows = await this.db.sql<InviteRow[]>`
      UPDATE agent_invites i
      SET revoked_at = ${Date.now()}
      FROM actors a
      WHERE i.id = ${id} AND i.revoked_at IS NULL AND a.id = i.actor_id
      RETURNING i.*, a.display_name AS name
    `;
    if (!rows[0]) return null;
    return toInvite(rows[0]);
  }

  async isRevoked(actorId: string): Promise<boolean> {
    const rows = await this.db.sql<{ revoked_at: number | null }[]>`
      SELECT revoked_at FROM agent_invites WHERE actor_id = ${actorId}
    `;
    return rows.length > 0 && rows[0].revoked_at !== null;
  }

  async findByActorId(actorId: string): Promise<AgentInvite | null> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      WHERE i.actor_id = ${actorId} AND i.revoked_at IS NULL
    `;
    return rows[0] ? toInvite(rows[0]) : null;
  }
}
