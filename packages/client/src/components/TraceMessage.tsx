import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, InteractionRequest, TraceChunk } from "@workspace/shared";
import { formatElapsed } from "../lib/format";
import { Avatar } from "./Avatar";
import { AgentBadge } from "./AgentBadge";
import { PermissionCard } from "./PermissionCard";

/** Toolman lines are tagged in the trace; everything else is prose. */
const TOOL_LINE = /^\[toolman\] /;

function countActions(chunks: TraceChunk[]): number {
  return chunks.filter((c) => TOOL_LINE.test(c.content)).length;
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
  interactions = [],
  onResolveInteraction,
}: {
  runId: string;
  agentName: string;
  chunks: TraceChunk[];
  startedAt: number;
  /** Prompts this run is paused on; answering here is the same act as anywhere. */
  interactions?: InteractionRequest[];
  onResolveInteraction?: (requestId: string, decision: "approve" | "deny") => void;
}) {
  // A live run's age is the one thing that changes with no new frames.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const actions = countActions(chunks);
  const paused = interactions.length > 0;

  return (
    <div id={`trace-${runId}`} className="mt-4 flex gap-4 py-0.5 pr-4 pl-4">
      <div className="pt-0.5">
        <Avatar name={agentName} size={40} />
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
          {paused ? "needs your decision" : "is working…"}
          <span className="font-mono text-xs text-faint">
            {actions > 0 && `${actions} action${actions === 1 ? "" : "s"} · `}
            {formatElapsed(now - startedAt)}
          </span>
        </div>
        <TraceBody chunks={chunks} />
        {paused && onResolveInteraction && (
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
}: {
  message: ChatMessage;
  durationMs?: number;
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
        {message.content}
      </div>
      {message.trace && message.trace.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-body"
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
