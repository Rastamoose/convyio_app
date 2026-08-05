import type { BoardEventEnvelope, BoardItem } from "@workspace/shared";
import type { BoardClient } from "./boardClient";
import type { PendingWork, StashedWork } from "./pendingWork";
import type { AgentRunner } from "./runner";
import type { Presence } from "./presence";

/**
 * Reacts to decisions on the agent's proposals: resumes approved work, drops
 * denied work, halts work whose backing item was deleted (I4), and sweeps the
 * persisted stash against the board snapshot after a restart.
 */
export class ProposalLifecycle {
  constructor(
    private board: BoardClient,
    private pendingWork: PendingWork,
    private runner: AgentRunner,
    private presence: Presence,
  ) {}

  onBoardEvent(envelope: BoardEventEnvelope): void {
    const { item } = envelope;

    if (envelope.type === "item.deleted") {
      if (this.runner.abortIfWorkingOn(item.id)) {
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
      this.pendingWork.delete(item.id);
      this.presence.refresh();
      return;
    }

    const work = this.pendingWork.get(item.id);
    if (!work) {
      this.presence.refresh();
      return;
    }

    if (envelope.type === "item.approved") {
      this.resumeApproved(item, work, envelope.actor.display_name);
    } else if (envelope.type === "item.denied") {
      const payload = envelope.payload;
      const reason =
        "reason" in payload && typeof payload.reason === "string" ? payload.reason : null;
      this.dropDenied(item, work, envelope.actor.display_name, reason);
    }
    this.presence.refresh();
  }

  /**
   * Restart recovery: decisions made while the agent was down arrive via the
   * board snapshot rather than live events. Sweep the persisted stash against
   * it so approved work still resumes and denied work is still dropped.
   */
  sweep(): void {
    for (const [itemId, work] of this.pendingWork.entries()) {
      const item = this.board.resolve(itemId);
      if (!item) {
        this.pendingWork.delete(itemId);
      } else if (item.status === "approved" || item.status === "in_progress") {
        this.resumeApproved(item, work, item.approvedByName ?? "a human");
      } else if (item.status === "denied") {
        this.dropDenied(item, work, "a human", null);
      }
    }
  }

  private resumeApproved(item: BoardItem, work: StashedWork, decidedBy: string): void {
    this.pendingWork.delete(item.id);
    console.log(`[agent] ${item.ref} approved — resuming`);
    this.runner.enqueue({
      authorName: "system",
      content:
        `Your proposal ${item.ref} ("${item.title}") was APPROVED by ${decidedBy}. ` +
        `Call board_start("${item.ref}"), do the work it authorizes using ${item.ref} as the ` +
        `board_item_ref for mutating actions, and call board_complete("${item.ref}") when finished. ` +
        `Original request:\n${work.origin}`,
      channel: work.channel,
      taskId: item.id,
    });
  }

  private dropDenied(item: BoardItem, work: StashedWork, decidedBy: string, reason: string | null): void {
    this.pendingWork.delete(item.id);
    console.log(`[agent] ${item.ref} denied — dropping`);
    this.runner.enqueue({
      authorName: "system",
      content:
        `Your proposal ${item.ref} ("${item.title}") was DENIED by ${decidedBy}` +
        `${reason ? ` with reason: ${reason}` : ""}. ` +
        `Drop that line of work. Briefly acknowledge this in chat; do not re-propose it.`,
      channel: work.channel,
    });
  }
}
