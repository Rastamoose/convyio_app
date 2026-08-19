import { useEffect, useRef, useState } from "react";
import type { Actor, BoardItem, BoardItemEvent } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { ITEM_STATUS_BADGE, ITEM_STATUS_LABEL } from "../lib/status";
import { formatFullDateTime, relativeTime } from "../lib/format";
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
    <div className="mb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
      {children}
    </div>
  );
}

/** Cmd/Ctrl+Enter-to-save discoverability line under an editing textarea. */
function EditHint() {
  return (
    <div className="mt-1 text-[10px] text-faint">esc to cancel • ⌘↵ to save</div>
  );
}

/**
 * Two-step inline delete: the first click arms a red "Confirm delete?", the
 * second executes. Disarms after 3s or when the pointer leaves.
 */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | null>(null);
  const disarm = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    setConfirming(false);
  };
  useEffect(() => disarm, []);
  return (
    <span onMouseLeave={disarm}>
      <ActionButton
        label={confirming ? "Confirm delete?" : "Delete"}
        tone={confirming ? "deny" : "destructive"}
        onClick={() => {
          if (confirming) {
            disarm();
            onDelete();
          } else {
            setConfirming(true);
            timer.current = window.setTimeout(() => setConfirming(false), 3000);
          }
        }}
      />
    </span>
  );
}

