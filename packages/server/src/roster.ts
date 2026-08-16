import type { Participant, ParticipantKind } from "@workspace/shared";
import type { AgentInvites } from "./auth/AgentInvites";
import type { WorkspaceDb } from "./db";

/**
 * The participant roster: persistent identity plus live presence, keyed by
 * kind:name so a rejoin reclaims the same identity. Exists so the hub only
 * routes frames and never decides who is in the room.
 */
export class Roster {
  private known = new Map<string, Participant>();

  private constructor(
    private db: WorkspaceDb,
    private agentInvites: AgentInvites,
  ) {}

  /** Drop every in-memory participant. Tests that share one env call this
   *  after truncating the DB so the next test starts with an empty room. */
  clear(): void {
    this.known.clear();
  }

  /**
   * Async factory: agents and registered humans are permanent members of
   * the workspace, not ephemeral connections, so every workspace member is
   * loaded into the roster before the server accepts connections
   * (grey/offline until its process or tab connects). Non-member actors
   * (demo personas, guests) are identities only and are not pre-loaded.
   *
   * User-created agents whose invites have been revoked are not loaded, so
   * they disappear from the roster after revocation (their actor rows stay
   * in the database for attribution).
   */
  static async create(db: WorkspaceDb, agentInvites: AgentInvites): Promise<Roster> {
    const roster = new Roster(db, agentInvites);
    for (const kind of ["agent", "human"] as const) {
      for (const actor of await db.listMembers(kind)) {
        if (kind === "agent" && (await agentInvites.isRevoked(actor.id))) continue;
        roster.known.set(rosterKey(kind, actor.displayName), {
          id: actor.id,
          name: actor.displayName,
          kind,
          status: "",
          runState: "idle",
          online: false,
        });
      }
    }
    return roster;
  }

  /**
   * Find-or-create the participant for a joining connection. Participant
   * identity is the persistent actor identity, so board attribution and
   * presence agree on ids.
   */
  async join(kind: ParticipantKind, name: string, actorId?: string): Promise<Participant> {
    const key = rosterKey(kind, name);
    let participant = actorId
      ? [...this.known.values()].find((known) => known.id === actorId)
      : this.known.get(key);
    if (!participant) {
      const actor = actorId ? await this.db.getActor(actorId) : await this.db.upsertActor(kind, name);
      if (!actor || actor.kind !== kind) throw new Error("join identity no longer exists");
      participant = {
        id: actor.id,
        name: actor.displayName,
        kind,
        status: "",
        runState: "idle",
        online: true,
      };
      this.known.set(rosterKey(kind, actor.displayName), participant);
    }
    participant.online = true;
    participant.runState = "idle";
    return participant;
  }

  async addOffline(actorId: string): Promise<void> {
    const actor = await this.db.getActor(actorId);
    if (!actor || !(await this.db.isMember(actorId))) return;
    this.known.set(rosterKey(actor.kind, actor.displayName), {
      id: actor.id,
      name: actor.displayName,
      kind: actor.kind,
      status: "",
      runState: "idle",
      online: false,
    });
  }

  get(kind: ParticipantKind, name: string): Participant | undefined {
    return this.known.get(rosterKey(kind, name));
  }

  list(): Participant[] {
    return [...this.known.values()];
  }

  onlineAgentName(): string | null {
    for (const p of this.known.values()) {
      if (p.kind === "agent" && p.online) return p.name;
    }
    return null;
  }

  setOnline(id: string, online: boolean): void {
    for (const p of this.known.values()) {
      if (p.id === id) p.online = online;
    }
  }

  /** Drop a human from the live roster: after a scripted demo run (personas
   *  are not workspace members) or after a real member is removed from the
   *  workspace. An ordinary disconnect never calls this — it just goes
   *  offline via setOnline, staying in the roster. */
  removeHuman(id: string): void {
    for (const [key, p] of this.known) {
      if (p.id === id && p.kind === "human") this.known.delete(key);
    }
  }

  /** Remove a revoked user-created agent from the live roster. */
  removeAgent(id: string): void {
    for (const [key, p] of this.known) {
      if (p.id === id && p.kind === "agent") this.known.delete(key);
    }
  }
}

function rosterKey(kind: ParticipantKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}
