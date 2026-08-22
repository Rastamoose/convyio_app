import { useEffect, useMemo, useState } from "react";
import { TOOLMAN_READ_ACTIONS, type ChatMessage, type InteractionRequest, type ToolExecution, type TraceChunk } from "@workspace/shared";
import { formatElapsed } from "../lib/format";
import { renderMessageContent } from "../lib/markdown";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { PermissionCard } from "./PermissionCard";
import { ToolCard, ToolCardGroup } from "./ToolCard";

/** Toolman lines are tagged in the trace; everything else is prose. */
const TOOL_LINE = /^\[toolman\] /;

function countActions(chunks: TraceChunk[]): number {
  return chunks.filter((c) => TOOL_LINE.test(c.content)).length;
}

function isReadAction(action: ToolExecution["action"]): boolean {
  return (TOOLMAN_READ_ACTIONS as readonly string[]).includes(action);
}

/**
 * Consecutive calls collapse into one row instead of spamming the trace: same
 * action always groups, and read-only actions (file/list/search/status) group
 * with each other too, since a burst of reads is one gesture to a human reader.
 */
function groupExecutions(executions: ToolExecution[]): ToolExecution[][] {
  const groups: ToolExecution[][] = [];
  for (const execution of executions) {
    const last = groups[groups.length - 1];
    const sameAction = last && last[0].action === execution.action;
    const bothReads = last && isReadAction(last[0].action) && isReadAction(execution.action);
    if (sameAction || bothReads) last!.push(execution);
    else groups.push([execution]);
  }
  return groups;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

function TraceBody({ chunks }: { chunks: TraceChunk[] }) {
  return (
    <div className="space-y-1 pl-[52px]">
      {chunks.map((chunk, i) => (
        <div
          key={i}
          className={`text-sm ${chunk.kind === "thought" ? "italic text-muted" : "text-body"}`}
        >
          {chunk.content}
        </div>
      ))}
    </div>
  );
}

export function TraceMessageLive({
  runId,
  agentName,
  chunks,
  startedAt,
  suspended,
  suspendedReason,
  interactions = [],
  executions = [],
  onResolveInteraction,
}: {
  runId: string;
  agentName: string;
  chunks: TraceChunk[];
  startedAt: number;
  suspended?: boolean;
  suspendedReason?: string;
  /** Prompts this run is paused on; answering here is the same act as anywhere. */
  interactions?: InteractionRequest[];
  executions?: ToolExecution[];
  onResolveInteraction?: (requestId: string, decision: "approve" | "deny") => void;
}) {
  // A live run's age is the one thing that changes with no new frames.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const actions = countActions(chunks);
  const paused = interactions.length > 0 || suspended;

  return (
    <div id={`trace-${runId}`} className="mt-4 flex gap-4 py-0.5 pr-4 pl-4">
      <div className="pt-0.5">
        <Avatar name={agentName} size={40} mascot={agentName.toLowerCase() === "noodle"} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-body hover:underline">{agentName}</span>
          <AgentBadge />
        </div>
        <div className="mb-1 flex items-center gap-2 text-sm text-muted">
          <span className="relative flex h-2.5 w-2.5">
            {!paused && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-working opacity-75" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${paused ? "bg-dead" : "bg-working"}`}
            />
          </span>
          {suspended ? "is waiting for approval" : paused ? "needs your decision" : "is working…"}
          <span className="text-xs text-faint">
            {actions > 0 && `${actions} action${actions === 1 ? "" : "s"} · `}
            {formatElapsed(now - startedAt)}
          </span>
        </div>
        {suspended && suspendedReason && (
          <div className="mb-2 text-xs text-faint">{suspendedReason}</div>
        )}
        {executions.length > 0 ? (
          <div className="mt-2 space-y-1">
            {groupExecutions(executions).map((group) =>
              group.length === 1 ? (
                <ToolCard key={group[0].id} execution={group[0]} />
              ) : (
                <ToolCardGroup key={group[0].id} executions={group} />
              ),
            )}
          </div>
        ) : (
          <TraceBody chunks={chunks} />
        )}
        {interactions.length > 0 && onResolveInteraction && (
          <div className="mt-2 space-y-2 pl-[52px]">
            {interactions.map((request) => (
              <PermissionCard
                key={request.id}
                request={request}
                onResolve={onResolveInteraction}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function TraceMessageFinished({
  message,
  durationMs,
  mentionRegex,
  onRefClick,
}: {
  message: ChatMessage;
  durationMs?: number;
  mentionRegex: RegExp | null;
  onRefClick?: (ref: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = useMemo(
    () => (durationMs != null ? formatElapsed(durationMs) : null),
    [durationMs],
  );
  const actions = useMemo(() => countActions(message.trace ?? []), [message.trace]);

  return (
    <div className="min-w-0">
      <div className="leading-[1.375rem] break-words whitespace-pre-wrap">
        {renderMessageContent(message.content, mentionRegex, onRefClick)}
      </div>
      {message.trace && message.trace.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1.5 text-[11px] text-muted hover:text-body"
          >
            <Chevron expanded={expanded} />
            {expanded
              ? "Hide trace"
              : [elapsed && `Worked for ${elapsed}`, actions > 0 && `${actions} actions`]
                  .filter(Boolean)
                  .join(" · ") || "View trace"}
          </button>
          {expanded && <TraceBody chunks={message.trace} />}
        </div>
      )}
    </div>
  );
}
