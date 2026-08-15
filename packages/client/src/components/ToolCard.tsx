import { useState } from "react";
import type { ToolExecution } from "@workspace/shared";

export function ToolCard({ execution }: { execution: ToolExecution }) {
  const [open, setOpen] = useState(execution.status === "running");
  const mark =
    execution.status === "completed" ? "✓" :
    execution.status === "failed" || execution.status === "denied" ? "✕" :
    execution.status === "cancelled" ? "–" : "●";
  const duration = execution.completedAt ? `${((execution.completedAt - execution.startedAt) / 1000).toFixed(1)}s` : "running";

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-divider bg-subtle/50">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-mono text-xs"
      >
        <span className={execution.status === "running" ? "text-working" : execution.status === "completed" ? "text-online" : "text-muted"}>
          {mark}
        </span>
        <span className="min-w-0 flex-1 truncate text-body">{execution.summary}</span>
        <span className="shrink-0 text-faint">{duration}</span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-divider px-3 py-2 font-mono text-[11px] leading-5 text-muted whitespace-pre-wrap">
          {execution.outputPreview || execution.error || execution.inputPreview}
        </pre>
      )}
    </div>
  );
}
