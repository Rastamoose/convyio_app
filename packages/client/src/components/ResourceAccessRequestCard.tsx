import { useState } from "react";
import type { AgentResourceAccessRequest } from "@workspace/shared";

const kindLabel: Record<string, string> = {
  channel: "channel",
  git_project: "Git project",
  local_project: "local project",
  workspace_file: "workspace file",
};

export function ResourceAccessRequestCard({
  request,
  onResolve,
  compact,
}: {
  request: AgentResourceAccessRequest;
  onResolve: (requestId: string, decision: "approved" | "denied") => Promise<boolean>;
  compact?: boolean;
}) {
  const [working, setWorking] = useState(false);

  const decide = async (decision: "approved" | "denied") => {
    setWorking(true);
    await onResolve(request.id, decision);
    setWorking(false);
  };

  return (
    <div className={`rounded-lg bg-subtle ${compact ? "p-2" : "p-2.5"}`}>
      <div className={`mb-1 font-bold tracking-wider text-muted uppercase ${compact ? "text-[10px]" : "text-[10px]"}`}>
        {request.agentName ?? "An agent"} wants access to a {kindLabel[request.resourceKind] ?? request.resourceKind}
      </div>
      <div className={`mb-1 font-medium text-body ${compact ? "text-xs" : "text-sm"}`}>
        {request.resourceName ?? request.resourceId}
      </div>
      {request.reason && (
        <div className={`mb-2 text-faint ${compact ? "text-[10px]" : "text-[11px]"}`}>“{request.reason}”</div>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={working}
          onClick={() => decide("approved")}
          className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => decide("denied")}
          className="rounded-md bg-subtle px-2.5 py-1 text-xs font-medium text-body hover:bg-subtle-hover disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
