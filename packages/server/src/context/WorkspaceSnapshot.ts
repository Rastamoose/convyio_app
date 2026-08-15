import type { WorkspaceSnapshot } from "@workspace/shared";
import type { WorkspaceDb } from "../db";
import type { BoardService } from "../board/BoardService";
import type { ContextStore } from "./ContextStore";

/**
 * Builds a cursor-bearing workspace projection. `seq` is the highest
 * thread_events.seq included; callers treat live events at or below it as
 * already represented.
 */
export class WorkspaceSnapshotBuilder {
  constructor(
    private store: WorkspaceDb,
    private board: BoardService,
    private context: ContextStore,
  ) {}

  async build(): Promise<WorkspaceSnapshot> {
    // Capture seq first. Events after it arrive live; events at or below it
    // are represented here. Taking seq last would let an intervening event
    // land in the cursor but miss the projection.
    const [seqRow] = await this.store.sql<{ seq: number | null }[]>`
      SELECT max(seq) AS seq FROM thread_events
      WHERE workspace_id = ${this.store.workspaceId}
    `;
    const [items, context, members] = await Promise.all([
      this.board.list(this.store.workspaceId, { includeDeleted: true }),
      this.context.listActive(),
      this.store.listMembers(),
    ]);
    return {
      seq: seqRow?.seq ?? 0,
      generatedAt: Date.now(),
      items: items.filter((item) => item.deletedAt == null),
      plans: [],
      context,
      members,
    };
  }
}
