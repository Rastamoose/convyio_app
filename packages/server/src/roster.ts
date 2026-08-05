import type { Participant, ParticipantKind } from "@workspace/shared";
import type { WorkspaceDb } from "./db";

/**
 * The participant roster: persistent identity plus live presence, keyed by
 * kind:name so a rejoin reclaims the same identity. Exists so the hub only
 * routes frames and never decides who is in the room.
 */
export class Roster {
  private known = new Map<string, Participant>();

  constructor(private db: WorkspaceDb) {
    // Agents are permanent members of the server, not ephemeral connections:
    // every agent actor is in the roster from boot, grey until its process
    // connects. Humans stay presence-only by design.
    for (const actor of db.listActors("agent")) {
      this.known.set(rosterKey("agent", actor.displayName), {
        id: actor.id,
        name: actor.displayName,
        kind: "agent",
        status: "",
        runState: "idle",
        online: false,
      });
    }
  }

  /**
   * Find-or-create the participant for a joining connection. Participant
   * identity is the persistent actor identity, so board attribution and
   * presence agree on ids.
   */
  join(kind: ParticipantKind, name: string): Participant {
    const key = rosterKey(kind, name);
    let participant = this.known.get(key);
    if (!participant) {
      const actor = this.db.upsertActor(kind, name);
      participant = {
        id: actor.id,
        name: actor.displayName,
        kind,
        status: "",
        runState: "idle",
        online: true,
      };
      this.known.set(key, participant);
    }
    participant.online = true;
    participant.runState = "idle";
    return participant;
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

  /** Humans exist only while a tab is open; dropping one logs it out. */
  removeHuman(id: string): void {
    for (const [key, p] of this.known) {
      if (p.id === id && p.kind === "human") this.known.delete(key);
    }
  }
}

function rosterKey(kind: ParticipantKind, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}
