import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { PermissionCard } from "./PermissionCard";
import { ResourceAccessRequestCard } from "./ResourceAccessRequestCard";
import { ProjectAccessRequestCard } from "./ProjectAccessRequestCard";

/** Workspace-wide "who's waiting on you" list, replacing the old per-agent auto-pop card. */
export function PendingApprovalsButton() {
  const {
    participants,
    pendingInteractions,
    resolveInteraction,
    pendingResourceAccessRequests,
    resolveResourceAccessRequest,
    pendingProjectAccessRequests,
    resolveProjectAccessRequest,
  } = useWorkspace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const count =
    pendingInteractions.length + pendingResourceAccessRequests.length + pendingProjectAccessRequests.length;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Pending approvals"
        title="Pending approvals"
        className="relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition select-none hover:bg-subtle-hover hover:text-body"
      >
        <svg
          className="h-4.5 w-4.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-canvas bg-accent text-[9px] leading-none font-bold text-on-accent">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Pending approvals"
          className="elevated absolute top-full right-0 z-50 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-lg p-2"
        >
          <p className="px-1.5 py-1 text-[10px] font-bold tracking-wider text-muted uppercase">
            Pending approvals
          </p>
          {count === 0 ? (
            <p className="px-1.5 py-2 text-sm text-muted">No pending approvals.</p>
          ) : (
            <div className="space-y-2 p-1">
              {pendingInteractions.map((request) => (
                <div key={request.id}>
                  <div className="mb-1 px-0.5 text-[10px] font-bold tracking-wider text-faint uppercase">
                    {participants.find((p) => p.id === request.agentId)?.name ?? "An agent"}
                  </div>
                  <PermissionCard request={request} onResolve={resolveInteraction} />
                </div>
              ))}
              {pendingResourceAccessRequests.map((request) => (
                <ResourceAccessRequestCard
                  key={request.id}
                  request={request}
                  onResolve={resolveResourceAccessRequest}
                  compact
                />
              ))}
              {pendingProjectAccessRequests.map((request) => (
                <ProjectAccessRequestCard
                  key={request.id}
                  request={request}
                  onResolve={resolveProjectAccessRequest}
                  compact
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
