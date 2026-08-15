import type { BoardEventEnvelope } from "@workspace/shared";
import type { AgentRunner } from "./runner";
import type { Presence } from "./presence";

/**
 * Reacts to live board decisions that affect a running agent. Approved
 * ticket work is queued by the server, not stashed locally. This only
 * aborts a mid-run when the backing item is deleted.
 */
export class ProposalLifecycle {
  constructor(
    private runner: AgentRunner,
    private presence: Presence,
  ) {}

  onBoardEvent(envelope: BoardEventEnvelope): void {
    const { item } = envelope;
    if (envelope.type === "item.deleted" && this.runner.abortIfWorkingOn(item.id)) {
      console.log(`[agent] ${item.ref} deleted mid-run — halting`);
      this.runner.enqueue({
        authorName: "system",
        content:
          `Board item ${item.ref} ("${item.title}") was DELETED by ${envelope.actor.display_name}. ` +
          `The work it authorized is halted; the toolman will refuse further actions on it. ` +
          `Briefly acknowledge this in chat.`,
        channel: "general",
      });
    }
    this.presence.refresh();
  }

  sweep(): void {
    this.presence.refresh();
  }
}
