import { useEffect, useState } from "react";
import type { Actor, BoardItem, BoardItemEvent } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { ITEM_STATUS_BADGE, ITEM_STATUS_LABEL } from "../lib/status";
import { relativeTime } from "../lib/format";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { ActionButton } from "./ActionButton";

const EVENT_VERB: Record<string, string> = {
  "item.created": "created",
  "item.proposed": "proposed",
  "item.approved": "approved",
  "item.denied": "denied",
  "item.started": "started",
  "item.blocked": "blocked",
  "item.unblocked": "unblocked",
  "item.completed": "completed",
  "item.edited": "edited",
  "item.deleted": "deleted",
  "item.reopened": "reopened",
};

function eventDetail(event: BoardItemEvent): string | null {
  if (event.type === "item.denied" || event.type === "item.blocked") {
    if ("reason" in event.payload && typeof event.payload.reason === "string") {
      return event.payload.reason || null;
    }
    return null;
  }
  if (event.type === "item.edited" && "changed" in event.payload) {
    const fields = Object.keys(event.payload.changed);
    return fields.length > 0 ? fields.join(", ") : null;
  }
  return null;
}

/** "a, b\nc" → ["a", "b", "c"]; an all-whitespace input means unrestricted. */
export function parseScopePaths(text: string): string[] | null {
  const paths = text
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paths.length > 0 ? paths : null;
}

function Label({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[10px] font-bold tracking-wide text-muted uppercase">
      {children}
    </div>
  );
}

