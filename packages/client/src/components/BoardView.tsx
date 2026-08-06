import { useEffect, useState } from "react";
import type { BoardItem, ItemStatus } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { ITEM_STATUS_LABEL } from "../lib/status";
import { BoardCard } from "./BoardCard";
import { ItemDrawer } from "./ItemDrawer";

const COLUMN_STATUSES: ItemStatus[] = [
  "proposed",
  "approved",
  "in_progress",
  "blocked",
  "done",
];

export function BoardView({
  highlightRef,
  openItemId,
  onOpenItem,
  onDiscuss,
  onJumpToTrace,
}: {
  highlightRef: string | null;
  openItemId: string | null;
  onOpenItem: (itemId: string | null) => void;
  onDiscuss: (item: BoardItem) => void;
  onJumpToTrace: (runId: string) => void;
}) {
  const { board, createBoardItem } = useWorkspace();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [showDenied, setShowDenied] = useState(false);
  const [adding, setAdding] = useState(false);
  const canSubmit = !!title.trim() && !adding;

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
    setAdding(true);
    // The form only resets when the item landed.
    void createBoardItem(title.trim(), description.trim() || undefined)
      .then((ok) => {
        if (!ok) return;
        setTitle("");
        setDescription("");
        setDescriptionOpen(false);
      })
      .finally(() => setAdding(false));
  };

  const columns: ItemStatus[] = showDenied
    ? [...COLUMN_STATUSES, "denied"]
    : COLUMN_STATUSES;

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
            aria-label="New board item title"
            className="w-64 rounded bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-blurple"
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
            aria-label="New board item description"
            className="w-full resize-none rounded bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-blurple"
            placeholder="Description (optional)"
            maxLength={1000}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {columns.map((status) => {
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
                  {ITEM_STATUS_LABEL[status]}
                </span>
                <span className="rounded-full bg-input px-1.5 py-px text-[10px] font-bold text-muted">
                  {items.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {items.length === 0 ? (
                  <div className="flex items-center gap-1.5 px-1 py-2 text-xs text-faint">
                    <svg
                      className="h-3.5 w-3.5 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Nothing here yet
                  </div>
                ) : (
                  items.map((item) => (
                    <BoardCard
                      key={item.id}
                      item={item}
                      highlighted={highlightRef === item.ref}
                      onOpen={onOpenItem}
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
          onDiscuss={onDiscuss}
        />
      )}
    </div>
  );
}
