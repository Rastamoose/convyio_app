import type { BoardItem } from "@workspace/shared";

export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5">
      <div className="text-[10px] font-bold tracking-wide text-muted uppercase">
        {label}
      </div>
      <div className="text-sm leading-snug break-words text-body">{value}</div>
    </div>
  );
}

export function ProposalCard({
  item,
  onApprove,
  onDeny,
  onDiscuss,
}: {
  item: BoardItem;
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
}) {
  return (
    <div className="rounded-lg bg-input p-3">
      <div className="mb-2 flex items-baseline gap-2 text-xs">
        <span className="shrink-0 rounded bg-blurple px-1 py-px font-bold text-mention-text">
          {item.ref}
        </span>
        <span className="truncate font-medium text-body">
          {item.createdByName}
        </span>
        <span className="ml-auto shrink-0 text-faint">
          {relativeTime(item.createdAt)}
        </span>
      </div>
      <Field label="What" value={item.title} />
      {item.proposalWhy && <Field label="Why" value={item.proposalWhy} />}
      {item.proposalEffect && (
        <Field label="Expected effect" value={item.proposalEffect} />
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          onClick={() => onApprove(item.id)}
          className="flex-1 rounded bg-online px-2 py-1 text-xs font-semibold text-mention-text hover:opacity-90"
        >
          Approve
        </button>
        <button
          onClick={() => onDeny(item.id)}
          className="flex-1 rounded bg-dead px-2 py-1 text-xs font-semibold text-mention-text hover:opacity-90"
        >
          Deny
        </button>
        <button
          onClick={() => onDiscuss(item)}
          className="flex-1 rounded bg-popup px-2 py-1 text-xs font-semibold text-body hover:bg-mention-bg-hover"
        >
          Discuss
        </button>
      </div>
    </div>
  );
}