export function ItemDrawer({
  item,
  onClose,
  onDiscuss,
}: {
  item: BoardItem;
  onClose: () => void;
  onDiscuss: (item: BoardItem) => void;
}) {
  const {
    approveItem,
    denyItem,
    startItem,
    completeItem,
    reopenItem,
    deleteItem,
    editItem,
    fetchActors,
    fetchItemEvents,
  } = useWorkspace();
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [scopeDraft, setScopeDraft] = useState<string | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [events, setEvents] = useState<BoardItemEvent[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void fetchItemEvents(item.id).then((rows) => {
      if (!cancelled) setEvents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.status]);

  useEffect(() => {
    setTitleDraft(null);
    setDescDraft(null);
    setScopeDraft(null);
    setOwnerOpen(false);
  }, [item.id]);

  const saveTitle = () => {
    if (titleDraft != null) {
      const next = titleDraft.trim();
      if (next && next !== item.title) editItem(item.id, { title: next });
    }
    setTitleDraft(null);
  };

  const saveDescription = () => {
    if (descDraft != null && descDraft !== (item.description ?? "")) {
      editItem(item.id, { description: descDraft });
    }
    setDescDraft(null);
  };

  const saveScopePaths = () => {
    if (scopeDraft != null) {
      const next = parseScopePaths(scopeDraft);
      if (JSON.stringify(next) !== JSON.stringify(item.scopePaths)) {
        editItem(item.id, { scopePaths: next });
      }
    }
    setScopeDraft(null);
  };

  const openOwnerPicker = () => {
    setOwnerOpen((o) => !o);
    if (actors == null) void fetchActors().then(setActors);
  };

  const assignOwner = (actorId: string | null) => {
    setOwnerOpen(false);
    if (actorId !== item.owner) editItem(item.id, { owner: actorId });
  };

  const actions = {
    proposed: (
      <>
        <ActionButton label="Approve" tone="approve" onClick={() => approveItem(item.id)} />
        <ActionButton label="Deny" tone="deny" onClick={() => denyItem(item.id)} />
        <ActionButton label="Discuss" tone="neutral" onClick={() => onDiscuss(item)} />
      </>
    ),
    approved: (
      <>
        <ActionButton label="Start" tone="primary" onClick={() => startItem(item.id)} />
        <ActionButton label="Delete" tone="destructive" onClick={() => deleteItem(item.id)} />
      </>
    ),
    in_progress: (
      <>
        <ActionButton label="Complete" tone="approve" onClick={() => completeItem(item.id)} />
        <ActionButton label="Delete" tone="destructive" onClick={() => deleteItem(item.id)} />
      </>
    ),
    blocked: (
      <>
        <ActionButton label="Complete" tone="approve" onClick={() => completeItem(item.id)} />
        <ActionButton label="Delete" tone="destructive" onClick={() => deleteItem(item.id)} />
      </>
    ),
    done: (
      <>
        <ActionButton label="Reopen" tone="primary" onClick={() => reopenItem(item.id)} />
        <ActionButton label="Delete" tone="destructive" onClick={() => deleteItem(item.id)} />
      </>
    ),
    denied: (
      <ActionButton label="Delete" tone="destructive" onClick={() => deleteItem(item.id)} />
    ),
  }[item.status];

  return (
    <aside className="fixed top-12 right-0 bottom-0 z-40 flex w-[420px] flex-col overflow-y-auto border-l border-sidebar-dark bg-sidebar p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded bg-blurple px-1 py-px text-[10px] font-bold text-mention-text">
          {item.ref}
        </span>
        <span
          className={`text-[11px] font-bold tracking-wide uppercase ${ITEM_STATUS_BADGE[item.status]}`}
        >
          {ITEM_STATUS_LABEL[item.status]}
        </span>
        <button
          onClick={onClose}
          aria-label="Close item details"
          className="ml-auto rounded p-1 text-muted hover:bg-input hover:text-body"
          title="Close"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {titleDraft != null ? (
        <input
          autoFocus
          aria-label="Item title"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveTitle();
            if (e.key === "Escape") {
              e.stopPropagation();
              setTitleDraft(null);
            }
          }}
          className="mb-3 w-full rounded bg-input px-2 py-1.5 text-base font-semibold text-body outline-none"
          maxLength={200}
        />
      ) : (
        <button
          onClick={() => setTitleDraft(item.title)}
          className="mb-3 rounded px-1 py-0.5 text-left text-base font-semibold text-body hover:bg-input/50"
          title="Click to edit"
        >
          {item.title}
        </button>
      )}

      <div className="mb-3">
        <Label>Description</Label>
        {descDraft != null ? (
          <textarea
            autoFocus
            aria-label="Item description"
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={saveDescription}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveDescription();
              if (e.key === "Escape") {
                e.stopPropagation();
                setDescDraft(null);
              }
            }}
            rows={4}
            className="w-full resize-none rounded bg-input px-2 py-1.5 text-sm text-body outline-none"
            maxLength={1000}
          />
        ) : (
          <button
            onClick={() => setDescDraft(item.description ?? "")}
            className="w-full rounded px-1 py-0.5 text-left text-sm hover:bg-input/50"
          >
            {item.description ? (
              <span className="break-words whitespace-pre-wrap text-body">
                {item.description}
              </span>
            ) : (
              <span className="text-faint">Add a description…</span>
            )}
          </button>
        )}
      </div>

      {item.origin === "agent" && item.proposalWhy && (
        <div className="mb-3">
          <Label>Why</Label>
          <div className="text-sm leading-snug break-words text-body">
            {item.proposalWhy}
          </div>
        </div>
      )}
      {item.origin === "agent" && item.proposalEffect && (
        <div className="mb-3">
          <Label>Expected effect</Label>
          <div className="text-sm leading-snug break-words text-body">
            {item.proposalEffect}
          </div>
        </div>
      )}

      <div className="mb-3">
        <Label>Scope paths</Label>
        {scopeDraft != null ? (
          <textarea
            autoFocus
            aria-label="Scope paths, one per line or comma-separated"
            value={scopeDraft}
            onChange={(e) => setScopeDraft(e.target.value)}
            onBlur={saveScopePaths}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveScopePaths();
              if (e.key === "Escape") {
                e.stopPropagation();
                setScopeDraft(null);
              }
            }}
            rows={3}
            className="w-full resize-none rounded bg-input px-2 py-1.5 font-mono text-xs text-body outline-none"
            placeholder={'One path per line; end with "/" for a subtree. Empty = unrestricted.'}
            maxLength={2000}
          />
        ) : (
          <button
            onClick={() => setScopeDraft((item.scopePaths ?? []).join("\n"))}
            className="w-full rounded px-1 py-0.5 text-left hover:bg-input/50"
            title="Click to edit"
          >
            {item.scopePaths && item.scopePaths.length > 0 ? (
              <ul className="font-mono text-xs text-body">
                {item.scopePaths.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-faint">Unrestricted</span>
            )}
          </button>
        )}
      </div>

      <div className="relative mb-3">
        <Label>Owner</Label>
        <button
          onClick={openOwnerPicker}
          className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-input/50"
        >
          {item.ownerName ? (
            <>
              <Avatar name={item.ownerName} size={18} />
              <span className="text-body">{item.ownerName}</span>
            </>
          ) : (
            <span className="text-faint">Unassigned</span>
          )}
        </button>
        {ownerOpen && (
          <div className="absolute top-full left-0 z-50 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg bg-popup p-1 shadow-lg">
            <button
              onClick={() => assignOwner(null)}
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-muted hover:bg-input"
            >
              Unassign
            </button>
            {actors == null ? (
              <div className="px-2 py-1.5 text-sm text-faint">Loading…</div>
            ) : (
              actors.map((actor) => (
                <button
                  key={actor.id}
                  onClick={() => assignOwner(actor.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-body hover:bg-input"
                >
                  <Avatar name={actor.displayName} size={18} />
                  {actor.displayName}
                  {actor.kind === "agent" && <AgentBadge />}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="mb-3 space-y-0.5 text-xs text-muted">
        <div>
          created by {item.createdByName ?? "unknown"} ·{" "}
          {relativeTime(item.createdAt)}
        </div>
        {item.approvedByName && (
          <div>
            approved by {item.approvedByName}
            {item.approvedAt != null && ` · ${relativeTime(item.approvedAt)}`}
          </div>
        )}
        {item.startedAt != null && (
          <div>started {relativeTime(item.startedAt)}</div>
        )}
        {item.completedAt != null && (
          <div>completed {relativeTime(item.completedAt)}</div>
        )}
      </div>

      <div className="mb-4 flex gap-1.5 border-t border-divider pt-3">
        {actions}
      </div>

      <div className="border-t border-divider pt-3">
        <Label>Activity</Label>
        {events.length === 0 ? (
          <div className="text-xs text-faint">No activity yet</div>
        ) : (
          <div className="space-y-1">
            {events.map((event) => {
              const detail = eventDetail(event);
              return (
                <div key={event.id} className="text-xs text-muted">
                  <span className="font-medium text-body">
                    {event.actorName}
                  </span>{" "}
                  {EVENT_VERB[event.type] ?? event.type}
                  {detail && <span className="text-faint"> — {detail}</span>}
                  <span className="text-faint">
                    {" "}
                    · {relativeTime(event.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
