import { useMemo, useState } from "react";
import type { ChatMessage, TraceChunk } from "@workspace/shared";
import { Avatar } from "./Avatar";

function formatElapsed(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s}s`;
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
  agentName,
  chunks,
}: {
  agentName: string;
  chunks: TraceChunk[];
}) {
  return (
    <div className="mt-4 flex gap-4 py-0.5 pr-4 pl-4">
      <div className="pt-0.5">
        <Avatar name={agentName} size={40} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-body hover:underline">{agentName}</span>
          <span className="rounded bg-blurple px-1 py-px text-[10px] font-bold text-mention-text">
            AGENT
          </span>
        </div>
        <div className="mb-1 flex items-center gap-2 text-sm text-muted">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-working opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-working" />
          </span>
          is working…
        </div>
        <TraceBody chunks={chunks} />
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

  return (
    <div className="min-w-0">
      <div className="leading-[1.375rem] break-words whitespace-pre-wrap">
        {message.content}
      </div>
      {message.trace && message.trace.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-body"
          >
            <Chevron expanded={expanded} />
            {expanded ? "Hide trace" : elapsed ? `Worked for ${elapsed}` : "View trace"}
          </button>
          {expanded && <TraceBody chunks={message.trace} />}
        </div>
      )}
    </div>
  );
}
