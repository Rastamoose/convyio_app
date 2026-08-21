import type { AgentSocket } from "./socket";
import type { BoardClient } from "./boardClient";

/**
 * Broadcasts the agent's presence: "working" while the runner drives a run,
 * red/blocked while any of its proposals await a human decision, orange/idle
 * otherwise.
 */
export class Presence {
  private selfId: string | null = null;
  private runActive = false;

  constructor(
    private socket: AgentSocket,
    private board: BoardClient,
  ) {}

  /** Identity arrives with the welcome frame; blocked-detection needs it. */
  setSelf(participantId: string): void {
    this.selfId = participantId;
  }

  /** The runner owns the status while a run executes; refresh() defers to it. */
  working(status: string, taskId: string | null): void {
    this.runActive = true;
    this.socket.send({ type: "status_update", status, runState: "working", taskId });
  }

  /** Hand the status back to board-derived availability between runs. */
  endRun(): void {
    this.runActive = false;
    this.refresh();
  }

  /** Re-derive blocked/idle from the board; a no-op while a run is active. */
  refresh(): void {
    if (this.runActive) return;
    const proposed = this.selfId ? this.board.myProposedItems(this.selfId) : [];
    const pendingAccess = (this.board as { pendingResourceAccess?: () => Array<{ kind: string; name: string }> }).pendingResourceAccess?.() ?? [];
    if (proposed.length > 0) {
      const refs = proposed.map((i) => i.ref).join(", ");
      this.socket.send({
        type: "status_update",
        status: `Blocked — awaiting approval (${refs})`,
        runState: "blocked",
        taskId: proposed[0].id,
      });
    } else if (pendingAccess.length > 0) {
      const names = pendingAccess.map((r) => r.name).join(", ");
      this.socket.send({
        type: "status_update",
        status: `Blocked — waiting for access approval (${names})`,
        runState: "blocked",
        taskId: null,
      });
    } else {
      this.socket.send({ type: "status_update", status: "", runState: "idle", taskId: null });
    }
  }
}
