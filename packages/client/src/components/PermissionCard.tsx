import type { InteractionRequest } from "@workspace/shared";
import { ActionButton } from "./ActionButton";

const CAPABILITY_LABEL: Record<string, string> = {
  file_write: "write a file",
  shell_repo: "run a command",
  network: "reach the network",
};

/**
 * A run paused on a decision. The card renders the server's request id, so
 * answering here and answering from anywhere else are the same act.
 */
export function PermissionCard({
  request,
  onResolve,
}: {
  request: InteractionRequest;
  onResolve: (requestId: string, decision: "approve" | "deny") => void;
}) {
  return (
    <div className="rounded-lg bg-popup p-2.5">
      <div className="mb-1 text-[11px] font-bold tracking-wide text-muted uppercase">
        Wants to {CAPABILITY_LABEL[request.capability] ?? request.capability}
      </div>
      <code className="mb-2 block overflow-x-auto rounded bg-composer px-2 py-1.5 font-mono text-xs whitespace-pre text-body">
        {request.summary}
      </code>
      {request.boardItemRef && (
        <div className="mb-2 text-[11px] text-faint">under {request.boardItemRef}</div>
      )}
      <div className="flex gap-1.5">
        <ActionButton
          label="Allow"
          tone="primary"
          compact
          onClick={() => onResolve(request.id, "approve")}
        />
        <ActionButton
          label="Deny"
          tone="deny"
          compact
          onClick={() => onResolve(request.id, "deny")}
        />
      </div>
    </div>
  );
}