export function ItemDrawer({
  item,
  originChannel,
  onClose,
  onDiscuss,
  onOpenConversation,
}: {
  item: BoardItem;
  originChannel?: string;
  onClose: () => void;
  onDiscuss: (item: BoardItem) => void;
  onOpenConversation?: () => void;
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
  const [ownerIndex, setOwnerIndex] = useState(0);
  const [actors, setActors] = useState<Actor[] | null>(null);
  const [events, setEvents] = useState<BoardItemEvent[]>([]);
  const [evidence, setEvidence] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const ownerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // On open, put keyboard focus inside the drawer.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Same pattern as MemberCard: a click anywhere outside closes the picker.
  useEffect(() => {
    if (!ownerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ownerRef.current && !ownerRef.current.contains(e.target as Node)) {
        setOwnerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ownerOpen]);

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
    setOwnerIndex(0);
    if (actors == null) void fetchActors().then(setActors);
  };

  const assignOwner = (actorId: string | null) => {
    setOwnerOpen(false);
    if (actorId !== item.owner) editItem(item.id, { owner: actorId });
  };

  // Index 0 is "Unassign"; the loaded actors follow.
  const ownerOptions: (Actor | null)[] = [null, ...(actors ?? [])];

  const onOwnerKeyDown = (e: React.KeyboardEvent) => {
    if (!ownerOpen) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setOwnerIndex(
        (i) => (i + delta + ownerOptions.length) % ownerOptions.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      assignOwner(ownerOptions[ownerIndex]?.id ?? null);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // close the picker, not the drawer
      setOwnerOpen(false);
    }
  };

  const actions = {
    proposed: (
      <>
        <ActionButton label="Approve" tone="approve" onClick={() => approveItem(item.id, item.owner ?? undefined)} />
        <ActionButton label="Deny" tone="deny" onClick={() => denyItem(item.id)} />
        <ActionButton label="Discuss" tone="neutral" onClick={() => onDiscuss(item)} />
      </>
    ),
    approved: (
      <>
        <ActionButton label="Start" tone="primary" onClick={() => startItem(item.id)} />
        <DeleteButton onDelete={() => deleteItem(item.id)} />
      </>
    ),
    in_progress: (
      <>
        <input
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          aria-label="Verification evidence"
          placeholder="Evidence"
          className="min-w-40 flex-1 rounded-md bg-input px-2 py-1 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
        />
        <ActionButton label="Complete" tone="approve" onClick={() => evidence.trim() && completeItem(item.id, evidence.trim())} />
        <DeleteButton onDelete={() => deleteItem(item.id)} />
      </>
    ),
    blocked: (
      <>
        <input
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          aria-label="Verification evidence"
          placeholder="Evidence"
          className="min-w-40 flex-1 rounded-md bg-input px-2 py-1 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
        />
        <ActionButton label="Complete" tone="approve" onClick={() => evidence.trim() && completeItem(item.id, evidence.trim())} />
        <DeleteButton onDelete={() => deleteItem(item.id)} />
      </>
    ),
    done: (
      <>
        <ActionButton label="Reopen" tone="primary" onClick={() => reopenItem(item.id)} />
        <DeleteButton onDelete={() => deleteItem(item.id)} />
      </>
    ),
    denied: <DeleteButton onDelete={() => deleteItem(item.id)} />,
  }[item.status];

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed top-10 right-0 bottom-0 left-0 z-30 animate-fade-in bg-black/20"
      />
      <aside className="elevated fixed top-12 right-2 bottom-2 z-40 flex w-[420px] animate-slide-in-right flex-col overflow-y-auto rounded-l-xl p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded bg-accent px-1 py-px text-[10px] font-bold text-on-accent">
            {item.ref}
          </span>
          <span
            className={`text-[10px] font-bold tracking-wider uppercase ${ITEM_STATUS_BADGE[item.status]}`}
          >
            {ITEM_STATUS_LABEL[item.status]}
          </span>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close item details"
            className="ml-auto rounded-md p-1 text-muted transition duration-150 outline-none hover:bg-subtle-hover hover:text-body focus-visible:ring-2 focus-visible:ring-accent"
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
            className="mb-3 w-full rounded-md bg-input px-2 py-1.5 text-base font-semibold text-body outline-none focus:ring-2 focus:ring-accent"
            maxLength={200}
          />
        ) : (
          <button
            onClick={() => setTitleDraft(item.title)}
            className="mb-3 rounded-md px-1 py-0.5 text-left text-base font-semibold text-body hover:bg-subtle-hover"
            title="Click to edit"
          >
            {item.title}
          </button>
        )}

        <div className="mb-3">
          <Label>Description</Label>
          {descDraft != null ? (
            <>
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
                className="w-full resize-none rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
                maxLength={1000}
              />
              <EditHint />
            </>
          ) : (
            <button
              onClick={() => setDescDraft(item.description ?? "")}
              className="w-full rounded-md px-1 py-0.5 text-left text-sm hover:bg-subtle-hover"
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

        {originChannel && (
          <div className="mb-3">
            <Label>Origin conversation</Label>
            {onOpenConversation ? (
              <button onClick={onOpenConversation} className="text-sm font-semibold text-accent hover:underline">
                #{originChannel}
              </button>
            ) : (
              <div className="text-sm text-body">#{originChannel}</div>
            )}
          </div>
        )}

        <div className="mb-3">
          <Label>Scope paths</Label>
          {scopeDraft != null ? (
            <>
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
                className="w-full resize-none rounded-md bg-input px-2 py-1.5 text-xs text-body outline-none focus:ring-2 focus:ring-accent"
                placeholder={'One path per line; end with "/" for a subtree. Empty = unrestricted.'}
                maxLength={2000}
              />
              <EditHint />
            </>
          ) : (
            <button
              onClick={() => setScopeDraft((item.scopePaths ?? []).join("\n"))}
              className="w-full rounded-md px-1 py-0.5 text-left hover:bg-subtle-hover"
              title="Click to edit"
            >
              {item.scopePaths && item.scopePaths.length > 0 ? (
                <ul className="text-xs text-body">
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

        <div ref={ownerRef} onKeyDown={onOwnerKeyDown} className="relative mb-3">
          <Label>Owner</Label>
          <button
            onClick={openOwnerPicker}
            aria-expanded={ownerOpen}
            className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-subtle-hover"
          >
            {item.ownerName ? (
              <>
                <Avatar name={item.ownerName} size={18} mascot={item.ownerName.toLowerCase() === "noodle"} />
                <span className="text-body">{item.ownerName}</span>
              </>
            ) : (
              <span className="text-faint">Unassigned</span>
            )}
          </button>
          {ownerOpen && (
            <div className="elevated absolute top-full left-0 z-50 mt-1 max-h-56 w-64 overflow-y-auto rounded-lg p-1">
              <button
                onClick={() => assignOwner(null)}
                className={`block w-full rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-subtle-hover ${
                  ownerIndex === 0 ? "bg-subtle" : ""
                }`}
              >
                Unassign
              </button>
              {actors == null ? (
                <div className="px-2 py-1.5 text-sm text-faint">Loading…</div>
              ) : (
                actors.map((actor, i) => (
                  <button
                    key={actor.id}
                    onClick={() => assignOwner(actor.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-body hover:bg-subtle-hover ${
                      ownerIndex === i + 1 ? "bg-subtle" : ""
                    }`}
                  >
                    <Avatar name={actor.displayName} size={18} mascot={actor.managedAgent === "noodle"} />
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
            <span title={formatFullDateTime(item.createdAt)}>
              {relativeTime(item.createdAt)}
            </span>
          </div>
          {item.approvedByName && (
            <div>
              approved by {item.approvedByName}
              {item.approvedAt != null && (
                <>
                  {" · "}
                  <span title={formatFullDateTime(item.approvedAt)}>
                    {relativeTime(item.approvedAt)}
                  </span>
                </>
              )}
            </div>
          )}
          {item.startedAt != null && (
            <div>
              started{" "}
              <span title={formatFullDateTime(item.startedAt)}>
                {relativeTime(item.startedAt)}
              </span>
            </div>
          )}
          {item.completedAt != null && (
            <div>
              completed{" "}
              <span title={formatFullDateTime(item.completedAt)}>
                {relativeTime(item.completedAt)}
              </span>
            </div>
          )}
        </div>

        <div className="mb-4 flex gap-1.5 border-t border-divider pt-3">
          {actions}
        </div>

        <div className="border-t border-divider pt-3">
          <Label>Activity</Label>
          {events.length === 0 ? (
            <div className="flex items-center gap-1.5 text-xs text-faint">
              <svg
                className="h-3.5 w-3.5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M12 7v5l3 3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Nothing yet — actions on this item will show up here
            </div>
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
                      ·{" "}
                      <span title={formatFullDateTime(event.createdAt)}>
                        {relativeTime(event.createdAt)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
