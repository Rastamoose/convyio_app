import { useEffect, useState } from "react";
import type { BoardItem, ItemStatus } from "@workspace/shared";
import type { ActiveRun } from "../hooks/useWorkspace";
import { Avatar } from "./Avatar";
import { ProposalCard } from "./ProposalCard";

const STATUS_DOT: Record<ItemStatus, string> = {
  proposed: "bg-dead",
  in_progress: "bg-online",
  approved: "bg-working",
  blocked: "bg-away",
  done: "bg-offline",
  denied: "bg-offline",
};

function ItemRow({
  item,
  activeRuns,
  highlighted,
}: {
  item: BoardItem;
  activeRuns: ActiveRun[];
  highlighted: boolean;
}) {
  const muted = item.status === "done" || item.status === "denied";
  const liveRun =
    item.status === "in_progress" && item.ownerName
      ? activeRuns.find((r) => r.agentName === item.ownerName)
      : undefined;
  return (
    <div
      id={`board-item-${item.ref}`}
      className={`mb-0.5 rounded px-2 py-1.5 hover:bg-white/5 ${
        highlighted ? "bg-blurple/20 ring-1 ring-blurple" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded bg-input px-1 text-xs font-bold text-blurple">
          {item.ref}
        </span>
        <span
          className={`min-w-0 truncate text-sm ${
            item.status === "denied"
              ? "text-muted line-through"
              : muted
                ? "text-muted"
                : "text-body"
          }`}
        >
          {item.title}
        </span>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[item.status]}`}
          title={item.status}
        />
        {item.ownerName && (
          <span className="shrink-0" title={item.ownerName}>
            <Avatar name={item.ownerName} size={18} />
          </span>
        )}
        {liveRun && (
          <button
            onClick={() =>
              document
                .getElementById(`trace-${liveRun.runId}`)
                ?.scrollIntoView({ behavior: "smooth" })
            }
            className="shrink-0 text-xs text-blurple hover:underline"
          >
            trace
          </button>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  label,
  count,
  tinted = false,
  onClick,
  collapsed,
}: {
  label: string;
  count: number;
  tinted?: boolean;
  onClick?: () => void;
  collapsed?: boolean;
}) {
  const body = (
    <>
      {label} — {count}
      {onClick != null && (
        <span className="ml-1 text-faint">{collapsed ? "▸" : "▾"}</span>
      )}
    </>
  );
  const base = `mb-1 px-2 text-[11px] font-bold tracking-wide uppercase ${
    tinted ? "text-dead" : "text-muted"
  }`;
  if (onClick) {
    return (
      <button onClick={onClick} className={`block w-full text-left ${base}`}>
        {body}
      </button>
    );
  }
  return <h2 className={base}>{body}</h2>;
}

export function BoardPanel({
  board,
  activeRuns,
  highlightRef,
  onCreate,
  onApprove,
  onDeny,
  onDiscuss,
}: {
  board: BoardItem[];
  activeRuns: ActiveRun[];
  highlightRef: string | null;
  onCreate: (title: string, description?: string) => void;
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [deniedOpen, setDeniedOpen] = useState(false);
  const canSubmit = !!title.trim();

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

  const byStatus = (status: ItemStatus) =>
    board.filter((i) => i.status === status);
  const proposed = byStatus("proposed");
  const inProgress = byStatus("in_progress");
  const approved = byStatus("approved");
  const blocked = byStatus("blocked");
  const done = byStatus("done");
  const denied = byStatus("denied");

  const rows = (items: BoardItem[]) =>
    items.map((item) => (
      <ItemRow
        key={item.id}
        item={item}
        activeRuns={activeRuns}
        highlighted={highlightRef === item.ref}
      />
    ));

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-sidebar-dark bg-sidebar">
      <header className="flex h-12 shrink-0 items-center border-b border-sidebar-dark px-4">
        <span className="font-semibold text-body">Board</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-4">
        <div className="mb-3 space-y-1.5 px-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            className="w-full rounded bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
            placeholder="Add a board item…"
            maxLength={200}
          />
          {descriptionOpen ? (
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="w-full rounded bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint"
              placeholder="Description (optional)"
              maxLength={1000}
            />
          ) : (
            <button
              onClick={() => setDescriptionOpen(true)}
              className="px-1 text-xs text-faint hover:text-body"
            >
              + description
            </button>
          )}
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="w-full rounded bg-blurple px-2 py-1.5 text-sm font-semibold text-mention-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add item
          </button>
        </div>

        {proposed.length > 0 && (
          <section className="mb-3 rounded-lg bg-dead/10 py-2">
            <SectionHeader label="Proposed" count={proposed.length} tinted />
            {proposed.map((item) =>
              expandedId === item.id ? (
                <div key={item.id} className="px-2 pb-1">
                  <ProposalCard
                    item={item}
                    onApprove={onApprove}
                    onDeny={onDeny}
                    onDiscuss={onDiscuss}
                  />
                  <button
                    onClick={() => setExpandedId(null)}
                    className="mt-1 px-1 text-xs text-faint hover:text-body"
                  >
                    collapse
                  </button>
                </div>
              ) : (
                <div
                  key={item.id}
                  className="cursor-pointer"
                  onClick={() => setExpandedId(item.id)}
                >
                  <ItemRow
                    item={item}
                    activeRuns={activeRuns}
                    highlighted={highlightRef === item.ref}
                  />
                </div>
              ),
            )}
          </section>
        )}

        {inProgress.length > 0 && (
          <section className="mb-3">
            <SectionHeader label="In progress" count={inProgress.length} />
            {rows(inProgress)}
          </section>
        )}

        {blocked.length > 0 && (
          <section className="mb-3">
            <SectionHeader label="Blocked" count={blocked.length} />
            {rows(blocked)}
          </section>
        )}

        {approved.length > 0 && (
          <section className="mb-3">
            <SectionHeader label="Approved" count={approved.length} />
            {rows(approved)}
          </section>
        )}

        {done.length > 0 && (
          <section className="mb-3">
            <SectionHeader
              label="Done"
              count={done.length}
              onClick={() => setDoneOpen((o) => !o)}
              collapsed={!doneOpen}
            />
            {doneOpen && rows(done)}
          </section>
        )}

        {denied.length > 0 && (
          <section className="mb-3">
            <SectionHeader
              label="Denied"
              count={denied.length}
              onClick={() => setDeniedOpen((o) => !o)}
              collapsed={!deniedOpen}
            />
            {deniedOpen && rows(denied)}
          </section>
        )}
      </div>
    </aside>
  );
}
