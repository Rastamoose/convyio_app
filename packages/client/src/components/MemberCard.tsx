import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardItem, Participant } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { formatElapsed } from "../lib/format";
import { presenceLabel } from "../lib/status";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { ProposalCard } from "./ProposalCard";

export function MemberCard({
  participant,
  anchor,
  onDiscuss,
  onPrefill,
  onClose,
}: {
  participant: Participant;
  /** Viewport rect of the sidebar row that opened the card. */
  anchor: DOMRect;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
  onClose: () => void;
}) {
  const { board, activeRuns, messages } = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const [top, setTop] = useState(anchor.top);

  // Align with the clicked row, clamped so the card never runs past the
  // viewport bottom (layout effect: measured height, adjusted before paint).
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8)));
  }, [anchor, participant]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const isAgent = participant.kind === "agent";
  const currentTask = participant.currentTaskId
    ? board.find(
        (b) =>
          b.id === participant.currentTaskId ||
          b.ref === participant.currentTaskId,
      )
    : undefined;
  const pendingItem = isAgent
    ? board.find(
        (b) => b.status === "proposed" && b.createdBy === participant.id,
      )
    : undefined;

  const liveRun = activeRuns.find((r) => r.agentName === participant.name);
  const lastRunMessage = [...messages]
    .reverse()
    .find((m) => m.authorId === participant.id && m.runId);
  const jumpId = liveRun
    ? `trace-${liveRun.runId}`
    : lastRunMessage
      ? `msg-${lastRunMessage.id}`
      : null;

  const mention = () => {
    onClose();
    onPrefill(
      currentTask
        ? `@${participant.name} re: ${currentTask.ref} `
        : `@${participant.name} `,
    );
  };

  return (
    <div
      ref={ref}
      style={{ top, left: anchor.right + 8 }}
      className="animate-pop-in fixed z-50 max-h-[70vh] w-80 overflow-y-auto rounded-lg bg-popup p-4 shadow-lg"
    >
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={participant.name} size={48} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-body">
            {participant.name}
            {isAgent && <AgentBadge className="ml-1.5 align-middle" />}
          </div>
          <div className="truncate text-xs text-muted" title={presenceLabel(participant)}>
            {presenceLabel(participant)}
            {!isAgent && participant.status ? ` — ${participant.status}` : ""}
          </div>
        </div>
      </div>
      {isAgent && (
        <>
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-bold tracking-wide text-muted uppercase">
              Current task
            </div>
            {currentTask ? (
              <div className="text-sm text-body">
                <span className="rounded bg-blurple px-1 py-px text-xs font-bold text-mention-text">
                  {currentTask.ref}
                </span>{" "}
                {currentTask.title}
                {participant.taskStartedAt != null && (
                  <span className="ml-1.5 text-xs text-faint">
                    {formatElapsed(now - participant.taskStartedAt)}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted">No active task</div>
            )}
          </div>
          {pendingItem && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-bold tracking-wide text-dead uppercase">
                Pending request
              </div>
              <ProposalCard
                item={pendingItem}
                onDiscuss={(item) => {
                  onClose();
                  onDiscuss(item);
                }}
              />
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              disabled={!jumpId}
              onClick={() => {
                if (!jumpId) return;
                document
                  .getElementById(jumpId)
                  ?.scrollIntoView({ behavior: "smooth" });
              }}
              className="flex-1 cursor-pointer rounded bg-input px-2 py-1.5 text-xs font-semibold text-body hover:bg-mention-bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-input"
            >
              Jump to trace
            </button>
            <button
              onClick={mention}
              className="flex-1 cursor-pointer rounded bg-blurple px-2 py-1.5 text-xs font-semibold text-mention-text hover:opacity-90"
            >
              Mention
            </button>
          </div>
        </>
      )}
    </div>
  );
}
