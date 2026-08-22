import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Actor,
  AgentAccessPolicy,
  AgentInstallation,
  AgentInvite,
  AgentPairing,
  AgentPairingResponse,
  AgentProvider,
} from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { Sql, WorkspaceDb } from "../db";
import { appendJoinNotice } from "../joinNotices";
import { NOODLE_NAME } from "../managedAgents";
import { USERNAME_PATTERN } from "./Auth";

const TOKEN_BYTES = 32;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AgentProfileFields {
  instructions: string;
  requestedModel: string | null;
  access: AgentAccessPolicy;
}

export interface AgentProfilePatch {
  instructions?: string;
  requestedModel?: string | null;
  access?: AgentAccessPolicy;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  token_hash: string;
  actor_id: string;
  created_by: string;
  provider: string;
  instructions: string;
  requested_model: string | null;
  access_mode: AgentAccessPolicy["mode"];
  selected_actor_ids: string[];
  config_revision: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  api_key_ciphertext: string | null;
  name?: string;
}

interface PairingRow {
  id: string;
  invite_id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

interface InstallationRow {
  id: string;
  invite_id: string;
  created_at: number;
  last_used_at: number | null;
}

function toInvite(row: InviteRow): AgentInvite {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    name: row.name ?? "",
    provider: row.provider as AgentProvider,
    instructions: row.instructions,
    requestedModel: row.requested_model,
    access: { mode: row.access_mode, selectedActorIds: row.selected_actor_ids },
    configRevision: row.config_revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function toPairing(row: PairingRow): AgentPairing {
  return {
    id: row.id,
    agentId: row.invite_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

function toInstallation(row: InstallationRow): AgentInstallation {
  return {
    id: row.id,
    agentId: row.invite_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Persists user-created agent profiles and resolves all of their credentials. */
export class AgentInvites {
  constructor(
    private db: WorkspaceDb,
    private pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
  ) {}

  async create(
    name: string,
    provider: AgentProvider,
    createdBy: Actor,
    profile: AgentProfileFields = {
      instructions: "",
      requestedModel: null,
      access: { mode: "workspace", selectedActorIds: [] },
    },
    apiKeyCiphertext: string | null = null,
  ): Promise<{ invite: AgentInvite; token: string }> {
    const trimmed = name.trim();
    if (!USERNAME_PATTERN.test(trimmed)) {
      throw new ApiError(
        400,
        "BAD_NAME",
        "agent names are 1-32 characters of letters, digits, spaces, - and _",
      );
    }
    if (trimmed.toLowerCase() === NOODLE_NAME) {
      throw new ApiError(409, "NAME_RESERVED", `${NOODLE_NAME} is reserved for Convyio's built-in agent`);
    }
    const human = await this.db.findMemberByName("human", trimmed);
    if (human) {
      throw new ApiError(409, "NAME_TAKEN", `the name ${trimmed} is already in use`);
    }
    const existingAgent = await this.db.findMemberByName("agent", trimmed);
    if (existingAgent) {
      throw new ApiError(409, "NAME_TAKEN", `the name ${trimmed} is already in use`);
    }
    await this.validateAccess(profile.access);

    const actor = await this.db.upsertActor("agent", trimmed);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const inviteId = randomUUID();
    const now = Date.now();
    await appendJoinNotice(
      this.db.sql,
      { id: this.db.workspaceId, name: this.db.workspaceName },
      { id: actor.id, displayName: actor.displayName, kind: "agent" },
      now,
    );

    await this.db.sql`
      INSERT INTO agent_invites (
        id, workspace_id, token_hash, actor_id, created_by, provider,
        instructions, requested_model, access_mode, selected_actor_ids,
        config_revision, created_at, updated_at, revoked_at, api_key_ciphertext
      ) VALUES (
        ${inviteId}, ${this.db.workspaceId}, ${hashToken(token)}, ${actor.id}, ${createdBy.id}, ${provider},
        ${profile.instructions}, ${profile.requestedModel}, ${profile.access.mode},
        ${this.db.sql.json(profile.access.selectedActorIds)}, 1, ${now}, ${now}, NULL, ${apiKeyCiphertext}
      )
    `;

    const invite: AgentInvite = {
      id: inviteId,
      workspaceId: this.db.workspaceId,
      actorId: actor.id,
      name: actor.displayName,
      provider,
      instructions: profile.instructions,
      requestedModel: profile.requestedModel,
      access: profile.access,
      configRevision: 1,
      createdBy: createdBy.id,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    };
    return { invite, token };
  }

  async update(id: string, patch: AgentProfilePatch): Promise<AgentInvite | null> {
    if (patch.access) await this.validateAccess(patch.access);
    const now = Date.now();
    const rows = await this.db.sql<InviteRow[]>`
      UPDATE agent_invites i
      SET instructions = CASE
            WHEN ${patch.instructions !== undefined} THEN ${patch.instructions ?? ""}
            ELSE i.instructions
          END,
          requested_model = CASE
            WHEN ${patch.requestedModel !== undefined} THEN ${patch.requestedModel ?? null}
            ELSE i.requested_model
          END,
          access_mode = CASE
            WHEN ${patch.access !== undefined} THEN ${patch.access?.mode ?? "workspace"}
            ELSE i.access_mode
          END,
          selected_actor_ids = CASE
            WHEN ${patch.access !== undefined} THEN ${this.db.sql.json(patch.access?.selectedActorIds ?? [])}
            ELSE i.selected_actor_ids
          END,
          config_revision = i.config_revision + 1,
          updated_at = ${now}
      FROM actors a
      WHERE i.id = ${id}
        AND i.workspace_id = ${this.db.workspaceId}
        AND i.revoked_at IS NULL
        AND a.id = i.actor_id
      RETURNING i.*, a.display_name AS name
    `;
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async createPairing(id: string, createdBy: Actor): Promise<AgentPairingResponse | null> {
    const pairingCode = randomBytes(TOKEN_BYTES).toString("hex");
    const now = Date.now();
    return this.db.transaction(async (sql) => {
      const invite = await sql`
        SELECT id FROM agent_invites
        WHERE id = ${id} AND workspace_id = ${this.db.workspaceId} AND revoked_at IS NULL
        FOR UPDATE
      `;
      if (!invite[0]) return null;
      await sql`
        UPDATE agent_pairings
        SET revoked_at = ${now}
        WHERE invite_id = ${id} AND consumed_at IS NULL AND revoked_at IS NULL
      `;
      const rows = await sql<PairingRow[]>`
        INSERT INTO agent_pairings (
          id, invite_id, token_hash, created_by, created_at, expires_at, consumed_at, revoked_at
        ) VALUES (
          ${randomUUID()}, ${id}, ${hashToken(pairingCode)}, ${createdBy.id},
          ${now}, ${now + this.pairingTtlMs}, NULL, NULL
        )
        RETURNING id, invite_id, created_at, expires_at, consumed_at, revoked_at
      `;
      return { pairing: toPairing(rows[0]), pairingCode };
    });
  }

  /** Mint an installation directly, without a pairing code. The code/expiry
   *  ceremony in exchangePairing exists only so a human can type a
   *  short-lived code into a terminal; a server-managed hosted agent (one
   *  with a stored API key) has no such human step and can skip straight to
   *  this. */
  async mintInstallation(inviteId: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    return this.db.transaction((sql) => this.mintInstallationWithin(sql, inviteId));
  }

  async exchangePairing(pairingCode: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    return this.db.transaction(async (sql) => {
      const now = Date.now();
      const consumed = await sql<PairingRow[]>`
        UPDATE agent_pairings p
        SET consumed_at = ${now}
        FROM agent_invites i, workspace_members m
        WHERE p.token_hash = ${hashToken(pairingCode)}
          AND p.consumed_at IS NULL
          AND p.revoked_at IS NULL
          AND p.expires_at > ${now}
          AND i.id = p.invite_id
          AND i.workspace_id = ${this.db.workspaceId}
          AND i.revoked_at IS NULL
          AND m.workspace_id = i.workspace_id
          AND m.actor_id = i.actor_id
        RETURNING p.id, p.invite_id, p.created_at, p.expires_at, p.consumed_at, p.revoked_at
      `;
      if (!consumed[0]) return null;
      const minted = await this.mintInstallationWithin(sql, consumed[0].invite_id);
      if (!minted) throw new Error("active pairing lost its agent invite");
      return minted;
    });
  }

  private async mintInstallationWithin(sql: Sql, inviteId: string): Promise<{
    invite: AgentInvite;
    installation: AgentInstallation;
    installationToken: string;
  } | null> {
    const invite = await this.findInvite(sql, inviteId);
    if (!invite) return null;
    const installationToken = randomBytes(TOKEN_BYTES).toString("hex");
    const now = Date.now();
    const installationRows = await sql<InstallationRow[]>`
      INSERT INTO agent_installations (id, invite_id, token_hash, created_at, last_used_at)
      VALUES (${randomUUID()}, ${inviteId}, ${hashToken(installationToken)}, ${now}, NULL)
      RETURNING id, invite_id, created_at, last_used_at
    `;
    return { invite, installation: toInstallation(installationRows[0]), installationToken };
  }

  async resolve(token: string): Promise<{ actor: Actor; invite: AgentInvite } | null> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      JOIN workspace_members m ON m.actor_id = i.actor_id AND m.workspace_id = i.workspace_id
      WHERE i.workspace_id = ${this.db.workspaceId}
        AND i.token_hash = ${hashToken(token)}
        AND i.revoked_at IS NULL
    `;
    return this.resolved(rows[0]);
  }

  /** Forget this machine's durable credential. Does not revoke the agent
   *  invite — only the installation that presented the token. */
  async revokeInstallation(token: string): Promise<boolean> {
    const rows = await this.db.sql`
      DELETE FROM agent_installations
      WHERE token_hash = ${hashToken(token)}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async resolveInstallation(token: string): Promise<{ actor: Actor; invite: AgentInvite } | null> {
    const now = Date.now();
    const rows = await this.db.sql<InviteRow[]>`
      UPDATE agent_installations installation
      SET last_used_at = ${now}
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      JOIN workspace_members m ON m.actor_id = i.actor_id AND m.workspace_id = i.workspace_id
      WHERE installation.token_hash = ${hashToken(token)}
        AND installation.invite_id = i.id
        AND i.workspace_id = ${this.db.workspaceId}
        AND i.revoked_at IS NULL
      RETURNING i.*, a.display_name AS name
    `;
    return this.resolved(rows[0]);
  }

  async list(): Promise<AgentInvite[]> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      JOIN workspace_members m ON m.actor_id = i.actor_id AND m.workspace_id = i.workspace_id
      WHERE i.workspace_id = ${this.db.workspaceId} AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC
    `;
    return rows.map(toInvite);
  }

  /** Internal only — never exposes ciphertext through the public AgentInvite
   *  shape. Used by ApiKeyAgentSupervisor to restart hosted agents on boot. */
  async listOpenAiWithKeys(): Promise<{ invite: AgentInvite; apiKeyCiphertext: string }[]> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      JOIN workspace_members m ON m.actor_id = i.actor_id AND m.workspace_id = i.workspace_id
      WHERE i.workspace_id = ${this.db.workspaceId}
        AND i.revoked_at IS NULL
        AND i.provider = 'openai'
        AND i.api_key_ciphertext IS NOT NULL
      ORDER BY i.created_at DESC
    `;
    return rows.map((row) => ({ invite: toInvite(row), apiKeyCiphertext: row.api_key_ciphertext! }));
  }

  async revoke(id: string): Promise<AgentInvite | null> {
    const rows = await this.db.sql<InviteRow[]>`
      UPDATE agent_invites i
      SET revoked_at = ${Date.now()}
      FROM actors a
      WHERE i.id = ${id}
        AND i.workspace_id = ${this.db.workspaceId}
        AND i.revoked_at IS NULL
        AND a.id = i.actor_id
      RETURNING i.*, a.display_name AS name
    `;
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async isRevoked(actorId: string): Promise<boolean> {
    const rows = await this.db.sql<{ revoked_at: number | null }[]>`
      SELECT revoked_at FROM agent_invites
      WHERE workspace_id = ${this.db.workspaceId} AND actor_id = ${actorId}
    `;
    return rows.length > 0 && rows[0].revoked_at !== null;
  }

  async findByActorId(actorId: string): Promise<AgentInvite | null> {
    const rows = await this.db.sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      WHERE i.workspace_id = ${this.db.workspaceId}
        AND i.actor_id = ${actorId}
        AND i.revoked_at IS NULL
    `;
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async allowsAuthor(agentId: string, authorId: string): Promise<boolean> {
    const invite = await this.findByActorId(agentId);
    if (!invite) return true;
    if (invite.access.mode === "creator") return authorId === invite.createdBy;
    if (invite.access.mode === "selected") return invite.access.selectedActorIds.includes(authorId);
    const actor = await this.db.getActor(authorId);
    return actor?.kind === "human" && (await this.db.isMember(authorId));
  }

  private async resolved(row: InviteRow | undefined): Promise<{ actor: Actor; invite: AgentInvite } | null> {
    if (!row) return null;
    const actor = await this.db.getActor(row.actor_id);
    return actor ? { actor, invite: toInvite(row) } : null;
  }

  private async findInvite(sql: Sql, id: string): Promise<AgentInvite | null> {
    const rows = await sql<InviteRow[]>`
      SELECT i.*, a.display_name AS name
      FROM agent_invites i
      JOIN actors a ON a.id = i.actor_id
      WHERE i.id = ${id} AND i.workspace_id = ${this.db.workspaceId} AND i.revoked_at IS NULL
    `;
    return rows[0] ? toInvite(rows[0]) : null;
  }

  private async validateAccess(access: AgentAccessPolicy): Promise<void> {
    const uniqueIds = new Set(access.selectedActorIds);
    if (uniqueIds.size !== access.selectedActorIds.length) {
      throw new ApiError(400, "BAD_ACCESS", "selected actor ids must be unique");
    }
    if (access.mode === "selected" && uniqueIds.size === 0) {
      throw new ApiError(400, "BAD_ACCESS", "selected access requires at least one actor id");
    }
    if (access.mode !== "selected" && uniqueIds.size > 0) {
      throw new ApiError(400, "BAD_ACCESS", "selected actor ids require selected access");
    }
    if (uniqueIds.size === 0) return;
    const rows = await this.db.sql<{ actor_id: string }[]>`
      SELECT m.actor_id
      FROM workspace_members m
      JOIN actors a ON a.id = m.actor_id
      WHERE m.workspace_id = ${this.db.workspaceId}
        AND m.actor_id IN ${this.db.sql([...uniqueIds])}
        AND a.kind = 'human'
    `;
    if (rows.length !== uniqueIds.size) {
      throw new ApiError(400, "BAD_ACCESS", "selected actors must be human workspace members");
    }
  }
}
