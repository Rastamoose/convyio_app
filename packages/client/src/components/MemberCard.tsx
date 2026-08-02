import { useEffect, useRef, useState } from "react";
import type { BoardItem, ChatMessage, Participant } from "@workspace/shared";
import type { ActiveRun } from "../hooks/useWorkspace";
import { Avatar } from "./Avatar";
import { ProposalCard } from "./ProposalCard";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function MemberCard({
  participant,
  board,
  activeRuns,
  messages,
  onApprove,
  onDeny,
  onDiscuss,
  onPrefill,
  onClose,
}: {
  participant: Participant;
  board: BoardItem[];
  activeRuns: ActiveRun[];
  messages: ChatMessage[];
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onPrefill: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

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
      className="fixed top-16 left-[248px] z-50 max-h-[70vh] w-80 overflow-y-auto rounded-lg bg-popup p-4 shadow-lg"
    >
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={participant.name} size={48} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-body">
            {participant.name}
            {isAgent && (
              <span className="ml-1.5 rounded bg-blurple px-1 py-px align-middle text-[10px] font-bold text-mention-text">
                AGENT
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted">
            {participant.online ? "Online" : "Offline"}
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
                onApprove={onApprove}
                onDeny={onDeny}
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
              className="flex-1 rounded bg-input px-2 py-1.5 text-xs font-semibold text-body hover:bg-mention-bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-input"
            >
              Jump to trace
            </button>
            <button
              onClick={mention}
              className="flex-1 rounded bg-blurple px-2 py-1.5 text-xs font-semibold text-mention-text hover:opacity-90"
            >
              Mention
            </button>
          </div>
        </>
      )}
    </div>
  );
}
