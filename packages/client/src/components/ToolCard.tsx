import { useState } from "react";
import type { ToolExecution } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";

function statusMark(status: ToolExecution["status"]) {
  return status === "completed" ? "✓" :
    status === "failed" || status === "denied" ? "✕" :
    status === "cancelled" ? "–" : "●";
}

function markClass(status: ToolExecution["status"]) {
  return status === "running" ? "text-working" : status === "completed" ? "text-online" : "text-muted";
}

/** Collapsed row for a run of consecutive same-action calls; expands to the individual ToolCards. */
export function ToolCardGroup({ executions }: { executions: ToolExecution[] }) {
  const [open, setOpen] = useState(false);
  const anyRunning = executions.some((e) => e.status === "running");
  const anyFailed = executions.some((e) => e.status === "failed" || e.status === "denied");
  const status = anyRunning ? "running" : anyFailed ? "failed" : executions[executions.length - 1].status;
  const totalMs = executions.reduce(
    (sum, e) => sum + (e.completedAt ? e.completedAt - e.startedAt : 0),
    0,
  );

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-divider bg-subtle/50">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className={markClass(status)}>{statusMark(status)}</span>
        <span className="min-w-0 flex-1 truncate text-body">
          {executions[0].action} <span className="text-faint">×{executions.length}</span>
        </span>
        <span className="shrink-0 text-faint">{anyRunning ? "running" : `${(totalMs / 1000).toFixed(1)}s`}</span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-divider p-1">
          {executions.map((execution) => (
            <ToolCard key={execution.id} execution={execution} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolCard({ execution }: { execution: ToolExecution }) {
  const { apiFetch } = useWorkspace();
  const [open, setOpen] = useState(execution.status === "running");
  const [fullLog, setFullLog] = useState<string | null>(null);
  const mark = statusMark(execution.status);
  const duration = execution.completedAt ? `${((execution.completedAt - execution.startedAt) / 1000).toFixed(1)}s` : "running";

  const loadFull = async () => {
    if (!execution.outputArtifact || fullLog) return;
    const res = await apiFetch(`/api/tool-executions/${execution.id}/artifact/output`);
    if (!res?.ok) return;
    setFullLog(await res.text());
  };

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-divider bg-subtle/50">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className={markClass(execution.status)}>{mark}</span>
        <span className="min-w-0 flex-1 truncate text-body">{execution.summary}</span>
        <span className="shrink-0 text-faint">{duration}</span>
      </button>
      {open && (
        <div className="border-t border-divider">
          <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-muted whitespace-pre-wrap">
            {fullLog || execution.outputPreview || execution.error || execution.inputPreview}
          </pre>
          {execution.outputArtifact && !fullLog && (
            <button
              onClick={() => void loadFull()}
              className="cursor-pointer px-3 pb-2 text-[11px] text-accent"
            >
              Load full log
            </button>
          )}
        </div>
      )}
    </div>
  );
}
