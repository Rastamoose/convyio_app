import { useEffect, useState } from "react";
import type {
  Actor,
  BoardItem,
  BoardItemEvent,
  ItemStatus,
} from "@workspace/shared";
import type { ActiveRun, BoardItemEdit } from "../hooks/useWorkspace";
import { BoardCard } from "./BoardCard";
import { ItemDrawer } from "./ItemDrawer";

const COLUMNS: { status: ItemStatus; label: string }[] = [
  { status: "proposed", label: "Proposed" },
  { status: "approved", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

export function BoardView({
  board,
  activeRuns,
  highlightRef,
  openItemId,
  onOpenItem,
  onCreate,
  onApprove,
  onDeny,
  onDiscuss,
  onStart,
  onComplete,
  onReopen,
  onDelete,
  onEdit,
  onJumpToTrace,
  fetchActors,
  fetchItemEvents,
}: {
  board: BoardItem[];
  activeRuns: ActiveRun[];
  highlightRef: string | null;
  openItemId: string | null;
  onOpenItem: (itemId: string | null) => void;
  onCreate: (title: string, description?: string) => void;
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onStart: (itemId: string) => void;
  onComplete: (itemId: string) => void;
  onReopen: (itemId: string) => void;
  onDelete: (itemId: string) => void;
  onEdit: (itemId: string, fields: BoardItemEdit) => void;
  onJumpToTrace: (runId: string) => void;
  fetchActors: () => Promise<Actor[]>;
  fetchItemEvents: (itemId: string) => Promise<BoardItemEvent[]>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [showDenied, setShowDenied] = useState(false);
  const canSubmit = !!title.trim();

  const openItem = openItemId
    ? (board.find((i) => i.id === openItemId) ?? null)
    : null;

  useEffect(() => {
    if (openItemId && !openItem) onOpenItem(null);
  }, [openItemId, openItem, onOpenItem]);

  useEffect(() => {
    if (!highlightRef) return;
    document
      .getElementById(`board-item-${highlightRef}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightRef]);

  const submit = () => {
    if (!canSubmit) return;
    onCreate(title.trim(), description.trim() || undefined);
    setTitle("");
    setDescription("");
    setDescriptionOpen(false);
  };

  const columns = showDenied
    ? [...COLUMNS, { status: "denied" as ItemStatus, label: "Denied" }]
    : COLUMNS;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-divider px-4 py-3">
        <span className="font-semibold text-body">Board</span>
        <span className="text-xs text-muted">
          {board.length} item{board.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-1.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="w-64 rounded bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
            placeholder="Add a board item…"
            maxLength={200}
          />
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="rounded bg-blurple px-3 py-1.5 text-sm font-semibold text-mention-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
          {!descriptionOpen && (
            <button
              onClick={() => setDescriptionOpen(true)}
              className="px-1 text-xs text-faint hover:text-body"
            >
              + description
            </button>
          )}
        </div>
        <button
          onClick={() => setShowDenied((o) => !o)}
          className={`ml-auto rounded px-2 py-1 text-xs font-semibold ${
            showDenied
              ? "bg-input text-body"
              : "text-muted hover:bg-input/50 hover:text-body"
          }`}
        >
          {showDenied ? "Hide denied" : "Show denied"}
        </button>
        {descriptionOpen && (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full resize-none rounded bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
            placeholder="Description (optional)"
            maxLength={1000}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {columns.map(({ status, label }) => {
          const items = board.filter((i) => i.status === status);
          const proposed = status === "proposed";
          return (
            <div
              key={status}
              className={`flex h-full w-72 shrink-0 flex-col rounded-lg bg-sidebar/50 ${
                proposed ? "border border-dead/30" : ""
              }`}
            >
              <div className="flex shrink-0 items-center gap-2 px-3 py-2">
                <span
                  className={`text-[11px] font-bold tracking-wide uppercase ${
                    proposed ? "text-dead" : "text-muted"
                  }`}
                >
                  {label}
                </span>
                <span className="rounded-full bg-input px-1.5 py-px text-[10px] font-bold text-muted">
                  {items.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {items.length === 0 ? (
                  <div className="px-1 py-2 text-xs text-faint">empty</div>
                ) : (
                  items.map((item) => (
                    <BoardCard
                      key={item.id}
                      item={item}
                      activeRuns={activeRuns}
                      highlighted={highlightRef === item.ref}
                      onOpen={onOpenItem}
                      onApprove={onApprove}
                      onDeny={onDeny}
                      onDiscuss={onDiscuss}
                      onJumpToTrace={onJumpToTrace}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {openItem && (
        <ItemDrawer
          item={openItem}
          onClose={() => onOpenItem(null)}
          onApprove={onApprove}
          onDeny={onDeny}
          onDiscuss={onDiscuss}
          onStart={onStart}
          onComplete={onComplete}
          onReopen={onReopen}
          onDelete={onDelete}
          onEdit={onEdit}
          fetchActors={fetchActors}
          fetchItemEvents={fetchItemEvents}
        />
      )}
    </div>
  );
}
